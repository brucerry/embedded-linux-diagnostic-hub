import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../shared/automation';
import { consoleCompletion } from '../shared/ssh-console';
import { completionFixtures } from './fixtures/flow-completion';
import {
    displayText,
    initialPositions,
    scene,
    snapshot,
} from '../src/features/automation/flow/model';
import { exportRaster } from '../src/features/automation/flow/raster';
import type { FlowExportFormat } from '../src/features/automation/flow/types';

interface DrawCall {
    text: string;
    font: string;
    y: number;
}
const unxml = (value: string) =>
    value.replace(
        /&(amp|lt|gt|quot|apos);/g,
        (_, key: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key]!,
    );
const flat = (value: string) => displayText(value).replaceAll('\n', '');

for (const fixture of completionFixtures()) {
    test(`all export appendices preserve semantic fields: ${fixture.name}`, async () => {
        // Real model, layout, renderer, PDF pagination and serializer; deterministic metrics and
        // mocked codec isolate content-path completeness. Real codecs are qualified separately.
        const originalCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
        let calls: DrawCall[] = [];
        const canvases: { width: number; height: number }[] = [];
        class ContentCanvas {
            width: number;
            height: number;
            context: object;
            constructor(width: number, height: number) {
                this.width = width;
                this.height = height;
                canvases.push(this);
                this.context = new Proxy(
                    {
                        font: '14px system-ui',
                        measureText(text: string) {
                            const size = parseFloat(this.font),
                                width = (Array.from(text).length * size) / 2;
                            return {
                                width,
                                actualBoundingBoxLeft: 0,
                                actualBoundingBoxRight: width,
                                actualBoundingBoxAscent: size * 0.8,
                                actualBoundingBoxDescent: size * 0.2,
                            };
                        },
                        fillText(text: string, _x: number, y: number) {
                            calls.push({ text, font: this.font, y });
                        },
                    },
                    {
                        get: (target, key) =>
                            key in target ? target[key as keyof typeof target] : () => {},
                    },
                );
            }
            getContext() {
                return this.context;
            }
            async convertToBlob({ type }: { type: string }) {
                return new Blob([new Uint8Array([255, 216, 255, 217])], { type });
            }
        }
        Object.defineProperty(globalThis, 'OffscreenCanvas', {
            configurable: true,
            writable: true,
            value: ContentCanvas,
        });
        try {
            validatePlan(fixture.input.draft);
            if (fixture.input.active) validatePlan(fixture.input.active.plan);
            fixture.criteria.forEach((c) => {
                if (c) consoleCompletion(c);
            });
            const inputBefore = JSON.stringify(fixture.input),
                data = snapshot(
                    fixture.input,
                    Boolean(fixture.input.active),
                    '2026-10-15T19:00:00.000Z',
                ),
                graph = scene(data, initialPositions(data.nodes)),
                graphBefore = JSON.stringify(graph);
            const fieldsByFormat: Record<string, string[][]> = {};
            for (const format of ['svg', 'png', 'pdf'] as FlowExportFormat[]) {
                calls = [];
                const result = await exportRaster(graph, format, true);
                const transcript =
                    format === 'svg'
                        ? Array.from(
                              (await result.blob.text()).matchAll(
                                  /<text\b[^>]*data-flow-text="appendix"[^>]*>(.*?)<\/text>/g,
                              ),
                              (m) => unxml(m[1]),
                          ).join('')
                        : calls
                              .filter((c) =>
                                  format === 'pdf'
                                      ? parseFloat(c.font) === 11
                                      : c.y >= graph.graphHeight,
                              )
                              .map((c) => c.text)
                              .join('');
                for (const context of [data.summary, data.timing, data.completion])
                    assert.ok(
                        transcript.includes(flat(context)),
                        `${format}: complete snapshot context`,
                    );
                const fields: string[][] = [];
                for (const [index, node] of data.nodes.entries()) {
                    const heading = `${node.ordinal}. ${node.name}`,
                        start = transcript.indexOf(flat(heading)),
                        next = data.nodes[index + 1],
                        end = next
                            ? transcript.indexOf(
                                  flat(`${next.ordinal}. ${next.name}`),
                                  start + heading.length,
                              )
                            : transcript.length;
                    assert.ok(
                        start >= 0 && end > start,
                        `${format}: command ${node.ordinal} appendix section`,
                    );
                    const section = transcript.slice(start, end),
                        criterion = fixture.criteria[index],
                        expectedCriterion = criterion
                            ? `Completion criterion: ${displayText(JSON.stringify(criterion))}`
                            : undefined;
                    assert.equal(node.criterion, expectedCriterion, 'resolved model criterion');
                    const required = [
                        node.name,
                        node.intent,
                        node.enabled ? 'Enabled' : 'Disabled',
                        node.delay,
                        node.status,
                        ...(node.command ? [node.command] : []),
                        ...(expectedCriterion ? [expectedCriterion] : []),
                    ];
                    for (const field of required)
                        assert.ok(
                            section.includes(flat(field)),
                            `${format}: command ${node.ordinal} missing semantic field ${JSON.stringify(field)}`,
                        );
                    if (!node.command) assert.match(section, /empty (payload|command)/);
                    if (!criterion) assert.ok(!section.includes('Completion criterion:'));
                    assert.ok(
                        !section.includes('NEXT_DRAFT_ONLY#') &&
                            !section.includes('NEXT_STEP_ONLY#'),
                    );
                    fields.push(required.map(flat));
                }
                fieldsByFormat[format] = fields;
                assert.ok(
                    canvases.every((c) => c.width === 1 && c.height === 1),
                    'all measuring/output canvases released',
                );
                assert.equal(JSON.stringify(graph), graphBefore, 'raw scene remains exact');
                assert.equal(
                    JSON.stringify(fixture.input),
                    inputBefore,
                    'raw plan and criteria remain exact',
                );
            }
            assert.deepEqual(fieldsByFormat.pdf, fieldsByFormat.svg);
            assert.deepEqual(fieldsByFormat.png, fieldsByFormat.svg);
        } finally {
            if (originalCanvas)
                Object.defineProperty(globalThis, 'OffscreenCanvas', originalCanvas);
            else Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
        }
    });
}
