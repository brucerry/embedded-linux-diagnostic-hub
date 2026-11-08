import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NativeCaptureStore } from '../../electron/capture-store';
import { CaptureStorageError, type CaptureRepository } from '../../shared/capture-store';
import { type AutomationPlan } from '../../shared/automation';
import { DEFAULT_SERIAL_SETTINGS } from '../../shared/serial';
import { SerialSession } from '../../src/features/serial/session';
import { FlowRunner } from '../../src/features/automation/runner';
import { serialCaptureBackend } from '../../src/features/automation/capture/serial-backend';
import { streamCaptureReport } from '../../shared/capture-report';
import { serialCaptureFixture, deferred, until } from './serial-capture';
import { Owners } from './memory-resource-core';
import { sshCycle } from './memory-resource-ssh';

export const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const plan = (commands: string[]): AutomationPlan => ({
    transport: 'serial',
    start: null,
    timeoutSeconds: 30,
    repeatSeconds: null,
    serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: '' },
    steps: commands.map((command, i) => ({
        id: `step-${i}`,
        name: `Step ${i}`,
        command,
        enabled: true,
        delaySeconds: 0,
    })),
});
/** Deliberately source-coupled test inspection: fail if ownership fields disappear. */
function inspect(value: object, fields: Record<string, unknown>) {
    for (const [key, expected] of Object.entries(fields)) {
        assert.ok(key in value, `Update the test resource probe for missing field ${key}`);
        assert.deepEqual(
            Reflect.get(value, key),
            expected,
            `Unreleased ${value.constructor.name}.${key}`,
        );
    }
}
export function trackedRepository(store: CaptureRepository, owners: Owners): CaptureRepository {
    const writers = new Map<string, () => void>();
    return new Proxy(store, {
        get(target, key) {
            if (key === 'read')
                return async function* (id: string) {
                    const release = owners.take('reader', id);
                    try {
                        yield* target.read(id);
                    } finally {
                        release();
                    }
                };
            if (key === 'pin')
                return () =>
                    owners.join('pending-pin', 'catalog', async () => {
                        const pin = await target.pin(),
                            release = owners.take('pin', 'catalog');
                        return {
                            through: pin.through,
                            release: async () => {
                                await pin.release();
                                release();
                            },
                        };
                    });
            const method = Reflect.get(target, key);
            if (typeof method !== 'function') return method;
            return (...args: unknown[]) =>
                owners.join('repository-call', String(key), async () => {
                    const result = await method.apply(target, args);
                    if (key === 'begin') writers.set(result.id, owners.take('writer', result.id));
                    if (key === 'seal' || key === 'fail') {
                        writers.get(String(args[0]))?.();
                        writers.delete(String(args[0]));
                    }
                    return result;
                });
        },
    });
}

