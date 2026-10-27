import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests/ui',
    testMatch: ['terminal-visual-refinement.spec.ts', 'serial.spec.ts', 'terminal.spec.ts'],
    grep: /Serial and SSH visual audit|scene motion pauses|Serial beach motion|recoverable target break|terminal starts on connection and supports animated copy|full terminal viewport contains|SSH and Serial terminal layouts match/,
    workers: 1,
    timeout: 60000,
    use: {
        baseURL: 'http://127.0.0.1:5189',
        viewport: { width: 1440, height: 1050 },
        trace: 'retain-on-failure',
    },
    projects: ['chromium', 'firefox', 'webkit'].map((name) => ({
        name,
        use: { browserName: name as 'chromium' | 'firefox' | 'webkit' },
    })),
    webServer: {
        command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5189 --strictPort',
        url: 'http://127.0.0.1:5189',
        reuseExistingServer: false,
    },
    outputDir: 'evidence/ui-results',
    reporter: [['list'], ['json', { outputFile: 'evidence/ui-results.json' }]],
});
