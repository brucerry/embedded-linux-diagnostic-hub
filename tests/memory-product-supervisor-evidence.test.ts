import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
    finishProductEvidence,
    supervisorEvidenceIO,
    writeSupervisorEvidence,
    verifySupervisorEvidence,
    retainSupervisorSourceBridge,
    readSupervisorSourceBridge,
    verifyBoundSupervisorSourceBridge,
    supervisorArguments,
    supervisorDestination,
    supervisorOutput,
    timelineLimit,
    type EvidenceFileSystem,
    type SupervisorLifecycle,
    type EvidenceReference,
} from './fixtures/memory-product-supervisor-evidence';
import {
    ProductRunOwner,
    observeProductOwner,
    productJob,
    type ProductClock,
} from './fixtures/memory-product-owner';
import { syncCloseEvidence } from './fixtures/memory-resource-evidence';
import { verifySoak } from './fixtures/memory-resource-verifier';
import { syntheticSourceFixture } from './fixtures/memory-source-bridge-input';
import {
    sourceDigest,
    SOURCE_LIMITS,
    sourceFingerprintInventory,
} from '../scripts/lib/committed-source-bridge.mjs';
import {
    createSourceBinding,
    sourceBindingFromArguments,
    sourceBindingTimeline,
    validateSourceBinding,
    validateClosedChild,
    parseSupervisorJSON,
    createHarnessObserver,
    harnessObserverSHA256,
    validateHarnessObserver,
} from '../scripts/lib/product-supervisor-contract.mjs';

const directory = path.resolve(
    '/synthetic/validation/gateway-normal-11111111-1111-1111-1111-111111111111-ABC123',
);
class Clock implements ProductClock {
    time = 0;
    timers = new Map<number, { due: number; callback(): void }>();
    next = 0;
    now = () => this.time;
    set = (callback: () => void, delay: number) => {
        const id = ++this.next;
        this.timers.set(id, { due: this.time + delay, callback });
        return id;
    };
    clear = (id: unknown) => {
        this.timers.delete(id as number);
    };
    advance(time: number) {
        for (;;) {
            const row = [...this.timers]
                .filter(([, value]) => value.due <= time)
                .sort((a, b) => a[1].due - b[1].due)[0];
            if (!row) break;
            this.time = row[1].due;
            this.timers.delete(row[0]);
            row[1].callback();
        }
        this.time = time;
    }
}
type File = {
    bytes: Buffer;
    ino: number;
    mtime: number;
    nlink: number;
    symlink: boolean;
    size?: number;
};
/** Memory-only FS. No file, subprocess, socket or product is created by these fixtures. */
class Filesystem implements EvidenceFileSystem {
    files = new Map<string, File>();
    events: string[] = [];
    hooks = new Map<string, () => void>();
    alias = false;
    directoryLink = false;
    touch(event: string) {
        this.events.push(event);
        this.hooks.get(event)?.();
    }
    put(name: string, text: string) {
        this.files.set(name, {
            bytes: Buffer.from(text),
            ino: this.files.size + 2,
            mtime: 1,
            nlink: 1,
            symlink: false,
        });
    }
    info(name: string) {
        if (name === path.basename(directory))
            return {
                isFile: () => false,
                isDirectory: () => true,
                isSymbolicLink: () => this.directoryLink,
                dev: 1,
                ino: 1,
                size: 0,
                nlink: 2,
                mtimeMs: 1,
                ctimeMs: 1,
            };
        const row = this.files.get(name);
        if (!row) throw Error('ENOENT ' + name);
        return {
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => row.symlink,
            dev: 1,
            ino: row.ino,
            size: row.size ?? row.bytes.length,
            nlink: row.nlink,
            mtimeMs: row.mtime,
            ctimeMs: row.mtime,
        };
    }
    async lstat(file: string) {
        const name = path.basename(file);
        this.touch(name + ':lstat');
        return this.info(name);
    }
    async realpath(file: string) {
        return this.alias ? file + '-foreign' : file;
    }
    async open(file: string, flags: string) {
        const name = path.basename(file);
        this.touch(name + ':open:' + flags);
        if (flags === 'wx') {
            if (this.files.has(name)) throw Error('EEXIST ' + name);
            this.put(name, '');
        }
        if (!this.files.has(name)) throw Error('ENOENT ' + name);
        let cursor = 0;
        return {
            stat: async () => {
                this.touch(name + ':stat');
                return this.info(name);
            },
            read: async (
                buffer: Buffer,
                offset: number,
                length: number,
                _position: number | null,
            ) => {
                this.touch(name + ':read');
                const value = this.files.get(name)!;
                const bytesRead = Math.max(0, Math.min(length, value.bytes.length - cursor));
                value.bytes.copy(buffer, offset, cursor, cursor + bytesRead);
                cursor += bytesRead;
                return { bytesRead };
            },
            writeFile: async (bytes: string) => {
                this.touch(name + ':write');
                this.files.get(name)!.bytes = Buffer.from(bytes);
            },
            sync: async () => {
                this.touch(name + ':sync');
            },
            close: async () => {
                this.touch(name + ':close');
            },
        };
    }
}
function syntheticRuntime() {
    return {
        executablePath: '/synthetic/node',
        executableSHA256: 'c'.repeat(64),
        node: 'v24.19.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '24.19.0', v8: 'synthetic-v8' },
        execArgv: ['--import', '/synthetic/observer.mjs'],
        nodeOptions: null,
    };
}
function syntheticTimeline(binding: any, observer: unknown, sourceBridge: EvidenceReference) {
    return (
        JSON.stringify({ time: 1, stage: 'supervisor-source-binding', data: binding }) +
        '\n' +
        JSON.stringify({ time: 2, stage: 'supervisor-harness-observer', data: observer }) +
        '\n' +
        JSON.stringify({
            time: 3,
            stage: 'supervisor-source-bridge',
            data: {
                sourceCommit: binding.sourceCommit,
                sourceTree: binding.sourceTree,
                reference: sourceBridge,
            },
        }) +
        '\n'
    );
}
function fixture() {
    const clock = new Clock();
    const job = productJob(
        JSON.stringify({
            schema: 1,
            nonce: '11111111-1111-1111-1111-111111111111',
            budgetMs: 2400000,
            reserveMs: 60000,
            deadlineMs: 2400000,
        }),
        clock,
    );
    const filesystem = new Filesystem();
    const sourceInput = syntheticSourceFixture();
    const sourceBytes = JSON.stringify(sourceInput.record) + '\n';
    filesystem.put('source-bridge.json', sourceBytes);
    const source = {
        expected: { ...sourceInput.expected },
        provider: sourceInput.provider,
        reference: {
            name: 'source-bridge.json',
            bytes: Buffer.byteLength(sourceBytes),
            sha256: sourceDigest(sourceBytes),
        },
    };
    const observer = createHarnessObserver(syntheticRuntime());
    const binding = createSourceBinding({
        jobNonce: job.nonce,
        observerSHA256: harnessObserverSHA256(observer),
        sourceSHA256: sourceInput.fingerprint,
        sourceCommit: source.expected.sourceCommit,
        sourceTree: source.expected.sourceTree,
        sourceBridgeSHA256: source.reference.sha256,
        adapterSHA256: 'b'.repeat(64),
        lane: 'gateway',
        gcMode: 'normal',
        viewer: false,
        component: false,
        calibration: false,
    });
    filesystem.put('timeline.jsonl', syntheticTimeline(binding, observer, source.reference));
    const io = supervisorEvidenceIO(directory, filesystem);
    const events = Object.assign(new EventEmitter(), {
        connected: true,
        exitCode: 0,
        disconnect() {
            filesystem.events.push('IPC:disconnect');
            this.connected = false;
        },
    });
    const owner = new ProductRunOwner(job, events, clock);
    const lifecycle: SupervisorLifecycle = {
        pid: 123,
        spawnObserved: true,
        exitObserved: true,
        closeObserved: true,
        code: 0,
        closeCode: 0,
        signal: null,
        closeSignal: null,
        error: null,
        timedOut: false,
        terminationRequested: false,
        killErrors: [],
        elapsedMs: 1,
    };
    return {
        clock,
        job,
        binding,
        observer,
        filesystem,
        io,
        events,
        owner,
        lifecycle,
        source,
        sourceInput,
    };
}
async function closeChild(f: ReturnType<typeof fixture>) {
    await f.owner.join();
    await finishProductEvidence(f.owner, f.binding, f.observer, f.io, f.source, f.clock);
}

