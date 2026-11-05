import assert from 'node:assert/strict';

const retained = new Set();
export const GATEWAY_COMMAND_BOUNDS = Object.freeze({
    ownership: Object.freeze({ deadlineMs: 60000, stdout: 32768, stderr: 65536, chunks: 1024 }),
    build: Object.freeze({ deadlineMs: 480000, stdout: 16777216, stderr: 1048576, chunks: 4096 }),
    install: Object.freeze({ deadlineMs: 180000, stdout: 16777216, stderr: 1048576, chunks: 4096 }),
    lock: Object.freeze({ deadlineMs: 120000, stdout: 16777216, stderr: 1048576, chunks: 4096 }),
});
export class DiagnosticGatewayCustodyFailure extends Error {
    constructor(cause, owner) {
        super('Diagnostic Gateway command failed; uncertain custody retained.', { cause });
        this.owner = owner;
    }
}
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
};
/** Explicit fake/native ports only. Direct spawn/exit/child+pipe close observations, never whole-group
 * retirement. No signal, deletion, retry, forced exit or implicit native launcher is available.
 * Exact command/environment selection is enforced by the diagnostic execution capability.
 */
export function startDiagnosticGatewayCommand(plan, environment, ports) {
    ports = Object.freeze({ ...ports });
    assert.ok(['build', 'lock', 'install', 'ownership'].includes(plan.role));
    assert.ok(Array.isArray(plan.command) && plan.command.length > 1);
    assert.ok(plan.command.every((s) => typeof s === 'string' && s && !s.includes('\0')));
    assert.ok(plan.cwd?.startsWith('/'));
    assert.match(plan.owner, /^[a-f0-9]{32}$/);
    assert.ok(Number.isSafeInteger(plan.id) && plan.id > 0);
    const bounds = GATEWAY_COMMAND_BOUNDS[plan.role];
    for (const k of ['launch', 'setTimer', 'clearTimer', 'now'])
        assert.equal(typeof ports[k], 'function');
    const selected = { ...structuredClone(plan), env: structuredClone(environment) },
        result = deferred(),
        closure = deferred(),
        listeners = [],
        unknownReturns = new Set(),
        diagnostics = [];
    const started = ports.now();
    assert.ok(Number.isFinite(started));
    let child,
        timer,
        primary,
        unknown = 0,
        spawned = false,
        exited = false,
        closed = false,
        code,
        signal,
        closeCode,
        closeSignal,
        pid,
        inputAck = selected.input === undefined,
        inputFinish = inputAck,
        inputClosed = inputAck,
        retired = false;
    const outputs = {
        stdout: { chunks: [], bytes: 0, closed: false, overflow: false },
        stderr: { chunks: [], bytes: 0, closed: false, overflow: false },
    };
    const snapshot = () =>
        Object.freeze({
            spawned,
            exited,
            closed,
            pid: pid ?? null,
            inputAck,
            inputFinish,
            inputClosed,
            stdoutClosed: outputs.stdout.closed,
            stderrClosed: outputs.stderr.closed,
            listeners: listeners.length,
            unknownOperations: unknown,
            primaryFailure: Boolean(primary),
            diagnostics: diagnostics.length,
            directRetired: retired,
            processGroupRetirement: null,
        });
    const owner = Object.freeze({
        result: result.promise,
        closed: closure.promise,
        snapshot,
        diagnostics: () => [...diagnostics],
        output: () => ({ stdout: Buffer.concat(outputs.stdout.chunks), stderr: Buffer.concat(outputs.stderr.chunks) }),
    });
    retained.add(owner);
    const fail = (error) => {
        if (primary && error !== primary && !diagnostics.includes(error) && diagnostics.length < 16)
            diagnostics.push(error);
        primary ??= error;
        result.reject(new DiagnosticGatewayCustodyFailure(primary, owner));
    };
    function unexpected(value) {
        unknown++;
        unknownReturns.add(value);
        try {
            if (typeof value?.then === 'function') {
                const p = value.then(() => {}, fail);
                if (p instanceof Promise) p.catch(fail);
            }
        } catch (e) {
            fail(e);
        }
        throw Error('Unsupported synchronous Gateway port return.');
    }
    function sync(actual, wanted) {
        if (actual !== wanted) unexpected(actual);
    }
    function on(target, event, callback) {
        listeners.push({ target, event, callback });
        sync(target.on(event, callback), target);
    }
    function finish() {
        if (
            retired ||
            !closed ||
            !outputs.stdout.closed ||
            !outputs.stderr.closed ||
            !inputClosed ||
            !inputAck
        )
            return;
        try {
            if (!spawned || !exited || !Number.isSafeInteger(pid) || pid <= 0)
                fail(Error('Incomplete Gateway lifecycle.'));
            if (
                code !== closeCode ||
                signal !== closeSignal ||
                signal !== null ||
                code !== 0
            )
                fail(Error('Unsuccessful or inconsistent Gateway close.'));
            if (!primary && !inputFinish) fail(Error('Gateway input did not finish.'));
            const elapsed = ports.now() - started;
            if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > bounds.deadlineMs)
                fail(Error('Gateway elapsed observation budget exceeded.'));
            assert.equal(unknown, 0);
            sync(ports.clearTimer(timer), undefined);
            timer = undefined;
            while (listeners.length) {
                const r = listeners.at(-1);
                sync(r.target.off(r.event, r.callback), r.target);
                listeners.pop();
            }
            retired = true;
            retained.delete(owner);
            closure.resolve(snapshot());
            if (primary) return;
            result.resolve({
                owner: selected.owner, id: selected.id, role: selected.role,
                cwd: selected.cwd, command: [...selected.command],
                lifecycle: { pid, spawnObserved: spawned, exitObserved: exited, closeObserved: closed,
                    code, signal, closeCode, closeSignal, error: null, timedOut: false,
                    terminationRequested: false, killErrors: [], elapsedMs: elapsed },
            });
        } catch (e) {
            fail(e);
        }
    }
    try {
        timer = ports.setTimer(
            () => fail(Error('Gateway observation deadline; custody retained.')),
            bounds.deadlineMs,
        );
        if (timer === undefined || typeof timer?.then === 'function') unexpected(timer);
        assert.ok(!primary);
        child = ports.launch(selected.command[0], selected.command.slice(1), {
            cwd: selected.cwd,
            env: selected.env,
            shell: false,
            stdio: [selected.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
        if (!child || typeof child.on !== 'function') {
            unexpected(child);
        }
        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        on(child, 'error', fail);
        on(child, 'spawn', () => {
            if (spawned || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
                fail(Error('Invalid Gateway spawn.'));
                return;
            }
            spawned = true;
            pid = child.pid;
            if (selected.role === 'ownership') {
                try { assert.equal(child.spawnfile,selected.command[0]); assert.deepEqual(child.spawnargs,selected.command); }
                catch(error) { fail(error); }
            }
        });
        on(child, 'exit', (c, s) => {
            if (exited || !spawned) fail(Error('Invalid Gateway exit.'));
            exited = true;
            code = c;
            signal = s;
            finish();
        });
        on(child, 'close', (c, s) => {
            if (closed) fail(Error('Duplicate Gateway close.'));
            closed = true;
            closeCode = c;
            closeSignal = s;
            finish();
        });
        for (const name of ['stdout', 'stderr']) {
            const stream = outputs[name];
            assert.ok(child[name]);
            on(child[name], 'error', fail);
            on(child[name], 'data', (bytes) => {
                if (retired) return;
                if (!Buffer.isBuffer(bytes) || !bytes.length || stream.closed) {
                    fail(Error('Invalid Gateway output.'));
                    return;
                }
                if (stream.overflow) return;
                const maximum = name === 'stdout' ? bounds.stdout : bounds.stderr;
                if (
                    stream.bytes + bytes.length > maximum ||
                    stream.chunks.length >= bounds.chunks
                ) {
                    stream.overflow = true;
                    fail(Error('Gateway output bound exceeded.'));
                    return;
                }
                stream.bytes += bytes.length;
                stream.chunks.push(Buffer.from(bytes));
            });
            on(child[name], 'close', () => {
                if (stream.closed) fail(Error('Duplicate Gateway pipe close.'));
                stream.closed = true;
                finish();
            });
        }
        if (selected.input === undefined) assert.equal(child.stdin, null);
        else {
            assert.ok(child.stdin);
            on(child.stdin, 'error', fail);
            on(child.stdin, 'finish', () => {
                inputFinish = true;
                finish();
            });
            on(child.stdin, 'close', () => {
                inputClosed = true;
                finish();
            });
            sync(
                child.stdin.end(Buffer.from(selected.input), (error) => {
                    if (inputAck) {
                        fail(Error('Duplicate Gateway input callback.'));
                        return;
                    }
                    inputAck = true;
                    if (error) fail(error);
                    finish();
                }),
                child.stdin,
            );
        }
    } catch (e) {
        fail(e);
    }
    return owner;
}
