import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { INSTALLATION_PRODUCT } from '../shared/installation';
import {
    refuseNativeOfflineLaunch as offlineLaunchCLI,
    runWindowsOfflineLaunch as runOfflineLaunchCase,
    type InstallationSnapshot,
    type OfflineCondition,
    type OfflineLaunchIO,
    type OfflineLaunchRequest,
    type OwnedClosure,
    type ReadyObservation,
} from './fixtures/windows-installer-offline';

// No OS adapter, real file, timer, worker, registry, UI, network or child process.
// POSIX synthetic fixture paths exercise orchestration on this host, not Windows path qualification.
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const hex = (n: string) => n.repeat(64);
const mutateJSON = (value: Uint8Array, change: Record<string, unknown>) =>
    bytes({ ...JSON.parse(Buffer.from(value).toString()), ...change });
class Gate<T> {
    done = false;
    resolve!: (value: T) => void;
    reject!: (error: unknown) => void;
    promise = new Promise<T>((resolve, reject) => {
        this.resolve = (value) => {
            assert.equal(this.done, false);
            this.done = true;
            resolve(value);
        };
        this.reject = (error) => {
            assert.equal(this.done, false);
            this.done = true;
            reject(error);
        };
    });
}
const turns = async () => {
    for (let i = 0; i < 32; i++) await Promise.resolve();
};
function fixture() {
    const root = path.resolve('/synthetic/windows-offline/install');
    const profile = path.resolve('/synthetic/windows-offline/appdata/profile');
    const creationTimeMs = 1800000000123,
        installationId = '00000000-0000-4000-8000-000000000001';
    const transactionId = '00000000-0000-4000-8000-000000000002';
    const payloadManifestBytes = bytes({ syntheticPayload: true });
    const manifestBytes = bytes({
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        layout: 'windows-nsis',
        platform: 'win32',
        arch: 'x64',
        version: '0.6.0',
        sourceCommit: 'a'.repeat(40),
        entryPoint: 'Diagnostic Hub.exe',
        files: [{ kind: 'file', path: 'Diagnostic Hub.exe', bytes: 10, sha256: hex('3') }],
    });
    const request: OfflineLaunchRequest = {
        mode: 'synthetic-memory',
        root,
        profile,
        version: '0.6.0',
        sourceCommit: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        setupSHA256: hex('1'),
        setupBytes: 10,
        payloadManifestSHA256: sha(payloadManifestBytes),
        installEvidenceSHA256: hex('2'),
    };
    const snapshot: InstallationSnapshot = {
        prerequisite: {
            kind: 'synthetic-memory-installation',
            sha256: request.installEvidenceSHA256,
            setupSHA256: request.setupSHA256,
            setupBytes: request.setupBytes,
            sourceCommit: request.sourceCommit,
            sourceTree: request.sourceTree,
            consentObserved: true,
            launchUnchecked: true,
            wizardFinishObserved: true,
            installerCloseObserved: true,
            installerExitCode: 0,
            installerSignal: null,
            payloadVerified: true,
        },
        manifestBytes,
        payloadManifestBytes,
        recordBytes: bytes({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            installationId,
            manifestSHA256: sha(manifestBytes),
            profile: 'dedicated',
        }),
        ownerBytes: bytes({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            installationId,
            transactionId,
            root,
        }),
        journalBytes: bytes({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            installationId,
            transactionId,
            root,
            phase: 'candidate-active',
            oldDigest: null,
            candidateDigest: sha(manifestBytes),
            candidateVersion: '0.6.0',
            candidateActivatedAt: creationTimeMs - 5,
        }),
        dedicatedProfile: profile,
        bootAckAbsentBeforeLaunch: true,
    };
    const ready: ReadyObservation = {
        native: {
            pid: 234,
            executable: path.join(root, 'Diagnostic Hub.exe'),
            createdAt: new Date(creationTimeMs).toISOString(),
            handle: 87,
            visible: true,
            minimized: false,
            title: 'Synthetic Hub',
            version: '0.6.0',
        },
        bootAckBytes: bytes({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            transactionId,
            installationId,
            root,
            manifestSHA256: sha(manifestBytes),
            version: '0.6.0',
            profile,
            nativeExecutable: path.join(root, 'Diagnostic Hub.exe'),
            pid: 234,
            processCreationMs: creationTimeMs,
        }),
        ui: {
            ownerId: 'owned-memory-process',
            interactionObserved: true,
            evidenceSHA256: hex('4'),
        },
    };
    const offline: OfflineCondition = {
        state: 'offline',
        scope: 'machine',
        observationId: 'synthetic-offline-lease',
        method: 'external-condition-readback',
        evidenceSHA256: hex('5'),
        source: 'synthetic-memory',
    };
    const events: string[] = [],
        files = new Map<string, Uint8Array>();
    const barriers = [new Gate<void>(), new Gate<void>(), new Gate<void>(), new Gate<void>()];
    const closure: OwnedClosure = {
        ownerId: ready.ui.ownerId,
        pid: 234,
        creationTimeMs,
        processCloseObserved: true,
        exitCode: 0,
        signal: null,
        stdoutEOF: true,
        stderrEOF: true,
        admittedOwnersClosed: true,
    };
    const closed = Promise.all(barriers.map((g) => g.promise)).then(() => closure);
    const owner = { id: closure.ownerId, pid: closure.pid, creationTimeMs, closed };
    let reads = 0,
        offlines = 0,
        launches = 0,
        readies = 0,
        closes = 0;
    const io: OfflineLaunchIO = {
        scope: 'synthetic-memory',
        readInstallation: async () => {
            assert.ok(++reads <= 2);
            events.push('read-install');
            return structuredClone(snapshot);
        },
        observeOffline: async () => {
            assert.ok(++offlines <= 2);
            events.push('offline');
            return structuredClone(offline);
        },
        launchInstalled: async (executable) => {
            assert.equal(++launches, 1);
            assert.equal(executable, path.join(root, 'Diagnostic Hub.exe'));
            events.push('launch');
            return owner;
        },
        observeReady: async (selected) => {
            assert.equal(++readies, 1);
            assert.equal(selected, owner);
            events.push('ready');
            return structuredClone(ready);
        },
        requestNormalClose: async (selected) => {
            assert.equal(++closes, 1);
            assert.equal(selected, owner);
            events.push('request-close');
        },
        openEvidence: async (name, flags, mode) => {
            assert.ok(['stages.json', 'observation.json'].includes(name));
            assert.equal(flags, 'wx');
            assert.equal(mode, 0o600);
            assert.equal(files.has(name), false);
            events.push('open:' + name);
            files.set(name, new Uint8Array());
            return {
                writeFile: async (value) => {
                    assert.ok(value.length <= 65536);
                    events.push('write:' + name);
                    files.set(name, value.slice());
                },
                sync: async () => {
                    events.push('sync:' + name);
                },
                close: async () => {
                    events.push('close:' + name);
                },
            };
        },
        readEvidence: async (name) => {
            events.push('readback:' + name);
            return files.get(name)!.slice();
        },
    };
    const release = () => {
        for (const gate of barriers) if (!gate.done) gate.resolve();
    };
    return {
        request,
        snapshot,
        ready,
        offline,
        owner,
        closure,
        barriers,
        io,
        files,
        events,
        release,
        counts: () => ({ reads, offlines, launches, readies, closes }),
    };
}
type Fixture = ReturnType<typeof fixture>;
async function exercise(f: Fixture) {
    const originals = [f.request, f.snapshot, f.ready, f.offline];
    const before = originals.map((v) => structuredClone(v));
    const byteGetters = [
        () => f.snapshot.recordBytes,
        () => f.snapshot.manifestBytes,
        () => f.snapshot.payloadManifestBytes,
        () => f.snapshot.ownerBytes,
        () => f.snapshot.journalBytes,
        () => f.ready.bootAckBytes,
    ];
    const byteOriginals = byteGetters.map((read) => {
        const value = read();
        return {
            read,
            value,
            prototype: Object.getPrototypeOf(value),
            buffer: Buffer.isBuffer(value),
            properties: Object.getOwnPropertyDescriptors(value),
        };
    });
    const descriptors = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map((k) =>
        Object.getOwnPropertyDescriptor(globalThis, k),
    );
    f.release();
    try {
        return await runOfflineLaunchCase(f.request, f.io);
    } finally {
        for (const [i, value] of [f.request, f.snapshot, f.ready, f.offline].entries()) {
            assert.equal(value, originals[i]);
            // Node structuredClone normalizes Buffer to Uint8Array on both sides.
            assert.deepEqual(structuredClone(value), before[i]);
        }
        for (const original of byteOriginals) {
            const value = original.read();
            assert.equal(value, original.value);
            assert.equal(Object.getPrototypeOf(value), original.prototype);
            assert.equal(Buffer.isBuffer(value), original.buffer);
            assert.deepEqual(Object.getOwnPropertyDescriptors(value), original.properties);
        }
        for (const [i, key] of [
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
        ].entries())
            assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), descriptors[i]);
    }
}
function blocked(result: Awaited<ReturnType<typeof runOfflineLaunchCase>>, reason: string) {
    assert.equal(result.status, 'blocked');
    assert.ok(result.reasons.includes(reason), result.reasons.join(','));
    assert.equal(result.observation.nativeQualified, false);
}

