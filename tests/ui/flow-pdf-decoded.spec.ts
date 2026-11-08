import { test, expect } from '@playwright/test';
import { imagePdf } from '../../src/features/automation/flow/pdf';
import { inspectFlowPdfExport, readFlowPdfImages } from '../fixtures/flow-pdf-content';
import { exportFlowPdfVisualCase, flowPdfVisualCase } from '../fixtures/flow-pdf-visual-case';
import { inspectDecodedFlowPdf } from './fixtures/flow-pdf-decoded';

test('PDF decodes overview, readable graph tiles and every continued detail line', async ({
    page,
}, info) => {
    await page.goto('/');
    const result = await page.evaluate(exportFlowPdfVisualCase, flowPdfVisualCase);
    const pdf = Buffer.from(result.pdf, 'base64');
    const structure = inspectFlowPdfExport(pdf);
    const images = readFlowPdfImages(pdf).map((image) => ({
        jpeg: image.data.toString('base64'),
        width: image.width,
        height: image.height,
    }));
    const input = { images, svg: result.svg, scene: flowPdfVisualCase };
    const report = await page.evaluate(inspectDecodedFlowPdf, input);
    expect(report.decodedJpegs).toBe(structure.pages);
    // Font metrics can produce two to four detail pages. The oracle computes
    // this count independently from authored text before reading any JPEG.
    expect(report.detailPageCount).toBeGreaterThanOrEqual(2);
    expect(report.detailPageCount).toBeLessThanOrEqual(4);
    expect(structure.pages).toBe(3 + report.detailPageCount);
    expect(report.pages.map((p) => p.role)).toEqual([
        'overview',
        'graph-1',
        'graph-2',
        ...Array.from({ length: report.detailPageCount }, (_, index) => `details-${index + 1}`),
    ]);
    expect(report.detailLines).toBeGreaterThan(45);
    expect(report.pages.every((p) => p.comparisons >= 3)).toBe(true);

    // Every control is reserialized as a valid PDF. Structural success must not
    // be confused with decoded role/body fidelity. Keep controls bounded and
    // local; no devices, downloads, OCR, external assets or package changes.
    const controls: { name: string; images: typeof images; error: RegExp }[] = [];
    const swapped = images.slice();
    [swapped[1], swapped[3]] = [swapped[3], swapped[1]];
    controls.push({
        name: 'reordered graph/details',
        images: swapped,
        error: /graph-1 role title/,
    });
    for (const [name, index, rectangle, error] of [
        ['empty overview body', 0, [32, 65, 778, 467], /overview card 1/],
        ['empty graph body', 1, [32, 65, 778, 467], /graph-1 card 1/],
        ['missing connecting edge', 1, [421, 297, 78, 10], /graph-1 connecting edge/],
        ['empty details body', 3, [32, 65, 778, 467], /details-1 detail line/],
        [
            'missing continued details',
            images.length - 1,
            [32, 65, 778, 467],
            new RegExp(`details-${report.detailPageCount} detail line`),
        ],
    ] as const) {
        const jpeg = await page.evaluate(
            async ({ jpeg, rectangle }) => {
                const image = new Image();
                image.src = 'data:image/jpeg;base64,' + jpeg;
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = 1684;
                canvas.height = 1190;
                try {
                    const ctx = canvas.getContext('2d')!;
                    ctx.drawImage(image, 0, 0);
                    ctx.scale(2, 2);
                    ctx.fillStyle = '#1d242d';
                    ctx.fillRect(rectangle[0], rectangle[1], rectangle[2], rectangle[3]);
                    return canvas.toDataURL('image/jpeg', 0.94).split(',')[1];
                } finally {
                    image.src = '';
                    canvas.width = 1;
                    canvas.height = 1;
                }
            },
            { jpeg: images[index].jpeg, rectangle },
        );
        const changed = images.slice();
        changed[index] = { ...images[index], jpeg };
        controls.push({ name, images: changed, error });
    }
    // This incomplete marker/scan envelope is structurally admissible. Some
    // decoders recover pixels from incomplete data; decoding or the unchanged
    // first-page content checks must still reject it.
    const envelope = Buffer.from([
        255, 216, 255, 192, 0, 17, 8, 4, 166, 6, 148, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 218, 0,
        12, 3, 1, 0, 2, 17, 3, 17, 0, 63, 0, 42, 255, 217,
    ]);
    controls.push({
        name: 'incomplete JPEG envelope',
        images: [{ ...images[0], jpeg: envelope.toString('base64') }, ...images.slice(1)],
        error: /Decoded PDF (?:JPEG decoding failed on page 1|overview role title: ink error)/,
    });
    for (const control of controls) {
        const bytes = imagePdf(
            control.images.map((i) => ({
                bytes: Buffer.from(i.jpeg, 'base64'),
                width: i.width,
                height: i.height,
            })),
        );
        expect(inspectFlowPdfExport(bytes).pages).toBe(structure.pages);
        await expect(
            page.evaluate(inspectDecodedFlowPdf, {
                ...input,
                images: readFlowPdfImages(bytes).map((i) => ({
                    jpeg: i.data.toString('base64'),
                    width: i.width,
                    height: i.height,
                })),
            }),
        ).rejects.toThrow(control.error);
    }
    await info.attach('decoded-pdf-content', {
        contentType: 'application/json',
        body: JSON.stringify({ structure, report, negativeControls: controls.map((c) => c.name) }),
    });
});
