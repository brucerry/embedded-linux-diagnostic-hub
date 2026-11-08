import assert from 'node:assert/strict';

const retained = new Set();
export const GIT_READ_BOUNDS = Object.freeze({
    deadlineMs: 30000,
    stderr: 1024 ** 2,
    chunks: 4096,
    input: 4096,
    stdout: 136 * 1024 ** 2,
});
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
};
const prefix = [
    '--no-replace-objects',
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
];
export function ownedGitRequestKind(args) {
    assert.deepEqual(args.slice(0, prefix.length), prefix);
    const tail = args.slice(prefix.length),
        fixed = [
            ['rev-parse', '--show-toplevel'],
            ['rev-parse', '--show-object-format'],
            ['rev-parse', '--show-prefix'],
            ['rev-parse', '--verify', 'HEAD'],
            ['rev-parse', '--verify', 'HEAD^{tree}'],
            ['ls-files', '--stage', '--sparse', '-z'],
            [
                'config',
                '--includes',
                '--name-only',
                '--get-regexp',
                '^(extensions\\.partialclone|remote\\..*\\.promisor)$',
            ],
        ];
    const batch =
        JSON.stringify(tail) === JSON.stringify(['cat-file', '--batch']) ||
        JSON.stringify(tail) === JSON.stringify(['cat-file', '--batch-check']);
    assert.ok(
        batch || fixed.some((v) => JSON.stringify(v) === JSON.stringify(tail)),
        'Unadmitted Git command.',
    );
    return batch ? 'batch' : 'fixed';
}
export function validateOwnedGitRequest(args, input) {
    const batch = ownedGitRequestKind(args) === 'batch';
    if (batch) assert.ok(typeof input === 'string' && /^(?:[a-f0-9]{40}\n){1,64}$/.test(input));
    else assert.equal(input, undefined);
}
export class GitReadCustodyFailure extends Error {
    constructor(cause, owner) {
        super('Owned Git read failed; uncertain custody retained.', { cause });
        this.owner = owner;
    }
}
/** Direct Git child/pipe observation. No default launcher, timeout signal or process-group claim. */
export function startOwnedGitRead(plan, ports) {
    assert.ok(
        plan.executable?.startsWith('/') &&
            Array.isArray(plan.args) &&
            plan.args.every((v) => typeof v === 'string' && !v.includes('\0')),
    );
    assert.ok(
        plan.cwd?.startsWith('/') &&
            Number.isSafeInteger(plan.maximum) &&
            plan.maximum > 0 &&
            plan.maximum <= GIT_READ_BOUNDS.stdout,
    );
    assert.ok(
        plan.input === undefined ||
            (typeof plan.input === 'string' &&
                Buffer.byteLength(plan.input) <= GIT_READ_BOUNDS.input),
    );
    validateOwnedGitRequest(plan.args, plan.input);
    for (const k of ['launch', 'setTimer', 'clearTimer', 'now'])
        assert.equal(typeof ports[k], 'function');
    const selected = structuredClone(plan),
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
    });
    retained.add(owner);
    const fail = (error) => {
        if (primary && error !== primary && !diagnostics.includes(error) && diagnostics.length < 16)
            diagnostics.push(error);
        primary ??= error;
        result.reject(new GitReadCustodyFailure(primary, owner));
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
        throw Error('Unsupported synchronous Git port return.');
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
                fail(Error('Incomplete Git lifecycle.'));
            if (
                code !== closeCode ||
                signal !== closeSignal ||
                signal !== null ||
                ![0, 1].includes(code)
            )
                fail(Error('Unsuccessful or inconsistent Git close.'));
            if (!primary && !inputFinish) fail(Error('Git input did not finish.'));
            const elapsed = ports.now() - started;
            if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > GIT_READ_BOUNDS.deadlineMs)
                fail(Error('Git elapsed observation budget exceeded.'));
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
                stdout: Buffer.concat(outputs.stdout.chunks),
                stderr: Buffer.concat(outputs.stderr.chunks),
                code,
                pid,
                directRetirement: true,
                processGroupRetirement: null,
            });
        } catch (e) {
            fail(e);
        }
    }
    try {
        timer = ports.setTimer(
            () => fail(Error('Git observation deadline; custody retained.')),
            GIT_READ_BOUNDS.deadlineMs,
        );
        if (timer === undefined || typeof timer?.then === 'function') unexpected(timer);
        assert.ok(!primary);
        child = ports.launch(selected.executable, selected.args, {
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
                fail(Error('Invalid Git spawn.'));
                return;
            }
            spawned = true;
            pid = child.pid;
        });
        on(child, 'exit', (c, s) => {
            if (exited || !spawned) fail(Error('Invalid Git exit.'));
            exited = true;
            code = c;
            signal = s;
            finish();
        });
        on(child, 'close', (c, s) => {
            if (closed) fail(Error('Duplicate Git close.'));
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
                    fail(Error('Invalid Git output.'));
                    return;
                }
                if (stream.overflow) return;
                const maximum = name === 'stdout' ? selected.maximum : GIT_READ_BOUNDS.stderr;
                if (
                    stream.bytes + bytes.length > maximum ||
                    stream.chunks.length >= GIT_READ_BOUNDS.chunks
                ) {
                    stream.overflow = true;
                    fail(Error('Git output bound exceeded.'));
                    return;
                }
                stream.bytes += bytes.length;
                stream.chunks.push(Buffer.from(bytes));
            });
            on(child[name], 'close', () => {
                if (stream.closed) fail(Error('Duplicate Git pipe close.'));
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
                        fail(Error('Duplicate Git input callback.'));
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