/** Each complete cycle has identical constant-cardinality state and all fault paths warmed. */
export async function nativeCycle(
    profile: string,
    payloadBytes: number,
    emit: (stage: string, data?: unknown) => Promise<void>,
) {
    const owners = new Owners();
    const store = await NativeCaptureStore.open(profile, { profileOwned: true });
    const tracked = trackedRepository(store, owners);
    const releaseStore = owners.take('store', profile);
    let capturedBytes = 0,
        exportedBytes = 0;
    let failure: unknown;
    try {
        for (const scenario of ['success', 'cancel', 'quota-begin', 'quota-append'] as const) {
            const gate = deferred();
            let entered = false,
                appendCalls = 0,
                outputFinished = false;
            const fixture = serialCaptureFixture(async function* () {
                try {
                    for (let offset = 0; offset < payloadBytes; offset += 16384)
                        yield new Uint8Array(Math.min(16384, payloadBytes - offset)).fill(
                            65 + ((offset / 16384) % 26),
                        );
                    yield new TextEncoder().encode('\r\nboard# ');
                } finally {
                    outputFinished = true;
                }
            });
            const session = new SerialSession(async () => {});
            const subscription = owners.take('listener', 'Serial status');
            const unsubscribe = session.subscribe(() => {});
            let readable: ReadableStream<Uint8Array> | null = null,
                writable: WritableStream<Uint8Array> | null = null;
            const broken = new Proxy(tracked, {
                get(target, key) {
                    if (key === 'begin' && scenario === 'quota-begin')
                        return async () => {
                            throw new CaptureStorageError('quota', 'Synthetic begin quota.');
                        };
                    if (key === 'append')
                        return async (...args: Parameters<CaptureRepository['append']>) => {
                            appendCalls++;
                            if (appendCalls === 2 && scenario === 'cancel') {
                                entered = true;
                                await gate.promise;
                            }
                            if (appendCalls === 2 && scenario === 'quota-append')
                                throw new CaptureStorageError('quota', 'Synthetic append quota.');
                            return target.append(...args);
                        };
                    return Reflect.get(target, key);
                },
            });
            let lastState = '',
                completion = '';
            const runner = new FlowRunner(
                (state) => {
                    lastState = state.state;
                },
                (row) => {
                    completion = row.completion;
                    capturedBytes += row.stored?.committedBytes ?? 0;
                },
            );
            let pending: Promise<void> | undefined;
            try {
                session.select(fixture.port, 'synthetic memory UART');
                await session.connect(DEFAULT_SERIAL_SETTINGS);
                readable = fixture.port.readable;
                writable = fixture.port.writable;
                pending = runner.start(
                    plan(scenario === 'success' ? ['fixture'] : ['fixture', 'never-send']),
                    serialCaptureBackend(session, broken),
                );
                if (scenario === 'cancel') {
                    try {
                        await until(() => entered);
                        runner.cancel();
                        await turn();
                        assert.equal(runner.busy, true, 'Cancel must still own pending append.');
                        assert.throws(() => session.send(new Uint8Array([88])), /owned/);
                    } finally {
                        gate.resolve();
                    }
                }
                await pending;
                assert.equal(runner.busy, false);
                assert.equal(
                    fixture.writes.length,
                    scenario === 'quota-begin' ? 0 : 1,
                    'A failure must suppress the next input.',
                );
                assert.equal(lastState, scenario === 'success' ? 'finished' : 'paused');
                if (scenario === 'cancel') {
                    assert.equal(completion, 'cancelled');
                    // Join old output before explicitly rearming the same connected generation.
                    await until(() => outputFinished);
                    await runner.start(plan(['rearmed']), serialCaptureBackend(session, tracked));
                    assert.equal(lastState, 'finished');
                    assert.equal(fixture.writes.length, 2);
                }
                await emit('work', { scenario, capturedBytes });
                if (scenario === 'success') {
                    for (const format of ['json', 'csv', 'markdown', 'text'] as const) {
                        const release = owners.take('export', format),
                            hash = createHash('sha256');
                        try {
                            for await (const chunk of streamCaptureReport(tracked, format)) {
                                hash.update(chunk);
                                exportedBytes += chunk.length;
                            }
                            await emit('export', { format, sha256: hash.digest('hex') });
                        } finally {
                            release();
                        }
                    }
                    // Early iterator return must release its actual read lease.
                    const first = (await tracked.page()).records[0];
                    const reader = tracked.read(first.id)[Symbol.asyncIterator]();
                    await reader.next();
                    await reader.return?.();
                }
            } finally {
                runner.cancel();
                gate.resolve();
                await pending;
                await session.close(true);
                unsubscribe();
                subscription();
                assert.equal(readable?.locked ?? false, false);
                assert.equal(writable?.locked ?? false, false);
                assert.equal(session.isOwned, false);
                assert.equal(fixture.opens, fixture.closes);
                inspect(session, {
                    automationOwner: undefined,
                    capture: undefined,
                    reader: undefined,
                    writer: undefined,
                    queue: [],
                    queuedBytes: 0,
                    listeners: new Set(),
                });
            }
            for (const capture of (await tracked.page()).records) await tracked.delete(capture.id);
            assert.equal((await tracked.page()).records.length, 0);
        }
        await sshCycle(tracked, payloadBytes, owners);
        for (const capture of (await tracked.page()).records) await tracked.delete(capture.id);
        await emit('before-store-close');
    } catch (error) {
        failure = error;
    }
    try {
        await tracked.close();
        releaseStore();
        inspect(store, {
            closed: true,
            closing: false,
            active: undefined,
            readers: new Map(),
            pins: 0,
            modifying: false,
            deleting: new Set(),
            resultWriting: new Set(),
            listing: 0,
            catalog: undefined,
            catalogFile: undefined,
            operation: undefined,
            metadataQueues: new Map(),
            metadataUncertain: new Map(),
            jsonOperations: new Map(),
        });
        await emit('after-store-close');
        const reopened = await NativeCaptureStore.open(profile, { profileOwned: true });
        try {
            assert.equal((await reopened.page()).records.length, 0);
        } finally {
            await reopened.close();
        }
        await turn();
        await turn();
        owners.empty('complete owner teardown');
        await emit('after-teardown', {
            owners: owners.snapshot(),
            capturedBytes,
            exportedBytes,
            diskRecords: 0,
            cache: 'closed; catalog removed; canonical captures explicitly cleared',
        });
    } catch (error) {
        failure ??= error;
    }
    if (failure) throw failure;
    return { capturedBytes, exportedBytes };
}
