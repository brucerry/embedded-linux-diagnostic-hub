import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests/ui',
    outputDir: './test-results/capture',
    workers: 3,
    use: {
        viewport: { width: 1440, height: 1050 },
        trace: 'retain-on-failure',
        baseURL: 'http://127.0.0.1:62887',
    },
    projects: [
        ...(['chromium', 'firefox', 'webkit'] as const).map((browserName) => ({
            name: 'storage-' + browserName,
            testMatch: 'capture-storage.spec.ts',
            use: { browserName },
        })),
        {
            name: 'arming-chromium',
            testMatch: 'automation-arming.spec.ts',
            use: { browserName: 'chromium' },
        },
    ],
    webServer: {
        command: 'npm run dev -- --port 62887 --strictPort',
        url: 'http://127.0.0.1:62887',
        reuseExistingServer: false,
    },
    reporter: 'list',
});
