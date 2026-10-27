import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests/ui',
    testMatch: ['automation-flow.spec.ts', 'automation-flow-export.spec.ts'],
    workers: 1,
    timeout: 60000,
    use: {
        baseURL: 'http://127.0.0.1:5181',
        viewport: { width: 1440, height: 1050 },
        trace: 'off',
    },
    projects: [
        { name: 'chromium', use: { browserName: 'chromium' } },
        { name: 'firefox', use: { browserName: 'firefox' } },
        { name: 'webkit', use: { browserName: 'webkit' } },
    ],
    webServer: {
        command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5181 --strictPort',
        url: 'http://127.0.0.1:5181',
        reuseExistingServer: true,
    },
    outputDir: 'evidence/ui-results',
    reporter: [['list'], ['json', { outputFile: 'evidence/ui-results.json' }]],
});