test('file sync/close precedes IPC disconnect; parent sidecar is explicitly non-qualifying', async () => {
    const f = fixture();
    await closeChild(f);
    assert.ok(
        f.filesystem.events.indexOf('child-evidence.json:sync') <
            f.filesystem.events.indexOf('child-evidence.json:close'),
    );
    assert.ok(
        f.filesystem.events.indexOf('child-evidence.json:close') <
            f.filesystem.events.indexOf('IPC:disconnect'),
    );
    assert.equal(f.owner.snapshot().completed, true);
    const row = await writeSupervisorEvidence(
        f.job,
        f.binding,
        f.observer,
        f.lifecycle,
        f.io,
        f.source,
    );
    assert.equal(row.status, 'collected-non-qualifying-supervisor-evidence');
    assert.equal(row.qualification, false);
    assert.equal(row.releaseAcceptance, false);
    assert.equal(row.timeline?.name, 'timeline.jsonl');
    assert.deepEqual(row.failures, []);
    const manifest = JSON.parse(f.filesystem.files.get('child-evidence.json')!.bytes.toString());
    assert.equal(manifest.ownerCompletion, 'not-asserted');
    assert.equal(manifest.nonce, f.job.nonce);
    assert.deepEqual(
        JSON.parse(f.filesystem.files.get('supervisor-evidence.json')!.bytes.toString()),
        row,
    );
});

test('reserved arguments and foreign output locations cannot override parent evidence custody', () => {
    const f = fixture();
    supervisorArguments(['--lane=gateway', '--out=validation/evidence'], false);
    for (const reserved of ['child', 'product-job', 'supervisor-output']) {
        assert.throws(() => supervisorArguments(['--' + reserved + '=foreign'], false));
        const internal = ['--child=1', '--product-job={}', '--supervisor-output=x'];
        supervisorArguments(internal, true);
        assert.throws(() => supervisorArguments([...internal, '--' + reserved + '=again'], true));
    }
    const destination = path.dirname(directory),
        root = path.dirname(destination);
    assert.equal(supervisorDestination(root, destination), destination);
    assert.throws(() => supervisorDestination(root, path.join(root, 'src')));
    assert.equal(supervisorOutput(destination, directory, 'gateway', 'normal', f.job), directory);
    for (const output of [
        directory + '-foreign',
        path.join(destination, 'foreign'),
        path.join(root, path.basename(directory)),
    ])
        assert.throws(() => supervisorOutput(destination, output, 'gateway', 'normal', f.job));
});

test('unjoined ownership cannot finish even with a written manifest', async () => {
    const f = fixture();
    await assert.rejects(
        finishProductEvidence(f.owner, f.binding, f.observer, f.io, f.source, f.clock),
        /descendants/,
    );
    assert.equal(f.owner.snapshot().completed, false);
    assert.ok(f.owner.snapshot().invalid);
    assert.equal(f.events.connected, true);
    assert.equal(f.events.listenerCount('message'), 1);
    assert.ok(f.clock.timers.size > 0);
});

for (const stage of [
    'source-bridge.json:open:r',
    'source-bridge.json:read',
    'source-bridge.json:close',
    'timeline.jsonl:open:r',
    'timeline.jsonl:read',
    'timeline.jsonl:close',
    'child-evidence.json:open:wx',
    'child-evidence.json:write',
    'child-evidence.json:sync',
    'child-evidence.json:close',
]) {
    test('child ' + stage + ' failure retains ownership and never disconnects', async () => {
        const f = fixture();
        await f.owner.join();
        const first = Error('first:' + stage);
        f.filesystem.hooks.set(stage, () => {
            throw first;
        });
        await assert.rejects(
            finishProductEvidence(f.owner, f.binding, f.observer, f.io, f.source, f.clock),
            (error: unknown) => error === first,
        );
        assert.equal(f.owner.snapshot().completed, false);
        assert.ok(f.owner.snapshot().invalid);
        assert.equal(f.events.connected, true);
        assert.equal(f.events.listenerCount('message'), 1);
        assert.ok(!f.filesystem.events.includes('IPC:disconnect'));
    });
}

test('timeline sync/close errors are retained and cannot enter child finalization', async () => {
    const f = fixture();
    await f.owner.join();
    const errors = await syncCloseEvidence([
        {
            sync: async () => {
                throw Error('timeline sync');
            },
            close: async () => {
                throw Error('timeline close');
            },
        },
    ]);
    assert.equal(errors.length, 2);
    f.owner.hold(errors[0]);
    assert.equal(f.owner.snapshot().completed, false);
    assert.equal(f.events.connected, true);
    assert.equal(f.filesystem.files.has('child-evidence.json'), false);
});

