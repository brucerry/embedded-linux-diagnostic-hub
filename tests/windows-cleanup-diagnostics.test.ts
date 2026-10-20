import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { transformSync } from 'esbuild';
import {
    boundedCleanupDiagnostic,
    cleanupDiagnosticLimits,
    cleanupDiagnostics,
    namedCleanupFailure,
    cleanupErrorReason,
} from '../scripts/lib/pilot-cleanup-diagnostics.mjs';
import { OwnedHost } from './fixtures/memory-resource-gateway-process';

function aggregate(
    failures: Record<string, unknown> = {},
    publish?: (stage: string, data: any) => unknown,
) {
    const source = fs.readFileSync('tests/fixtures/memory-product-aggregate-native.ts', 'utf8');
    const extracted = ['teardown', 'teardownOnce']
        .map((name) => {
            const found = source.match(
                new RegExp(`    async function ${name}\\(\\) \\{[\\s\\S]*?\\n    \\}`),
            );
            assert(found);
            return found[0];
        })
        .join('\n');
    const calls: string[] = [],
        facts: any[] = [];
    const op = (name: string) => async () => {
        calls.push(name);
        if (name in failures) throw failures[name];
    };
    const realm = vm.createContext({
        AggregateError,
        cleanupDiagnostics,
        namedCleanupFailure,
        boundedCleanupDiagnostic,
        host: {
            page: { isClosed: () => false, evaluate: op('pageJoin') },
            releaseQualificationHolds: op('releaseHolds'),
            close: op('hostClose'),
            assertExited: op('hostAssert'),
        },
        protocol: { detach: op('detach') },
        gateway: { close: op('gatewayClose'), assertExited: op('gatewayAssert') },
        workers: {
            dispose: () => {
                calls.push('workers');
                if ('workers' in failures) throw failures.workers;
            },
        },
        context: {
            emit(stage: string, data: any) {
                facts.push({ stage, data });
                return publish?.(stage, data);
            },
        },
    });
    vm.runInContext(
        transformSync(
            `let closed=false,teardownTask;${extracted};globalThis.driver={teardown,state:()=>closed};`,
            { loader: 'ts', format: 'cjs', target: 'es2022' },
        ).code,
        realm,
    );
    return {
        driver: realm.driver as { teardown(): Promise<void>; state(): boolean },
        calls,
        facts,
    };
}
const baselineCalls = [
    'releaseHolds',
    'pageJoin',
    'detach',
    'gatewayClose',
    'gatewayAssert',
    'hostClose',
    'hostAssert',
    'workers',
];
test('actual native teardown retains each named disposer cause and still attempts later independent cleanup', async () => {
    const gateway = new AggregateError(
        [Object.assign(Error('release RPC rejected'), { code: 'E_RELEASE' })],
        'gateway nested',
        { cause: Error('target cause') },
    );
    const workers = Error('worker disposal');
    const detach = Error('CDP detach');
    const x = aggregate({ gatewayClose: gateway, workers, detach });
    let failure: any;
    try {
        await x.driver.teardown();
        assert.fail('must fail');
    } catch (error) {
        failure = error;
    }
    assert(failure instanceof AggregateError);
    assert.equal(x.driver.state(), false);
    assert.deepEqual(
        x.calls,
        baselineCalls.filter((x) => x !== 'gatewayAssert'),
    );
    assert.deepEqual(
        failure.errors.map((e: any) => e.disposer),
        ['detach-renderer-protocol', 'gateway-close-and-join', 'dispose-viewer-workers'],
    );
    assert.equal(failure.errors[1].cause, gateway);
    assert.equal(failure.errors[2].cause, workers);
    const text = JSON.stringify(boundedCleanupDiagnostic(failure));
    for (const word of [
        'E_RELEASE',
        'target cause',
        'worker disposal',
        'CDP detach',
        'gateway-close-and-join',
    ])
        assert(text.includes(word), word);
    await assert.rejects(x.driver.teardown(), (error) => error === failure);
    assert.equal(x.calls.filter((s) => s === 'hostClose').length, 1);
});
test('actual teardown baseline still closes only after all diagnostic publications settle', async () => {
    const x = aggregate();
    await x.driver.teardown();
    assert.deepEqual(x.calls, baselineCalls);
    assert.equal(x.driver.state(), true);
});
for (const transport of ['throw', 'reject', 'pending'] as const)
    test(
        'diagnostic ' + transport + ' cannot skip independent disposers or authorize closed state',
        async () => {
            let release!: () => void;
            const pending = new Promise<void>((r) => (release = r));
            const x = aggregate({}, () => {
                if (transport === 'throw') throw Error('sink throw');
                if (transport === 'reject') return Promise.reject(Error('sink reject'));
                return pending;
            });
            let settled = false;
            const result = x.driver.teardown().then(
                () => {
                    settled = true;
                    return undefined;
                },
                (e) => {
                    settled = true;
                    return e;
                },
            );
            for (let i = 0; i < 40; i++) await Promise.resolve();
            assert.deepEqual(x.calls, baselineCalls);
            assert.equal(x.driver.state(), false);
            if (transport === 'pending') {
                assert.equal(settled, false);
                release();
                await result;
                assert.equal(x.driver.state(), true);
            } else {
                const failure = await result;
                assert(failure instanceof AggregateError);
                assert.equal(failure.errors.at(-1).disposer, 'cleanup-diagnostic-publication');
                assert.equal(x.driver.state(), false);
            }
        },
    );
