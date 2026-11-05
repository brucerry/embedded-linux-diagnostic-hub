import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const WEB_BUILD_BOUNDS = Object.freeze({
    deadlineMs: 10 * 60 * 1000,
    stdoutBytes: 16 * 1024 ** 2,
    stderrBytes: 1024 ** 2,
    chunksPerStream: 4096,
});
const retained = new Set();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function completeEnvironmentDigest(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    const rows = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    assert.ok(
        rows.length <= 256 &&
            rows.every(
                ([k, v]) => k && !/[=\x00]/.test(k) && typeof v === 'string' && !v.includes('\0'),
            ),
    );
    const bytes = Buffer.from(JSON.stringify(rows));
    assert.ok(bytes.length <= 65536);
    return digest(bytes);
}

export function validateWebBuildCustody(value) {
    assert.deepEqual(Object.keys(value).sort(), [
        'bounds',
        'childClose',
        'descendantRetirement',
        'elapsedMs',
        'environmentSHA256',
        'exit',
        'policy',
        'spawn',
        'stderr',
        'stdout',
    ]);
    assert.equal(value.policy, 'owned-direct-child-no-signals-v1');
    assert.deepEqual(value.bounds, WEB_BUILD_BOUNDS);
    assert.ok(
        Number.isFinite(value.elapsedMs) &&
            value.elapsedMs >= 0 &&
            value.elapsedMs <= WEB_BUILD_BOUNDS.deadlineMs,
    );
    assert.equal(value.spawn, true);
    assert.equal(value.exit, true);
    assert.equal(value.childClose, true);
    assert.equal(value.descendantRetirement, 'not-observed');
    assert.match(value.environmentSHA256, /^[a-f0-9]{64}$/);
    for (const name of ['stdout', 'stderr']) {
        assert.deepEqual(Object.keys(value[name]).sort(), ['bytes', 'closed', 'sha256']);
        assert.equal(value[name].closed, true);
        assert.ok(Number.isSafeInteger(value[name].bytes) && value[name].bytes >= 0);
        assert.ok(value[name].bytes <= WEB_BUILD_BOUNDS[name + 'Bytes']);
        assert.match(value[name].sha256, /^[a-f0-9]{64}$/);
    }
    return value;
}

export class WebBuildCustodyFailure extends Error {
    constructor(reason, owner) {
        super('Web build failed or is still held: ' + reason);
        this.owner = owner;
    }
}

/** Catch the propagated main promise too: an uncaught module rejection would terminate the
 * caller despite its retained child handles. Setting a future exit status does not force exit.
 */
export async function runHeldWebProducer(main, ports) {
    try {
        return await main();
    } catch {
        ports.setExitCode(1);
        ports.report('Web producer failed or remains held. No retry or cleanup was attempted.');
        return undefined;
    }
}

/** Explicit dispatch only, through a supplied launcher. No implicit process API or teardown.
 * Failure rejects promptly but keeps the child/listeners/output buffers reachable until known
 * direct closure. No deadline or close observation establishes descendant retirement.
 */