test('write/sync/close and read/close errors preserve the initial failure without dropping later failures', async () => {
    const f = fixture();
    const errors = [Error('write-primary'), Error('sync-secondary'), Error('close-tertiary')];
    for (const [i, stage] of ['write', 'sync', 'close'].entries())
        f.filesystem.hooks.set('child-evidence.json:' + stage, () => {
            throw errors[i];
        });
    await assert.rejects(
        f.io.write('child-evidence.json', {}),
        (error: any) =>
            error instanceof AggregateError &&
            error.cause === errors[0] &&
            error.errors.every((e: unknown, i: number) => e === errors[i]),
    );
    const first = Error('read-primary'),
        last = Error('read-close-secondary');
    f.filesystem.hooks.set('timeline.jsonl:read', () => {
        throw first;
    });
    f.filesystem.hooks.set('timeline.jsonl:close', () => {
        throw last;
    });
    await assert.rejects(
        f.io.hash('timeline.jsonl', 4096),
        (error: any) =>
            error instanceof AggregateError && error.cause === first && error.errors[1] === last,
    );
});

for (const update of [
    { pid: null },
    { spawnObserved: false },
    { exitObserved: false },
    { closeObserved: false },
    { code: 1, closeCode: 1 },
    { signal: 'SIGTERM', closeSignal: 'SIGTERM' },
    { closeCode: 1 },
    { closeSignal: 'SIGTERM' },
    { timedOut: true },
    { error: 'sampler or supervisor error' },
    { terminationRequested: true },
    { killErrors: ['cancel send failed'] },
]) {
    test(
        'abnormal lifecycle stays invalid without reading child files: ' + JSON.stringify(update),
        async () => {
            const f = fixture();
            await closeChild(f);
            f.filesystem.events.length = 0;
            const row = await writeSupervisorEvidence(
                f.job,
                f.binding,
                f.observer,
                { ...f.lifecycle, ...update },
                f.io,
                f.source,
            );
            assert.equal(row.status, 'invalid-non-qualifying-supervisor-evidence');
            assert.equal(row.timeline, null);
            assert.equal(row.childEvidence, null);
            assert.ok(!f.filesystem.events.some((event) => /timeline|child-evidence/.test(event)));
        },
    );
}

test('missing and foreign/malformed child manifests or changed timeline bytes remain invalid', async () => {
    for (const mode of [
        'missing',
        'malformed',
        'nonce',
        'kind',
        'qualification',
        'extra',
        'timeline',
    ]) {
        const f = fixture();
        await closeChild(f);
        const bytes = f.filesystem.files.get('child-evidence.json')!.bytes;
        const value = JSON.parse(bytes.toString());
        if (mode === 'missing') f.filesystem.files.delete('child-evidence.json');
        else if (mode === 'malformed') f.filesystem.put('child-evidence.json', '{bad-json');
        else if (mode === 'timeline') f.filesystem.put('timeline.jsonl', 'changed-after-close');
        else {
            if (mode === 'nonce') value.nonce = '22222222-2222-2222-2222-222222222222';
            if (mode === 'kind') value.kind = 'staged-artifact-producer';
            if (mode === 'qualification') value.qualification = true;
            if (mode === 'extra') value.ownerCompleted = true;
            f.filesystem.put('child-evidence.json', JSON.stringify(value) + '\n');
        }
        const row = await writeSupervisorEvidence(
            f.job,
            f.binding,
            f.observer,
            f.lifecycle,
            f.io,
            f.source,
        );
        assert.equal(row.status, 'invalid-non-qualifying-supervisor-evidence', mode);
        assert.equal(row.timeline, null);
        assert.ok(row.failures.length);
    }
});

test('unknown closure and a later close never upgrade evidence or detach the owner', async () => {
    const f = fixture();
    const child = Object.assign(new EventEmitter(), {
        pid: 123,
        connected: true,
        kill: () => assert.fail('never kill an owning harness'),
        send: (_message: unknown, callback: () => void) => callback(),
    });
    const observed = observeProductOwner(child, f.job, f.clock);
    child.emit('spawn');
    child.emit('exit', 0, null);
    f.clock.advance(2400000);
    const lifecycle = await observed.outcome;
    const sidecar = await writeSupervisorEvidence(
        f.job,
        f.binding,
        f.observer,
        lifecycle,
        f.io,
        f.source,
    );
    assert.equal(sidecar.timeline, null);
    assert.equal(sidecar.lifecycle?.closeObserved, false);
    assert.equal(child.connected, true);
    assert.equal(child.listenerCount('close'), 1);
    child.emit('close', 0, null);
    assert.equal(observed.snapshot().closeObserved, true);
    assert.equal(sidecar.lifecycle?.closeObserved, false);
    assert.equal(sidecar.status, 'invalid-non-qualifying-supervisor-evidence');
});

test('bounded reads reject aliases, hardlinks, growth, mutation and oversize; metadata never overwrites', async () => {
    for (const mode of [
        'symlink',
        'hardlink',
        'directory-link',
        'ancestor-alias',
        'oversize',
        'growth',
        'mutation',
    ]) {
        const f = fixture(),
            file = f.filesystem.files.get('timeline.jsonl')!;
        if (mode === 'symlink') file.symlink = true;
        if (mode === 'hardlink') file.nlink = 2;
        if (mode === 'directory-link') f.filesystem.directoryLink = true;
        if (mode === 'ancestor-alias') f.filesystem.alias = true;
        if (mode === 'oversize') file.size = timelineLimit + 1;
        if (mode === 'growth')
            f.filesystem.hooks.set('timeline.jsonl:read', () => {
                file.bytes = Buffer.alloc(4097);
            });
        if (mode === 'mutation')
            f.filesystem.hooks.set('timeline.jsonl:read', () => {
                file.mtime++;
            });
        await assert.rejects(
            f.io.hash('timeline.jsonl', 4096),
            (error: unknown) => error instanceof Error,
            mode,
        );
    }
    const f = fixture();
    await f.io.write('child-evidence.json', {});
    await assert.rejects(f.io.write('child-evidence.json', {}), /EEXIST/);
    await assert.rejects(f.io.hash('../foreign', 100), /filename/);
    await assert.rejects(f.io.write('child-evidence.json', 'x'.repeat(40000)), /size bound/);
});

