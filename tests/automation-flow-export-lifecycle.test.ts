import assert from 'node:assert/strict';
import test from 'node:test';
import {
    initialPositions,
    scene,
    snapshot,
} from '../src/features/automation/flow/model';
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

test('cancelling pending PNG encoding rejects without a result and releases both memory canvases', async (t) => {
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
    let releaseEncoder!: (value: Blob) => void;
    const encoder = new Promise<Blob>((resolve) => {
        releaseEncoder = resolve;
    });
    // This unused payload is never claimed to be a valid encoded image.
    const discardedBlob = new Blob(['discarded after cancellation'], { type: 'image/png' });
    const canvases: MemoryCanvas[] = [];
    let encodingCalls = 0,
        paintCalls = 0,
        measureCalls = 0;
    const paint = (...values: number[]) => {
        assert.ok(values.every(Number.isFinite));
        assert.ok(++paintCalls <= 512, 'Bound memory drawing operations.');
    };
    const context = () => Object.seal({
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
        constructor(width: number, height: number) {
            assert.ok(canvases.length < 2, 'Only measuring and PNG output canvases are expected.');
            assert.ok(Number.isInteger(width) && width > 0);
            assert.ok(Number.isInteger(height) && height > 0);
            assert.ok(width * height <= 8_000_000);
            this.width = width;
            this.height = height;
            canvases.push(this);
        }
        getContext(kind: string) {
            assert.equal(kind, '2d');
            return this.context;
        }
        async convertToBlob(options: { type: string; quality?: number }) {
            assert.strictEqual(this, canvases[1], 'Only the output canvas may encode.');
            assert.equal(++encodingCalls, 1);
            assert.deepEqual(options, { type: 'image/png', quality: undefined });
            return encoder;
        }
    }
    const originalCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = t.mock.timers;
    let timersActive = false,
        canvasInstalled = false;
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
        assert.notStrictEqual(globalThis.setTimeout, originalSetTimeout);
        assert.notStrictEqual(globalThis.clearTimeout, originalClearTimeout);
        timersActive = true;
        Object.defineProperty(globalThis, 'OffscreenCanvas', {
            configurable: true,
            writable: true,
            value: MemoryCanvas,
        });
        canvasInstalled = true;
        assert.strictEqual(globalThis.OffscreenCanvas, MemoryCanvas);
        outcome = observe(exportRaster(graph, 'png', false, { signal: controller.signal }));
        await pumpUntil(() => encodingCalls === 1 || outcome!.settled, 'PNG encoder admission');
        if (outcome.settled) throw outcome.error ?? Error('Export finished before the encoder gate.');
        assert.equal(encodingCalls, 1);
        assert.equal(outcome.settled, false);
        assert.equal(controller.signal.aborted, false);
        assert.equal(canvases.length, 2);
        assert.ok(canvases[1].width > 1 && canvases[1].height > 1);
        assert.ok(paintCalls > 0 && measureCalls > 0);

        controller.abort();
        releaseEncoder(discardedBlob);
        await pumpUntil(() => outcome!.settled, 'cancelled export completion');
        assert.equal(outcome.succeeded, false, 'Cancellation must never publish a success result.');
        assert.equal(outcome.result, undefined);
        assert.ok(outcome.error instanceof DOMException);
        assert.equal(outcome.error.name, 'AbortError');
        assert.equal(encodingCalls, 1);
        assert.equal(canvases.length, 2);
        assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
        assert.deepEqual(input, inputBefore);
        assert.deepEqual(graph, graphBefore);
    } catch (error) {
        failures.push(error);
    } finally {
        controller.abort();
        releaseEncoder(discardedBlob);
        try {
            if (timersActive && outcome) {
                try {
                    await pumpUntil(() => outcome!.settled, 'owned export during unwind');
                    if (
                        outcome.error !== undefined &&
                        !(outcome.error instanceof DOMException && outcome.error.name === 'AbortError') &&
                        !failures.includes(outcome.error)
                    )
                        failures.push(outcome.error);
                } catch (error) {
                    failures.push(error);
                }
            }
        } finally {
            try {
                if (canvasInstalled) {
                    if (originalCanvas)
                        Object.defineProperty(globalThis, 'OffscreenCanvas', originalCanvas);
                    else assert.equal(Reflect.deleteProperty(globalThis, 'OffscreenCanvas'), true);
                }
                assert.deepEqual(
                    Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas'),
                    originalCanvas,
                );
            } catch (error) {
                failures.push(error);
            } finally {
                try {
                    timers.reset();
                    assert.strictEqual(globalThis.setTimeout, originalSetTimeout);
                    assert.strictEqual(globalThis.clearTimeout, originalClearTimeout);
                } catch (error) {
                    failures.push(error);
                }
            }
        }
    }
    if (failures.length)
        throw new AggregateError(failures, 'PNG cancellation test or memory fixture unwind failed.');
    assert.ok(outcome?.settled && !outcome.succeeded);
    assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas'), originalCanvas);
    assert.strictEqual(globalThis.setTimeout, originalSetTimeout);
    assert.strictEqual(globalThis.clearTimeout, originalClearTimeout);
});
