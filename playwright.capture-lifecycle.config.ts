import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests/ui',
    testMatch: 'capture-storage-lifecycle.spec.ts',
    workers: 3,
    outputDir: './test-results/capture-lifecycle',
    reporter: 'list',
    use: { baseURL: 'http://127.0.0.1:62913', trace: 'retain-on-failure' },
    webServer: {
        command: 'npm run dev -- --port 62913 --strictPort',
        url: 'http://127.0.0.1:62913',
        reuseExistingServer: false,
    },
    projects: (['chromium', 'firefox', 'webkit'] as const).map((browserName) => ({
        name: 'capture-lifecycle-' + browserName,
        use: { browserName },
    })),
});
