import { pngSize, MAX_PAGES } from './model';
import { canvasText, drawGraph, drawSceneAsync, fillBackground, svg } from './render';
import { imagePdf, PAPER, pdfTiles, type PdfImage } from './pdf';
import { fontMeasure, layoutScene, measuredLines, previewLine, textRun } from './text-layout';
import type { FlowExportFormat, Scene, FlowExportResult } from './types';

type RasterCanvas = HTMLCanvasElement | OffscreenCanvas;
export async function exportRaster(
    source: Scene,
    format: FlowExportFormat,
    downscale: boolean,
    options: {
        signal?: AbortSignal;
        pngPixelBudget?: number;
        progress?(message: string): void;
    } = {},
): Promise<FlowExportResult> {
    const check = () => {
        if (options.signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
    };
    const yieldControl = async () => {
        check();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        check();
    };
    const createCanvas = (width: number, height: number): RasterCanvas => {
        if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    };
    const encode = async (canvas: RasterCanvas, type: string, quality?: number) => {
        await yieldControl();
        const blob =
            'convertToBlob' in canvas
                ? await canvas.convertToBlob({ type, quality })
                : await new Promise<Blob>((resolve, reject) =>
                      canvas.toBlob(
                          (blob) =>
                              blob ? resolve(blob) : reject(Error('Local canvas encoding failed.')),
                          type,
                          quality,
                      ),
                  );
        check();
        return blob;
    };
    check();
    const canvases: RasterCanvas[] = [];
    try {
        const measuringCanvas = createCanvas(1, 1);
        canvases.push(measuringCanvas);
        const measuringContext = measuringCanvas.getContext('2d') as
            CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!measuringContext) throw Error('Export font metrics are unavailable.');
        const scene = await layoutScene(source, fontMeasure(measuringContext), yieldControl);
        let blob: Blob;
        if (format === 'svg') blob = new Blob([svg(scene)], { type: 'image/svg+xml' });
        else {
            if (format === 'png') {
                const size = pngSize(scene, downscale, options.pngPixelBudget),
                    canvas = createCanvas(size.width, size.height);
                canvases.push(canvas);
                const ctx = canvas.getContext('2d') as
                    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
                if (!ctx) throw Error('PNG canvas is unavailable.');
                ctx.scale(size.scale, size.scale);
                await drawSceneAsync(ctx, scene, yieldControl);
                blob = await encode(canvas, 'image/png');
            } else {
                const tiles = pdfTiles(scene.width, scene.graphHeight),
                    images: PdfImage[] = [];
                const canvas = createCanvas(PAPER.width * 2, PAPER.height * 2);
                canvases.push(canvas);
                const ctx = canvas.getContext('2d') as
                    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
                if (!ctx) throw Error('PDF canvas is unavailable.');
                ctx.scale(2, 2);
                const measure = fontMeasure(ctx);
                const caption = (value: string, x: number, y: number, size: number) =>
                    canvasText(ctx, previewLine(value, 778, 24, size, measure), x, y, size);
                const header = (title: string) => {
                    fillBackground(ctx, PAPER.width, PAPER.height);
                    caption(title, 32, 28, 14);
                    caption(
                        `${scene.snapshot.kind} · ${scene.snapshot.identity} · ${scene.snapshot.capturedAt}`,
                        32,
                        48,
                        10.5,
                    );
                    caption(
                        'Local snapshot · not execution proof · full commands in appendix',
                        32,
                        577,
                        10.5,
                    );
                };
                let totalBytes = 0;
                const save = async () => {
                    if (images.length >= MAX_PAGES)
                        throw Error(
                            'PDF exceeds 128 pages. Reset the layout or shorten the draft.',
                        );
                    const page = await encode(canvas, 'image/jpeg', 0.94);
                    if (page.type !== 'image/jpeg')
                        throw Error(
                            'This engine cannot encode local JPEG pages for PDF. SVG and PNG remain available.',
                        );
                    const bytes = new Uint8Array(await page.arrayBuffer());
                    if (bytes[0] !== 255 || bytes[1] !== 216)
                        throw Error(
                            'The PDF page encoder returned an invalid JPEG. No PDF was exported.',
                        );
                    totalBytes += bytes.length;
                    if (totalBytes > 30 * 1024 * 1024)
                        throw Error(
                            'PDF exceeds the 32 MiB export limit. Use SVG or reset layout.',
                        );
                    images.push({ bytes, width: canvas.width, height: canvas.height });
                    options.progress?.(`Rendering PDF page ${images.length}`);
                };
                header(`Automation flow · overview · ${tiles.length} readable graph tiles follow`);
                const fit = Math.min(778 / scene.width, 480 / scene.graphHeight);
                ctx.save();
                ctx.translate(32, 65);
                ctx.scale(fit, fit);
                drawGraph(ctx, scene);
                ctx.restore();
                await save();
                for (const tile of tiles) {
                    const x = tile.column * PAPER.strideX,
                        y = tile.row * PAPER.strideY;
                    header(
                        `Graph tile ${tile.index}/${tiles.length} · column ${tile.column + 1}/${tile.columns} · row ${tile.row + 1}/${tile.rows}`,
                    );
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(32, 65, 778, 467);
                    ctx.clip();
                    // 14 px card labels become 10.9 pt; no giant-page shrinking.
                    ctx.translate(32 - x * 0.778, 65 - y * 0.778);
                    ctx.scale(0.778, 0.778);
                    drawGraph(ctx, scene);
                    ctx.restore();
                    const ordinals = scene.nodes
                        .filter(
                            (n) =>
                                n.x < x + 1000 && n.x + 300 > x && n.y < y + 600 && n.y + 168 > y,
                        )
                        .map((n) => n.ordinal);
                    caption(
                        `Commands ${ordinals.join(', ') || '(arrows only)'} · arrows continue in adjacent numbered row/column tiles`,
                        32,
                        550,
                        10.5,
                    );
                    await save();
                }
                const sections = [
                    {
                        reference: 'Snapshot context',
                        content: [
                            scene.snapshot.identity,
                            scene.snapshot.capturedAt,
                            scene.snapshot.summary,
                            scene.snapshot.timing,
                            scene.snapshot.completion,
                        ],
                    },
                    ...scene.nodes.map((n) => ({
                        reference: `Command ${n.ordinal}`,
                        content: [
                            '',
                            `${n.ordinal}. ${n.name} · ${n.enabled ? 'Enabled' : 'Disabled'} · ${n.intent}`,
                            `${n.delay} · ${n.status}`,
                            ...(n.criterion ? [n.criterion] : []),
                            n.command || '(empty payload)',
                        ],
                    })),
                ];
                const lines: { text: string; reference: string }[] = [];
                for (const section of sections)
                    for (const value of section.content)
                        for (const text of await measuredLines(
                            value,
                            760,
                            11,
                            measure,
                            yieldControl,
                        ))
                            lines.push({ text, reference: section.reference });
                const detailPages: (typeof lines)[] = [[]];
                let detailHeight = 0;
                for (const line of lines) {
                    const r = textRun(line.text, 32, 0, 11, 'ink', 'pdf-detail', measure),
                        height = Math.max(15, r.bounds.y + r.bounds.height + 3);
                    if (height > 467)
                        throw Error(
                            'A glyph cluster exceeds a readable PDF detail page. Use SVG or PNG.',
                        );
                    if (detailHeight + height > 467) {
                        detailPages.push([]);
                        detailHeight = 0;
                    }
                    detailPages.at(-1)!.push(line);
                    detailHeight += height;
                }
                const pages = detailPages.length;
                if (images.length + pages > MAX_PAGES)
                    throw Error('PDF exceeds 128 pages. Use SVG or a compact layout.');
                for (let i = 0; i < pages; i++) {
                    header(
                        `Details ${i + 1}/${pages} · ${detailPages[i][0].reference} → ${detailPages[i].at(-1)!.reference} · continued text keeps this reference`,
                    );
                    let y = 65;
                    for (const line of detailPages[i]) {
                        const r = textRun(line.text, 32, y, 11, 'ink', 'pdf-detail', measure);
                        canvasText(ctx, r.text, r.x, r.y, 11);
                        y += Math.max(15, r.bounds.y + r.bounds.height - y + 3);
                    }
                    await save();
                }
                const pdf = imagePdf(images);
                blob = new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
            }
        }
        check();
        return { blob, width: scene.width, height: scene.height };
    } finally {
        for (const canvas of canvases) {
            canvas.width = 1;
            canvas.height = 1;
        }
    }
}
