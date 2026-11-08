import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    createOfflineOwnedLaunch,
    type IndependentOwners,
    type OwnedLaunchDependencies,
} from './fixtures/windows-installer-owned-launch';
import {
    runOfflineLaunchCase,
    type OfflineLaunchIO,
    type OfflineLaunchRequest,
    type InstallationSnapshot,
} from './fixtures/windows-installer-offline';
import { type WindowQueryCapture } from './fixtures/windows-installer-window-query';
import { INSTALLATION_PRODUCT } from '../shared/installation';

// Real EventEmitters, synthetic child/pipe objects only. No transport/process/timer/fs.
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
class Pipe extends EventEmitter {
    readableEnded = false;
    closed = false;
    destroyed = false;
    failRegistration: string | undefined;
    registrationError = Error('synthetic pipe registration failure');
    override on(event: string, fn: (...args: any[]) => void): this {
        if (event === this.failRegistration) throw this.registrationError;
        return super.on(event, fn);
    }
    endOwned() {
        if (!this.readableEnded) {
            this.readableEnded = true;
            this.emit('end');
        }
    }
    closeOwned() {
        if (!this.closed) {
            this.closed = true;
            this.emit('close');
        }
    }
}
class Child extends EventEmitter {
    pid = 234;
    exitCode: number | null = null;
    signalCode: string | null = null;
    stdout = new Pipe();
    stderr = new Pipe();
    spawned = false;
    exited = false;
    closed = false;
    spawnOwned() {
        if (!this.spawned) {
            this.spawned = true;
            this.emit('spawn');
        }
    }
    exitOwned(code = 0, signal: string | null = null) {
        if (!this.exited) {
            this.exited = true;
            this.exitCode = code;
            this.signalCode = signal;
            this.emit('exit', code, signal);
        }
    }
    closeOwned(code = this.exitCode, signal = this.signalCode) {
        if (!this.closed) {
            this.closed = true;
            this.emit('close', code, signal);
        }
    }
}
function observe<T>(promise: Promise<T>) {
    const result: { done: boolean; value?: T; error?: unknown } = { done: false };
    void promise.then(
        (value) => {
            result.value = value;
            result.done = true;
        },
        (error) => {
            result.error = error;
            result.done = true;
        },
    );
    return result;
}
async function turns() {
    for (let i = 0; i < 48; i++) await Promise.resolve();
}
async function until(predicate: () => boolean) {
    for (let i = 0; i < 96; i++) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail('synthetic logical-step bound exceeded');
}
function fixture() {
    const root = path.resolve('/synthetic/owned-launch/install'),
        profile = '/synthetic/owned-launch/profile';
    const config = { mode: 'synthetic-memory' as const, root, profile, version: '0.6.0' };
    const executable = path.join(root, 'Diagnostic Hub.exe'),
        child = new Child();
    const creationTimeMs = 1800000000123,
        ownerId = 'synthetic-owned-launch-1';
    const identity = new Gate<void>(),
        owners = new Gate<IndependentOwners>();
    const native = {
        pid: child.pid,
        executable,
        createdAt: new Date(creationTimeMs).toISOString(),
        handle: 87,
        visible: true,
        minimized: false,
        title: 'Synthetic Hub',
        version: config.version,
    };
    let invokeCount = 0,
        queryCount = 0,
        delegates = 0;
    let nextQuery: WindowQueryCapture | undefined;
    let queryHook: (() => void) | undefined;
    const capture = (): WindowQueryCapture => ({
        requestedPID: native.pid,
        returned: true,
        exitCode: 0,
        signal: null,
        stdoutEOF: true,
        stderrEOF: true,
        failure: 'none',
        stdout: Buffer.from(JSON.stringify({ schemaVersion: 1, state: 'observed', ...native })),
        stderr: new Uint8Array(),
    });
    const proof = (): IndependentOwners => ({
        source: 'independent-synthetic-owner-observer',
        ownerId,
        pid: native.pid,
        creationTimeMs,
        inventoryComplete: true,
        owners: [{ id: 'independently-observed-synthetic-subordinate', closeObserved: true }],
    });
    const deps: OwnedLaunchDependencies = {
        scope: 'synthetic-memory',
        ownerId,
        invoke: (target, options) => {
            assert.equal(++invokeCount, 1);
            assert.equal(target, executable);
            assert.deepEqual(options, {
                cwd: root,
                args: [],
                shell: false,
                detached: false,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return { child, eventHistory: 'fresh-observation-window' };
        },
        query: async (selected) => {
            assert.equal(selected, child);
            assert.ok(++queryCount <= 2);
            if (queryCount === 1) {
                for (const name of ['error', 'close', 'exit', 'spawn'])
                    assert.ok(child.listenerCount(name) >= 1, name);
                for (const pipe of [child.stdout, child.stderr])
                    for (const name of ['error', 'close', 'end', 'data'])
                        assert.ok(pipe.listenerCount(name) >= 1, name);
                await identity.promise;
            } else queryHook?.();
            return nextQuery ?? capture();
        },
        independentOwners: async (selected, owner) => {
            assert.equal(selected, child);
            assert.equal(owner.id, ownerId);
            return owners.promise;
        },
        delegateNormalClose: async (selected, target) => {
            assert.equal(selected, child);
            assert.equal(++delegates, 1);
            assert.deepEqual(target, {
                ownerId,
                pid: native.pid,
                creationTimeMs,
                executable,
                windowHandle: native.handle,
            });
            assert.equal(Object.isFrozen(target), true);
        },
    };
    const adapter = createOfflineOwnedLaunch(config, deps);
    function releaseIdentity() {
        if (!identity.done) identity.resolve();
    }
    function releaseOwners() {
        if (!owners.done) owners.resolve(proof());
    }
    function finishLocal() {
        child.spawnOwned();
        child.exitOwned();
        child.stdout.endOwned();
        child.stdout.closeOwned();
        child.stderr.endOwned();
        child.stderr.closeOwned();
        child.closeOwned();
    }
    async function start() {
        const work = adapter.io.launchInstalled(executable);
        child.spawnOwned();
        releaseIdentity();
        return work;
    }
    function releaseAll() {
        releaseIdentity();
        finishLocal();
        releaseOwners();
    }
    return {
        root,
        profile,
        config,
        executable,
        child,
        native,
        creationTimeMs,
        ownerId,
        identity,
        owners,
        deps,
        adapter,
        start,
        releaseIdentity,
        releaseOwners,
        finishLocal,
        releaseAll,
        capture,
        proof,
        setNextQuery(value: WindowQueryCapture) {
            nextQuery = value;
        },
        onNextQuery(fn: () => void) {
            queryHook = fn;
        },
        counts: () => ({ invokeCount, queryCount, delegates }),
    };
}

test('early post-return error is observed before identity awaits and is retained until genuine independent closure', async () => {
    const f = fixture(),
        original = Error('synthetic early child error');
    const launch = f.adapter.io.launchInstalled(f.executable);
    assert.equal(f.adapter.custody.child, f.child);
    assert.equal(f.adapter.custody.registrationComplete, true);
    f.child.emit('error', original);
    f.child.spawnOwned();
    f.releaseIdentity();
    const owner = await launch,
        closed = observe(owner.closed);
    try {
        f.finishLocal();
        await turns();
        assert.equal(closed.done, false);
        assert.equal(f.adapter.custody.independentAccepted, false);
        f.releaseOwners();
        await until(() => closed.done);
        assert.equal(closed.error, original);
        assert.ok(f.adapter.custody.errors.includes(original));
        assert.equal(f.adapter.custody.closeObserved, true);
    } finally {
        f.releaseAll();
    }
});

test('exit, child close, both pipe end/close and independent owner acknowledgements remain separate barriers', async () => {
    const f = fixture(),
        owner = await f.start(),
        closed = observe(owner.closed);
    const unrelated = () => {};
    f.child.on('data-unrelated', unrelated);
    try {
        const steps = [
            () => f.child.exitOwned(),
            () => f.child.closeOwned(),
            () => f.child.stdout.endOwned(),
            () => f.child.stdout.closeOwned(),
            () => f.child.stderr.endOwned(),
            () => f.child.stderr.closeOwned(),
        ];
        for (const step of steps) {
            step();
            await turns();
            assert.equal(closed.done, false);
        }
        assert.equal(f.adapter.custody.independentAccepted, false);
        f.releaseOwners();
        await until(() => closed.done);
        assert.equal(closed.error, undefined);
        assert.equal(closed.value!.admittedOwnersClosed, true);
        assert.equal(f.child.listenerCount('data-unrelated'), 1);
        for (const name of ['error', 'close', 'exit', 'spawn'])
            assert.equal(f.child.listenerCount(name), 0);
        for (const pipe of [f.child.stdout, f.child.stderr])
            for (const name of ['error', 'close', 'end', 'data'])
                assert.equal(pipe.listenerCount(name), 0);
    } finally {
        f.releaseAll();
        f.child.off('data-unrelated', unrelated);
    }
});

test('synchronous invocation and observer registration failures preserve custody without process-absence or closure proof', async () => {
    const f = fixture(),
        original = Error('synthetic prehandle throw');
    f.deps.invoke = () => {
        assert.equal(f.adapter.custody.invoked, true);
        throw original;
    };
    await assert.rejects(f.adapter.io.launchInstalled(f.executable), (error) => error === original);
    assert.equal(f.adapter.custody.returned, false);
    assert.equal(f.adapter.custody.historyUncertain, true);
    const prehandle = observe(f.adapter.closure);
    await turns();
    assert.equal(prehandle.done, false);
    const g = fixture();
    g.child.stderr.failRegistration = 'end';
    await assert.rejects(
        g.adapter.io.launchInstalled(g.executable),
        /OWNED_LAUNCH_OBSERVATION_UNCERTAIN/,
    );
    assert.equal(g.adapter.custody.child, g.child);
    assert.ok(g.adapter.custody.errors.includes(g.child.stderr.registrationError));
    const pending = observe(g.adapter.closure);
    g.releaseAll();
    await turns();
    assert.equal(pending.done, false);
    assert.equal(g.adapter.custody.settled, false);
});

test('prehandle or already-set child/pipe properties mark history uncertain instead of reconstructing callbacks', async () => {
    for (const variant of ['unknown-source', 'exit', 'pipe-end'] as const) {
        const f = fixture(),
            invoke = f.deps.invoke;
        f.deps.invoke = (...args) => {
            const returned = invoke(...args);
            if (variant === 'unknown-source') returned.eventHistory = 'prehandle-or-unknown';
            if (variant === 'exit') f.child.exitOwned();
            if (variant === 'pipe-end') f.child.stdout.endOwned();
            return returned;
        };
        await assert.rejects(
            f.adapter.io.launchInstalled(f.executable),
            /OWNED_LAUNCH_OBSERVATION_UNCERTAIN/,
        );
        assert.equal(f.adapter.custody.historyUncertain, true);
        if (variant === 'exit') assert.equal(f.adapter.custody.exitObserved, false);
        if (variant === 'pipe-end') assert.equal(f.adapter.custody.stdout.endObserved, false);
        const pending = observe(f.adapter.closure);
        f.releaseAll();
        await turns();
        assert.equal(pending.done, false);
    }
});

test('failed independent inventory cannot be inferred from parent and pipes, and output overflow is explicit failure', async () => {
    const f = fixture(),
        owner = await f.start(),
        closed = observe(owner.closed);
    f.finishLocal();
    f.owners.resolve({ ...f.proof(), inventoryComplete: false });
    await turns();
    assert.equal(closed.done, false);
    assert.equal(f.adapter.custody.independentAccepted, false);
    assert.ok(
        f.adapter.custody.errors.some(
            (error) =>
                error instanceof Error && error.message === 'INDEPENDENT_OWNER_CLOSURE_UNCONFIRMED',
        ),
    );
    const g = fixture(),
        other = await g.start(),
        observed = observe(other.closed);
    g.child.stdout.emit('data', new Uint8Array(4097));
    g.finishLocal();
    g.releaseOwners();
    await until(() => observed.done);
    assert.equal(g.adapter.custody.stdout.bytes, 4097);
    assert.equal(g.adapter.custody.stdout.overflow, true);
    assert.equal(g.adapter.custody.stdout.retained.length, 0);
    assert.ok(
        observed.error instanceof Error && observed.error.message === 'PIPE_CAPTURE_OVER_BOUND',
    );
});

test('fresh missing/inaccessible/replaced identity refuses close and repeated requests join one failed attempt', async () => {
    for (const state of ['missing', 'inaccessible', 'different-creation'] as const) {
        const f = fixture(),
            owner = await f.start();
        const raw = f.capture();
        raw.stdout = Buffer.from(
            JSON.stringify(
                state === 'different-creation'
                    ? {
                          schemaVersion: 1,
                          state: 'observed',
                          ...f.native,
                          createdAt: new Date(1).toISOString(),
                      }
                    : { schemaVersion: 1, state, requestedPID: owner.pid },
            ),
        );
        f.setNextQuery(raw);
        const first = f.adapter.io.requestNormalClose(owner),
            second = f.adapter.io.requestNormalClose(owner);
        assert.equal(first, second);
        await assert.rejects(first, /FRESH_CLOSE_IDENTITY_UNCONFIRMED/);
        assert.equal(f.counts().delegates, 0);
        assert.equal(f.counts().queryCount, 2);
        const closed = observe(owner.closed);
        await turns();
        assert.equal(closed.done, false);
        f.releaseAll();
        await until(() => closed.done);
        assert.ok(closed.error instanceof Error);
    }
});

test('fresh matching identity delegates once under reentry while owned closure remains pending', async () => {
    const f = fixture(),
        owner = await f.start();
    let reentrant: Promise<void> | undefined;
    f.onNextQuery(() => {
        reentrant = f.adapter.io.requestNormalClose(owner);
    });
    const close = f.adapter.io.requestNormalClose(owner);
    await close;
    assert.equal(reentrant, close);
    assert.deepEqual(f.counts(), { invokeCount: 1, queryCount: 2, delegates: 1 });
    const closed = observe(owner.closed);
    await turns();
    assert.equal(closed.done, false);
    f.releaseAll();
    await until(() => closed.done);
    assert.equal(closed.error, undefined);
    await f.adapter.io.requestNormalClose(owner);
    assert.equal(f.counts().delegates, 1);
});

test('original process closing during fresh query prevents delegation to any later window', async () => {
    const f = fixture(),
        owner = await f.start();
    f.onNextQuery(() => {
        f.child.exitOwned();
        f.child.closeOwned();
    });
    await f.adapter.io.requestNormalClose(owner);
    assert.equal(f.counts().delegates, 0);
    const closed = observe(owner.closed);
    await turns();
    assert.equal(closed.done, false);
    f.releaseAll();
    await until(() => closed.done);
    assert.equal(closed.error, undefined);
});

function composition(
    f: ReturnType<typeof fixture>,
): OfflineLaunchIO & { request: OfflineLaunchRequest; files: Map<string, Uint8Array> } {
    const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex'),
        bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
    const id = '00000000-0000-4000-8000-000000000001',
        tx = '00000000-0000-4000-8000-000000000002';
    const payload = bytes({ syntheticPayload: true }),
        manifest = bytes({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            layout: 'windows-nsis',
            platform: 'win32',
            arch: 'x64',
            version: f.config.version,
            sourceCommit: 'a'.repeat(40),
            entryPoint: 'Diagnostic Hub.exe',
            files: [
                { kind: 'file', path: 'Diagnostic Hub.exe', bytes: 10, sha256: '1'.repeat(64) },
            ],
        });
    const request: OfflineLaunchRequest = {
        ...f.config,
        sourceCommit: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        setupSHA256: '2'.repeat(64),
        setupBytes: 10,
        payloadManifestSHA256: hash(payload),
        installEvidenceSHA256: '3'.repeat(64),
    };
    const snapshot: InstallationSnapshot = {
        prerequisite: {
            kind: 'synthetic-memory-installation',
            sha256: request.installEvidenceSHA256,
            setupSHA256: request.setupSHA256,
            setupBytes: 10,
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
        recordBytes: bytes({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            installationId: id,
            manifestSHA256: hash(manifest),
            profile: 'dedicated',
        }),
        manifestBytes: manifest,
        payloadManifestBytes: payload,
        ownerBytes: bytes({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            installationId: id,
            transactionId: tx,
            root: f.root,
        }),
        journalBytes: bytes({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            installationId: id,
            transactionId: tx,
            root: f.root,
            phase: 'candidate-active',
            oldDigest: null,
            candidateDigest: hash(manifest),
            candidateVersion: f.config.version,
            candidateActivatedAt: f.creationTimeMs - 5,
        }),
        dedicatedProfile: f.profile,
        bootAckAbsentBeforeLaunch: true,
    };
    const files = new Map<string, Uint8Array>();
    return {
        ...f.adapter.io,
        request,
        files,
        scope: 'synthetic-memory',
        readInstallation: async () => structuredClone(snapshot),
        observeOffline: async () => ({
            state: 'offline',
            scope: 'machine',
            observationId: 'synthetic-offline',
            method: 'external-condition-readback',
            evidenceSHA256: '4'.repeat(64),
            source: 'synthetic-memory',
        }),
        observeReady: async (owner) => ({
            native: f.native,
            bootAckBytes: bytes({
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                transactionId: tx,
                installationId: id,
                root: f.root,
                manifestSHA256: hash(manifest),
                version: f.config.version,
                profile: f.profile,
                nativeExecutable: f.executable,
                pid: owner.pid,
                processCreationMs: owner.creationTimeMs,
            }),
            ui: { ownerId: owner.id, interactionObserved: true, evidenceSHA256: '5'.repeat(64) },
        }),
        openEvidence: async (name, flags, mode) => {
            assert.equal(flags, 'wx');
            assert.equal(mode, 0o600);
            assert.equal(files.has(name), false);
            files.set(name, new Uint8Array());
            return {
                writeFile: async (b) => {
                    assert.ok(b.length <= 65536);
                    files.set(name, b.slice());
                },
                sync: async () => {},
                close: async () => {},
            };
        },
        readEvidence: async (name) => files.get(name)!.slice(),
    };
}
test('actual offline orchestration composes the adapter and cannot publish before the independent owner barrier', async () => {
    const f = fixture(),
        io = composition(f),
        operation = runOfflineLaunchCase(io.request, io),
        run = observe(operation.completed),
        retired = observe(operation.retirement);
    try {
        await until(() => f.adapter.custody.returned);
        f.child.spawnOwned();
        f.releaseIdentity();
        await until(() => f.adapter.custody.closeDelegated);
        f.finishLocal();
        await turns();
        assert.equal(run.done, false);
        assert.equal(retired.done, false);
        assert.equal(io.files.size, 0);
        assert.equal(f.adapter.io.launchAttempt.snapshot().directClosureObserved, true);
        f.releaseOwners();
        await until(() => run.done);
        assert.equal(run.error, undefined);
        assert.equal(run.value!.status, 'synthetic-complete');
        assert.equal(io.files.size, 2);
        assert.equal(f.adapter.custody.settled, true);
        assert.equal(run.value!.terminal, true);
        assert.equal(run.value!.ownershipState, 'retired');
        assert.equal(retired.value!.basis, 'adapter-attempt');
    } finally {
        f.releaseAll();
    }
});

test('actual orchestration retains a fresh-close refusal and waits for later external closure before blocked evidence', async () => {
    const f = fixture(),
        io = composition(f),
        operation = runOfflineLaunchCase(io.request, io),
        run = observe(operation.completed),
        retired = observe(operation.retirement);
    try {
        await until(() => f.adapter.custody.returned);
        f.child.spawnOwned();
        f.releaseIdentity();
        await until(() => f.adapter.custody.owner !== null);
        const raw = f.capture();
        raw.stdout = Buffer.from(
            JSON.stringify({ schemaVersion: 1, state: 'inaccessible', requestedPID: f.native.pid }),
        );
        f.setNextQuery(raw);
        await until(() => f.adapter.custody.errors.length > 0);
        await turns();
        assert.equal(run.done, false);
        assert.equal(retired.done, false);
        assert.equal(io.files.size, 0);
        assert.equal(f.counts().delegates, 0);
        const original = f.adapter.custody.errors[0];
        f.finishLocal();
        f.releaseOwners();
        await until(() => run.done);
        assert.equal(run.error, undefined);
        assert.equal(run.value!.status, 'blocked');
        assert.ok(run.value!.failures.includes(original));
        assert.equal(run.value!.terminal, true);
        assert.equal(run.value!.ownershipState, 'retired');
        assert.equal(retired.value!.basis, 'adapter-attempt');
    } finally {
        f.releaseAll();
    }
});

// Pre-fix characterization source/results are preserved outside the candidate.
// These are current safety assertions against the actual caller and adapter.
test('completed matching-request missing after original close is no action, while genuine query errors remain errors', async () => {
    for (const variant of [
        'completed-missing',
        'rejected-query',
        'uncertain-query',
        'foreign-request',
        'inaccessible',
    ] as const) {
        const f = fixture(),
            owner = await f.start(),
            closed = observe(owner.closed);
        const original = Error('synthetic fresh query rejected');
        try {
            const capture = f.capture();
            if (variant === 'foreign-request') capture.requestedPID++;
            capture.stdout = Buffer.from(
                JSON.stringify({
                    schemaVersion: 1,
                    state: variant === 'inaccessible' ? 'inaccessible' : 'missing',
                    requestedPID: capture.requestedPID,
                }),
            );
            if (variant === 'uncertain-query') {
                capture.stdoutEOF = false;
                capture.failure = 'pending';
            }
            if (variant === 'rejected-query') {
                f.deps.query = async (selected) => {
                    assert.equal(selected, f.child);
                    f.child.exitOwned();
                    f.child.closeOwned();
                    throw original;
                };
            } else {
                f.setNextQuery(capture);
                f.onNextQuery(() => {
                    f.child.exitOwned();
                    f.child.closeOwned();
                });
            }
            const attempted = observe(f.adapter.io.requestNormalClose(owner));
            await until(() => attempted.done);
            assert.equal(f.adapter.custody.closeObserved, true);
            assert.equal(f.counts().delegates, 0);
            if (variant === 'completed-missing') {
                assert.equal(attempted.error, undefined);
                assert.equal(
                    f.adapter.custody.closeNoActionReason,
                    'original-closed-with-completed-missing',
                );
                assert.equal(f.adapter.custody.errors.length, 0);
            } else {
                assert.ok(attempted.error instanceof Error);
                assert.equal(f.adapter.custody.closeNoActionReason, null);
                if (variant === 'rejected-query') assert.equal(attempted.error, original);
                else assert.equal(attempted.error.message, 'FRESH_CLOSE_IDENTITY_UNCONFIRMED');
                assert.ok(f.adapter.custody.errors.includes(attempted.error));
            }
            await turns();
            assert.equal(closed.done, false);
            // Repeated close requests join the same transaction without another query/delegation.
            assert.equal(observe(f.adapter.io.requestNormalClose(owner)).done, false);
            f.finishLocal();
            await turns();
            assert.equal(closed.done, false);
            const direct = observe(f.adapter.io.launchAttempt.directClosed);
            await until(() => direct.done);
            assert.equal(direct.value!.processCloseObserved, true);
            assert.equal(f.adapter.io.launchAttempt.snapshot().retired, false);
            f.releaseOwners();
            await until(() => closed.done);
            assert.equal(closed.error, attempted.error);
            assert.equal(f.adapter.io.launchAttempt.snapshot().retired, true);
            const retired = observe(f.adapter.io.launchAttempt.retired);
            await until(() => retired.done);
            assert.equal(retired.value!.independentOwnersObserved, true);
        } finally {
            f.releaseAll();
        }
    }
});

test('identity failure exposes retained attempt before await and diagnostic settlement never acknowledges unproved retirement', async () => {
    for (const variant of ['rejected-identity', 'mismatched-identity'] as const) {
        const f = fixture(),
            io = composition(f),
            original = Error('synthetic initial identity rejected');
        let independentCalls = 0;
        const joinOwners = f.deps.independentOwners;
        f.deps.independentOwners = (...args) => {
            independentCalls++;
            return joinOwners(...args);
        };
        f.deps.query = async (selected) => {
            assert.equal(selected, f.child);
            await f.identity.promise;
            if (variant === 'rejected-identity') throw original;
            const raw = f.capture();
            raw.stdout = Buffer.from(
                JSON.stringify({
                    schemaVersion: 1,
                    state: 'observed',
                    ...f.native,
                    executable: path.join(f.root, 'foreign.exe'),
                }),
            );
            return raw;
        };
        const operation = runOfflineLaunchCase(io.request, io);
        const diagnostic = observe(operation.diagnostic),
            completed = observe(operation.completed);
        const retired = observe(operation.retirement),
            direct = observe(f.adapter.io.launchAttempt.directClosed);
        const closure = observe(f.adapter.closure);
        try {
            assert.equal(io.launchAttempt, f.adapter.io.launchAttempt);
            assert.equal(io.launchAttempt!.retainedCustody, f.adapter.custody);
            await until(() => f.adapter.custody.returned);
            assert.equal(completed.done, false);
            assert.equal(diagnostic.done, false);
            f.child.spawnOwned();
            f.releaseIdentity();
            await until(() => diagnostic.done);
            assert.equal(diagnostic.error, undefined);
            const result = diagnostic.value!;
            assert.equal(result.status, 'blocked');
            assert.equal(result.terminal, false);
            assert.equal(result.ownershipState, 'pending');
            assert.equal(result.observation.terminal, false);
            assert.equal(result.observation.nativeQualified, false);
            assert.equal(io.files.size, 2);
            assert.equal(result.custody.owner, null);
            assert.equal(result.custody.launchAttempt, io.launchAttempt);
            assert.equal(result.custody.launchAttempt!.retainedCustody, f.adapter.custody);
            assert.equal(f.adapter.custody.child, f.child);
            assert.equal(f.adapter.custody.owner, null);
            assert.equal(completed.done, false);
            assert.equal(retired.done, false);
            assert.equal(direct.done, false);
            const stages = JSON.parse(Buffer.from(io.files.get('stages.json')!).toString());
            const saved = JSON.parse(Buffer.from(io.files.get('observation.json')!).toString());
            assert.equal(saved.terminal, false);
            assert.equal(saved.ownershipState, 'pending');
            assert.equal(stages.launch, 'invoked-outcome-unconfirmed');
            assert.equal(stages.closure, undefined);
            assert.equal(stages.launchAttempt.handleReturned, true);
            assert.equal(stages.launchAttempt.identityAccepted, false);
            const retained = f.adapter.custody.errors[0];
            assert.ok(result.failures.includes(retained));
            if (variant === 'rejected-identity') assert.equal(retained, original);
            const unrelated = () => {};
            f.child.on('unrelated', unrelated);
            f.finishLocal();
            f.releaseOwners();
            await until(() => direct.done);
            await turns();
            assert.equal(direct.error, undefined);
            assert.equal(direct.value!.processCloseObserved, true);
            assert.equal(f.adapter.custody.directClosureObserved, true);
            assert.equal(f.adapter.custody.listenersDetached, true);
            assert.equal(f.adapter.custody.independentAccepted, false);
            assert.equal(independentCalls, 0);
            assert.equal(f.adapter.custody.independentEvidence, null);
            assert.equal(f.adapter.custody.settled, false);
            assert.equal(retired.done, false);
            assert.equal(completed.done, false);
            assert.equal(closure.done, false);
            assert.equal(f.adapter.io.launchAttempt.snapshot().retired, false);
            assert.ok(result.failures.includes(retained));
            assert.equal(f.adapter.custody.child, f.child);
            for (const name of ['error', 'close', 'exit', 'spawn'])
                assert.equal(f.child.listenerCount(name), 0);
            for (const pipe of [f.child.stdout, f.child.stderr])
                for (const name of ['error', 'close', 'end', 'data'])
                    assert.equal(pipe.listenerCount(name), 0);
            assert.equal(f.child.listenerCount('unrelated'), 1);
            f.child.off('unrelated', unrelated);
            // No independent identity-bound join was available. Local closure is not
            // descendant/owner retirement proof, and no recovery/retry is fabricated.
        } finally {
            f.releaseAll();
        }
    }
});
