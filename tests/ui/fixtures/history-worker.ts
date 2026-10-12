import type { Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

let workerSource: Promise<string> | undefined;

export async function installBundledHistoryWorker(page: Page) {
    // Dense-history assertions measure graph behavior across 35 collections. Bundle
    // the current source once per test-worker run to avoid repeating Vite's module
    // request waterfall; the application's real Worker lifecycle remains intact.
    workerSource ??= build({
        entryPoints: [path.resolve(__dirname, '../../../src/services/history.worker.ts')],
        bundle: true,
        platform: 'browser',
        format: 'esm',
        write: false,
        logLevel: 'silent',
    }).then(({ outputFiles }) => {
        if (outputFiles.length !== 1) throw new Error('Expected one standalone history worker.');
        return outputFiles[0].text;
    });
    const body = await workerSource;
    await page.route(
        (url) =>
            url.pathname === '/src/services/history.worker.ts' &&
            url.search === '?worker_file&type=module',
        (route) => route.fulfill({ contentType: 'text/javascript', body }),
    );
}