for (const stage of ['open:wx', 'write', 'sync', 'close']) {
    test(
        'supervisor sidecar ' + stage + ' error is thrown and retained bytes are never cleaned up',
        async () => {
            const f = fixture();
            await closeChild(f);
            const failure = Error('sidecar:' + stage);
            f.filesystem.hooks.set('supervisor-evidence.json:' + stage, () => {
                throw failure;
            });
            await assert.rejects(
                writeSupervisorEvidence(f.job, f.binding, f.observer, f.lifecycle, f.io, f.source),
                (error: unknown) => error === failure,
            );
            assert.ok(f.filesystem.files.has('timeline.jsonl'));
            assert.ok(f.filesystem.files.has('child-evidence.json'));
        },
    );
}

test('spawn request failure remains an invalid non-qualifying record with no inferred child absence', async () => {
    const f = fixture();
    const result = await writeSupervisorEvidence(
        f.job,
        f.binding,
        f.observer,
        null,
        f.io,
        f.source,
        Error('synthetic spawn call failure'),
    );
    assert.equal(result.status, 'invalid-non-qualifying-supervisor-evidence');
    assert.equal(result.lifecycle, null);
    assert.equal(result.timeline, null);
    assert.match(result.failures[0], /synthetic spawn call failure/);
});

test('v4 retained graph verifies exact bytes against independent expected source/job without qualification', async () => {
    const f = fixture();
    await closeChild(f);
    await writeSupervisorEvidence(f.job, f.binding, f.observer, f.lifecycle, f.io, f.source);
    const graph = await verifySupervisorEvidence(f.job, f.binding, f.observer, f.io, f.source);
    assert.equal(graph.kind, 'verified-non-qualifying-supervisor-graph');
    assert.equal(graph.qualification, false);
    assert.equal(graph.releaseAcceptance, false);
    assert.deepEqual(graph.sourceBridge, f.source.reference);
    assert.equal(graph.timeline.name, 'timeline.jsonl');
    const foreignJob = { ...f.job, nonce: '22222222-2222-2222-2222-222222222222' };
    await assert.rejects(
        verifySupervisorEvidence(foreignJob, f.binding, f.observer, f.io, f.source),
    );
    for (const update of [
        { sourceSHA256: 'c'.repeat(64) },
        { adapterSHA256: 'c'.repeat(64) },
        { lane: 'browser' },
        { gcMode: 'forced' },
        { viewer: true },
        { requestedMode: 'component' },
    ])
        await assert.rejects(
            verifySupervisorEvidence(
                f.job,
                { ...f.binding, ...update },
                f.observer,
                f.io,
                f.source,
            ),
        );
});

test('both GC modes and all requested scopes verify only as synthetic non-qualifying graphs', async () => {
    for (const gcMode of ['normal', 'forced'])
        for (const requestedMode of ['full-product', 'component', 'calibration']) {
            const f = fixture();
            f.binding = { ...f.binding, gcMode, requestedMode };
            f.filesystem.put(
                'timeline.jsonl',
                syntheticTimeline(f.binding, f.observer, f.source.reference),
            );
            await closeChild(f);
            await writeSupervisorEvidence(
                f.job,
                f.binding,
                f.observer,
                f.lifecycle,
                f.io,
                f.source,
            );
            const graph = await verifySupervisorEvidence(
                f.job,
                f.binding,
                f.observer,
                f.io,
                f.source,
            );
            assert.equal(graph.qualification, false);
            assert.equal(graph.releaseAcceptance, false);
            assert.equal(graph.binding.requestedMode, requestedMode);
        }
});

test('readback rejects invalid lifecycle metadata before reading potentially live child evidence', async () => {
    const f = fixture();
    await writeSupervisorEvidence(
        f.job,
        f.binding,
        f.observer,
        { ...f.lifecycle, closeObserved: false },
        f.io,
        f.source,
    );
    f.filesystem.events.length = 0;
    await assert.rejects(verifySupervisorEvidence(f.job, f.binding, f.observer, f.io, f.source));
    assert.ok(!f.filesystem.events.some((event) => /timeline|child-evidence/.test(event)));
});

test('canonical byte parsing rejects duplicate JSON members, alternate encoding and malformed UTF8', () => {
    assert.equal(parseSupervisorJSON(Buffer.from('{"synthetic":true}\n')).synthetic, true);
    for (const bytes of [
        Buffer.from('{"a":1,"a":2}\n'),
        Buffer.from('{"a": 1}\n'),
        Buffer.from('{"a":1}'),
        Buffer.from([0xff, 10]),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}\n')]),
    ])
        assert.throws(() => parseSupervisorJSON(bytes));
});

test('strict source binding schemas retain requested-scope semantics and reject unknown fields/versions', () => {
    const f = fixture();
    assert.equal(validateSourceBinding(f.binding), f.binding);
    for (const update of [
        { schemaVersion: 1 },
        { kind: 'staged-artifact-producer' },
        { qualification: true },
        { sourceSHA256: '' },
        { jobNonce: 'foreign' },
        { adapterSHA256: '' },
        { gcMode: 'swapped' },
        { viewer: 'false' },
        { requestedMode: 'passed' },
        { extra: true },
    ])
        assert.throws(() => validateSourceBinding({ ...f.binding, ...update }));
    const base = new Map([
        ['lane', 'gateway'],
        ['gc', 'normal'],
        ['source-commit', f.source.expected.sourceCommit],
        ['source-tree', f.source.expected.sourceTree],
        ['source-sha256', f.binding.sourceSHA256],
    ]);
    assert.equal(
        sourceBindingFromArguments(
            new Map([...base, ['viewer', '0']]),
            f.binding.sourceSHA256,
            'b'.repeat(64),
            f.job.nonce,
            f.observer,
            f.source,
        ).viewer,
        true,
    );
    assert.equal(
        sourceBindingFromArguments(
            new Map([...base, ['component', '0']]),
            f.binding.sourceSHA256,
            'b'.repeat(64),
            f.job.nonce,
            f.observer,
            f.source,
        ).requestedMode,
        'component',
    );
    assert.equal(
        sourceBindingFromArguments(
            new Map([...base, ['calibration', '1']]),
            f.binding.sourceSHA256,
            'b'.repeat(64),
            f.job.nonce,
            f.observer,
            f.source,
        ).requestedMode,
        'calibration',
    );
    for (const flags of [
        [['calibration', '0']],
        [
            ['calibration', '1'],
            ['component', '1'],
        ],
        [
            ['calibration', '1'],
            ['memory-policy', 'x'],
        ],
    ])
        assert.throws(() =>
            sourceBindingFromArguments(
                new Map([...base, ...flags] as [string, string][]),
                f.binding.sourceSHA256,
                'b'.repeat(64),
                f.job.nonce,
                f.observer,
                f.source,
            ),
        );
});

