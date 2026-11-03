import { defineConfig } from '@playwright/test';
import path from 'node:path';

const workspace = process.env.GITHUB_WORKSPACE;
const application = process.env.HUB_AUTOMATION_RETIREMENT_APPLICATION;
const scope = process.env.HUB_AUTOMATION_RETIREMENT_SCOPE;
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
    testMatch: 'automation-retirement.spec.ts',
    grep: /(?:^| )automation-retirement\.spec\.ts (?:Serial Cancel after dispatch joins the pending write and port close before releasing its lease|Serial recoverable break retains the port while explicit Disconnect joins held write and close acknowledgements)$/,
    fullyParallel: false,
    forbidOnly: true,
    workers: 1,
    retries: 0,
    repeatEach: 1,
    maxFailures: 1,
    timeout: 30_000,
    globalTimeout: 120_000,
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
        timeout: 30_000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
