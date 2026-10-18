import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests/ui',
    testMatch: 'stored-serial-review-correction.spec.ts',
    workers: 3,
    outputDir: './test-results/visible-review',
    reporter: 'list',
    use: {
        baseURL: 'http://127.0.0.1:62907',
        viewport: { width: 1440, height: 1050 },
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'npm run dev -- --port 62907 --strictPort',
        url: 'http://127.0.0.1:62907',
        reuseExistingServer: false,
    },
    projects: (['chromium', 'firefox', 'webkit'] as const).map((browserName) => ({
        name: 'visible-review-' + browserName,
        use: { browserName },
    })),
});
