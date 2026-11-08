import type { Scene } from '../../../src/features/automation/flow/types';

export interface DecodedFlowPdfInput {
    images: { jpeg: string; width: number; height: number }[];
    svg: string;
    scene: Scene;
}

/**
 * Browser-only oracle for the bounded visual fixture. It uses a real JPEG
 * decoder, an independent SVG graph rendering, and a simple linear grapheme
 * wrapper for the authored detail text. No production layout/render helper is
 * imported. Pixel error is measured over ink, never diluted by blank paper.
 * This is same-engine content fidelity, not OCR or a general PDF renderer.
 */
export async function inspectDecodedFlowPdf(input: DecodedFlowPdfInput) {
    const check = (condition: unknown, message: string) => {
        if (!condition) throw Error(message);
    };
    check(input.images.length >= 3 && input.images.length <= 8, 'Decoded PDF page budget');
    check(input.svg.length <= 256 * 1024, 'Decoded PDF SVG reference budget');
    check(
        input.images.reduce((sum, image) => sum + image.jpeg.length, 0) <= 12 * 1024 * 1024,
        'Decoded PDF total encoded read budget',
    );
    check(input.scene.nodes.length === 2, 'Decoded PDF two-command fixture');
    const canvases: HTMLCanvasElement[] = [];
    const makeCanvas = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1684;
        canvas.height = 1190;
        canvases.push(canvas);
        return canvas;
    };
    const context = (canvas: HTMLCanvasElement) => {
        const result = canvas.getContext('2d', { willReadFrequently: true });
        if (!result) throw Error('Decoded PDF canvas unavailable');
        return result;
    };
    const background = [29, 36, 45];
    const reports: { page: number; role: string; comparisons: number; maxInkError: number }[] = [];
    const display = (text: string) =>
        text.replace(/[\ufffe\uffff]/gu, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
    const parts = (text: string) =>
        Array.from(
            new Intl.Segmenter(undefined, {
                granularity: 'grapheme',
            }).segment(text),
            (item) => item.segment,
        );
    const reference = makeCanvas(),
        ref = context(reference);
    const decoded = makeCanvas(),
        actual = context(decoded);
    ref.scale(2, 2);
    const clear = () => {
        ref.fillStyle = '#1d242d';
        ref.fillRect(0, 0, 842, 595);
    };
    const metrics = (text: string, size: number) => {
        ref.font = `${size}px system-ui, sans-serif`;
        return ref.measureText(text);
    };
    const wrap = (value: string) => {
        const lines: string[] = [];
        for (const raw of display(value).split('\n')) {
            let line = '';
            for (const part of parts(raw)) {
                const m = metrics(line + part, 11);
                if (
                    Math.max(0, m.actualBoundingBoxLeft) +
                        Math.max(m.width, m.actualBoundingBoxRight) >
                    756
                ) {
                    check(line, 'Decoded PDF reference glyph exceeds line width');
                    lines.push(line);
                    line = '';
                }
                line += part;
            }
            lines.push(line);
        }
        return lines;
    };
    const drawText = (text: string, x: number, y: number, size: number) => {
        ref.font = `${size}px system-ui, sans-serif`;
        ref.fillStyle = '#e7edf4';
        ref.fillText(text, x, y);
    };
    let report: (typeof reports)[number];
    const compare = (
        label: string,
        x: number,
        y: number,
        width: number,
        height: number,
        maxError = 0.12,
    ) => {
        const left = Math.floor(x * 2),
            top = Math.floor(y * 2);
        const w = Math.ceil(width * 2),
            h = Math.ceil(height * 2);
        check(
            left >= 0 && top >= 0 && left + w <= 1684 && top + h <= 1190,
            `Decoded PDF reference bounds: ${label}`,
        );
        const expected = ref.getImageData(left, top, w, h).data;
        const observed = actual.getImageData(left, top, w, h).data;
        let error = 0,
            ink = 0;
        for (let at = 0; at < expected.length; at += 4) {
            let expectedInk = 0,
                observedInk = 0;
            for (let c = 0; c < 3; c++) {
                expectedInk += Math.abs(expected[at + c] - background[c]);
                observedInk += Math.abs(observed[at + c] - background[c]);
            }
            if (Math.max(expectedInk, observedInk) < 45) continue;
            ink += Math.max(expectedInk, observedInk);
            for (let c = 0; c < 3; c++) error += Math.abs(expected[at + c] - observed[at + c]);
        }
        check(ink > 1000, `Decoded PDF reference has no meaningful ink: ${label}`);
        const inkError = error / ink;
        check(
            inkError <= maxError,
            `Decoded PDF ${report.role} ${label}: ink error ${inkError.toFixed(4)} > ${maxError}`,
        );
        report.comparisons++;
        report.maxInkError = Math.max(report.maxInkError, inkError);
    };
    const textCheck = (text: string, x: number, y: number, size: number, label: string) => {
        const m = metrics(text, size);
        drawText(text, x, y, size);
        // One-pixel guard excludes the next suffix glyph when checking a title prefix.
        compare(
            label,
            x - Math.max(0, m.actualBoundingBoxLeft),
            y - m.actualBoundingBoxAscent,
            Math.max(m.width, m.actualBoundingBoxRight),
            m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + 1,
        );
    };
    const { scene } = input;
    check(
        scene.width > 1000 && scene.width <= 1700 && scene.graphHeight <= 600,
        'Decoded PDF two-column single-row fixture geometry',
    );
    check(
        scene.nodes.every((n) => n.criterion === undefined && n.command.length < 4096),
        'Decoded PDF detail fixture budget',
    );
    const detailValues = [
        scene.snapshot.identity,
        scene.snapshot.capturedAt,
        scene.snapshot.summary,
        scene.snapshot.timing,
        scene.snapshot.completion,
        ...scene.nodes.flatMap((n) => [
            '',
            `${n.ordinal}. ${n.name} · ${n.enabled ? 'Enabled' : 'Disabled'} · ${n.intent}`,
            `${n.delay} · ${n.status}`,
            n.command || '(empty payload)',
        ]),
    ];
    const detailPages: {
        text: string;
        top: number;
        baseline: number;
        left: number;
        height: number;
    }[][] = [[]];
    let used = 0;
    for (const line of detailValues.flatMap(wrap)) {
        const m = metrics(line, 11);
        const ascent = Math.max(0, m.actualBoundingBoxAscent),
            descent = Math.max(0, m.actualBoundingBoxDescent);
        const baseline = Math.max(11, ascent) + 2;
        const height = Math.max(15, baseline + descent + 3);
        if (used + height > 467) {
            detailPages.push([]);
            used = 0;
        }
        detailPages.at(-1)!.push({
            text: line,
            top: 65 + used,
            baseline,
            left: 34 + Math.max(0, m.actualBoundingBoxLeft),
            height,
        });
        used += height;
    }
    check(
        detailPages.length >= 2 && detailPages.length <= 4,
        'Decoded PDF continued-details fixture',
    );
    check(input.images.length === 3 + detailPages.length, 'Decoded PDF exact role/page count');
    const doc = new DOMParser().parseFromString(input.svg, 'image/svg+xml');
    check(!doc.querySelector('parsererror'), 'Decoded PDF valid SVG graph reference');
    const svg = doc.documentElement;
    check(Number(svg.getAttribute('width')) === scene.width, 'Decoded PDF SVG scene width');
    for (const node of scene.nodes) {
        check(
            svg.querySelector(`[data-command="${node.ordinal}"][data-flow-text="name"]`),
            `Decoded PDF SVG card ${node.ordinal}`,
        );
    }
    for (const text of Array.from(svg.querySelectorAll('text'))) {
        if (!text.hasAttribute('data-command')) text.remove();
    }
    const graph = new Image();
    graph.src =
        'data:image/svg+xml;charset=utf-8,' +
        encodeURIComponent(new XMLSerializer().serializeToString(svg));
    try {
        await document.fonts.ready;
        await graph.decode();
        for (let pageIndex = 0; pageIndex < input.images.length; pageIndex++) {
            const image = input.images[pageIndex];
            check(
                image.width === 1684 &&
                    image.height === 1190 &&
                    image.jpeg.length <= 12 * 1024 * 1024,
                'Decoded PDF image dimension/byte budget',
            );
            const bitmap = new Image();
            bitmap.src = 'data:image/jpeg;base64,' + image.jpeg;
            try {
                await bitmap.decode();
            } catch {
                throw Error(`Decoded PDF JPEG decoding failed on page ${pageIndex + 1}`);
            }
            check(
                bitmap.naturalWidth === 1684 && bitmap.naturalHeight === 1190,
                'Decoded PDF JPEG decoded dimensions',
            );
            actual.clearRect(0, 0, 1684, 1190);
            actual.drawImage(bitmap, 0, 0);
            bitmap.src = '';
            clear();
            const role =
                pageIndex === 0
                    ? 'overview'
                    : pageIndex <= 2
                      ? `graph-${pageIndex}`
                      : `details-${pageIndex - 2}`;
            report = { page: pageIndex + 1, role, comparisons: 0, maxInkError: 0 };
            reports.push(report);
            const title =
                pageIndex === 0
                    ? 'Automation flow · overview · 2 readable graph tiles follow'
                    : pageIndex <= 2
                      ? `Graph tile ${pageIndex}/2 · column ${pageIndex}/2 · row 1/1`
                      : `Details ${pageIndex - 2}/${detailPages.length}`;
            textCheck(title, 32, 28, 14, 'role title');
            textCheck(
                `${scene.snapshot.kind} · ${scene.snapshot.identity} · ${scene.snapshot.capturedAt}`,
                32,
                48,
                10.5,
                'snapshot identity',
            );
            textCheck(
                'Local snapshot · not execution proof · full commands in appendix',
                32,
                577,
                10.5,
                'evidence warning',
            );
            if (pageIndex <= 2) {
                const scale =
                    pageIndex === 0 ? Math.min(778 / scene.width, 480 / scene.graphHeight) : 0.778;
                const tileX = pageIndex === 2 ? 700 : 0;
                ref.save();
                ref.beginPath();
                ref.rect(32, 65, 778, 467);
                ref.clip();
                ref.drawImage(
                    graph,
                    32 - tileX * scale,
                    65,
                    scene.width * scale,
                    Number(svg.getAttribute('height')) * scale,
                );
                ref.restore();
                const whole = scene.nodes.filter(
                    (n) => pageIndex === 0 || (n.x >= tileX && n.x + 300 <= tileX + 1000),
                );
                check(whole.length >= 1, 'Decoded PDF readable whole-card coverage');
                for (const node of whole) {
                    const left = 32 + (node.x - tileX) * scale,
                        top = 65 + node.y * scale;
                    compare(`card ${node.ordinal}`, left, top, 300 * scale, 168 * scale, 0.18);
                    for (const role of ['name', 'intent', 'preview', 'delay', 'status']) {
                        const text = svg.querySelector(
                            `[data-command="${node.ordinal}"][data-flow-text="${role}"]`,
                        )!;
                        const x = 32 + (Number(text.getAttribute('x')) - tileX) * scale;
                        const y = 65 + Number(text.getAttribute('y')) * scale;
                        const size = Number(text.getAttribute('font-size')) * scale;
                        const m = metrics(text.textContent ?? '', size);
                        compare(
                            `card ${node.ordinal} ${role}`,
                            x - Math.max(0, m.actualBoundingBoxLeft),
                            y - m.actualBoundingBoxAscent - 1,
                            Math.max(m.width, m.actualBoundingBoxRight) + 1,
                            m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + 2,
                            0.22,
                        );
                    }
                }
                // The connecting segment must survive, not just card rectangles/text.
                compare(
                    'connecting edge',
                    32 + ((pageIndex === 2 ? 800 : 500) - tileX) * scale,
                    65 + 300 * scale,
                    100 * scale,
                    10 * scale,
                    0.22,
                );
            } else {
                for (const [lineIndex, line] of detailPages[pageIndex - 3].entries()) {
                    if (!line.text.trim()) continue;
                    textCheck(
                        line.text,
                        line.left,
                        line.top + line.baseline,
                        11,
                        `detail line ${lineIndex + 1}`,
                    );
                }
            }
        }
        return {
            pages: reports,
            decodedJpegs: reports.length,
            detailPageCount: detailPages.length,
            detailLines: detailPages.reduce((sum, lines) => sum + lines.length, 0),
        };
    } finally {
        graph.src = '';
        for (const canvas of canvases) {
            canvas.width = 1;
            canvas.height = 1;
        }
    }
}
