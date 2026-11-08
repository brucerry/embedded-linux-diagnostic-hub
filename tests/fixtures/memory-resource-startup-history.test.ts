import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess, fork } from 'node:child_process';
import { isolatedGateway, OwnedHost } from './memory-resource-gateway-process';
import { ProcessSampler, type ProcessRow } from './memory-resource-processes';

/** Actual manager + ProcessSampler; only child events and OS table input are synthetic. */
async function scenario(config: {
    ordinal: number;
    survive?: boolean;
    mode?:
        | 'init-failure'
        | 'delayed-pid'
        | 'spawn-no-pid'
        | 'pid-no-spawn'
        | 'pid-change'
        | 'read-denied'
        | 'missing-created'
        | 'premature-exit'
        | 'fork-throw'
        | 'shutdown-helper';
}) {
    const mode = config.mode ?? 'init-failure';
    let rows: ProcessRow[] = [],
        ordinal = 0,
        denied = false;
    const factories: { pid: number; beforeInit: boolean }[] = [],
        reads: { roots: number[]; rows: ProcessRow[] }[] = [];
    const initialized = new Set<number>(),
        exitChecks: number[] = [],
        kills: number[] = [];
    const events: { stage: string; data: unknown }[] = [];
    const forkChild = ((_module, args) => {
        const current = ++ordinal,
            pid = 40 + current,
            role = (args as readonly string[])[0].slice(7);
        const selected = current === config.ordinal;
        if (selected && mode === 'fork-throw') throw Error('partial fork failure');
        const delayed = selected && ['delayed-pid', 'spawn-no-pid', 'pid-no-spawn'].includes(mode);
        const child = Object.assign(new EventEmitter(), {
            pid: delayed ? undefined : pid,
        }) as ChildProcess;
        const addRoot = () =>
            rows.push({
                pid,
                parent: 1,
                created: selected && mode === 'missing-created' ? '' : 'root-' + current,
                rssBytes: 1,
            });
        if (!delayed) addRoot();
        else
            queueMicrotask(() => {
                if (mode !== 'spawn-no-pid') {
                    Object.assign(child, { pid });
                    addRoot();
                }
                if (mode !== 'pid-no-spawn') child.emit('spawn');
            });
        const helper = () => {
            if (!rows.some((row) => row.pid === pid + 100))
                rows.push({
                    pid: pid + 100,
                    parent: pid,
                    created: 'helper-' + current,
                    rssBytes: 1,
                });
        };
        const finish = (code: number | null, signal: string | null) => {
            rows = rows
                .filter((row) => row.pid !== pid && (config.survive || row.parent !== pid))
                .map((row) => (row.parent === pid ? { ...row, parent: 1 } : row));
            child.emit('exit', code, signal);
            child.emit('close', code, signal);
        };
        child.send = ((message: { nonce: string; id: number; action: string }) => {
            queueMicrotask(() => {
                let ok = true;
                if (message.action === 'init') {
                    initialized.add(pid);
                    if (
                        selected &&
                        ['init-failure', 'delayed-pid', 'pid-change', 'premature-exit'].includes(
                            mode,
                        )
                    ) {
                        helper();
                        ok = false;
                    }
                    if (selected && mode === 'pid-change') Object.assign(child, { pid: 999 });
                    if (selected && mode === 'premature-exit') {
                        finish(1, null);
                        return;
                    }
                }
                if (selected && mode === 'shutdown-helper' && message.action === 'shutdown')
                    helper();
                child.emit('message', {
                    version: 1,
                    nonce: message.nonce,
                    id: message.id,
                    pid,
                    role,
                    ok,
                    ...(ok
                        ? {
                              value:
                                  message.action === 'init'
                                      ? { runtime: {}, descriptor: {} }
                                      : {
                                            resources: {
                                                ipcMessageListeners: 0,
                                                ipcDisconnectListeners: 0,
                                                timers: 0,
                                            },
                                        },
                          }
                        : { error: 'mock initialization failure ' + current }),
                });
                if (message.action === 'release') setImmediate(() => finish(0, null));
            });
            return true;
        }) as ChildProcess['send'];
        child.kill = () => {
            kills.push(pid);
            queueMicrotask(() => finish(null, 'SIGTERM'));
            return true;
        };
        return child;
    }) as typeof fork;
    let caught: unknown;
    let gateway: Awaited<ReturnType<typeof isolatedGateway>> | undefined;
    let failedCloseReturnedZeroOwners = false;
    try {
        gateway = await isolatedGateway(
            'http://127.0.0.1:5173',
            'normal',
            async (stage, data) => {
                events.push({ stage, data });
            },
            {
                forkChild,
                terminationMs: 20,
                makeSampler: (roots) => {
                    factories.push({ pid: roots[0], beforeInit: !initialized.has(roots[0]) });
                    const sampler = new ProcessSampler(roots, async () => {
                        reads.push({ roots: [...roots], rows: rows.map((row) => ({ ...row })) });
                        if (mode === 'read-denied' && roots[0] === 40 + config.ordinal && !denied) {
                            denied = true;
                            throw Object.assign(Error('mock EACCES'), { code: 'EACCES' });
                        }
                        return rows.map((row) => ({ ...row }));
                    });
                    return {
                        sample: () => sampler.sample(),
                        assertExited: () => {
                            exitChecks.push(roots[0]);
                            return sampler.assertExited();
                        },
                    };
                },
            },
        );
        await gateway.close();
        await gateway.assertExited();
    } catch (error) {
        caught = error;
    }
    if (caught && gateway) {
        try {
            const owners = await gateway.snapshotOwners();
            failedCloseReturnedZeroOwners = Object.values(owners).every((value) => value === 0);
        } catch {
            /* Failed teardown remains unavailable, never a zero-owner result. */
        }
    }
    return {
        caught,
        rows,
        factories,
        reads,
        exitChecks,
        kills,
        events,
        failedCloseReturnedZeroOwners,
    };
}

