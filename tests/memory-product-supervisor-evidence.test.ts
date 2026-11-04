import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
    finishProductEvidence,
    supervisorEvidenceIO,
    writeSupervisorEvidence,
    supervisorArguments,
    supervisorDestination,
    supervisorOutput,
    timelineLimit,
    type EvidenceFileSystem,
    type SupervisorLifecycle,
} from './fixtures/memory-product-supervisor-evidence';
import {
    ProductRunOwner,
    observeProductOwner,
    productJob,
    type ProductClock,
} from './fixtures/memory-product-owner';
import { syncCloseEvidence } from './fixtures/memory-resource-evidence';

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
    filesystem.put('timeline.jsonl', '{"stage":"synthetic-only"}\n');
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
    return { clock, job, filesystem, io, events, owner, lifecycle };
}
async function closeChild(f: ReturnType<typeof fixture>) {
    await f.owner.join();
    await finishProductEvidence(f.owner, f.io, f.clock);
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
    const row = await writeSupervisorEvidence(f.job, f.lifecycle, f.io);
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
    await assert.rejects(finishProductEvidence(f.owner, f.io, f.clock), /descendants/);
    assert.equal(f.owner.snapshot().completed, false);
    assert.ok(f.owner.snapshot().invalid);
    assert.equal(f.events.connected, true);
    assert.equal(f.events.listenerCount('message'), 1);
    assert.ok(f.clock.timers.size > 0);
});

for (const stage of [
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
            finishProductEvidence(f.owner, f.io, f.clock),
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
        f.io.hash('timeline.jsonl', 100),
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
            const row = await writeSupervisorEvidence(f.job, { ...f.lifecycle, ...update }, f.io);
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
            f.filesystem.put('child-evidence.json', JSON.stringify(value));
        }
        const row = await writeSupervisorEvidence(f.job, f.lifecycle, f.io);
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
    const sidecar = await writeSupervisorEvidence(f.job, lifecycle, f.io);
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
                file.bytes = Buffer.alloc(101);
            });
        if (mode === 'mutation')
            f.filesystem.hooks.set('timeline.jsonl:read', () => {
                file.mtime++;
            });
        await assert.rejects(
            f.io.hash('timeline.jsonl', 100),
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
                writeSupervisorEvidence(f.job, f.lifecycle, f.io),
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
        null,
        f.io,
        Error('synthetic spawn call failure'),
    );
    assert.equal(result.status, 'invalid-non-qualifying-supervisor-evidence');
    assert.equal(result.lifecycle, null);
    assert.equal(result.timeline, null);
    assert.match(result.failures[0], /synthetic spawn call failure/);
});

test('a delayed manifest sync cannot finish the owner after the unchanged total deadline', async () => {
    const f = fixture();
    await f.owner.join();
    f.filesystem.hooks.set('child-evidence.json:sync', () => {
        f.clock.time = f.job.deadlineMs;
    });
    await assert.rejects(finishProductEvidence(f.owner, f.io, f.clock), /existing total deadline/);
    assert.equal(f.owner.snapshot().completed, false);
    assert.equal(f.events.connected, true);
    assert.ok(f.owner.snapshot().invalid);
    assert.ok(!f.filesystem.events.includes('IPC:disconnect'));
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
    assert.match(main, /if \(ownershipJoined\) await finishProductEvidence/);
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