test('fixed orchestration emits complete explicitly synthetic evidence only after close and verified publication', async () => {
    const f = fixture(),
        result = await exercise(f);
    assert.equal(result.status, 'synthetic-complete');
    assert.equal(result.failures.length, 0);
    assert.equal(result.observation.kind, 'windows-offline-launch-observation');
    assert.equal(result.observation.nativeQualified, false);
    assert.equal('review' in result.observation, false);
    assert.equal('cases' in result.observation, false);
    assert.equal(result.observation.acceptance, 'not-a-nine-case-installer-receipt');
    assert.deepEqual(f.counts(), { reads: 2, offlines: 2, launches: 1, readies: 1, closes: 1 });
    assert.ok(f.events.indexOf('open:stages.json') > f.events.indexOf('request-close'));
    for (const name of ['stages.json', 'observation.json']) {
        assert.ok(f.events.indexOf('sync:' + name) < f.events.indexOf('close:' + name));
        assert.ok(f.events.indexOf('close:' + name) < f.events.indexOf('readback:' + name));
    }
    assert.equal(result.publication!.sha256, sha(f.files.get('observation.json')!));
    assert.ok(result.custody.handles.every((h) => h.closed));
});

test('missing real-install prerequisite never invokes launch', async () => {
    const f = fixture();
    f.snapshot.prerequisite.kind = 'real-nsis-installation';
    blocked(await exercise(f), 'INSTALL_PREREQUISITE_MISSING');
    assert.equal(f.counts().launches, 0);
});

