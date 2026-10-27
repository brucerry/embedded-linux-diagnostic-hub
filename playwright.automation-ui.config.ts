import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests/ui',
    testMatch: ['automation.spec.ts', 'automation-arming.spec.ts'],
    workers: 2,
    outputDir: './test-results/automation-ui',
    reporter: 'list',
    use: {
        baseURL: 'http://127.0.0.1:62895',
        browserName: 'chromium',
        viewport: { width: 1440, height: 1050 },
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'npm run dev -- --port 62895 --strictPort',
        url: 'http://127.0.0.1:62895',
        reuseExistingServer: false,
    },
});