test('serializer bounds cycles, nested aggregates, large UTF8 and throwing getters without invoking user code', () => {
    let invoked = 0;
    const hostile = Object.create(null);
    Object.defineProperty(hostile, 'message', {
        get() {
            invoked++;
            throw Error('getter');
        },
    });
    Object.defineProperty(hostile, 'toJSON', {
        get() {
            invoked++;
            throw Error('toJSON');
        },
    });
    const cyclic: any = new AggregateError([Error('first')], 'root');
    cyclic.cause = cyclic;
    cyclic.errors.push(hostile, ...Array.from({ length: 20 }, () => Error('界'.repeat(10000))));
    const out = boundedCleanupDiagnostic(cyclic),
        bytes = Buffer.byteLength(JSON.stringify(out));
    assert(bytes <= cleanupDiagnosticLimits.bytes);
    assert.equal(invoked, 0);
    assert(JSON.stringify(out).includes('[cycle]'));
    assert(JSON.stringify(out).includes('first'));
    assert.equal(cleanupErrorReason(hostile), '[unavailable accessor or reflection]');
    assert.equal(invoked, 0);
    const reflection = new Proxy(
        {},
        {
            ownKeys() {
                throw Error('reflection');
            },
        },
    );
    assert.doesNotThrow(() => boundedCleanupDiagnostic(reflection));
});
test('fixed diagnostic queue bounds publication even when every write remains pending', async () => {
    let sent = 0;
    const report = cleanupDiagnostics(() => {
        sent++;
        return new Promise(() => {});
    });
    for (let i = 0; i < 100; i++) report.note('cleanup', { i });
    assert.equal(sent, cleanupDiagnosticLimits.rows);
});

type Mode =
    | 'normal'
    | 'release-reject'
    | 'resource-null'
    | 'listeners'
    | 'disconnect-listeners'
    | 'timers'
    | 'first-failure'
    | 'late'
    | 'bad-exit'
    | 'history';
