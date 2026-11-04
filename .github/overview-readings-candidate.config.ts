import { defineConfig } from '@playwright/test';
import path from 'node:path';

const workspace = process.env.GITHUB_WORKSPACE;
const application = process.env.HUB_OVERVIEW_APPLICATION;
const scope = process.env.HUB_OVERVIEW_SCOPE;
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
    testMatch: ['overview-unknown-readings.spec.ts'],
    grep: /(?:^| )overview-unknown-readings\.spec\.ts Overview renders unknown uptime and memory without false zero and recovers genuine values$/,
    fullyParallel: false,
    forbidOnly: true,
    workers: 1,
    retries: 0,
    repeatEach: 1,
    maxFailures: 1,
    timeout: 90_000,
    globalTimeout: 300_000,
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
        timeout: 90_000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
