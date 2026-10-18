import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests/ui',
    testMatch: 'stored-serial-results.spec.ts',
    workers: 3,
    timeout: 60000,
    outputDir: './test-results/stored-ui',
    reporter: 'list',
    use: {
        baseURL: 'http://127.0.0.1:62893',
        viewport: { width: 1440, height: 1050 },
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'npm run dev -- --port 62893 --strictPort',
        url: 'http://127.0.0.1:62893',
        reuseExistingServer: false,
    },
    projects: (['chromium', 'firefox', 'webkit'] as const).map((browserName) => ({
        name: 'stored-ui-' + browserName,
        use: { browserName },
    })),
});
