import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { pilotLimits } from './hosted-pilot-contract.mjs';
const now = () => Number(process.hrtime.bigint() / 1000000n);
/** A single durable credit with a finite pending/total diagnostic envelope. */
export function runtimeDiagnostics(send, hold) {
    let tail = Promise.resolve(),
        failed,
        rows = 0,
        bytes = 0,
        pending = 0;
    const emit = (stage, data) => {
        const size = Buffer.byteLength(JSON.stringify({ stage, data }));
        if (failed) return Promise.reject(failed);
        assert(
            size <= 65536 &&
                ++rows <= 1024 &&
                bytes + size <= pilotLimits.evidenceBytes &&
                pending + size <= 262144,
            'Runtime diagnostic envelope',
        );
        bytes += size;
        pending += size;
        const task = tail.then(() => {
            if (failed) throw failed;
            return send(stage, data);
        });
        tail = task.then(
            () => {
                pending -= size;
            },
            (e) => {
                pending -= size;
                failed ??= e;
                hold(e);
            },
        );
        void task.catch(() => {});
        return task;
    };
    return {
        emit,
        note(stage, data) {
            try {
                void emit(stage, data).catch(hold);
            } catch (e) {
                hold(e);
            }
        },
        async drain() {
            await tail;
            if (failed) throw failed;
        },
    };
}
export function stopHeldPilotActivity(startup, stopPeriodic) {
    stopPeriodic();
    startup?.stopQueryAdmission();
}
export function pilotStageDeadlines(binding, stage, at = now()) {
    const workCutoff = binding.deadline - pilotLimits.reserveMs;
    const runtimeDeadline = Math.min(workCutoff, at + pilotLimits.ptyTestMs);
    return Object.freeze({
        runtimeDeadline,
        stageDeadline: stage === 'real-os-pty' ? runtimeDeadline : workCutoff,
        cleanupDeadline: binding.deadline,
    });
}
export function startupBound(task, { signal, deadline, label, clock = now }) {
    return new Promise((resolve, reject) => {
        const finish = (e, value) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            e ? reject(e) : resolve(value);
        };
        const abort = () => finish(signal.reason ?? Error('Startup cancelled'));
        const timer = setTimeout(
            () => finish(Error(label + ' absolute deadline')),
            Math.max(0, deadline - clock()),
        );
        signal?.addEventListener('abort', abort, { once: true });
        Promise.resolve(task).then(
            (value) => finish(null, value),
            (e) => finish(e),
        );
        if (signal?.aborted) abort();
    });
}
/** Exact production pre-PTY boundary. No build admission before identity and ready receipts.
 * @returns {Promise<any>} */
