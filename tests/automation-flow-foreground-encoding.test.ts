import assert from 'node:assert/strict';
import test from 'node:test';
import { initialPositions, scene, snapshot } from '../src/features/automation/flow/model';
import { exportRaster } from '../src/features/automation/flow/raster';
import type { FlowExportResult, FlowInput } from '../src/features/automation/flow/types';

interface Outcome {
    settled: boolean;
    succeeded: boolean;
    result?: FlowExportResult;
    error?: unknown;
}
function observe(promise: Promise<FlowExportResult>): Outcome {
    const outcome: Outcome = { settled: false, succeeded: false };
    void promise.then(
        (result) => {
            outcome.result = result;
            outcome.succeeded = true;
            outcome.settled = true;
        },
        (error: unknown) => {
            outcome.error = error;
            outcome.settled = true;
        },
    );
    return outcome;
}

test('foreground toBlob(null) rejects without an export and releases both memory canvases', async (t) => {
    const input: FlowInput = {
        draft: {
            transport: 'ssh',
            steps: [
                {
                    id: 'inspect',
                    name: 'Inspect',
                    command: "printf 'inspect'",
                    enabled: true,
                    delaySeconds: 0,
                },
            ],
            start: null,
            timeoutSeconds: 5,
            repeatSeconds: null,
            serial: { lineEnding: 'CR', prompt: '# ', timestampPrefix: '' },
        },
        active: null,
        busy: false,
        state: { state: 'idle', message: 'Inspection only' },
        evidence: [],
    };
    const data = snapshot(input, false, '2026-10-29T12:00:00.000Z');
    const graph = scene(data, initialPositions(data.nodes));
    const inputBefore = structuredClone(input);
    const graphBefore = structuredClone(graph);
    const controller = new AbortController();
    const canvases: MemoryCanvas[] = [];
    let elementCalls = 0,
        encodingCalls = 0,
        paintCalls = 0,
        measureCalls = 0;
    const paint = (...values: number[]) => {
        assert.ok(values.every(Number.isFinite));
        assert.ok(++paintCalls <= 512, 'Bound memory drawing operations.');
    };
    const context = () =>
        Object.seal({
            font: '14px system-ui',
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 0,
            measureText(value: string) {
                assert.ok(++measureCalls <= 4096, 'Bound deterministic font measurements.');
                assert.ok(value.length <= 1024);
                const size = parseFloat(this.font);
                assert.ok(Number.isFinite(size) && size > 0);
                const width = (Array.from(value).length * size) / 2;
                return {
                    width,
                    actualBoundingBoxLeft: 0,
                    actualBoundingBoxRight: width,
                    actualBoundingBoxAscent: size * 0.8,
                    actualBoundingBoxDescent: size * 0.2,
                };
            },
            scale: paint,
            fillRect: paint,
            beginPath: paint,
            moveTo: paint,
            bezierCurveTo: paint,
            stroke: paint,
            lineTo: paint,
            closePath: paint,
            fill: paint,
            roundRect: paint,
            fillText(value: string, x: number, y: number) {
                assert.ok(value.length <= 1024);
                paint(x, y);
            },
        });
    class MemoryCanvas {
        width: number;
        height: number;
        private context = context();
        constructor() {
            assert.ok(canvases.length < 2, 'Only measuring and PNG output canvases are expected.');
            // Browser-like defaults represented as scalars, with no native canvas or pixel allocation.
            this.width = 300;
            this.height = 150;
            canvases.push(this);
        }
        getContext(kind: string) {
            assert.equal(kind, '2d');
            return this.context;
        }
        toBlob(callback: BlobCallback, type?: string, quality?: number) {
            assert.strictEqual(this, canvases[1], 'Only the output canvas may encode.');
            assert.equal(++encodingCalls, 1);
            assert.equal(type, 'image/png');
            assert.equal(quality, undefined);
            assert.ok(this.width > 1 && this.height > 1);
            assert.ok(this.width * this.height <= 8_000_000);
            callback(null);
        }
    }
    const fakeDocument = Object.freeze({
        createElement(tag: string) {
            assert.equal(tag, 'canvas');
            assert.ok(++elementCalls <= 2);
            return new MemoryCanvas();
        },
    });
    const originalGlobals = new Map(
        ['OffscreenCanvas', 'document', 'setTimeout', 'clearTimeout'].map(
            (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
        ),
    );
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = t.mock.timers;
    let timersActive = false;
    const installed: string[] = [];
    let outcome: Outcome | undefined;
    const failures: unknown[] = [];
    const pumpUntil = async (check: () => boolean, label: string) => {
        for (let pulse = 0; pulse < 4096; pulse++) {
            if (check()) return;
            // Node 24 MockTimers executes due zero-delay yields without advancing real time.
            timers.tick(0);
            await Promise.resolve();
        }
        assert.ok(check(), label + ' exceeded 4096 logical timer/microtask pulses.');
    };
    try {
        timers.enable({ apis: ['setTimeout'] });
        timersActive = true;
        assert.notStrictEqual(globalThis.setTimeout, originalSetTimeout);
        assert.notStrictEqual(globalThis.clearTimeout, originalClearTimeout);
        for (const [key, value] of [
            ['OffscreenCanvas', undefined],
            ['document', fakeDocument],
        ] as const) {
            Object.defineProperty(globalThis, key, {
                configurable: true,
                writable: true,
                value,
            });
            installed.push(key);
        }
        assert.equal(typeof globalThis.OffscreenCanvas, 'undefined');
        assert.strictEqual(globalThis.document, fakeDocument);
        outcome = observe(exportRaster(graph, 'png', false, { signal: controller.signal }));
        await pumpUntil(() => outcome!.settled, 'foreground null encoder rejection');
        assert.equal(controller.signal.aborted, false, 'Encoding must fail before unwind aborts.');
        assert.equal(outcome.succeeded, false);
        assert.equal(outcome.result, undefined, 'No successful or partial export may escape.');
        assert.ok(outcome.error instanceof Error);
        assert.equal(outcome.error.name, 'Error');
        assert.equal(outcome.error.message, 'Local canvas encoding failed.');
        assert.equal(encodingCalls, 1);
        assert.equal(elementCalls, 2);
        assert.equal(canvases.length, 2);
        assert.ok(paintCalls > 0 && measureCalls > 0);
        assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
        assert.deepEqual(input, inputBefore);
        assert.deepEqual(graph, graphBefore);
    } catch (error) {
        failures.push(error);
    } finally {
        controller.abort();
        try {
            if (timersActive && outcome) {
                try {
                    await pumpUntil(() => outcome!.settled, 'owned export during unwind');
                    if (
                        outcome.error !== undefined &&
                        !(
                            outcome.error instanceof Error &&
                            outcome.error.message === 'Local canvas encoding failed.'
                        ) &&
                        !(
                            outcome.error instanceof DOMException &&
                            outcome.error.name === 'AbortError'
                        ) &&
                        !failures.includes(outcome.error)
                    )
                        failures.push(outcome.error);
                } catch (error) {
                    failures.push(error);
                }
            }
        } finally {
            try {
                for (const key of installed.reverse()) {
                    try {
                        const descriptor = originalGlobals.get(key);
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
                            originalGlobals.get(key),
                        );
                } catch (error) {
                    failures.push(error);
                }
            }
        }
    }
    if (failures.length)
        throw new AggregateError(
            failures,
            'Foreground null encoder test or memory fixture unwind failed.',
        );
    assert.ok(outcome?.settled && !outcome.succeeded);
    assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
    for (const [key, descriptor] of originalGlobals)
        assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), descriptor);
    assert.strictEqual(globalThis.setTimeout, originalSetTimeout);
    assert.strictEqual(globalThis.clearTimeout, originalClearTimeout);
});
