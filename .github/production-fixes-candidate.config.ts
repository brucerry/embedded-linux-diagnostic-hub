import { defineConfig } from '@playwright/test';
import path from 'node:path';

const workspace = process.env.GITHUB_WORKSPACE;
const application = process.env.HUB_FIXES_APPLICATION;
const scope = process.env.HUB_FIXES_SCOPE;
if (
    !workspace ||
    application !== path.join(workspace, 'application') ||
    !scope ||
    !path.isAbsolute(scope)
)
    throw Error('Missing owned candidate CI paths.');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const baseURL = 'http://127.0.0.1:5200';

export default defineConfig({
    testDir: path.join(application, 'tests/ui'),
    testMatch: ['production-evidence.spec.ts', 'ssh-cleanup-fault.spec.ts'],
    grep: /(?:^| )(?:production\-evidence\.spec\.ts unsafe numeric evidence stays unknown in structured views and exact in Standard output|ssh\-cleanup\-fault\.spec\.ts SSH rejected\-finalize requires explicit acknowledged cleanup without command replay|ssh\-cleanup\-fault\.spec\.ts SSH lost\-finalize requires explicit acknowledged cleanup without command replay|ssh\-cleanup\-fault\.spec\.ts SSH uncertain start remains blocked and incomplete without replay or fabricated cleanup)$/,
    fullyParallel: false,
    forbidOnly: true,
    workers: 1,
    retries: 0,
    repeatEach: 1,
    maxFailures: 1,
    timeout: 45_000,
    globalTimeout: 240_000,
    outputDir: path.join(scope, 'test-results'),
    reporter: [['json', { outputFile: path.join(scope, 'report.json') }]],
    use: {
        baseURL,
        browserName: 'chromium',
        channel: 'chromium',
        headless: true,
        viewport: { width: 1440, height: 1050 },
        trace: 'off',
        screenshot: 'off',
        video: 'off',
        launchOptions: {
            chromiumSandbox: true,
            ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        },
    },
    webServer: {
        command:
            `${quote(process.execPath)} ` +
            `${quote(path.join(application, 'node_modules/vite/bin/vite.js'))} ` +
            '--host 127.0.0.1 --port 5200 --strictPort',
        cwd: application,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 45_000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
