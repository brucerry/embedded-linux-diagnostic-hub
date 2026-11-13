/** Actual Gateway retirement/idle/shutdown source with closed-memory ports only.
 * No Gateway/SSH2 import, connection, HTTP server, native actor, process or real timer. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../gateway/server.ts', import.meta.url), 'utf8');
assert.equal(
    createHash('sha256').update(source).digest('hex'),
    '059ef8c6f5a29457a1473ab0a304f256188c43b9c2180b33eb12fd28a7f6be21',
);
const tree = ts.createSourceFile(
    'actual-gateway-server.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);
const gateway = tree.statements.filter(
    (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'createGateway',
);
assert.equal(gateway.length, 1);
const statements = gateway[0].body!.statements;
function one(name: string) {
    const found = statements.filter((node) =>
        ts.isFunctionDeclaration(node)
            ? node.name?.text === name
            : ts.isVariableStatement(node) &&
              node.declarationList.declarations.some(
                  (decl) => ts.isIdentifier(decl.name) && decl.name.text === name,
              ),
    );
    assert.equal(found.length, 1, 'One actual source declaration: ' + name);
    return found[0].getText(tree);
}
const unref = statements.filter(
    (node) => ts.isExpressionStatement(node) && node.expression.getText(tree) === 'cleanup.unref()',
);
assert.equal(unref.length, 1);
const declarations =
    ['stopping', 'cleanupTimerOwned', 'retireSession', 'cleanup', 'closing', 'close']
        .map(one)
        .join('\n') +
    '\n' +
    unref[0].getText(tree);
function deferred() {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
}
const turns = async () => {
    for (let i = 0; i < 32; i++) await Promise.resolve();
};
const outcome = (task: Promise<unknown>) =>
    task.then(
        (value) => ({ resolved: true, rejected: false, value }),
        (error: unknown) => ({ resolved: false, rejected: true, error }),
    );
function fixture(options: { autoHttpClose?: boolean } = {}) {
    const sessions = new Map<string, any>(),
        attempts = new Map<string, any>(),
        cancelledAttempts = new Map<string, any>(),
        ownedSessions = new Set<any>(),
        retiringSessions = new Map<any, Promise<void>>(),
        inFlight = new Set<any>(),
        requestTasks = new Set<Promise<unknown>>(),
        httpSocketClosures = new Map<object, Promise<void>>(),
        httpResponseClosures = new Map<object, Promise<void>>(),
        events: string[] = [];
    let now = 1001,
        api: any,
        idle: (() => void) | undefined,
        serverCallback: ((error?: Error) => void) | undefined,
        httpCloseCalls = 0,
        closeConnectionsCalls = 0,
        clearCalls = 0,
        unrefCalls = 0;
    const timer = {
        unref() {
            unrefCalls++;
        },
    };
    const server = {
        listening: true,
        close(callback: (error?: Error) => void) {
            httpCloseCalls++;
            events.push('http-close-issued');
            serverCallback = callback;
            if (options.autoHttpClose)
                queueMicrotask(() => {
                    server.listening = false;
                    callback();
                });
            return server;
        },
        closeAllConnections() {
            closeConnectionsCalls++;
            events.push('http-connections-close-issued');
        },
    };
    const context = vm.createContext(
        {
            sessions,
            attempts,
            cancelledAttempts,
            ownedSessions,
            retiringSessions,
            inFlight,
            requestTasks,
            httpSocketClosures,
            httpResponseClosures,
            server,
            idleMs: 1000,
            Date: { now: () => now },
            setInterval(callback: () => void, ms: number) {
                assert.equal(idle, undefined);
                assert.equal(ms, 30000);
                idle = callback;
                return timer;
            },
            clearInterval(value: unknown) {
                assert.equal(value, timer);
                clearCalls++;
            },
            module: { exports: {} },
            exports: {},
        },
        { codeGeneration: { strings: false, wasm: false } },
    );
    context.exports = context.module.exports;
    const program =
        declarations +
        '\nmodule.exports={retireSession,close,snapshot:()=>({stopping,cleanupTimerOwned})};';
    const compiled = ts.transpileModule(program, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new vm.Script(compiled, { filename: 'actual-gateway-retirement.memory.cjs' }).runInContext(
        context,
    );
    api = context.module.exports;
    function ssh(
        name: string,
        control: {
            disconnectFailure?: { value: unknown };
            join?: ReturnType<typeof deferred>;
            console?: ReturnType<typeof deferred>;
            onDisconnect?: () => void;
            consoleBusy?: boolean;
        } = {},
    ) {
        let disconnects = 0,
            joins = 0,
            consoleCalls = 0;
        const value = {
            consoleBusy: Boolean(control.consoleBusy),
            disconnect() {
                disconnects++;
                events.push(name + ':disconnect');
                control.onDisconnect?.();
                if (control.disconnectFailure) throw control.disconnectFailure.value;
            },
            joinAutomationCleanup() {
                joins++;
                events.push(name + ':join');
                return control.join?.promise ?? Promise.resolve();
            },
            shutdownConsole() {
                consoleCalls++;
                events.push(name + ':console');
                return control.console?.promise ?? Promise.resolve();
            },
        };
        ownedSessions.add(value);
        return { value, counts: () => ({ disconnects, joins, consoleCalls }) };
    }
    return {
        ...api,
        ssh,
        sessions,
        attempts,
        cancelledAttempts,
        ownedSessions,
        retiringSessions,
        inFlight,
        requestTasks,
        httpSocketClosures,
        httpResponseClosures,
        events,
        idle() {
            assert.ok(idle);
            idle();
        },
        setNow(value: number) {
            now = value;
        },
        finishHttp() {
            assert.ok(serverCallback);
            server.listening = false;
            serverCallback();
        },
        counts: () => ({ httpCloseCalls, closeConnectionsCalls, clearCalls, unrefCalls }),
    };
}

test('retirement is registered before disconnect and preserves disconnect-then-join pending/success ownership', async () => {
    const f = fixture(),
        joined = deferred(),
        ssh = f.ssh('owned', { join: joined });
    const task = f.retireSession(ssh.value),
        observed = outcome(task);
    assert.equal(f.retiringSessions.get(ssh.value), task);
    assert.equal(f.retireSession(ssh.value), task);
    assert.equal(ssh.counts().disconnects, 0);
    await turns();
    assert.deepEqual(f.events, ['owned:disconnect', 'owned:join']);
    assert.equal(f.ownedSessions.has(ssh.value), true);
    assert.equal(f.retiringSessions.size, 1);
    joined.resolve();
    assert.equal((await observed).resolved, true);
    await turns();
    assert.equal(f.ownedSessions.has(ssh.value), false);
    assert.equal(f.retiringSessions.size, 0);
    assert.deepEqual(ssh.counts(), { disconnects: 1, joins: 1, consoleCalls: 0 });
});

test('synchronous Error and falsey disconnect failures become exact retained rejections without retry', async () => {
    for (const raw of [Error('authored disconnect failure'), undefined, null, false, 0, '']) {
        const f = fixture(),
            ssh = f.ssh('failed', { disconnectFailure: { value: raw } });
        let task!: Promise<unknown>;
        assert.doesNotThrow(() => {
            task = f.retireSession(ssh.value);
        });
        const result = await outcome(task);
        assert.equal(result.rejected, true);
        if ('error' in result) assert.equal(result.error, raw);
        assert.equal(f.retiringSessions.get(ssh.value), task);
        assert.equal(f.ownedSessions.has(ssh.value), true);
        assert.equal(f.retireSession(ssh.value), task);
        await turns();
        assert.deepEqual(ssh.counts(), { disconnects: 1, joins: 0, consoleCalls: 0 });
    }
});

test('a rejected actual join remains owned with its original falsey reason after disconnect succeeded', async () => {
    for (const raw of [undefined, Error('authored join failure')]) {
        const f = fixture(),
            joined = deferred(),
            ssh = f.ssh('join-failed', { join: joined }),
            task = f.retireSession(ssh.value),
            observed = outcome(task);
        await turns();
        joined.reject(raw);
        const result = await observed;
        assert.equal(result.rejected, true);
        if ('error' in result) assert.equal(result.error, raw);
        assert.equal(f.retiringSessions.get(ssh.value), task);
        assert.equal(f.ownedSessions.has(ssh.value), true);
        assert.equal(f.retireSession(ssh.value), task);
        await turns();
        assert.deepEqual(ssh.counts(), { disconnects: 1, joins: 1, consoleCalls: 0 });
    }
});

test('disconnect reentrancy reuses the already-registered task instead of issuing another disconnect', async () => {
    const f = fixture(),
        joined = deferred();
    let nested: Promise<void> | undefined;
    const ssh = f.ssh('reentrant', {
        join: joined,
        onDisconnect: () => {
            nested = f.retireSession(ssh.value);
        },
    });
    const task = f.retireSession(ssh.value);
    await turns();
    assert.equal(nested, task);
    assert.equal(ssh.counts().disconnects, 1);
    assert.equal(ssh.counts().joins, 1);
    joined.resolve();
    await task;
    await turns();
    assert.equal(f.ownedSessions.size, 0);
    assert.equal(f.retiringSessions.size, 0);
});

test('actual idle callback removes expired admission while retaining failed or pending owners and busy guards', async () => {
    const f = fixture(),
        joined = deferred(),
        failed = f.ssh('failed', { disconnectFailure: { value: undefined } }),
        pending = f.ssh('pending', { join: joined }),
        busy = f.ssh('busy'),
        consoleBusy = f.ssh('console', { consoleBusy: true }),
        recent = f.ssh('recent');
    for (const [id, ssh, touched, active] of [
        ['failed', failed, 0, false],
        ['pending', pending, 0, false],
        ['busy', busy, 0, true],
        ['console', consoleBusy, 0, false],
        ['recent', recent, 1000, false],
    ] as const)
        f.sessions.set(id, { ssh: ssh.value, touched, busy: active });
    f.cancelledAttempts.set('expired', { expires: 1000 });
    f.cancelledAttempts.set('fresh', { expires: 2000 });
    assert.doesNotThrow(() => f.idle());
    assert.equal(f.sessions.has('failed'), false);
    assert.equal(f.sessions.has('pending'), false);
    for (const id of ['busy', 'console', 'recent']) assert.equal(f.sessions.has(id), true);
    assert.equal(f.retiringSessions.size, 2);
    assert.equal(f.ownedSessions.has(failed.value), true);
    assert.equal(f.cancelledAttempts.has('expired'), false);
    assert.equal(f.cancelledAttempts.has('fresh'), true);
    await turns();
    f.idle();
    await turns();
    assert.equal(failed.counts().disconnects, 1);
    assert.equal(pending.counts().disconnects, 1);
    assert.equal(f.ownedSessions.has(pending.value), true);
    joined.resolve();
    await f.retiringSessions.get(pending.value);
    await turns();
    assert.equal(f.ownedSessions.has(pending.value), false);
    assert.equal(f.ownedSessions.has(failed.value), true);
    assert.equal(f.retiringSessions.has(failed.value), true);
});

test('actual close joins healthy siblings and HTTP/request/attempt owners before reporting one disconnect failure', async () => {
    const f = fixture(),
        joined = deferred(),
        attemptDone = deferred(),
        requestDone = deferred(),
        socketDone = deferred(),
        responseDone = deferred(),
        failed = f.ssh('failed', { disconnectFailure: { value: undefined } }),
        healthy = f.ssh('healthy', { join: joined });
    f.sessions.set('failed', { ssh: failed.value });
    f.sessions.set('healthy', { ssh: healthy.value });
    let aborts = 0;
    f.attempts.set('attempt', {
        ssh: healthy.value,
        controller: {
            abort() {
                aborts++;
            },
        },
        done: attemptDone.promise,
    });
    f.requestTasks.add(requestDone.promise);
    void requestDone.promise.then(() => f.requestTasks.delete(requestDone.promise));
    const socket = {},
        response = {};
    f.httpSocketClosures.set(socket, socketDone.promise);
    f.httpResponseClosures.set(response, responseDone.promise);
    const task = f.close(),
        observed = outcome(task);
    let completed = false;
    void observed.then(() => {
        completed = true;
    });
    assert.equal(f.close(), task);
    await turns();
    assert.equal(healthy.counts().joins, 1);
    assert.equal(failed.counts().disconnects, 1);
    assert.equal(completed, false);
    assert.equal(aborts, 1);
    joined.resolve();
    await turns();
    assert.equal(completed, false);
    attemptDone.resolve();
    await turns();
    assert.equal(completed, false);
    requestDone.resolve();
    await turns();
    assert.equal(completed, false);
    f.finishHttp();
    await turns();
    assert.equal(completed, false);
    f.httpSocketClosures.delete(socket);
    socketDone.resolve();
    await turns();
    assert.equal(completed, false);
    f.httpResponseClosures.delete(response);
    responseDone.resolve();
    const result = await observed;
    assert.equal(result.rejected, true);
    if ('error' in result) {
        const error = result.error as AggregateError;
        assert.equal(error.name, 'AggregateError');
        assert.equal(error.errors.length, 1);
        assert.equal(error.errors[0], undefined);
    }
    assert.equal(f.ownedSessions.has(failed.value), true);
    assert.equal(f.retiringSessions.has(failed.value), true);
    assert.equal(f.ownedSessions.has(healthy.value), false);
    assert.equal(f.retiringSessions.has(healthy.value), false);
    assert.deepEqual(f.counts(), {
        httpCloseCalls: 1,
        closeConnectionsCalls: 1,
        clearCalls: 1,
        unrefCalls: 1,
    });
});

test('normal successful close retains existing zero-owner and map-clear behavior', async () => {
    const f = fixture({ autoHttpClose: true }),
        ssh = f.ssh('healthy');
    f.sessions.set('session', { ssh: ssh.value });
    f.cancelledAttempts.set('cancelled', { expires: 2000 });
    await f.close();
    await turns();
    assert.equal(f.sessions.size, 0);
    assert.equal(f.attempts.size, 0);
    assert.equal(f.cancelledAttempts.size, 0);
    assert.equal(f.ownedSessions.size, 0);
    assert.equal(f.retiringSessions.size, 0);
    assert.equal(f.snapshot().stopping, true);
    assert.equal(f.snapshot().cleanupTimerOwned, false);
    assert.deepEqual(ssh.counts(), { disconnects: 1, joins: 1, consoleCalls: 1 });
    assert.deepEqual(f.counts(), {
        httpCloseCalls: 1,
        closeConnectionsCalls: 1,
        clearCalls: 1,
        unrefCalls: 1,
    });
});
