import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests/ui',
    testMatch: 'serial-capture-integration.spec.ts',
    workers: 3,
    timeout: 30000,
    outputDir: './test-results/serial-capture',
    reporter: 'list',
    use: { trace: 'retain-on-failure' },
    projects: (['chromium', 'firefox', 'webkit'] as const).map((browserName) => ({
        name: 'serial-capture-' + browserName,
        use: { browserName },
    })),
});