test('both PID-backed init failures establish history before init and refresh newly spawned helpers before kill', async () => {
    for (const ordinal of [1, 2])
        for (const survive of [false, true]) {
            const result = await scenario({ ordinal, survive });
            assert.ok(result.caught);
            assert.match(String(result.caught), /mock initialization failure/);
            assert.equal(result.caught instanceof AggregateError, survive);
            assert.ok(result.factories.every((factory) => factory.beforeInit));
            assert.deepEqual(
                result.factories.map((factory) => factory.pid),
                ordinal === 1 ? [41] : [41, 42],
            );
            assert.ok(result.exitChecks.includes(40 + ordinal));
            assert.ok(
                result.events.some(
                    (event) =>
                        event.stage === 'gateway-process-history' &&
                        (event.data as { stage: string; processes: { pid: number }[] }).stage ===
                            'before-abort' &&
                        (event.data as { processes: { pid: number }[] }).processes.some(
                            (row) => row.pid === 140 + ordinal,
                        ),
                ),
            );
            if (survive) {
                assert.match(String(result.caught), /cleanup is unverified/);
                assert.equal(result.rows[0].pid, 140 + ordinal);
            } else assert.equal(result.rows.length, 0);
        }
});

test('delayed PID assignment is observed before init for either host', async () => {
    for (const ordinal of [1, 2]) {
        const result = await scenario({ ordinal, survive: true, mode: 'delayed-pid' });
        assert.ok(result.caught instanceof AggregateError);
        assert.match(String(result.caught), /cleanup is unverified/);
        assert.ok(result.factories.every((factory) => factory.beforeInit));
        assert.ok(result.exitChecks.includes(40 + ordinal));
        assert.equal(result.rows[0].pid, 140 + ordinal);
    }
});

test('missing spawn identity, late identity without spawn, and changed PID never become verified cleanup', async () => {
    for (const ordinal of [1, 2])
        for (const mode of ['spawn-no-pid', 'pid-no-spawn', 'pid-change'] as const) {
            const result = await scenario({ ordinal, mode, survive: true });
            assert.ok(result.caught instanceof AggregateError, `${ordinal}/${mode}`);
            assert.match(String(result.caught), /cleanup is unverified/);
            assert.ok(!result.kills.includes(999));
            assert.ok(!result.factories.some((factory) => factory.pid === 999));
        }
});

test('startup read failure, missing creation identity and premature root exit retain incomplete-history failure', async () => {
    for (const ordinal of [1, 2])
        for (const mode of ['read-denied', 'missing-created', 'premature-exit'] as const) {
            const result = await scenario({ ordinal, mode, survive: mode === 'premature-exit' });
            assert.ok(result.caught instanceof AggregateError, `${ordinal}/${mode}`);
            assert.match(String(result.caught), /cleanup is unverified/);
            assert.ok(
                result.exitChecks.includes(40 + ordinal),
                'Available sampler must still run its exit assertion.',
            );
        }
});

test('synchronous fork partial-start uncertainty is retained in either position', async () => {
    for (const ordinal of [1, 2]) {
        const result = await scenario({ ordinal, mode: 'fork-throw' });
        assert.ok(result.caught instanceof AggregateError);
        assert.match(String(result.caught), /partial fork failure/);
        assert.match(String(result.caught), /partial-start history is unverified/);
    }
});

test('normal teardown observes helpers created during shutdown before releasing either root', async () => {
    for (const ordinal of [1, 2])
        for (const survive of [false, true]) {
            const result = await scenario({ ordinal, mode: 'shutdown-helper', survive });
            if (survive) {
                assert.ok(result.caught instanceof AggregateError);
                assert.match(String(result.caught), /cleanup is unverified/);
                assert.equal(
                    result.failedCloseReturnedZeroOwners,
                    false,
                    'Failed final history assertion must not publish closed zero owners.',
                );
            } else assert.equal(result.caught, undefined);
            assert.ok(
                result.events.some(
                    (event) =>
                        event.stage === 'gateway-process-history' &&
                        (
                            event.data as { stage: string; processes: { pid: number }[] }
                        ).stage.startsWith('before-release/') &&
                        (event.data as { processes: { pid: number }[] }).processes.some(
                            (row) => row.pid === 140 + ordinal,
                        ),
                ),
            );
        }
});

test('unsolicited replies record failure without bypassing manager history through an immediate kill', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 42 }) as ChildProcess;
    let kills = 0;
    child.kill = () => {
        kills++;
        queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
        return true;
    };
    child.send = (() => true) as ChildProcess['send'];
    const host = new OwnedHost('gateway-node', 'normal', {
        forkChild: (() => child) as typeof fork,
        terminationMs: 20,
    });
    child.emit('message', { unexpected: true });
    assert.equal(kills, 0);
    await assert.rejects(host.initialize('http://127.0.0.1:5173'), /Unsolicited/);
    await host.abort();
    assert.equal(kills, 1);
});
