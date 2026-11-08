import { defineConfig } from '@playwright/test';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

// Explicit opt-in only. The default UI/portability commands do not discover this lane.
const selected = process.env.HUB_FINAL_WEB_SELECTION;
const output = process.env.HUB_FINAL_WEB_OUTPUT;
// One explicit engine per invocation; omission preserves the original Chromium lane.
const engine = process.env.HUB_FINAL_WEB_ENGINE ?? 'chromium';
if (engine !== 'chromium' && engine !== 'firefox' && engine !== 'webkit')
    throw Error('Select exactly one supported final-web engine.');
if (
    !selected ||
    !/^validation\/(?:[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/)?web-startup-selection\.json$/.test(selected)
)
    throw Error('Supply the independently selected final-ZIP input manifest.');
if (!output || !/^validation\/web-startup-[A-Za-z0-9_-]{1,80}$/.test(output))
    throw Error('Supply one fresh, disposable final-web output leaf.');
const root = realpathSync(process.cwd());
if (realpathSync(path.join(root, 'validation')) !== path.join(root, 'validation'))
    throw Error('Noncanonical output parent is unsupported.');
let outputExists = false;
try {
    // lstat also detects an existing dangling symlink; existsSync would miss it.
    lstatSync(path.join(root, output));
    outputExists = true;
} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (outputExists) throw Error('Existing output ownership is unsupported.');
export default defineConfig({
    testDir: './tests/final-artifact',
    testMatch: 'web-startup.spec.ts',
    globalSetup: './tests/final-artifact/web-startup-setup.ts',
    outputDir: path.join(root, output),
    reporter: [['json', { outputFile: path.join(root, output, 'report.json') }]],
    workers: 1,
    retries: 0,
    timeout: 90_000,
    globalTimeout: 120_000,
    use: {
        browserName: engine,
        launchOptions: engine === 'chromium' ? { chromiumSandbox: true } : {},
        trace: 'off',
        screenshot: 'off',
        video: 'off',
    },
});