for (const mode of [
    'v1',
    'v2',
    'unknown-version',
    'kind',
    'qualification',
    'releaseAcceptance',
    'status',
    'failures',
    'extra',
    'job',
    'child-reference',
    'timeline-reference',
    'lifecycle',
]) {
    test('semantic retained parent graph rejects ' + mode, async () => {
        const f = fixture();
        await closeChild(f);
        await writeSupervisorEvidence(f.job, f.binding, f.observer, f.lifecycle, f.io, f.source);
        const value = JSON.parse(
            f.filesystem.files.get('supervisor-evidence.json')!.bytes.toString(),
        );
        if (mode === 'v1') value.schemaVersion = 1;
        if (mode === 'v2') value.schemaVersion = 2;
        if (mode === 'unknown-version') value.schemaVersion = 99;
        if (mode === 'kind') value.kind = 'staged-artifact-producer';
        if (mode === 'qualification') value.qualification = true;
        if (mode === 'releaseAcceptance') value.releaseAcceptance = true;
        if (mode === 'status') value.status = 'invalid-non-qualifying-supervisor-evidence';
        if (mode === 'failures') value.failures = ['initial failure'];
        if (mode === 'extra') value.extra = true;
        if (mode === 'job') value.job.deadlineMs++;
        if (mode === 'child-reference') value.childEvidence.sha256 = 'c'.repeat(64);
        if (mode === 'timeline-reference') value.timeline.bytes++;
        if (mode === 'lifecycle') value.lifecycle.closeObserved = false;
        f.filesystem.put('supervisor-evidence.json', JSON.stringify(value) + '\n');
        await assert.rejects(
            verifySupervisorEvidence(f.job, f.binding, f.observer, f.io, f.source),
        );
    });
}

test('child legacy/foreign binding and fixed filenames cannot be relabeled into a v4 graph', async () => {
    const f = fixture();
    await closeChild(f);
    const value = JSON.parse(f.filesystem.files.get('child-evidence.json')!.bytes.toString());
    const timeline = await f.io.timeline(f.binding, f.observer, f.source.reference);
    for (const update of [
        { schemaVersion: 1 },
        { schemaVersion: 2 },
        { binding: { ...f.binding, sourceSHA256: 'c'.repeat(64) } },
        { timeline: { ...timeline, name: '../foreign.jsonl' } },
        { ownerCompletion: 'passed' },
    ])
        assert.throws(() =>
            validateClosedChild(
                { ...value, ...update },
                {
                    job: f.job,
                    binding: f.binding,
                    observer: f.observer,
                    timeline,
                    sourceBridge: f.source.reference,
                },
            ),
        );
});

test('independent matching harness snapshots are retained as observer-only v4 evidence', async () => {
    const f = fixture();
    const childObserver = createHarnessObserver(syntheticRuntime());
    assert.notEqual(childObserver, f.observer);
    assert.equal(harnessObserverSHA256(childObserver), harnessObserverSHA256(f.observer));
    await f.owner.join();
    await finishProductEvidence(f.owner, f.binding, childObserver, f.io, f.source, f.clock);
    const row = await writeSupervisorEvidence(
        f.job,
        f.binding,
        f.observer,
        f.lifecycle,
        f.io,
        f.source,
    );
    assert.equal(row.schemaVersion, 4);
    assert.equal(row.qualification, false);
    const child = JSON.parse(f.filesystem.files.get('child-evidence.json')!.bytes.toString());
    assert.equal(child.observer.role, 'harness-observer');
    assert.equal(child.observer.qualification, false);
    const graph = await verifySupervisorEvidence(f.job, f.binding, f.observer, f.io, f.source);
    assert.equal(graph.releaseAcceptance, false);
    assert.equal(graph.observer.role, 'harness-observer');
});

test('harness snapshots copy and freeze observations while preserving flags and null environment exactly', () => {
    const raw = syntheticRuntime(),
        observed = createHarnessObserver(raw);
    const digest = harnessObserverSHA256(observed);
    raw.versions.v8 = 'changed-after-snapshot';
    raw.execArgv.push('--foreign');
    assert.equal(harnessObserverSHA256(observed), digest);
    for (const value of [
        observed,
        observed.runtime,
        observed.runtime.versions,
        observed.runtime.execArgv,
    ])
        assert.equal(Object.isFrozen(value), true);
    assert.throws(() => observed.runtime.execArgv.push('--cannot-mutate'));
    const reordered = createHarnessObserver({
        ...syntheticRuntime(),
        versions: { v8: 'synthetic-v8', node: '24.19.0' },
    });
    assert.equal(harnessObserverSHA256(reordered), digest);
    const empty = createHarnessObserver({ ...syntheticRuntime(), nodeOptions: '' });
    assert.notEqual(harnessObserverSHA256(empty), digest);
    const windows = createHarnessObserver({
        ...syntheticRuntime(),
        platform: 'win32',
        executablePath: 'C:\\synthetic\\node.exe',
    });
    assert.equal(windows.runtime.executablePath, 'C:\\synthetic\\node.exe');
    const versionMap = JSON.parse('{"node":"24.19.0","__proto__":"synthetic-only"}');
    const safe = createHarnessObserver({ ...syntheticRuntime(), versions: versionMap });
    assert.equal(Object.getPrototypeOf(safe.runtime.versions), Object.prototype);
    assert.equal(Object.hasOwn(safe.runtime.versions, '__proto__'), true);
});

test('observer schema rejects missing/unknown/bounded identity fields without collecting a real identity', () => {
    const f = fixture();
    for (const update of [
        { schemaVersion: 2 },
        { role: 'shipping-runtime' },
        { kind: 'staged-artifact-producer' },
        { qualification: true },
        { extra: true },
        { runtime: null },
    ])
        assert.throws(() => validateHarnessObserver({ ...f.observer, ...update }));
    for (const update of [
        { executablePath: 'relative/node' },
        { executableSHA256: '' },
        { node: 'v22.0.0' },
        { versions: { node: '24.0.0' } },
        { versions: Object.assign(Object.create({ node: '24.19.0' }), { v8: 'synthetic' }) },
        { arch: 'unknown' },
        { platform: 'unknown' },
        { execArgv: 'not-an-array' },
        { execArgv: Array(65).fill('--x') },
        { nodeOptions: undefined },
        { nodeOptions: 'x'.repeat(8193) },
        { extra: true },
    ])
        assert.throws(() => createHarnessObserver({ ...syntheticRuntime(), ...update }));
    assert.throws(() => createHarnessObserver(undefined));
    assert.throws(
        () =>
            createHarnessObserver({
                ...syntheticRuntime(),
                execArgv: Array(5).fill('x'.repeat(4096)),
            }),
        /metadata bound/,
    );
});