test('artifact lineage and actual-consent/finish/installer-close facts cannot be replaced by a success label', async () => {
    const changes: Partial<InstallationSnapshot['prerequisite']>[] = [
        { sha256: hex('8') },
        { setupSHA256: hex('8') },
        { setupBytes: 11 },
        { sourceCommit: 'c'.repeat(40) },
        { sourceTree: 'c'.repeat(40) },
        { consentObserved: false },
        { launchUnchecked: false },
        { wizardFinishObserved: false },
        { installerCloseObserved: false },
        { installerExitCode: null },
        { installerSignal: 'SIGTERM' },
        { payloadVerified: false },
    ];
    for (const change of changes) {
        const f = fixture();
        Object.assign(f.snapshot.prerequisite, change);
        const result = await exercise(f);
        assert.equal(result.status, 'blocked');
        assert.equal(f.counts().launches, 0);
    }
});

test('installed manifest, payload, transaction and dedicated profile mismatches stop before launch', async () => {
    const changes: ((f: Fixture) => void)[] = [
        (f) => {
            f.snapshot.manifestBytes = mutateJSON(f.snapshot.manifestBytes, { version: '0.5.0' });
        },
        (f) => {
            f.snapshot.payloadManifestBytes = bytes({ another: 'payload' });
        },
        (f) => {
            f.snapshot.journalBytes = mutateJSON(f.snapshot.journalBytes, {
                transactionId: 'f'.repeat(36),
            });
        },
        (f) => {
            f.snapshot.journalBytes = mutateJSON(f.snapshot.journalBytes, { oldDigest: hex('7') });
        },
        (f) => {
            f.snapshot.ownerBytes = mutateJSON(f.snapshot.ownerBytes, { root: '/foreign' });
        },
        (f) => {
            f.snapshot.dedicatedProfile = '/foreign-profile';
        },
    ];
    for (const change of changes) {
        const f = fixture();
        change(f);
        assert.equal((await exercise(f)).status, 'blocked');
        assert.equal(f.counts().launches, 0);
    }
});

