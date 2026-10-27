import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests/ui',
    testMatch: 'stored-ssh-results.spec.ts',
    workers: 1,
    timeout: 90000,
    outputDir: './test-results/ssh-stream',
    reporter: 'list',
    use: {
        baseURL: 'http://127.0.0.1:62894',
        viewport: { width: 1440, height: 1050 },
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'npm run dev -- --port 62894 --strictPort',
        url: 'http://127.0.0.1:62894',
        reuseExistingServer: false,
    },
    projects: (['chromium', 'firefox', 'webkit'] as const).map((browserName) => ({
        name: 'ssh-stream-' + browserName,
        use: { browserName },
    })),
});
