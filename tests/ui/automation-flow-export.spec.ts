import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { installDesktop } from './fixtures/desktop';

test('reviewed export defects: measured wide/Unicode bounds and XML-invalid text across SVG PNG PDF', async ({
    page,
}, info) => {
    await installDesktop(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: /Commands/ })
        .click();
    await flow.getByLabel('Step 1 name (optional)').fill('W'.repeat(120));
    const cases = [
        { name: 'wide', command: 'W'.repeat(90) },
        {
            name: 'unicode',
            command: 'Ｗ'.repeat(90) + '\n日本語 👨‍👩‍👧‍👦 e\u0301 العربية\n' + 'MΩ🧑‍💻 '.repeat(30),
        },
        { name: 'fffe', command: "printf '\ufffe'" },
        { name: 'ffff', command: "printf '\uffff'" },
    ];
    const evidence = [];
    for (const entry of cases) {
        await flow.getByLabel('Command 1 script').fill(entry.command);
        await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Automation flow', exact: true });
        const files: Record<string, Buffer> = {};
        for (const format of ['SVG', 'PNG', 'PDF']) {
            const [download] = await Promise.all([
                page.waitForEvent('download'),
                dialog.getByRole('button', { name: `Export ${format}`, exact: true }).click(),
            ]);
            await expect(dialog.getByRole('status', { name: 'Flow export status' })).toContainText(
                `${format} exported`,
            );
            files[format] = await readFile((await download.path())!);
            await download.saveAs(
                `evidence/${info.project.name}-${entry.name}.${format.toLowerCase()}`,
            );
        }
        const rendered = await page.evaluate(
            async ({ source, png, command }) => {
                const fromBlob = await new Blob([source], { type: 'image/svg+xml' }).text();
                const doc = new DOMParser().parseFromString(fromBlob, 'image/svg+xml');
                if (doc.querySelector('parsererror'))
                    throw Error(doc.querySelector('parsererror')!.textContent!);
                const svg = document.importNode(
                    doc.documentElement,
                    true,
                ) as unknown as SVGSVGElement;
                const host = document.createElement('div');
                host.style.cssText = 'position:fixed;left:-100000px;top:0';
                host.attachShadow({ mode: 'open' }).append(svg);
                document.body.append(host);
                await document.fonts.ready;
                const width = svg.viewBox.baseVal.width,
                    height = svg.viewBox.baseVal.height;
                const rectangles = Array.from(svg.querySelectorAll('rect'));
                const bounds = Array.from(svg.querySelectorAll('text'))
                    .filter((t) => Boolean(t.textContent))
                    .map((t) => {
                        const b = t.getBBox(),
                            ordinal = Number(t.getAttribute('data-command'));
                        const card = ordinal ? rectangles[ordinal] : null;
                        return {
                            text: t.textContent,
                            role: t.getAttribute('data-flow-text'),
                            x: b.x,
                            y: b.y,
                            right: b.x + b.width,
                            bottom: b.y + b.height,
                            card: card
                                ? {
                                      x: card.x.baseVal.value,
                                      y: card.y.baseVal.value,
                                      right: card.x.baseVal.value + card.width.baseVal.value,
                                      bottom: card.y.baseVal.value + card.height.baseVal.value,
                                  }
                                : null,
                        };
                    });
                const appendix = Array.from(
                    svg.querySelectorAll('[data-flow-text="appendix"]'),
                ).map((t) => t.textContent ?? '');
                const image = new Image();
                image.src = 'data:image/png;base64,' + png;
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                const ctx = canvas.getContext('2d')!;
                ctx.drawImage(image, 0, 0);
                const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                let edgeInk = 0;
                for (let y = 0; y < canvas.height; y++)
                    for (let x = canvas.width - 24; x < canvas.width; x++) {
                        const at = (y * canvas.width + x) * 4;
                        if (
                            Math.abs(pixels[at] - 29) > 2 ||
                            Math.abs(pixels[at + 1] - 36) > 2 ||
                            Math.abs(pixels[at + 2] - 45) > 2
                        )
                            edgeInk++;
                    }
                const result = {
                    width,
                    height,
                    pngWidth: image.naturalWidth,
                    pngHeight: image.naturalHeight,
                    bounds,
                    appendix,
                    edgeInk,
                    wideCharacters: appendix.filter((t) => /^W+$/.test(t)).join('').length,
                    visibleEscape:
                        !/[\ufffe\uffff]/u.test(command) ||
                        appendix
                            .join('')
                            .includes(command.includes('\ufffe') ? '\\ufffe' : '\\uffff'),
                };
                canvas.width = 1;
                canvas.height = 1;
                host.remove();
                return result;
            },
            {
                source: files.SVG.toString('utf8'),
                png: files.PNG.toString('base64'),
                command: entry.command,
            },
        );
        expect(rendered.pngWidth).toBe(rendered.width);
        expect(rendered.pngHeight).toBe(rendered.height);
        expect(rendered.edgeInk).toBe(0);
        for (const b of rendered.bounds) {
            expect(b.x).toBeGreaterThanOrEqual(0);
            expect(b.y).toBeGreaterThanOrEqual(0);
            expect(b.right).toBeLessThanOrEqual(rendered.width);
            expect(b.bottom).toBeLessThanOrEqual(rendered.height);
            if (b.card) {
                expect(b.x).toBeGreaterThanOrEqual(b.card.x);
                expect(b.y).toBeGreaterThanOrEqual(b.card.y);
                expect(b.right).toBeLessThanOrEqual(b.card.right);
                expect(b.bottom).toBeLessThanOrEqual(b.card.bottom);
            }
        }
        if (entry.name === 'wide') expect(rendered.wideCharacters).toBe(90);
        const presentation = entry.command
            .replace(/[\ufffe\uffff]/gu, (c) => `\\u${c.charCodeAt(0).toString(16)}`)
            .replaceAll('\n', '');
        expect(rendered.appendix.join('')).toContain(presentation);
        expect(rendered.visibleEscape).toBe(true);
        expect(files.PDF.subarray(0, 8).toString()).toBe('%PDF-1.4');
        await page.keyboard.press('Escape');
        await expect(flow.getByLabel('Command 1 script')).toHaveValue(entry.command);
        evidence.push({ case: entry.name, ...rendered });
    }
    await info.attach('rendered-export-bounds', {
        body: JSON.stringify(evidence),
        contentType: 'application/json',
    });
});