test('stale prelaunch ack and stale or foreign boot acknowledgement cannot prove this launch', async () => {
    const f = fixture();
    f.snapshot.bootAckAbsentBeforeLaunch = false;
    blocked(await exercise(f), 'STALE_PRELAUNCH_ACK');
    assert.equal(f.counts().launches, 0);
    for (const change of [
        { pid: 235 },
        { processCreationMs: 1 },
        { transactionId: 'f'.repeat(36) },
        { profile: '/foreign' },
        { manifestSHA256: hex('7') },
    ]) {
        const g = fixture();
        g.ready.bootAckBytes = mutateJSON(g.ready.bootAckBytes, change);
        blocked(await exercise(g), 'BOOT_ACK_MISMATCH');
        assert.equal(g.counts().closes, 1);
    }
});

test('unverified native window retains custody without messaging a different window', async () => {
    for (const change of [
        { pid: 235 },
        { executable: '/foreign.exe' },
        { createdAt: new Date(1).toISOString() },
        { minimized: true },
        { visible: false },
        { version: '0.5.0' },
    ]) {
        const f = fixture();
        Object.assign(f.ready.native, change);
        const result = await exercise(f);
        blocked(result, 'NATIVE_WINDOW_MISMATCH');
        assert.equal(f.counts().closes, 0);
        assert.equal(result.custody.owner, f.owner);
    }
});

test('UI and whole-machine offline observations are required independently of native visibility', async () => {
    const f = fixture();
    f.ready.ui.interactionObserved = false;
    blocked(await exercise(f), 'UI_UNCONFIRMED');
    for (const change of [{ state: 'unknown' as const }, { scope: 'renderer' as const }]) {
        const g = fixture();
        Object.assign(g.offline, change);
        blocked(await exercise(g), 'OFFLINE_UNCONFIRMED');
        assert.equal(g.counts().launches, 0);
    }
    const g = fixture();
    let n = 0;
    g.io.observeOffline = async () => ({
        ...g.offline,
        observationId: ++n === 1 ? 'before' : 'replacement',
    });
    blocked(await exercise(g), 'OFFLINE_IDENTITY_CHANGED');
    assert.equal(g.counts().closes, 1);
});

test('each owned process/pipe/owner barrier keeps completion and publication pending', async () => {
    for (let held = 0; held < 4; held++) {
        const f = fixture();
        for (let i = 0; i < 4; i++) if (i !== held) f.barriers[i].resolve();
        let settled = false;
        const task = runOfflineLaunchCase(f.request, f.io).then((v) => {
            settled = true;
            return v;
        });
        try {
            await turns();
            assert.equal(f.counts().closes, 1);
            assert.equal(settled, false);
            assert.equal(f.files.size, 0);
        } finally {
            f.release();
        }
        assert.equal((await task).status, 'synthetic-complete');
        assert.equal(f.counts().closes, 1);
    }
});

test('missing close, EOF, owner closure or normal exit cannot become complete evidence', async () => {
    for (const change of [
        { processCloseObserved: false },
        { stdoutEOF: false },
        { stderrEOF: false },
        { admittedOwnersClosed: false },
        { exitCode: null },
        { exitCode: 1 },
        { signal: 'SIGTERM' },
        { pid: 235 },
    ]) {
        const f = fixture();
        Object.assign(f.closure, change);
        blocked(await exercise(f), 'CLOSURE_UNCONFIRMED');
        assert.equal(f.counts().closes, 1);
    }
});

test('closure rejection preserves the original error and owned handle', async () => {
    const f = fixture(),
        original = Error('synthetic-close-failure');
    f.barriers[0].reject(original);
    const result = await exercise(f);
    blocked(result, 'BOUNDARY_FAILURE');
    assert.ok(result.failures.includes(original));
    assert.equal(result.custody.owner, f.owner);
    assert.equal(result.custody.closure, null);
});

test('normal-close request failure is retained and still waits for the owned close', async () => {
    const f = fixture(),
        original = Error('synthetic-request-failure');
    let attempts = 0;
    f.io.requestNormalClose = async () => {
        attempts++;
        throw original;
    };
    let settled = false;
    const task = runOfflineLaunchCase(f.request, f.io).then((v) => {
        settled = true;
        return v;
    });
    try {
        await turns();
        assert.equal(settled, false);
        assert.equal(f.files.size, 0);
    } finally {
        f.release();
    }
    const result = await task;
    assert.equal(result.status, 'blocked');
    assert.ok(result.failures.includes(original));
    assert.equal(attempts, 1);
});