function host(mode: Mode) {
    const child: any = Object.assign(new EventEmitter(), { pid: 42, connected: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code = 0) => {
        child.emit('exit', code, null);
        child.connected = false;
        child.emit('close', code, null);
    };
    child.send = (m: any, callback: (e?: Error) => void) => {
        callback?.();
        queueMicrotask(() => {
            const release = m.action === 'release';
            const value =
                mode === 'resource-null' && release
                    ? { resources: null }
                    : {
                          resources: {
                              ipcMessageListeners: mode === 'listeners' && release ? 1 : 0,
                              ipcDisconnectListeners:
                                  mode === 'disconnect-listeners' && release ? 1 : 0,
                              timers: mode === 'timers' && release ? 1 : 0,
                          },
                      };
            child.emit('message', {
                version: 1,
                nonce: m.nonce,
                pid: 42,
                role: 'ssh-fixture-node',
                id: m.id,
                ok: !(release && mode === 'release-reject'),
                error: release ? 'release rejected' : undefined,
                value,
            });
            if (release) {
                if (mode === 'late') timer = setTimeout(() => finish(), 50);
                else
                    setImmediate(() => {
                        if (mode === 'first-failure')
                            child.emit(
                                'error',
                                Object.assign(Error('asynchronous first failure'), {
                                    code: 'E_FIRST',
                                }),
                            );
                        finish(mode === 'bad-exit' ? 7 : 0);
                    });
            }
        });
        return true;
    };
    child.kill = () => {
        clearTimeout(timer);
        finish();
        return true;
    };
    const owned = new OwnedHost('ssh-fixture-node', 'normal', {
        forkChild: (() => child) as any,
        terminationMs: mode === 'late' ? 5 : 100,
    });
    return {
        owned,
        child,
        dispose() {
            clearTimeout(timer);
            if (!owned.terminalState) finish();
        },
    };
}
for (const [mode, phase] of Object.entries({
    'release-reject': 'release-request',
    'resource-null': 'release-message-listeners',
    listeners: 'release-message-listeners',
    'disconnect-listeners': 'release-disconnect-listeners',
    timers: 'release-timers',
    'first-failure': 'first-failure-verdict',
    late: 'wait-normal-termination',
    'bad-exit': 'normal-exit-verdict',
    history: 'before-release-history',
}) as [Mode, string][])
    test(
        'actual OwnedHost.close identifies ' +
            mode +
            ' before abort and preserves unchanged refusal',
        async () => {
            const h = host(mode);
            try {
                let failure: any;
                try {
                    await h.owned.close(
                        async () => {
                            if (mode === 'history')
                                throw Object.assign(Error('history failure'), {
                                    code: 'E_HISTORY',
                                });
                            return {
                                stage: 'before-release/ssh-fixture-node',
                                processes: [{ pid: 42, created: 'original', state: 'running' }],
                            };
                        },
                        { pid: 42, created: 'original' },
                    );
                    assert.fail('must refuse');
                } catch (error) {
                    failure = error;
                }
                assert.equal(failure.disposer, 'OwnedHost.close');
                assert.equal(failure.cleanup.phase, phase);
                assert.equal(failure.cleanup.role, 'ssh-fixture-node');
                assert.equal(failure.cleanup.pid, 42);
                assert.equal(failure.cleanup.created, 'original');
                assert.equal(failure.cleanup.releaseAuthorized, false);
                assert(failure.cause instanceof Error);
                const before = JSON.stringify(boundedCleanupDiagnostic(failure));
                assert(before.includes(phase));
                await h.owned.abort();
                assert.equal(
                    JSON.stringify(boundedCleanupDiagnostic(failure)),
                    before,
                    'diagnostic is frozen plain data from pre-abort state',
                );
            } finally {
                h.dispose();
            }
        },
    );
test('actual OwnedHost.close normal and delayed exits retain positive identity/release checks', async () => {
    const h = host('normal');
    try {
        const result = await h.owned.close(async () => ({ stage: 'before-release' }), {
            pid: 42,
            created: 'original',
        });
        assert.deepEqual(result.termination, { kind: 'exited', code: 0, signal: null });
    } finally {
        h.dispose();
    }
});
test('held-stage source establishes referenced ownership before hostile error serialization or transport', () => {
    const source = fs.readFileSync('scripts/windows-native-pilot-stage.mts', 'utf8');
    const found = source.match(/const hold = \(e: unknown\) => \{[\s\S]*?\n\};/);
    assert(found);
    const order: string[] = [];
    let state: any,
        aborted = false,
        cancelled = false;
    const realm = vm.createContext({
        hash: 'bound',
        held: undefined,
        terminal: undefined,
        terminalReportStarted: false,
        trace: {
            cancel() {
                assert(order.includes('hold'));
                order.push('timeline-cancel');
            },
            first() {
                assert(order.includes('hold'));
                return { origin: 'controlled' };
            },
            finish() {
                assert(order.includes('hold'));
                return Promise.resolve();
            },
        },
        abortCause(reason: unknown, origin: string) {
            assert(order.includes('hold'));
            assert.equal(origin, 'ownership-hold');
            assert.equal(reason, error);
            aborted = true;
        },
        startup: {
            stopQueryAdmission() {
                order.push('stop');
            },
            snapshot() {
                throw Error('snapshot unavailable');
            },
            cancel() {
                cancelled = true;
            },
        },
        createOwnershipHold(s: any) {
            state = s;
            order.push('hold');
            return { outcome: new Promise(() => {}) };
        },
        boundedCleanupDiagnostic(e: any) {
            assert(order.includes('hold'));
            return boundedCleanupDiagnostic(e);
        },
        cleanupErrorReason,
        diagnostics: {
            note() {
                order.push('persist');
                throw Error('transport failed');
            },
        },
        controller: {
            signal: { aborted: false },
            abort() {
                aborted = true;
            },
        },
    });
    vm.runInContext(
        transformSync(found[0] + '\nglobalThis.holdActual=hold;', {
            loader: 'ts',
            format: 'cjs',
            target: 'es2022',
        }).code,
        realm,
    );
    const error = new AggregateError(
        [namedCleanupFailure('target', Error('specific'))],
        'aggregate',
    );
    realm.holdActual(error);
    assert(order.indexOf('hold') < order.indexOf('persist'));
    assert.equal(aborted, true);
    assert.equal(cancelled, true);
    assert(JSON.stringify(state.error).includes('specific'));
    assert(state.startup.unavailable);
});

test('pending diagnostics cannot postpone the original aggregate cleanup failure and sticky-hold path', async () => {
    const original = Error('target release original');
    const x = aggregate({ gatewayClose: original }, () => new Promise(() => {}));
    const failure = await x.driver.teardown().then(
        () => assert.fail('must fail'),
        (e) => e,
    );
    assert.deepEqual(
        x.calls,
        baselineCalls.filter((s) => s !== 'gatewayAssert'),
    );
    assert.equal(failure.errors[0].cause, original);
    assert.equal(x.driver.state(), false);
});
test('actual OwnedHost failure survives native aggregate and held-stage serialization with its binding and phase', async () => {
    const h = host('release-reject');
    try {
        const cause = await h.owned
            .close(async () => ({ stage: 'before-release/ssh-fixture-node' }), {
                pid: 42,
                created: 'original',
            })
            .then(
                () => assert.fail('must fail'),
                (e) => e,
            );
        const x = aggregate({ gatewayClose: cause });
        const failure = await x.driver.teardown().then(
            () => assert.fail('must fail'),
            (e) => e,
        );
        const out: any = boundedCleanupDiagnostic(failure),
            text = JSON.stringify(out);
        assert(Buffer.byteLength(text) <= 8192);
        for (const word of [
            'gateway-close-and-join',
            'OwnedHost.close',
            'release-request',
            'release rejected',
            'original',
            'ssh-fixture-node',
        ])
            assert(text.includes(word), word);
    } finally {
        h.dispose();
    }
});

test('OwnedHost diagnostics never substitute a foreign PID creation identity', async () => {
    const h = host('release-reject');
    try {
        const failure = await h.owned.close(undefined, { pid: 43, created: 'foreign' }).then(
            () => assert.fail('must fail'),
            (e) => e,
        );
        assert.equal(failure.cleanup.pid, 42);
        assert.equal(failure.cleanup.created, null);
        assert(!JSON.stringify(failure.cleanup).includes('foreign'));
    } finally {
        h.dispose();
    }
});
test('throwing diagnostic transports cannot exceed the fixed publication-row cap', async () => {
    let sent = 0;
    const report = cleanupDiagnostics(() => {
        sent++;
        throw Error('sink');
    });
    for (let i = 0; i < 100; i++) report.note('cleanup', { i });
    assert.equal(sent, 16);
    await assert.rejects(report.drain(), /publication failed/);
});

test('serializer reads only fixed fields and never enumerates arbitrary object keys', () => {
    let reads = 0,
        enumerations = 0;
    const huge = new Proxy(
        { message: 'bounded', code: 'E_FIXED' },
        {
            ownKeys() {
                enumerations++;
                throw Error('must not enumerate');
            },
            getOwnPropertyDescriptor(target, key) {
                reads++;
                return Reflect.getOwnPropertyDescriptor(target, key);
            },
        },
    );
    const out: any = boundedCleanupDiagnostic(huge);
    assert.equal(out.message, 'bounded');
    assert.equal(out.code, 'E_FIXED');
    assert.equal(enumerations, 0);
    assert(reads < 256);
    const hostile = Object.create(null);
    Object.defineProperty(hostile, 'cause', {
        get() {
            throw Error('no getter');
        },
    });
    assert.doesNotThrow(() => boundedCleanupDiagnostic(hostile));
});