for (const [name, update] of [
    ['path', { executablePath: '/foreign/node' }],
    ['hash', { executableSHA256: 'd'.repeat(64) }],
    ['node', { node: 'v24.20.0', versions: { node: '24.20.0', v8: 'synthetic-v8' } }],
    ['versions', { versions: { node: '24.19.0', v8: 'foreign-v8' } }],
    ['arch', { arch: 'arm64' }],
    ['platform', { platform: 'darwin' }],
    ['flag-order', { execArgv: ['/synthetic/observer.mjs', '--import'] }],
    [
        'duplicate-flag',
        {
            execArgv: [
                '--import',
                '/synthetic/observer.mjs',
                '--import',
                '/synthetic/observer.mjs',
            ],
        },
    ],
    ['environment', { nodeOptions: '--require=/foreign/preload.cjs' }],
] as const) {
    test(
        'foreign harness ' + name + ' cannot match independently supplied observer context',
        async () => {
            const f = fixture(),
                foreign = createHarnessObserver({ ...syntheticRuntime(), ...update });
            assert.throws(() => validateHarnessObserver(foreign, f.observer), /identity mismatch/);
            await closeChild(f);
            const value = JSON.parse(
                f.filesystem.files.get('child-evidence.json')!.bytes.toString(),
            );
            value.observer = foreign;
            f.filesystem.put('child-evidence.json', JSON.stringify(value) + '\n');
            const result = await writeSupervisorEvidence(
                f.job,
                f.binding,
                f.observer,
                f.lifecycle,
                f.io,
                f.source,
            );
            assert.equal(result.status, 'invalid-non-qualifying-supervisor-evidence');
            assert.equal(result.childEvidence, null);
        },
    );
}

test('absent or mismatched observers cannot finish child custody or fall back to input metadata', async () => {
    const f = fixture();
    await f.owner.join();
    await assert.rejects(
        finishProductEvidence(f.owner, f.binding, undefined, f.io, f.source, f.clock),
    );
    assert.equal(f.owner.snapshot().completed, false);
    assert.equal(f.events.connected, true);
    assert.equal(f.filesystem.files.has('child-evidence.json'), false);
    const absentParent = fixture();
    await assert.rejects(
        writeSupervisorEvidence(
            absentParent.job,
            absentParent.binding,
            undefined,
            absentParent.lifecycle,
            absentParent.io,
            absentParent.source,
        ),
    );
    assert.equal(absentParent.filesystem.files.has('supervisor-evidence.json'), false);
    const g = fixture();
    await closeChild(g);
    await writeSupervisorEvidence(g.job, g.binding, g.observer, g.lifecycle, g.io, g.source);
    g.filesystem.events.length = 0;
    await assert.rejects(verifySupervisorEvidence(g.job, g.binding, undefined, g.io, g.source));
    assert.deepEqual(g.filesystem.events, []);
    const child = JSON.parse(g.filesystem.files.get('child-evidence.json')!.bytes.toString());
    delete child.observer;
    g.filesystem.put('child-evidence.json', JSON.stringify(child) + '\n');
    await assert.rejects(verifySupervisorEvidence(g.job, g.binding, g.observer, g.io, g.source));
});

test('virtual child refuses absent/read-failed observers before adapter import', async () => {
    await assert.rejects(verifySoak({ observerFailure: 'missing' }), /supervisor contract object/);
    await assert.rejects(
        verifySoak({ observerFailure: 'read' }),
        /Synthetic observer read failure/,
    );
});

test('virtual child rechecks work deadline after observer reads and initial timeline writes before importing', async () => {
    await assert.rejects(
        verifySoak({ observerDelayMs: 2340000 }),
        /work admission deadline exhausted/,
    );
    await assert.rejects(
        verifySoak({ initialEmitDelayMs: 2340000 }),
        /work admission deadline exhausted/,
    );
});

test('foreign timeline observer is refused even after both retained references are honestly rehashed', async () => {
    const f = fixture();
    await closeChild(f);
    await writeSupervisorEvidence(f.job, f.binding, f.observer, f.lifecycle, f.io, f.source);
    const foreign = createHarnessObserver({ ...syntheticRuntime(), nodeOptions: '--foreign' });
    f.filesystem.put('timeline.jsonl', syntheticTimeline(f.binding, foreign, f.source.reference));
    const timeline = await f.io.hash('timeline.jsonl', timelineLimit);
    const child = JSON.parse(f.filesystem.files.get('child-evidence.json')!.bytes.toString());
    child.timeline = timeline;
    f.filesystem.put('child-evidence.json', JSON.stringify(child) + '\n');
    const parent = JSON.parse(f.filesystem.files.get('supervisor-evidence.json')!.bytes.toString());
    parent.timeline = timeline;
    parent.childEvidence = await f.io.hash('child-evidence.json', 32 * 1024);
    f.filesystem.put('supervisor-evidence.json', JSON.stringify(parent) + '\n');
    await assert.rejects(
        verifySupervisorEvidence(f.job, f.binding, f.observer, f.io, f.source),
        /identity mismatch/,
    );
});

test('observer timeline record must be present second and unique', () => {
    const f = fixture(),
        line = (stage: string, data: unknown) => JSON.stringify({ time: 1, stage, data }) + '\n';
    for (const bytes of [
        line('supervisor-source-binding', f.binding),
        line('supervisor-source-binding', f.binding) + line('other', f.observer),
        syntheticTimeline(f.binding, f.observer, f.source.reference) +
            line('supervisor-harness-observer', f.observer),
    ]) {
        const parser = sourceBindingTimeline(f.binding, f.observer, f.source.reference);
        assert.throws(() => {
            parser.push(Buffer.from(bytes));
            parser.finish();
        });
    }
});

