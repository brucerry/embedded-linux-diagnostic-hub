import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutomationPlan, AutomationRecord } from '../shared/automation';
import {
    appendFrames,
    failedCapture,
    newCapture,
    sealedCapture,
    type CaptureFrame,
    type CaptureRepository,
    type StoredCapture,
} from '../shared/capture-store';
import type { SshStreamRequest } from '../shared/ssh-stream-rpc';
import { SshStreamHost } from '../backend/ssh/stream-host';
import { FlowRunner, type FlowState } from '../src/features/automation/runner';
import { sshCaptureBackend } from '../src/features/automation/capture/ssh-backend';
import { settled, until } from './fixtures/runner-cancel-fixture';

const connection = 'finalize-retry-connection';
const result = {
    stdout: 'retained output',
    stderr: '',
    completion: 'exit' as const,
    exitCode: 0,
    truncated: false,
    chunks: [],
    previewClipped: false,
};
const plan: AutomationPlan = {
    transport: 'ssh',
    timeoutSeconds: 10,
    repeatSeconds: 1,
    start: null,
    serial: { lineEnding: 'CR', prompt: '', timestampPrefix: '' },
    steps: ['one', 'never'].map((id) => ({
        id,
        name: id,
        command: id,
        enabled: true,
        delaySeconds: 0,
    })),
};

function memoryRepository() {
    let capture: StoredCapture;
    const frames: CaptureFrame[] = [];
    const forbidden = async (): Promise<never> => {
        throw Error('Unadmitted repository operation.');
    };
    const store: CaptureRepository = {
        async begin(header) {
            assert.equal(capture, undefined, 'Only one command may start.');
            capture = newCapture('00000000-0000-4000-8000-000000000001', 1, header);
            return structuredClone(capture);
        },
        async append(_id, batch) {
            capture = appendFrames(capture, batch);
            frames.push(...structuredClone(batch));
            return structuredClone(capture);
        },
        async seal(_id, observed, reason) {
            capture = sealedCapture(capture, observed, reason);
            return structuredClone(capture);
        },
        async fail(_id, observed, error) {
            capture = failedCapture(capture, observed, error);
        },
        page: forbidden,
        delete: forbidden,
        close: forbidden,
        pin: forbidden,
        async *read() {
            throw Error('No reader admitted.');
        },
    };
    return { store, snapshot: () => structuredClone({ capture, frames }) };
}