test('post-close installation change blocks completion while the normal new boot ack may exist', async () => {
    const f = fixture();
    let reads = 0;
    f.io.readInstallation = async () => {
        const value = structuredClone(f.snapshot);
        if (++reads === 2) {
            value.bootAckAbsentBeforeLaunch = false;
            value.ownerBytes = mutateJSON(value.ownerBytes, { extra: 'changed' });
        }
        return value;
    };
    blocked(await exercise(f), 'INSTALLATION_CHANGED');
    const g = fixture();
    let normalReads = 0;
    g.io.readInstallation = async () => ({
        ...structuredClone(g.snapshot),
        bootAckAbsentBeforeLaunch: ++normalReads === 1,
    });
    assert.equal((await exercise(g)).status, 'synthetic-complete');
});

test('publication open/write/sync/close/readback failure retains custody and never reports successful completion', async () => {
    for (const phase of ['open', 'writeFile', 'sync', 'close', 'readback'] as const) {
        const f = fixture(),
            original = Error('synthetic-publication-' + phase),
            open = f.io.openEvidence;
        let attempts = 0;
        f.io.openEvidence = async (...args) => {
            attempts++;
            if (phase === 'open') throw original;
            const handle = await open(...args);
            if (phase !== 'readback')
                handle[phase] = async () => {
                    throw original;
                };
            return handle;
        };
        if (phase === 'readback') f.io.readEvidence = async () => bytes({ wrong: 'readback' });
        const result = await exercise(f);
        assert.equal(result.status, 'blocked');
        assert.equal(result.publication, null);
        assert.equal(attempts, 1);
        assert.equal(f.files.has('observation.json'), false);
        if (phase !== 'open' && phase !== 'readback') {
            assert.equal(result.custody.handles[0].closed, false);
            assert.ok(result.failures.includes(original));
        }
    }
});

test('observation publication waits for its own close acknowledgement before readback/completion', async () => {
    const f = fixture(),
        gate = new Gate<void>(),
        open = f.io.openEvidence;
    f.release();
    f.io.openEvidence = async (...args) => {
        const handle = await open(...args);
        if (args[0] === 'observation.json') {
            const close = handle.close;
            handle.close = async () => {
                await gate.promise;
                await close();
            };
        }
        return handle;
    };
    let settled = false;
    const task = runOfflineLaunchCase(f.request, f.io).then((v) => {
        settled = true;
        return v;
    });
    try {
        await turns();
        assert.equal(settled, false);
        assert.equal(f.files.has('observation.json'), true);
        assert.equal(f.events.includes('readback:observation.json'), false);
    } finally {
        gate.resolve();
    }
    assert.equal((await task).status, 'synthetic-complete');
});

test('native CLI and injected caller refuse before IO, even with admission-shaped arguments', async () => {
    assert.throws(
        () =>
            offlineLaunchCLI([
                '--run',
                '--admission',
                '/synthetic/approval.json',
                '--output',
                '/synthetic/output',
            ]),
        /NATIVE_ADAPTER_UNAVAILABLE/,
    );
    assert.throws(
        () => offlineLaunchCLI(['--command', 'arbitrary']),
        /USE_FIXED_RUN_ADMISSION_OUTPUT_INTERFACE/,
    );
    const f = fixture();
    f.request.mode = 'native';
    f.io.scope = 'native';
    await assert.rejects(runOfflineLaunchCase(f.request, f.io), /NATIVE_ADAPTER_UNAVAILABLE/);
    assert.deepEqual(f.counts(), { reads: 0, offlines: 0, launches: 0, readies: 0, closes: 0 });
    assert.equal(f.files.size, 0);
    f.release();
});

test('changed returned owner identity cannot authorize a different normal-close target', async () => {
    const f = fixture(),
        ready = f.io.observeReady;
    f.io.observeReady = async (owner) => {
        const value = await ready(owner);
        f.owner.pid++;
        return value;
    };
    const result = await exercise(f);
    blocked(result, 'OWNER_IDENTITY_CHANGED');
    assert.equal(f.counts().closes, 0);
    assert.equal(result.custody.identity!.pid, 234);
});