test('streaming timeline context is unique, byte bounded, UTF8 strict and mode/source bound', async () => {
    const f = fixture();
    const line = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
    const valid = Buffer.from(syntheticTimeline(f.binding, f.observer, f.source.reference));
    const parser = sourceBindingTimeline(f.binding, f.observer, f.source.reference);
    for (let index = 0; index < valid.length; index++)
        parser.push(valid.subarray(index, index + 1));
    parser.finish();
    const invalid = [
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
        Buffer.concat([
            valid,
            Buffer.from([0xef, 0xbb, 0xbf]),
            line({ time: 2, stage: 'other', data: null }),
        ]),
        Buffer.concat([valid, valid]),
        Buffer.concat([
            valid,
            line({
                time: 2,
                stage: 'identity',
                data: {
                    lane: f.binding.lane,
                    gcMode: f.binding.gcMode,
                    sourceSHA256: f.binding.sourceSHA256,
                    adapterHash: f.binding.adapterSHA256,
                    viewer: f.binding.viewer,
                    productJob: { ...f.job, nonce: '22222222-2222-2222-2222-222222222222' },
                },
            }),
        ]),
        Buffer.concat([line({ time: 0, stage: 'other', data: null }), valid]),
        line({ time: 1, stage: 'other', data: f.binding }),
        line({
            time: 1,
            stage: 'supervisor-source-binding',
            data: { ...f.binding, sourceSHA256: 'c'.repeat(64) },
        }),
        line({
            time: 1,
            stage: 'supervisor-source-binding',
            data: { ...f.binding, gcMode: 'forced' },
        }),
        Buffer.from('{broken-json\n'),
        valid.subarray(0, valid.length - 1),
        Buffer.concat([valid, Buffer.from([0xff, 10])]),
        Buffer.concat([valid, Buffer.alloc(1024 ** 2 + 1, 120)]),
    ];
    for (const bytes of invalid) {
        const broken = sourceBindingTimeline(f.binding, f.observer, f.source.reference);
        assert.throws(() => {
            broken.push(bytes);
            broken.finish();
        });
    }
    // Even after honestly rehashing a changed timeline, source context semantics still block it.
    await closeChild(f);
    f.filesystem.put(
        'timeline.jsonl',
        line({
            time: 1,
            stage: 'supervisor-source-binding',
            data: { ...f.binding, requestedMode: 'calibration' },
        }).toString(),
    );
    const result = await writeSupervisorEvidence(
        f.job,
        f.binding,
        f.observer,
        f.lifecycle,
        f.io,
        f.source,
    );
    assert.equal(result.status, 'invalid-non-qualifying-supervisor-evidence');
});

test('foreign-run timeline cannot be relabeled by honestly updating both retained file references', async () => {
    const f = fixture();
    await closeChild(f);
    await writeSupervisorEvidence(f.job, f.binding, f.observer, f.lifecycle, f.io, f.source);
    const foreignBinding = { ...f.binding, jobNonce: '22222222-2222-2222-2222-222222222222' };
    f.filesystem.put(
        'timeline.jsonl',
        syntheticTimeline(foreignBinding, f.observer, f.source.reference),
    );
    const timeline = await f.io.hash('timeline.jsonl', timelineLimit);
    const child = JSON.parse(f.filesystem.files.get('child-evidence.json')!.bytes.toString());
    child.timeline = timeline;
    f.filesystem.put('child-evidence.json', JSON.stringify(child) + '\n');
    const parent = JSON.parse(f.filesystem.files.get('supervisor-evidence.json')!.bytes.toString());
    parent.timeline = timeline;
    parent.childEvidence = await f.io.hash('child-evidence.json', 32 * 1024);
    f.filesystem.put('supervisor-evidence.json', JSON.stringify(parent) + '\n');
    await assert.rejects(
        verifySupervisorEvidence(f.job, f.binding, f.observer, f.io, f.source),
        /source binding mismatch: jobNonce/,
    );
});

test('a delayed manifest sync cannot finish the owner after the unchanged total deadline', async () => {
    const f = fixture();
    await f.owner.join();
    f.filesystem.hooks.set('child-evidence.json:sync', () => {
        f.clock.time = f.job.deadlineMs;
    });
    await assert.rejects(
        finishProductEvidence(f.owner, f.binding, f.observer, f.io, f.source, f.clock),
        /existing total deadline/,
    );
    assert.equal(f.owner.snapshot().completed, false);
    assert.equal(f.events.connected, true);
    assert.ok(f.owner.snapshot().invalid);
    assert.ok(!f.filesystem.events.includes('IPC:disconnect'));
});

test('retention observes raw synthetic Git source then reads exact canonical bytes without overwrite', async () => {
    const f = fixture();
    f.filesystem.files.delete('source-bridge.json');
    const context = await retainSupervisorSourceBridge(
        f.io,
        f.sourceInput.expected,
        f.sourceInput.provider,
    );
    assert.deepEqual(context.reference, f.source.reference);
    assert.ok(
        f.sourceInput.calls.state >= 6,
        'Retention and readback must observe independent source.',
    );
    assert.equal(Object.isFrozen(context.expected), true);
    assert.equal(Object.isFrozen(context.reference), true);
    const childContext = await readSupervisorSourceBridge(
        f.io,
        f.sourceInput.expected,
        f.sourceInput.provider,
    );
    assert.deepEqual(childContext.reference, context.reference);
    assert.notEqual(childContext, context);
    await assert.rejects(
        retainSupervisorSourceBridge(f.io, f.sourceInput.expected, f.sourceInput.provider),
        /EEXIST/,
    );
});

for (const mode of [
    'missing',
    'malformed',
    'BOM',
    'changed-canonical',
    'symlink',
    'hardlink',
    'oversize',
]) {
    test(
        'retained source ' +
            mode +
            ' prevents child completion and produces only invalid parent evidence',
        async () => {
            const f = fixture();
            if (mode === 'missing') f.filesystem.files.delete('source-bridge.json');
            if (mode === 'malformed') f.filesystem.put('source-bridge.json', '{broken-json');
            if (mode === 'BOM')
                f.filesystem.put(
                    'source-bridge.json',
                    '\ufeff' + JSON.stringify(f.sourceInput.record) + '\n',
                );
            if (mode === 'changed-canonical')
                f.filesystem.put(
                    'source-bridge.json',
                    JSON.stringify({ ...f.sourceInput.record, qualification: true }) + '\n',
                );
            if (mode === 'symlink') f.filesystem.files.get('source-bridge.json')!.symlink = true;
            if (mode === 'hardlink') f.filesystem.files.get('source-bridge.json')!.nlink = 2;
            if (mode === 'oversize')
                f.filesystem.files.get('source-bridge.json')!.size = SOURCE_LIMITS.metadata + 1;
            await f.owner.join();
            await assert.rejects(
                finishProductEvidence(f.owner, f.binding, f.observer, f.io, f.source, f.clock),
            );
            assert.equal(f.owner.snapshot().completed, false);
            assert.equal(f.events.connected, true);
            assert.equal(f.filesystem.files.has('child-evidence.json'), false);
            const parent = await writeSupervisorEvidence(
                f.job,
                f.binding,
                f.observer,
                f.lifecycle,
                f.io,
                f.source,
            );
            assert.equal(parent.status, 'invalid-non-qualifying-supervisor-evidence');
            assert.equal(parent.sourceBridge, null);
            assert.ok(parent.failures.length > 0);
        },
    );
}