for (const boundary of ['before-dispatch', 'after-dispatch'] as const) {
    for (const rejectedRetry of [false, true]) {
        test(`SSH finalize ${boundary}, retry rejection ${rejectedRetry}`, async (t) => {
            const memory = memoryRepository(),
                rows: AutomationRecord[] = [],
                states: FlowState[] = [],
                commands: string[] = [];
            let owned = false,
                finalizes = 0,
                released = 0,
                retryEntered = false;
            let openRetry!: () => void;
            const retryGate = new Promise<void>((resolve) => {
                openRetry = resolve;
            });
            const host = new SshStreamHost(
                async (request, sink, complete, finalized) => {
                    owned = true;
                    commands.push(request.command);
                    await sink.append(
                        new TextEncoder().encode(result.stdout),
                        '2026-11-04T16:00:00.000Z',
                        'stdout',
                    );
                    complete(result);
                    await finalized;
                    owned = false;
                },
                () => {},
            );
            t.after(async () => {
                openRetry();
                await host.shutdown();
            });
            let finalizeRequest: SshStreamRequest | undefined;
            const expectedFinalizes = rejectedRetry ? 3 : 2;
            const backend = sshCaptureBackend(
                {
                    automationConnection: () => connection,
                    async automationStream(request) {
                        if (request.action !== 'finalize') return host.dispatch(request);
                        finalizeRequest = request;
                        finalizes++;
                        if (finalizes === 1) {
                            if (boundary === 'after-dispatch') await host.dispatch(request);
                            throw Error('Synthetic finalization reply unavailable.');
                        }
                        if (rejectedRetry && finalizes === 2)
                            throw Error('Synthetic explicit retry failure.');
                        assert.equal(finalizes, expectedFinalizes, 'Explicit retry is sent once.');
                        retryEntered = true;
                        await retryGate;
                        return host.dispatch(request);
                    },
                },
                memory.store,
                'local-client',
                { endpoint: 'in-memory SSH fixture' },
                () => true,
            );
            backend.acquire = () => () => {
                released++;
            };
            const runner = new FlowRunner(
                (s) => states.push(s),
                (row) => {
                    rows.push(row);
                },
                {
                    local: () => Date.UTC(2026, 10, 4, 16),
                    mono: () => 0,
                    watch: () => () => {},
                    sleep: async () => {
                        throw Error('No repeat may start.');
                    },
                },
            );
            await settled(runner.start(plan, backend));
            assert.equal(finalizes, 1, 'An uncertain finalization is not automatically retried.');
            assert.equal(runner.busy, true);
            assert.equal(runner.cleanupPending, true);
            assert.equal(released, 0);
            assert.equal(owned, boundary === 'before-dispatch');
            assert.equal(states.at(-1)?.cleanupPending, true);
            assert.match(states.at(-1)!.message, /SSH cleanup remains pending/);
            assert.deepEqual(commands, ['one']);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].stored?.state, 'complete');
            assert.equal(rows[0].stdout, result.stdout);
            const retained = memory.snapshot(),
                retainedRows = structuredClone(rows);
            assert.equal(
                Buffer.concat(retained.frames.map((frame) => frame.bytes)).toString(),
                result.stdout,
            );
            if (rejectedRetry) {
                await assert.rejects(runner.retryCleanup(), /Synthetic explicit retry failure/);
                assert.equal(runner.busy, true);
                assert.equal(runner.cleanupPending, true);
                assert.equal(released, 0);
                assert.equal(finalizes, 2);
            }
            const retry = runner.retryCleanup();
            try {
                await until(() => retryEntered);
                assert.equal(runner.retryCleanup(), retry);
                assert.equal(runner.busy, true);
                assert.equal(released, 0);
                assert.throws(() => runner.start(plan, backend), /awaiting cleanup/);
            } finally {
                openRetry();
                await settled(retry);
            }
            assert.equal(runner.busy, false);
            assert.equal(runner.cleanupPending, false);
            assert.equal(released, 1);
            assert.equal(owned, false);
            assert.deepEqual(commands, ['one']);
            assert.deepEqual(rows, retainedRows);
            assert.deepEqual(memory.snapshot(), retained);
            assert.equal(host.ownershipSnapshot.currentStates, 0);
            assert.equal(host.ownershipSnapshot.producers, 0);
            assert.equal(states.at(-1)?.state, 'paused');
            assert.match(states.at(-1)!.message, /SSH cleanup acknowledged/);
            await settled(runner.retryCleanup());
            assert.equal(finalizes, expectedFinalizes);
            assert.equal(released, 1);
            assert.deepEqual(await host.dispatch(finalizeRequest!), { ok: true });
            for (const patch of [
                { capability: 'f'.repeat(64) },
                { connection: 'other-valid-connection' },
                { id: 'other-valid-command' },
                { action: 'cancel' },
                { action: 'read' },
            ])
                await assert.rejects(
                    host.dispatch({ ...finalizeRequest!, ...patch }),
                    /invalid or stale/,
                );
            await assert.rejects(host.dispatch(finalizeRequest!, 'gateway'), /invalid or stale/);
            host.clear();
            await assert.rejects(host.dispatch(finalizeRequest!), /invalid or stale/);
        });
    }
}