export function startOwnedWebBuild(plan, ports) {
    assert.ok(Array.isArray(plan.command) && plan.command.length > 0);
    assert.ok(
        plan.command.every((part) => typeof part === 'string' && part && !part.includes('\0')),
    );
    assert.ok(typeof plan.cwd === 'string' && plan.cwd.startsWith('/'));
    assert.deepEqual(plan.environment, { NODE_ENV: 'production', WEB_BASE_PATH: './' });
    for (const name of ['launch', 'setTimer', 'clearTimer', 'now'])
        assert.equal(typeof ports[name], 'function');
    const selected = structuredClone(plan);
    const environmentSHA256 = completeEnvironmentDigest(selected.env);
    const started = ports.now();
    assert.ok(Number.isFinite(started) && started >= 0);
    let elapsedMs = 0;
    let child,
        timer,
        failure,
        settled = false,
        spawned = false,
        exited = false,
        closed = false;
    let pid = null,
        exitCode = null,
        exitSignal = null,
        closeCode = null,
        closeSignal = null;
    let resolveResult, rejectResult, resolveClosure;
    const result = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    // Retain a rejection handler even if a caller has not yet awaited the issued operation.
    result.catch(() => {});
    const closure = new Promise((resolve) => {
        resolveClosure = resolve;
    });
    const streams = Object.fromEntries(
        ['stdout', 'stderr'].map((name) => [
            name,
            {
                chunks: [],
                bytes: 0,
                closed: false,
                overflow: false,
            },
        ]),
    );
    const listeners = [];
    const snapshot = () => ({
        failure: failure ?? null,
        childAcquired: child !== undefined,
        pid,
        spawned,
        exited,
        childClosed: closed,
        stdoutClosed: streams.stdout.closed,
        stderrClosed: streams.stderr.closed,
        stdoutBytes: streams.stdout.bytes,
        stderrBytes: streams.stderr.bytes,
        stdoutOverflow: streams.stdout.overflow,
        stderrOverflow: streams.stderr.overflow,
        listeners: listeners.length,
        descendantRetirement: 'not-observed',
    });
    const owner = Object.freeze({
        result,
        snapshot,
        waitForDirectClosure: () => closure,
        retainedOutput: () => ({
            stdout: Buffer.concat(streams.stdout.chunks),
            stderr: Buffer.concat(streams.stderr.chunks),
        }),
    });
    retained.add(owner);
    function fail(reason) {
        failure ??= reason;
        if (!settled) {
            settled = true;
            rejectResult(new WebBuildCustodyFailure(failure, owner));
        }
    }
    function listen(target, event, callback) {
        // Register custody before asking an emitter to attach; uncertain attachment is retained.
        const row = { target, event, callback };
        listeners.push(row);
        assert.equal(target.on(event, callback), target);
    }
    function finish() {
        if (!closed || !streams.stdout.closed || !streams.stderr.closed) return;
        if (!spawned || !exited || pid === null)
            fail('Missing direct process lifecycle observations.');
        if (closeCode !== exitCode || closeSignal !== exitSignal) fail('Exit and close differ.');
        if (exitCode !== 0 || exitSignal !== null) fail('Nonzero or signalled direct exit.');
        try {
            elapsedMs = ports.now() - started;
            assert.ok(
                Number.isFinite(elapsedMs) &&
                    elapsedMs >= 0 &&
                    elapsedMs <= WEB_BUILD_BOUNDS.deadlineMs,
            );
        } catch {
            fail('Elapsed observation budget exceeded or monotonic clock invalid.');
        }
        try {
            if (timer !== undefined) {
                ports.clearTimer(timer);
                timer = undefined;
            }
            while (listeners.length) {
                const row = listeners.at(-1);
                assert.equal(row.target.off(row.event, row.callback), row.target);
                listeners.pop();
            }
        } catch {
            fail('Observer cleanup not acknowledged.');
            return;
        }
        const state = snapshot();
        retained.delete(owner);
        resolveClosure(state);
        if (failure || settled) return;
        const custody = {
            policy: 'owned-direct-child-no-signals-v1',
            bounds: { ...WEB_BUILD_BOUNDS },
            spawn: true,
            exit: true,
            childClose: true,
            elapsedMs,
            descendantRetirement: 'not-observed',
            environmentSHA256,
            stdout: {
                bytes: streams.stdout.bytes,
                closed: true,
                sha256: digest(Buffer.concat(streams.stdout.chunks)),
            },
            stderr: {
                bytes: streams.stderr.bytes,
                closed: true,
                sha256: digest(Buffer.concat(streams.stderr.chunks)),
            },
        };
        validateWebBuildCustody(custody);
        settled = true;
        resolveResult({
            pid,
            exitCode,
            signal: exitSignal,
            error: null,
            command: selected.command,
            environment: selected.environment,
            custody,
        });
    }
    try {
        // A real Node spawn emits lifecycle events asynchronously. An adapter that returns an
        // already-running/closed child or loses events is unsupported and cannot produce success.
        timer = ports.setTimer(
            () => fail('Observation deadline exceeded; custody retained.'),
            WEB_BUILD_BOUNDS.deadlineMs,
        );
        assert.equal(failure, undefined);
        child = ports.launch([...selected.command], {
            cwd: selected.cwd,
            env: { ...selected.env },
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        assert.ok(child && child.stdin === null && child.stdout && child.stderr);
        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        listen(child, 'error', () => fail('Direct child reported an error.'));
        listen(child, 'spawn', () => {
            if (spawned || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
                fail('Missing, duplicate or invalid spawn identity.');
                return;
            }
            spawned = true;
            pid = child.pid;
        });
        listen(child, 'exit', (code, signal) => {
            if (exited || !spawned) fail('Missing or duplicate exit lifecycle.');
            exited = true;
            exitCode = code;
            exitSignal = signal;
            if (code !== 0 || signal !== null) fail('Nonzero or signalled direct exit.');
            finish();
        });
        listen(child, 'close', (code, signal) => {
            if (closed) fail('Duplicate child close.');
            closed = true;
            closeCode = code;
            closeSignal = signal;
            finish();
        });
        for (const name of ['stdout', 'stderr']) {
            const stream = streams[name];
            listen(child[name], 'error', () => fail(name + ' reported an error.'));
            listen(child[name], 'data', (bytes) => {
                if (!Buffer.isBuffer(bytes) || bytes.length === 0 || stream.closed) {
                    fail('Unsupported ' + name + ' data.');
                    return;
                }
                if (stream.overflow) return; // Drain without retaining or hashing unbounded output.
                const remaining = WEB_BUILD_BOUNDS[name + 'Bytes'] - stream.bytes;
                if (
                    bytes.length > remaining ||
                    stream.chunks.length >= WEB_BUILD_BOUNDS.chunksPerStream
                ) {
                    stream.overflow = true;
                    fail(name + ' output bound exceeded; custody retained.');
                    return;
                }
                stream.bytes += bytes.length;
                stream.chunks.push(Buffer.from(bytes));
            });
            listen(child[name], 'close', () => {
                if (stream.closed) fail('Duplicate ' + name + ' close.');
                stream.closed = true;
                finish();
            });
        }
    } catch {
        fail('Dispatch or observer attachment was not acknowledged; custody retained.');
    }
    return owner;
}