for (const mode of ['commit', 'tree', 'fingerprint', 'reference', 'index', 'worktree', 'object']) {
    test('independent source ' + mode + ' mismatch blocks before custody release', async () => {
        const f = fixture();
        let source = f.source;
        let binding = f.binding;
        if (mode === 'commit')
            source = { ...source, expected: { ...source.expected, sourceCommit: 'e'.repeat(40) } };
        if (mode === 'tree')
            source = { ...source, expected: { ...source.expected, sourceTree: 'e'.repeat(40) } };
        if (mode === 'fingerprint') binding = { ...binding, sourceSHA256: 'e'.repeat(64) };
        if (mode === 'reference')
            source = {
                ...source,
                reference: { ...source.reference, bytes: source.reference.bytes + 1 },
            };
        if (mode === 'index') f.sourceInput.index[0].oid = 'e'.repeat(40);
        if (mode === 'worktree')
            f.sourceInput.files.get('source.txt')!.bytes = Buffer.from('foreign bytes');
        if (mode === 'object')
            f.sourceInput.objects.get(f.source.expected.sourceCommit)!.bytes =
                Buffer.from('foreign commit');
        await f.owner.join();
        await assert.rejects(
            finishProductEvidence(f.owner, binding, f.observer, f.io, source, f.clock),
        );
        assert.equal(f.owner.snapshot().completed, false);
        assert.equal(f.events.connected, true);
        assert.equal(f.filesystem.files.has('child-evidence.json'), false);
    });
}

test('a self-consistent forged inventory with honestly rebound hashes still fails independent source observation', async () => {
    const f = fixture();
    const forged = JSON.parse(JSON.stringify(f.sourceInput.record));
    forged.inventory[0].sha256 = 'f'.repeat(64);
    forged.inventorySHA256 = sourceDigest(JSON.stringify(forged.inventory));
    forged.sourceFingerprint = sourceFingerprintInventory(forged.inventory);
    const bytes = JSON.stringify(forged) + '\n';
    f.filesystem.put('source-bridge.json', bytes);
    const source = {
        ...f.source,
        reference: {
            name: 'source-bridge.json',
            bytes: Buffer.byteLength(bytes),
            sha256: sourceDigest(bytes),
        },
    };
    const binding = {
        ...f.binding,
        sourceSHA256: forged.sourceFingerprint,
        sourceBridgeSHA256: source.reference.sha256,
    };
    await assert.rejects(
        verifyBoundSupervisorSourceBridge(f.io, binding, source),
        /independently observed/,
    );
});

test('readback re-observes source after parent collection and cannot borrow input metadata as independent context', async () => {
    const f = fixture();
    await closeChild(f);
    await writeSupervisorEvidence(f.job, f.binding, f.observer, f.lifecycle, f.io, f.source);
    f.sourceInput.files.get('source.txt')!.bytes = Buffer.from('late dirty source');
    await assert.rejects(
        verifySupervisorEvidence(f.job, f.binding, f.observer, f.io, f.source),
        /Dirty source/,
    );
    f.filesystem.events.length = 0;
    await assert.rejects(
        verifySupervisorEvidence(f.job, f.binding, f.observer, f.io, undefined as any),
        /Independent source context/,
    );
    assert.deepEqual(f.filesystem.events, []);
});

for (const stage of ['open:wx', 'write', 'sync', 'close']) {
    test(
        'source bridge retention ' +
            stage +
            ' failure is preserved without constructing child evidence',
        async () => {
            const f = fixture();
            f.filesystem.files.delete('source-bridge.json');
            const failure = Error('source-retention:' + stage);
            f.filesystem.hooks.set('source-bridge.json:' + stage, () => {
                throw failure;
            });
            await assert.rejects(
                retainSupervisorSourceBridge(f.io, f.source.expected, f.source.provider),
                (error) => error === failure,
            );
            assert.equal(f.filesystem.files.has('child-evidence.json'), false);
        },
    );
}

test('source metadata has a separate bounded four MiB storage path without widening supervisor JSON', async () => {
    const f = fixture();
    f.filesystem.files.delete('source-bridge.json');
    // Storage/parser control only; this is deliberately not a semantically valid bridge.
    await f.io.write('source-bridge.json', { syntheticPadding: 'x'.repeat(40 * 1024) });
    const retained = await f.io.json('source-bridge.json', SOURCE_LIMITS.metadata);
    assert.equal((retained.value as any).syntheticPadding.length, 40 * 1024);
    await assert.rejects(f.io.json('child-evidence.json', SOURCE_LIMITS.metadata));
    await assert.rejects(
        f.io.write('source-bridge.json', { padding: 'x'.repeat(SOURCE_LIMITS.metadata) }),
        /size bound/,
    );
    await assert.rejects(readSupervisorSourceBridge(f.io, f.source.expected, f.source.provider));
});

test('soak wiring preserves timeline-close/finish and observed-outcome/sidecar order without new IPC sends', async () => {
    const source = await readFile('tests/fixtures/memory-resource-soak.ts', 'utf8');
    const main = source.slice(
        source.indexOf('async function main'),
        source.indexOf('async function supervise'),
    );
    assert.ok(
        main.lastIndexOf('syncCloseEvidence([timeline])') <
            main.indexOf('await finishProductEvidence'),
    );
    assert.match(main, /if \(ownershipJoined\)\s+await finishProductEvidence/);
    assert.doesNotMatch(main, /owner\.finish\(/);
    const supervisor = source.slice(
        source.indexOf('async function supervise'),
        source.indexOf('async function runChild'),
    );
    assert.ok(supervisor.indexOf('supervisorArguments') < supervisor.indexOf('spawn('));
    assert.ok(supervisor.indexOf('supervisorDestination') < supervisor.indexOf('fs.mkdtemp'));
    assert.ok(
        supervisor.indexOf('const row = await observed.outcome') <
            supervisor.indexOf('const evidence = await writeSupervisorEvidence'),
    );
    assert.doesNotMatch(source, /process\.send\(|child\.send\(/);
    const consumer = await readFile('scripts/lib/staged-artifact-gate.mjs', 'utf8');
    assert.match(consumer, /Full-product evidence blocked: authoritative final-artifact/);
});