for (const reply of ['lost', 'invalid-capability', 'invalid-shape'] as const) {
    test(`uncertain SSH start ${reply} retains custody and incomplete evidence`, async (t) => {
        const memory = memoryRepository(),
            rows: AutomationRecord[] = [],
            states: FlowState[] = [],
            actions: string[] = [];
        let owned = false,
            commands = 0,
            releases = 0;
        const host = new SshStreamHost(
            async (_request, _sink, complete, finalized) => {
                owned = true;
                commands++;
                complete(result);
                await finalized;
                owned = false;
            },
            () => {},
        );
        t.after(() => host.shutdown());
        const backend = sshCaptureBackend(
            {
                automationConnection: () => connection,
                async automationStream(request) {
                    actions.push(request.action);
                    const value = await host.dispatch(request);
                    if (request.action !== 'start') return value;
                    if (reply === 'lost') throw Error('Synthetic lost start acknowledgement.');
                    if (reply === 'invalid-shape') return { protocol: 1, unexpected: true };
                    return { protocol: 1, capability: 'invalid' };
                },
            },
            memory.store,
            'local-client',
            { endpoint: 'in-memory SSH fixture' },
            () => true,
        );
        backend.acquire = () => () => {
            releases++;
        };
        const runner = new FlowRunner(
            (s) => states.push(s),
            (row) => {
                rows.push(row);
            },
            {
                local: () => Date.UTC(2026, 10, 4, 16),
                mono: () => 0,
                watch: () => () => {},
                sleep: async () => {
                    throw Error('No repeat admitted.');
                },
            },
        );
        await settled(runner.start(plan, backend));
        assert.equal(owned, true);
        assert.equal(commands, 1);
        assert.equal(runner.busy, true);
        assert.equal(runner.cleanupPending, true);
        assert.equal(releases, 0);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].stored?.state, 'incomplete');
        assert.equal(rows[0].stored?.failure?.code, 'io');
        assert.equal(rows[0].stored?.committedBytes, 0);
        assert.equal(rows[0].stored?.observedBytes, 0, 'Only a verified lower bound is known.');
        assert.match(states.at(-1)!.message, /SSH cleanup remains pending.*uncertain/);
        const retained = memory.snapshot(),
            calls = [...actions];
        await assert.rejects(runner.retryCleanup(), /start outcome is uncertain/);
        await assert.rejects(runner.retryCleanup(), /start outcome is uncertain/);
        assert.equal(runner.cleanupPending, true);
        assert.equal(releases, 0);
        assert.deepEqual(actions, calls, 'No replay, fabricated capability, or cleanup RPC.');
        assert.deepEqual(memory.snapshot(), retained);
        assert.equal(commands, 1);
        assert.equal(owned, true);
    });
}

test('retirement receipt is bounded and cannot alter a newer active capture', async (t) => {
    let runs = 0,
        cancels = 0;
    const host = new SshStreamHost(
        async (_request, _sink, complete, finalized) => {
            runs++;
            complete(result);
            await finalized;
        },
        () => {
            cancels++;
        },
    );
    t.after(() => host.shutdown());
    const caps = (await host.dispatch({ protocol: 1, action: 'capabilities' })) as {
        epoch: string;
    };
    async function start(id: string) {
        const started = (await host.dispatch({
            protocol: 1,
            action: 'start',
            epoch: caps.epoch,
            request: { id, connection, command: 'fixture', timeoutMs: 1000 },
        })) as { capability: string };
        return {
            protocol: 1 as const,
            action: 'finalize' as const,
            id,
            connection,
            capability: started.capability,
        };
    }
    const first = await start('first-retirement-receipt');
    await host.dispatch(first);
    const second = await start('second-retirement-receipt');
    const before = host.ownershipSnapshot;
    assert.deepEqual(await host.dispatch(first), { ok: true });
    assert.deepEqual(host.ownershipSnapshot, before);
    assert.equal(cancels, 0);
    for (const action of ['cancel', 'read', 'ack'])
        await assert.rejects(
            host.dispatch({ ...first, action, ...(action === 'ack' ? { sequence: 0 } : {}) }),
            /invalid or stale/,
        );
    await host.dispatch(second);
    await assert.rejects(host.dispatch(first), /invalid or stale/);
    assert.deepEqual(await host.dispatch(second), { ok: true });
    assert.equal(runs, 2);
});

