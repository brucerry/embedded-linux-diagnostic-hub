import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareHistory } from '../src/services/history';
import { historyFrame, type HistoryFrame } from '../shared/diagnostics/presentation';
import type { Snapshot } from '../shared/types';

test('history postMessage failure releases its worker deadline and preserves local fallback against a stale response', async (t) => {
    const input: Snapshot = {
        schemaVersion: 1,
        mode: 'demo',
        endpoint: 'synthetic.invalid:22',
        username: 'fixture',
        capturedAt: '2026-10-29T12:00:00.000Z',
        results: [
            {
                id: 'memory',
                status: 'collected',
                stdout: 'MemTotal: 2048 kB\nMemFree: 512 kB\nMemAvailable: 1024 kB\n',
                stderr: '',
                exitCode: 0,
                durationMs: 1,
                collectedAt: '2026-10-29T12:00:00.000Z',
                truncated: false,
            },
        ],
    };
    const before = structuredClone(input);
    const expected = historyFrame(input);
    assert.equal(expected.readings.memory.length, 3);
    const trace: string[] = [];
    const workers: MemoryWorker[] = [];
    let stale: ((event: MessageEvent<{ frame: HistoryFrame }>) => void) | null = null;
    class MemoryWorker {
        onmessage: ((event: MessageEvent<{ frame: HistoryFrame }>) => void) | null = null;
        onerror: ((event: { preventDefault(): void }) => void) | null = null;
        onmessageerror: (() => void) | null = null;
        terminations = 0;
        constructor(url: URL, options: WorkerOptions) {
            assert.ok(url instanceof URL);
            assert.equal(url.pathname.split('/').at(-1), 'history.worker.ts');
            assert.equal(url.search, '');
            assert.deepEqual(options, { type: 'module', name: 'diagnostic-history' });
            assert.equal(workers.length, 0);
            workers.push(this);
            trace.push('allocate');
        }
        postMessage(message: { snapshot: Snapshot; previous?: HistoryFrame }) {
            assert.deepEqual(Object.keys(message).sort(), ['previous', 'snapshot']);
            assert.strictEqual(message.snapshot, input);
            assert.equal(message.previous, undefined);
            assert.equal(typeof this.onmessage, 'function');
            assert.equal(typeof this.onerror, 'function');
            assert.equal(typeof this.onmessageerror, 'function');
            stale = this.onmessage;
            trace.push('post-failed');
            throw Error('SYNTHETIC_POST_MESSAGE_FAILURE');
        }
        terminate() {
            assert.ok(
                ++this.terminations <= 2,
                'Only initial failure and one injected stale response.',
            );
            trace.push('terminate');
        }
    }
    const original = new Map(
        ['Worker', 'location', 'setTimeout', 'clearTimeout'].map(
            (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
        ),
    );
    const installed: string[] = [];
    const timers = t.mock.timers;
    let timersActive = false;
    let outcome: { settled: boolean; result?: HistoryFrame; error?: unknown } | undefined;
    const failures: unknown[] = [];
    const pump = async () => {
        for (let turn = 0; turn < 256; turn++) {
            if (outcome?.settled) return;
            timers.tick(0);
            await Promise.resolve();
        }
        assert.ok(outcome?.settled, 'Fallback exceeded 256 virtual timer/microtask turns.');
    };
    try {
        timers.enable({ apis: ['setTimeout'] });
        timersActive = true;
        assert.notStrictEqual(globalThis.setTimeout, original.get('setTimeout')!.value);
        assert.notStrictEqual(globalThis.clearTimeout, original.get('clearTimeout')!.value);
        for (const [key, value] of [
            ['Worker', MemoryWorker],
            ['location', Object.freeze({ protocol: 'https:' })],
        ] as const) {
            Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
            installed.push(key);
        }
        outcome = { settled: false };
        const observed = outcome;
        void prepareHistory(input).then(
            (result) => {
                observed.result = result;
                observed.settled = true;
            },
            (error: unknown) => {
                observed.error = error;
                observed.settled = true;
            },
        );
        assert.deepEqual(trace, ['allocate', 'post-failed', 'terminate']);
        assert.equal(workers[0].terminations, 1, 'Initial failure terminates before fallback.');
        assert.equal(outcome.settled, false);
        // Check original deadline release before the deliberately stale handler could clear it again.
        timers.tick(30_001);
        assert.deepEqual(trace, ['allocate', 'post-failed', 'terminate']);
        assert.equal(workers[0].terminations, 1);
        assert.ok(stale);
        const invokeStale = stale as (event: MessageEvent<{ frame: HistoryFrame }>) => void;
        // Deliberate invocation of a captured handler, not a claim that native Worker dispatches
        // after termination. Source finish may terminate again; no exactly-once contract is invented.
        trace.push('inject-stale');
        invokeStale({
            data: { frame: { capturedAt: 'STALE_SENTINEL', readings: {} } },
        } as MessageEvent);
        assert.equal(workers[0].terminations, 2);
        await pump();
        assert.equal(outcome.error, undefined);
        assert.deepEqual(outcome.result, expected);
        assert.notEqual(outcome.result!.capturedAt, 'STALE_SENTINEL');
        assert.deepEqual(input, before);
        const traceBeforeLateTime = [...trace];
        const resultBeforeLateTime = structuredClone(outcome.result);
        timers.tick(30_001);
        await Promise.resolve();
        assert.deepEqual(
            trace,
            traceBeforeLateTime,
            'Both finish calls must clear the original deadline.',
        );
        assert.equal(workers[0].terminations, 2);
        assert.deepEqual(outcome.result, resultBeforeLateTime);
        assert.deepEqual(input, before);
    } catch (error) {
        failures.push(error);
    } finally {
        try {
            if (timersActive && outcome) {
                try {
                    await pump();
                    if (outcome.error !== undefined && !failures.includes(outcome.error))
                        failures.push(outcome.error);
                } catch (error) {
                    failures.push(error);
                }
            }
        } finally {
            try {
                for (const key of installed.reverse()) {
                    try {
                        const descriptor = original.get(key);
                        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                        else assert.equal(Reflect.deleteProperty(globalThis, key), true);
                        assert.deepEqual(
                            Object.getOwnPropertyDescriptor(globalThis, key),
                            descriptor,
                        );
                    } catch (error) {
                        failures.push(error);
                    }
                }
            } finally {
                try {
                    timers.reset();
                    for (const key of ['setTimeout', 'clearTimeout'])
                        assert.deepEqual(
                            Object.getOwnPropertyDescriptor(globalThis, key),
                            original.get(key),
                        );
                } catch (error) {
                    failures.push(error);
                }
            }
        }
    }
    if (failures.length)
        throw new AggregateError(failures, 'History fallback or fixture restoration failed.');
    assert.ok(outcome?.settled && outcome.result);
    for (const [key, descriptor] of original)
        assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), descriptor);
});