export async function preparePilotStageRuntime(
    {
        binding,
        bindingSHA256,
        paths,
        startup,
        signal,
        deadline,
        emit,
        cancel,
        hold,
        root = process.cwd(),
    },
    {
        spawnPort = spawn,
        loader = pathToFileURL(createRequire(path.join(root, 'package.json')).resolve('tsx')).href,
        worker = path.join(root, 'tests/fixtures/native-pilot-runtime-worker.mts'),
        clock = now,
        cooperativeMs = 1000,
    } = {},
) {
    assert(Number.isSafeInteger(deadline) && deadline <= binding.deadline - pilotLimits.reserveMs);
    const cleanup = Math.min(binding.deadline, deadline + 10000);
    let child,
        runtime,
        eventSequence = 0,
        readyResolve,
        cancelled = false;
    const ready = new Promise((resolve) => {
        readyResolve = resolve;
    });
    const sendCancel = (p) => {
        if (cancelled) return;
        cancelled = true;
        void emit('runtime-cancel-request', { pid: p.pid, deadline }).catch(hold);
        if (!p.connected) {
            void emit('runtime-cancel-transport', {
                pid: p.pid,
                sent: false,
                connected: false,
            }).catch(hold);
            return;
        }
        p.send(
            {
                kind: 'cancel-native-pilot-build',
                reason: 'Runtime preparation cancelled',
                nonce: binding.nonce,
                bindingSHA256,
            },
            (e) => {
                void emit('runtime-cancel-transport', {
                    pid: p.pid,
                    sent: !e,
                    error: e ? String(e).slice(0, 1024) : null,
                }).catch(hold);
            },
        );
    };
    try {
        signal.throwIfAborted();
        assert(clock() < deadline);
        await emit('runtime-loader-before', { deadline, cleanupDeadline: cleanup, worker, loader });
        child = startup.spawn(
            'ssh-runtime-build',
            () =>
                spawnPort(
                    process.execPath,
                    [
                        '--import',
                        loader,
                        worker,
                        JSON.stringify({
                            root,
                            outputParent: paths.runtimeParent,
                            gated: true,
                            nonce: binding.nonce,
                            bindingSHA256,
                            deadline,
                            cleanupDeadline: cleanup,
                        }),
                    ],
                    {
                        cwd: root,
                        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                        windowsHide: true,
                        env: { ...process.env, HUB_NATIVE_PILOT_STAGE: '1' },
                    },
                ),
            sendCancel,
        );
        child.on('message', (m) => {
            try {
                assert(m?.nonce === binding.nonce && m.bindingSHA256 === bindingSHA256);
                assert(Buffer.byteLength(JSON.stringify(m)) <= 8192);
                if (m.kind === 'native-runtime-ready') {
                    assert.equal(m.pid, child.pid);
                    readyResolve(m);
                } else if (m.kind === 'native-runtime-event') {
                    assert.equal(m.sequence, eventSequence++);
                    void emit(m.stage, { pid: child.pid, ...m.data }).then(() => {
                        if (child.connected)
                            child.send(
                                {
                                    kind: 'native-runtime-event-ack',
                                    nonce: binding.nonce,
                                    bindingSHA256,
                                    sequence: m.sequence,
                                },
                                (e) => {
                                    if (e) hold(e);
                                },
                            );
                    }, hold);
                } else if (m.kind === 'native-runtime-result') runtime = m.result;
                else if (m.kind === 'native-runtime-cancel-ack')
                    void emit('runtime-cancel-ack', { pid: child.pid, reason: m.reason }).catch(
                        hold,
                    );
                else throw Error('Unrecognized runtime-worker message');
            } catch (e) {
                hold(e);
                cancel(e);
            }
        });
        const row = startup.children.get(child);
        const closedEarly = row.closed.then(() => {
            throw Error('Runtime worker closed before readiness/result');
        });
        void closedEarly.catch(() => {});
        await startupBound(Promise.race([Promise.all([ready, row.identityTask]), closedEarly]), {
            signal,
            deadline,
            label: 'Runtime readiness/identity',
            clock,
        });
        await startup.drainDiagnostics();
        signal.throwIfAborted();
        assert(clock() < deadline);
        await emit('runtime-admission', { pid: child.pid, identity: row.identity, deadline });
        await new Promise((resolve, reject) =>
            child.send(
                { kind: 'admit-native-runtime', nonce: binding.nonce, bindingSHA256, deadline },
                (e) => (e ? reject(e) : resolve()),
            ),
        );
        await startupBound(row.closed, {
            signal,
            deadline,
            label: 'Runtime build/pipe close',
            clock,
        });
        await startup.joinChild(child);
        signal.throwIfAborted();
        assert(clock() < deadline);
        assert.equal(row.code, 0);
        assert(runtime, 'Runtime worker closed without result');
        await emit('runtime-ready', { pid: child.pid, runtime, deadline });
        return runtime;
    } catch (e) {
        cancel(e);
        startup.cancel();
        void emit('runtime-failed', {
            error: String(e).slice(0, 1024),
            pid: child?.pid ?? null,
            deadline,
        }).catch(hold);
        if (child) {
            const row = startup.children.get(child);
            try {
                try {
                    await startupBound(row.closed, {
                        deadline: Math.min(cleanup, clock() + cooperativeMs),
                        label: 'Runtime cooperative stop',
                        clock,
                    });
                } catch {
                    startup.terminateChild(child, e);
                }
                await startupBound(row.closed, {
                    deadline: cleanup,
                    label: 'Runtime terminated pipe close',
                    clock,
                });
                await startupBound(startup.joinChild(child), {
                    deadline: cleanup,
                    label: 'Runtime descendant/identity join',
                    clock,
                });
            } catch (closure) {
                hold(closure);
            }
        }
        throw e;
    }
}
/** Outer parent watchdog covers loader/import/setup independently of the stage event loop. */
export async function waitPilotStage({
    child,
    startup,
    state,
    signal,
    cancel,
    hold,
    emit,
    clock = now,
}) {
    let stageTimer, runtimeTimer, abort;
    const failure = new Promise((_, reject) => {
        const stop = (reason) => {
            cancel(reason);
            void emit('stage-watchdog', {
                stage: state.stage,
                reason,
                stageDeadline: state.stageDeadline,
                runtimeDeadline: state.runtimeDeadline,
            }).catch(hold);
            reject(Error(reason));
        };
        runtimeTimer = setTimeout(
            () => {
                if (!state.runtimeReady) stop('Stage runtime startup absolute deadline');
            },
            Math.max(0, state.runtimeDeadline - clock()),
        );
        stageTimer = setTimeout(
            () => stop('Stage absolute work deadline'),
            Math.max(0, state.stageDeadline - clock()),
        );
        abort = () => stop(String(signal.reason ?? 'Stage parent cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
    try {
        await Promise.race([startup.children.get(child).closed, failure]);
    } catch (e) {
        try {
            await startupBound(startup.children.get(child).closed, {
                deadline: Math.min(state.cleanupDeadline, clock() + 10000),
                label: 'Stage cancellation pipe closure',
                clock,
            });
            await startup.joinChild(child);
        } catch (closure) {
            hold(closure);
        }
        throw e;
    } finally {
        clearTimeout(stageTimer);
        clearTimeout(runtimeTimer);
        signal.removeEventListener('abort', abort);
    }
}