for (const capabilitiesFail of [false, true]) {
    test(`SSH cleanup ${capabilitiesFail ? 'pre-start failure' : 'ordinary success'}`, async (t) => {
        const memory = memoryRepository(),
            states: FlowState[] = [],
            actions: string[] = [];
        let produced = 0,
            released = 0;
        const host = new SshStreamHost(
            async (_request, _sink, complete, finalized) => {
                produced++;
                complete({ ...result, stdout: '' });
                await finalized;
            },
            () => {},
        );
        t.after(() => host.shutdown());
        const backend = sshCaptureBackend(
            {
                automationConnection: () => connection,
                async automationStream(request) {
                    actions.push(request.action);
                    if (capabilitiesFail) throw Error('Capabilities unavailable before start.');
                    return host.dispatch(request);
                },
            },
            memory.store,
            'local-client',
            { endpoint: 'in-memory SSH fixture' },
            () => true,
        );
        backend.acquire = () => () => {
            released++;
        };
        const runner = new FlowRunner((state) => states.push(state), () => {}, {
            local: () => Date.UTC(2026, 10, 4, 16),
            mono: () => 0,
            watch: () => () => {},
            sleep: async () => {
                throw Error('No wait admitted.');
            },
        });
        await settled(
            runner.start({ ...plan, steps: [plan.steps[0]], repeatSeconds: null }, backend),
        );
        assert.equal(runner.busy, false);
        assert.equal(runner.cleanupPending, false);
        assert.equal(released, 1);
        assert.equal(produced, capabilitiesFail ? 0 : 1);
        assert.equal(
            actions.filter((action) => action === 'finalize').length,
            capabilitiesFail ? 0 : 1,
        );
        assert.equal(host.ownershipSnapshot.currentStates, 0);
        assert.equal(states.at(-1)?.state, capabilitiesFail ? 'paused' : 'finished');
    });
}

test('late pre-clear finalization cannot restore a revoked receipt or retire a replacement', async (t) => {
    let oldRetirementEntered = false;
    let releaseOld!: () => void;
    const retirement = new Promise<void>((resolve) => { releaseOld = resolve; });
    const cancelled: string[] = [];
    const host = new SshStreamHost(async (request, _sink, complete, finalized) => {
        complete(result);
        await finalized;
        if (request.id === 'retirement-clear-old001') {
            oldRetirementEntered = true;
            await retirement;
        }
    }, (id) => { cancelled.push(id); });
    t.after(async () => { releaseOld(); await host.shutdown(); });
    async function start(id: string, selectedConnection: string) {
        const caps = await host.dispatch({ protocol: 1, action: 'capabilities' }) as { epoch: string };
        const started = await host.dispatch({ protocol: 1, action: 'start', epoch: caps.epoch,
            request: { id, connection: selectedConnection, command: 'fixture', timeoutMs: 1000 },
        }) as { capability: string };
        return { protocol: 1 as const, action: 'finalize' as const,
            id, connection: selectedConnection, capability: started.capability };
    }
    const first = await start('retirement-clear-old001', connection);
    const pending = host.dispatch(first);
    await until(() => oldRetirementEntered);
    host.clear();
    const second = await start('retirement-clear-new001', connection + '-replacement');
    assert.equal(host.ownershipSnapshot.currentStates, 1);
    releaseOld();
    await settled(pending);
    assert.equal(host.ownershipSnapshot.currentStates, 1);
    assert.equal(host.ownershipSnapshot.retiringStates, 0);
    assert.equal(host.ownershipSnapshot.producers, 1);
    await assert.rejects(host.dispatch(first), /invalid or stale/);
    const replacement = await host.dispatch({ ...second, action: 'read' }) as { id: string };
    assert.equal(replacement.id, second.id);
    assert.deepEqual(cancelled, [first.id]);
    await host.dispatch(second);
    assert.equal(host.ownershipSnapshot.currentStates, 0);
    assert.equal(host.ownershipSnapshot.producers, 0);
    assert.deepEqual(await host.dispatch(second), { ok: true });
    await assert.rejects(host.dispatch(first), /invalid or stale/);
});
