import { test, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';
import { gatewayFixture } from '../fixtures/gateway';
import { consoleFixture } from '../fixtures/ssh-console';
import type {} from '../fixtures/console-browser';

const flowRegion = (page: Page) => page.getByRole('region', { name: 'Automation', exact: true });
const stage = (flow: Locator, label: string) =>
    flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(label) })
        .click();
async function showConsole(page: Page) {
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = flowRegion(page);
    await stage(flow, 'Connection');
    await flow.getByLabel('SSH execution mode', { exact: true }).selectOption('console');
    await expect(
        flow.getByRole('heading', { name: 'Stored SSH console results', exact: true }),
    ).toBeVisible();
    await stage(flow, 'Timing');
    await expect(flow.getByLabel('Capture device time', { exact: true })).toHaveCount(0);
    await expect(
        flow.getByText(
            'Device time capture is unavailable in console mode. Console records use local receive time.',
            { exact: true },
        ),
    ).toBeVisible();
    await stage(flow, 'Connection');
    return flow;
}
async function connect(page: Page, gateway: Awaited<ReturnType<typeof gatewayFixture>>) {
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const modal = page.getByRole('dialog', { name: 'Connect a Linux device' });
    await modal.getByLabel('Gateway HTTPS address').fill(gateway.url);
    await modal.getByLabel('Gateway access token').fill(gateway.token);
    await modal.getByLabel('Hostname or IP address').fill(gateway.options.host);
    await modal.getByLabel('Port', { exact: true }).fill(String(gateway.options.port));
    await modal.getByLabel('SSH username').fill(gateway.options.username);
    await modal.getByLabel('Password', { exact: true }).fill(gateway.options.password);
    await modal.getByRole('button', { name: 'Read fingerprint' }).click();
    await expect(modal.locator('.fingerprint-panel code')).toHaveText(gateway.pinned);
    await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
}
test('real results UI keeps off-page selection, finds full output, exports exact evidence and confirms deletion', async ({
    page,
    browserName,
}, info) => {
    await page.goto('/');
    const seeded = await page.evaluate(async () => {
        const source = '/tests/fixtures/console-browser.ts';
        await import(source);
        const seeded = await window.consoleQA.seed();
        window.consoleQA.trackOwners();
        return seeded;
    });
    const flow = await showConsole(page),
        results = flow.getByRole('region', { name: 'Stored SSH console results', exact: true });
    await expect(results.locator('.console-result-card')).toHaveCount(25);
    const first = results.getByRole('checkbox').first();
    const firstId = await first.getAttribute('aria-label');
    await first.check();
    await results.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(results.locator('.console-result-card')).toHaveCount(5);
    await results.getByRole('checkbox').first().check();
    await expect(results).toContainText('2 selected across pages');
    await results.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(results.getByRole('checkbox', { name: firstId!, exact: true })).toBeChecked();
    await results
        .getByLabel('Search all stored console output', { exact: true })
        .fill('ui-beyond-preview');
    await expect(results.locator('.console-result-card')).toHaveCount(1);
    await results.getByRole('button', { name: 'Preview flow', exact: true }).click();
    const preview = results.getByRole('region', { name: 'Console flow preview', exact: true });
    await expect(preview).toContainText('Preview clipped');
    await expect(preview).not.toContainText('UI-BEYOND-PREVIEW');
    expect(await preview.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).consoleInjected)).toBeUndefined();
    const downloadEvent = page.waitForEvent('download');
    await results.getByRole('button', { name: 'Export console evidence', exact: true }).click();
    const download = await downloadEvent;
    expect(await download.failure()).toBeNull();
    const report = JSON.parse(await fs.readFile((await download.path())!, 'utf8'));
    expect(report.mode).toBe('console');
    expect(report.captures).toHaveLength(1);
    expect(report.captures[0].capture.header.id).toBe(seeded.largeId);
    const raw = Buffer.concat(
        report.captures[0].records
            .filter((r: any) => r.kind === 'observation')
            .map((r: any) => Buffer.from(r.base64, 'base64')),
    );
    expect(raw.toString()).toContain('UI-BEYOND-PREVIEW');
    expect(raw.length).toBeGreaterThan(128 * 1024);
    await expect(
        results.getByRole('button', { name: 'Export console evidence', exact: true }),
    ).toBeEnabled();
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({
        path: info.outputPath('console-results-' + browserName + '-wide.png'),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        width: document.documentElement.scrollWidth,
        overflow: Array.from(document.querySelectorAll('body *'))
            .filter((e) => e.getClientRects().length)
            .map((e) => ({
                tag: e.tagName,
                className: e.className,
                text: e.textContent?.slice(0, 80),
                x: e.getBoundingClientRect().x,
                right: e.getBoundingClientRect().right,
                width: e.getBoundingClientRect().width,
            }))
            .filter((e) => e.right > innerWidth + 1 || e.x < -1)
            .slice(0, 30),
    }));
    await info.attach('narrow-layout', {
        body: JSON.stringify(layout, null, 2),
        contentType: 'application/json',
    });
    await page.screenshot({
        path: info.outputPath('console-results-' + browserName + '-narrow.png'),
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    await page.screenshot({
        path: info.outputPath('console-results-' + browserName + '-narrow.png'),
    });
    await results
        .getByRole('button', { name: 'Clear selected console flows', exact: true })
        .click();
    await results.getByRole('button', { name: 'Keep captures', exact: true }).click();
    await expect(results).toContainText('2 selected across pages');
    await results
        .getByRole('button', { name: 'Clear selected console flows', exact: true })
        .click();
    await results
        .getByRole('button', { name: 'Delete selected console flows', exact: true })
        .click();
    await expect(results).toContainText('Deleted 2 retained console flows.');
    await results
        .getByRole('button', { name: 'Clear all retained console flows', exact: true })
        .click();
    await results
        .getByRole('button', { name: 'Delete all retained console flows', exact: true })
        .click();
    await expect(results).toContainText('Deleted 28 retained console flows.');
    for (let cycle = 0; cycle < 3; cycle++) {
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await expect
            .poll(() => page.evaluate(() => window.consoleQA.owners()))
            .toEqual({ rendererJournals: 0, heldLocks: [], pendingLocks: [] });
        await page.getByRole('button', { name: 'Automation', exact: true }).click();
        await expect
            .poll(() =>
                page.evaluate(async () => (await window.consoleQA.owners()).rendererJournals),
            )
            .toBe(1);
        await expect(results.locator('.console-result-card')).toHaveCount(0);
    }
    await page.reload();
    const again = await showConsole(page);
    await expect(again.locator('.console-result-card')).toHaveCount(0);
});
test('actual authenticated gateway and browser journal keep Script/Enter/Enter/Script in one owned console', async ({
    page,
}) => {
    const model = consoleFixture({ fragment: 4 });
    await page.goto('/');
    const gateway = await gatewayFixture(undefined, {
        ...model,
        origin: new URL(page.url()).origin,
    });
    try {
        await connect(page, gateway);
        // The application keeps its separate Terminal shell open across navigation.
        await expect.poll(() => model.state.opens).toBe(1);
        const terminalShells = model.state.opens;
        const flow = await showConsole(page);
        await flow
            .getByLabel('SSH shell prompt alternatives', { exact: true })
            .fill('fixture:/root# \nfixture:/# ');
        await stage(flow, 'Commands');
        await flow.getByLabel('Command 1 script', { exact: true }).fill('cd /');
        for (let ordinal = 2; ordinal <= 4; ordinal++) {
            await flow.getByRole('button', { name: 'Add command', exact: true }).click();
            if (ordinal < 4)
                await flow
                    .getByLabel('Command ' + ordinal + ' SSH input', { exact: true })
                    .selectOption('send-enter');
            else await flow.getByLabel('Command 4 script', { exact: true }).fill('pwd');
        }
        await stage(flow, 'Timing');
        await flow.getByLabel('Command 3 delay', { exact: true }).fill('2');
        await stage(flow, 'Review');
        await flow.getByRole('button', { name: 'Run once', exact: true }).click();
        await expect.poll(() => model.state.inputs.length).toBeGreaterThan(0);
        await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
        const viewer = page.getByRole('dialog', { name: 'Automation flow', exact: true });
        await expect(viewer).toContainText('combined PTY');
        await expect(viewer).toContainText('process exit status is unavailable');
        const graphEvent = page.waitForEvent('download');
        await viewer.getByRole('button', { name: 'Export SVG', exact: true }).click();
        const graphDownload = await graphEvent;
        expect(await graphDownload.failure()).toBeNull();
        const graphText = await fs.readFile((await graphDownload.path())!, 'utf8');
        const graph = await page.evaluate((xml) => {
            const document = new DOMParser().parseFromString(xml, 'image/svg+xml');
            return {
                parseErrors: document.querySelectorAll('parsererror').length,
                text: document.documentElement.textContent,
            };
        }, graphText);
        expect(graph.parseErrors).toBe(0);
        expect(graph.text).toContain('combined PTY');
        expect(graph.text).toContain('Completion criterion:');
        expect(graph.text).toContain('Send Enter (exact CR)');
        await viewer.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await expect(viewer).toHaveCount(0);
        await page.getByRole('button', { name: 'Automation', exact: true }).click();
        await expect(flow.getByRole('button', { name: 'Run once', exact: true })).toBeEnabled({
            timeout: 20000,
        });
        await expect(flow.locator('.automation-state')).toContainText('Flow finished');
        await expect.poll(() => model.state.closes).toBe(1);
        expect(model.state.opens - terminalShells).toBe(1);
        expect(Buffer.concat(model.state.inputs).toString()).toBe('cd /\r\r\rpwd\r');
        expect(model.state.directories).toEqual(['/root', '/']);
        const results = flow.getByRole('region', {
            name: 'Stored SSH console results',
            exact: true,
        });
        await expect(results.locator('.console-result-card')).toHaveCount(1);
        await expect(results.locator('.console-result-card')).toContainText('Capture complete');
        await results.getByRole('button', { name: 'Preview flow', exact: true }).click();
        await expect(results.getByRole('region', { name: 'Console flow preview' })).toContainText(
            'Input write dispatched.',
        );
        await expect(results.getByRole('region', { name: 'Console flow preview' })).toContainText(
            'Send Enter',
        );
        const event = page.waitForEvent('download');
        await results.getByRole('button', { name: 'Export console evidence', exact: true }).click();
        const download = await event;
        expect(await download.failure()).toBeNull();
        const report = JSON.parse(await fs.readFile((await download.path())!, 'utf8'));
        const records = report.captures[0].records;
        expect(report.captures[0].capture.header.receiveTimeSource).toBe('gateway');
        expect(
            records.filter((r: any) => r.kind === 'outcome').map((r: any) => r.exitCode),
        ).toEqual([null, null, null, null]);
        expect(
            records
                .filter((r: any) => r.kind === 'segment-start' && r.segment.kind === 'command')
                .map((r: any) => Buffer.from(r.segment.requestBase64, 'base64').toString()),
        ).toEqual(['cd /\r', '\r', '\r', 'pwd\r']);
    } finally {
        await gateway.close();
    }
});
test('wrong shell criterion never auto-confirms; an explicit role correction rearms a new owned console', async ({
    page,
}) => {
    const model = consoleFixture({ fragment: 4 });
    await page.goto('/');
    const gateway = await gatewayFixture(undefined, {
        ...model,
        origin: new URL(page.url()).origin,
    });
    try {
        await connect(page, gateway);
        await expect.poll(() => model.state.opens).toBe(1);
        const terminalShells = model.state.opens;
        const flow = await showConsole(page);
        await flow
            .getByLabel('SSH shell prompt alternatives', { exact: true })
            .fill('fixture:/root# ');
        await stage(flow, 'Commands');
        await flow.getByLabel('Command 1 script', { exact: true }).fill('confirm-fixture');
        await flow.getByRole('button', { name: 'Add command', exact: true }).click();
        await flow.getByLabel('Command 2 SSH input', { exact: true }).selectOption('send-enter');
        await stage(flow, 'Timing');
        await flow.getByLabel('Command timeout', { exact: true }).fill('2');
        await stage(flow, 'Review');
        await flow.getByRole('button', { name: 'Run once', exact: true }).click();
        await expect.poll(() => model.state.closes).toBe(1);
        expect(model.state.confirmations).toBe(0);
        expect(Buffer.concat(model.state.inputs).toString()).toBe('confirm-fixture\r');
        await expect(flow.getByRole('button', { name: 'Run once', exact: true })).toBeEnabled();
        await expect(flow.locator('.automation-state')).toContainText(/paused|cancelled/i);
        await stage(flow, 'Commands');
        await flow.getByLabel('Command 1 override completion', { exact: true }).check();
        await flow
            .getByLabel('Command 1 completion role', { exact: true })
            .selectOption('intermediate-input-prompt');
        await flow
            .getByLabel('Command 1 completion alternatives', { exact: true })
            .fill('Proceed fixture [Enter]? ');
        await stage(flow, 'Review');
        await flow.getByRole('button', { name: 'Run once', exact: true }).click();
        await expect.poll(() => model.state.closes).toBe(2);
        expect(model.state.opens - terminalShells).toBe(2);
        expect(model.state.confirmations).toBe(1);
        expect(Buffer.concat(model.state.inputs).toString()).toBe(
            'confirm-fixture\rconfirm-fixture\r\r',
        );
        await expect(flow.getByRole('button', { name: 'Run once', exact: true })).toBeEnabled();
        await expect(flow.locator('.automation-state')).toContainText('Flow finished');
    } finally {
        await gateway.close();
    }
});
