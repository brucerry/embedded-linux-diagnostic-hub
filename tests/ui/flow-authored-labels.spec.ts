import { test, expect, type Page } from '@playwright/test';
import { imagePdf } from '../../src/features/automation/flow/pdf';
import { inspectFlowPdfExport, readFlowPdfImages } from '../fixtures/flow-pdf-content';
import type { LabelImage, LabelMutation } from './fixtures/flow-authored-labels';
async function browser(
    page: Page,
    task: { action: string; svg?: string; images?: LabelImage[]; mutation?: LabelMutation },
) {
    return page.evaluate(async (task) => {
        const url = new URL('/tests/ui/fixtures/flow-authored-labels.ts', location.href).href;
        const m = (await import(
            /* @vite-ignore */ url
        )) as typeof import('./fixtures/flow-authored-labels');
        if (task.action === 'export') return m.exportAuthoredLabels();
        if (task.action === 'svg') return m.inspectAuthoredSvg(task.svg!);
        if (task.action === 'mutate-svg') return m.mutateAuthoredSvg(task.svg!, task.mutation!);
        if (task.action === 'pdf') return m.inspectAuthoredPdf(task.images!);
        return m.mutateAuthoredPdf(task.images!, task.mutation!);
    }, task);
}
test('SVG and decoded PDF graph labels match independent authored literals', async ({
    page,
}, info) => {
    await page.goto('/');
    const result = (await browser(page, { action: 'export' })) as { pdf: string; svg: string };
    const pdf = Buffer.from(result.pdf, 'base64'),
        structure = inspectFlowPdfExport(pdf);
    const images = readFlowPdfImages(pdf).map((i) => ({
        jpeg: i.data.toString('base64'),
        width: i.width,
        height: i.height,
    }));
    const svg = await browser(page, { action: 'svg', svg: result.svg });
    const decoded = await browser(page, { action: 'pdf', images });
    const controls: [LabelMutation, RegExp, RegExp][] = [
        ['swapped', /SVG label 1.name literal mismatch/, /PDF graph label 1.name ink error/],
        ['wrong', /SVG label 1.preview literal mismatch/, /PDF graph label 1.preview ink error/],
        ['missing', /SVG label 2.intent cardinality/, /PDF graph label 2.intent ink error/],
    ];
    for (const [mutation, svgError, pdfError] of controls) {
        const changedSvg = (await browser(page, {
            action: 'mutate-svg',
            svg: result.svg,
            mutation,
        })) as string;
        await expect(browser(page, { action: 'svg', svg: changedSvg })).rejects.toThrow(svgError);
        const changed = (await browser(page, {
            action: 'mutate-pdf',
            images,
            mutation,
        })) as LabelImage[];
        const bytes = imagePdf(
            changed.map((i) => ({
                bytes: Buffer.from(i.jpeg, 'base64'),
                width: i.width,
                height: i.height,
            })),
        );
        expect(inspectFlowPdfExport(bytes).pages).toBe(structure.pages);
        const reread = readFlowPdfImages(bytes).map((i) => ({
            jpeg: i.data.toString('base64'),
            width: i.width,
            height: i.height,
        }));
        await expect(browser(page, { action: 'pdf', images: reread })).rejects.toThrow(pdfError);
    }
    const body = Buffer.from(
        JSON.stringify({
            schema: 1,
            structure,
            svg,
            decoded,
            negativeControls: controls.map((c) => c[0]),
            productionSource: '3cd35151c15d7cf7bca854c04961367dc6b6f36d',
        }),
    );
    if (body.length > 4096) throw Error('Authored label observation exceeds bound');
    await info.attach('authored-label-observation', { body, contentType: 'application/json' });
});
