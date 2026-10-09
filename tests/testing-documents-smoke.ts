import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron, chromium } from '@playwright/test';
import { documentFixtures } from './fixtures/test-reports';
import { reportHtml } from '../shared/testing/report';

async function main() {
    const root = path.resolve('validation/board-tests');
    await mkdir(root, { recursive: true });
    const reports = await documentFixtures();
    for (const [index, label] of ['pending', 'mixed'].entries()) {
        const report = reports[index];
        await writeFile(path.join(root, label + '.json'), JSON.stringify(report, null, 4));
        await writeFile(path.join(root, label + '.html'), reportHtml(report));
    }
    await build({
        entryPoints: ['tests/testing-pdf-entry.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        outfile: path.join(root, 'pdf-entry.cjs'),
    });
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
        ),
    ) as Record<string, string>;
    const app = await _electron.launch({
        args: [
            path.join(root, 'pdf-entry.cjs'),
            root,
            `--user-data-dir=${path.join(root, 'electron-profile')}`,
        ],
        env,
        timeout: 30000,
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const process = app.process();
            process.on('exit', (code) =>
                code === 0 ? resolve() : reject(Error(`PDF renderer exited ${code}`)),
            );
        });
    } finally {
        await app.close().catch(() => {});
    }
    for (const label of ['pending', 'mixed'])
        assert.equal(
            (await readFile(path.join(root, label + '-native.pdf'))).subarray(0, 5).toString(),
            '%PDF-',
        );
    const browser = await chromium.launch();
    try {
        for (const label of ['pending', 'mixed']) {
            const page = await browser.newPage();
            let external = 0;
            page.on('request', (request) => {
                if (/^https?:/.test(request.url())) external++;
            });
            const html = await readFile(path.join(root, label + '.html'), 'utf8');
            await page.setContent(html);
            await page.emulateMedia({ media: 'print' });
            assert.equal(external, 0);
            assert.equal(
                await page.locator('.raw pre').first().textContent(),
                reports[0].run.cases[0].evidence!.stdout,
            );
            await page.pdf({
                path: path.join(root, label + '-web.pdf'),
                format: 'A4',
                printBackground: true,
                preferCSSPageSize: true,
            });
            await page.close();
        }
    } finally {
        await browser.close();
    }
    console.log(
        'Native and website print layouts created for pending feedback and all five verdicts.',
    );
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
