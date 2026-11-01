import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
    initialPositions,
    scene,
    snapshot,
} from '../src/features/automation/flow/model';
import { exportRaster } from '../src/features/automation/flow/raster';
import type { FlowExportResult, FlowInput } from '../src/features/automation/flow/types';

interface RejectionCase {
    name: string;
    mime: string;
    bytes: readonly number[];
    expectedMessage: string;
    expectedArrayReads: number;
}
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

async function rejectsPdf(t: TestContext, fixture: RejectionCase) {
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
    const progress: string[] = [];
    const canvases: MemoryCanvas[] = [];
    let encodingCalls = 0,
        arrayReads = 0,
        paintCalls = 0,
        measureCalls = 0;
    // Only the fields read by the actual rejection branches exist. No native codec runs.
    const encoded = Object.freeze({
        type: fixture.mime,
        async arrayBuffer() {
            assert.equal(++arrayReads, 1);
            assert.ok(fixture.bytes.length <= 4);
            return Uint8Array.from(fixture.bytes).buffer;
        },
    }) as unknown as Blob;
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
            assert.ok(++measureCalls <= 4096);
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
        translate: paint,
        save: paint,
        restore: paint,
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
        private context: ReturnType<typeof context>;
        constructor(width: number, height: number) {
            assert.ok(canvases.length < 2, 'Only measuring and PDF page canvases are expected.');
            assert.ok(Number.isInteger(width) && width > 0);
            assert.ok(Number.isInteger(height) && height > 0);
            assert.ok(width * height <= 8_000_000);
            this.width = width;
            this.height = height;
            this.context = context();
            canvases.push(this);
        }
        getContext(kind: string) {
            assert.equal(kind, '2d');
            return this.context;
        }
        async convertToBlob(options: { type: string; quality?: number }) {
            assert.strictEqual(this, canvases[1]);
            assert.equal(++encodingCalls, 1, 'Reject the first page before any later encoding.');
            assert.deepEqual(options, { type: 'image/jpeg', quality: 0.94 });
            return encoded;
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
        outcome = observe(
            exportRaster(graph, 'pdf', false, {
                signal: controller.signal,
                progress(message) {
                    progress.push(message);
                    assert.ok(progress.length <= 1);
                },
            }),
        );
        await pumpUntil(() => outcome!.settled, 'PDF codec rejection');
        assert.equal(controller.signal.aborted, false, 'The codec error must occur before unwind.');
        assert.equal(outcome.succeeded, false);
        assert.equal(outcome.result, undefined, 'No successful or partial PDF result may escape.');
        assert.ok(outcome.error instanceof Error);
        assert.equal(outcome.error.name, 'Error');
        assert.equal(outcome.error.message, fixture.expectedMessage);
        assert.equal(encodingCalls, 1);
        assert.equal(arrayReads, fixture.expectedArrayReads);
        assert.deepEqual(progress, [], 'An invalid page must not be counted as rendered.');
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
                    await pumpUntil(() => outcome!.settled, 'owned PDF export during unwind');
                    const error = outcome.error;
                    if (
                        error !== undefined &&
                        !(error instanceof Error && error.message === fixture.expectedMessage) &&
                        !(error instanceof DOMException && error.name === 'AbortError') &&
                        !failures.includes(error)
                    )
                        failures.push(error);
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
        throw new AggregateError(failures, 'PDF rejection test or memory fixture unwind failed.');
    assert.ok(outcome?.settled && !outcome.succeeded);
    assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas'), originalCanvas);
    assert.strictEqual(globalThis.setTimeout, originalSetTimeout);
    assert.strictEqual(globalThis.clearTimeout, originalClearTimeout);
}

for (const fixture of [
    {
        name: 'PDF rejects unsupported encoder MIME before reading page bytes and releases canvases',
        mime: 'image/png',
        bytes: [255, 216, 255, 217],
        expectedMessage:
            'This engine cannot encode local JPEG pages for PDF. SVG and PNG remain available.',
        expectedArrayReads: 0,
    },
    {
        name: 'PDF rejects an invalid JPEG second signature byte and releases canvases',
        mime: 'image/jpeg',
        bytes: [255, 0, 255, 217],
        expectedMessage: 'The PDF page encoder returned an invalid JPEG. No PDF was exported.',
        expectedArrayReads: 1,
    },
] satisfies RejectionCase[])
    test(fixture.name, (t) => rejectsPdf(t, fixture));
