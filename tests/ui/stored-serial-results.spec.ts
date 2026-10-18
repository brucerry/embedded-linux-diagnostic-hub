import { test, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';
import { installSerial } from './fixtures/serial';
const stage = (flow: Locator, name: string) =>
    flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(name) })
        .click();
async function showStored(page: Page) {
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow.getByLabel('Automation transport').selectOption('serial');
    await expect(
        flow.getByRole('button', { name: 'Refresh stored results', exact: true }),
    ).toBeEnabled();
    return flow;
}
async function prepare(page: Page) {
    await installSerial(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const terminal = page.getByRole('region', { name: 'Local serial terminal' });
    await terminal.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await terminal.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(terminal.getByText('Ready', { exact: true })).toBeVisible();
    const flow = await showStored(page);
    await flow.getByLabel('Serial completion prompt').fill('board# ');
    await stage(flow, 'Commands');
    await flow.getByLabel('Step 1 name (optional)').fill('First capture');
    await flow.getByLabel('Command 1 script').fill('first');
    await flow.getByRole('button', { name: 'Add command', exact: true }).click();
    await flow.getByLabel('Step 2 name (optional)').fill('Second capture');
    await flow.getByLabel('Command 2 script').fill('second');
    await stage(flow, 'Review');
    return flow;
}
async function download(page: Page, flow: Locator) {
    const event = page.waitForEvent('download');
    await flow.getByRole('button', { name: 'Download QA results', exact: true }).click();
    const file = await event;
    expect(await file.failure()).toBeNull();
    return JSON.parse(await fs.readFile((await file.path())!, 'utf8'));
}

test('visible Serial flow persists full bytes/outcomes, reloads without reopening a port, exports beyond the preview and clears only explicitly', async ({
    page,
}, info) => {
    let flow = await prepare(page);
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.serialTest.writes.length)).toBe(1);
    await page.evaluate(() => {
        for (let index = 0; index < 18; index++)
            window.serialTest.push([...new Uint8Array(16384).fill(65)]);
        window.serialTest.push([...new TextEncoder().encode('\r\nBEYOND-PREVIEW\r\nboard# ')]);
    });
    await expect.poll(() => page.evaluate(() => window.serialTest.writes.length)).toBe(2);
    await page.evaluate(() =>
        window.serialTest.push([...new TextEncoder().encode('SECOND-RESPONSE\r\nboard# ')]),
    );
    await expect(flow.locator('.automation-state')).toContainText('Flow finished');
    await expect(flow.locator('tbody tr')).toHaveCount(2);
    await expect(flow.locator('tbody')).toContainText('First 8 KiB');
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(1);
    await flow.getByLabel('Search automation results').fill('beyond-preview');
    await expect(flow.locator('tbody tr')).toHaveCount(1);
    await expect(flow.locator('tbody')).not.toContainText('BEYOND-PREVIEW');
    const data = await download(page, flow);
    expect(data.captures).toHaveLength(1);
    const row = data.captures[0],
        raw = Buffer.concat(
            row.rawObservations.map((frame: { base64: string }) =>
                Buffer.from(frame.base64, 'base64'),
            ),
        );
    expect(raw.length).toBeGreaterThan(65536);
    expect(raw.toString()).toContain('BEYOND-PREVIEW');
    expect(row.captureComplete).toBe(true);
    expect(row.outcome.completion).toBe('prompt-observed');
    expect(row.outcome.exitCode).toBeNull();
    expect(row.capture.header.requestBase64).toBe(Buffer.from('first\r').toString('base64'));
    expect(row.capture.firstReceivedAt).toBe(row.rawObservations[0].receivedAt);
    expect(row.capture.lastReceivedAt).toBe(row.rawObservations.at(-1).receivedAt);
    await page.screenshot({ path: info.outputPath('stored-serial-filtered.png'), fullPage: true });
    await page.reload();
    flow = await showStored(page);
    await expect(flow.locator('tbody tr')).toHaveCount(2);
    expect(await page.evaluate(() => window.serialTest.opens)).toBe(0);
    expect(await page.evaluate(() => window.serialTest.writes.length)).toBe(0);
    await flow.getByRole('button', { name: 'Clear retained results', exact: true }).click();
    await expect(flow.locator('tbody tr')).toHaveCount(2);
    await flow.getByRole('button', { name: 'Keep captures', exact: true }).click();
    await expect(flow.locator('tbody tr')).toHaveCount(2);
    await flow.getByRole('button', { name: 'Clear retained results', exact: true }).click();
    await flow
        .getByRole('button', { name: 'Delete all stored Serial captures', exact: true })
        .click();
    await expect(flow.locator('tbody tr')).toHaveCount(0);
    await expect(flow.getByRole('status')).toContainText('Deleted 2');
});

test('paged UI exports exact off-screen selections and full filtered matches rather than rendered rows', async ({
    page,
}) => {
    await installSerial(page);
    await page.goto('/');
    const flow = await showStored(page);
    const ids = await page.evaluate(async () => {
        const storePath = '/src/features/automation/capture/indexeddb-store.ts',
            writerPath = '/shared/capture-writer.ts';
        const [{ IndexedDbCaptureStore }, { CaptureWriter }] = await Promise.all([
                import(storePath),
                import(writerPath),
            ]),
            store = await IndexedDbCaptureStore.open(),
            ids: string[] = [];
        for (let index = 0; index < 35; index++) {
            const writer = await CaptureWriter.begin(store, {
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'seeded',
                stepId: 'step-' + index,
                name: 'Stored ' + index,
                command: 'fixture',
                startedAt: '2026-10-15T00:00:00.000Z',
            });
            await writer.append(
                new TextEncoder().encode(
                    (index === 0 ? 'X'.repeat(9000) : '') +
                        (index === 0 || index === 34 ? 'OFFSCREEN-NEEDLE' : 'ordinary'),
                ),
                '2026-10-15T00:00:00.000Z',
                'serial',
            );
            const capture = await writer.finish('prompt-observed');
            ids.push(capture.id);
            await store.record(capture.id, {
                id: crypto.randomUUID().replaceAll('-', ''),
                ordinal: 1,
                completedAt: '2026-10-15T00:00:00.000Z',
                localZone: 'UTC',
                durationMs: 0,
                deviceTime: null,
                completion: 'prompt-observed',
                exitCode: null,
                truncated: false,
            });
        }
        await store.close();
        return ids;
    });
    await flow.getByRole('button', { name: 'Refresh stored results', exact: true }).click();
    await expect(flow.locator('tbody tr')).toHaveCount(20);
    await flow.locator('tr[data-capture-id="' + ids[0] + '"] input[type=checkbox]').check();
    await flow.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(flow.locator('tbody tr')).toHaveCount(15);
    await flow.locator('tr[data-capture-id="' + ids[34] + '"] input[type=checkbox]').check();
    await flow.getByLabel('Export scope', { exact: true }).selectOption('selected');
    const selected = await download(page, flow);
    expect(selected.captures.map((row: { capture: { id: string } }) => row.capture.id)).toEqual([
        ids[0],
        ids[34],
    ]);
    await flow.getByLabel('Search automation results').fill('offscreen-needle');
    await expect(flow.locator('tbody tr')).toHaveCount(2);
    await flow.getByLabel('Export scope', { exact: true }).selectOption('filtered');
    const filtered = await download(page, flow);
    expect(filtered.captures.map((row: { capture: { id: string } }) => row.capture.id)).toEqual([
        ids[0],
        ids[34],
    ]);
    expect(filtered.scope.filter.query).toBe('offscreen-needle');
    await flow.getByLabel('Export scope', { exact: true }).selectOption('all');
    const all = await download(page, flow);
    expect(all.captures).toHaveLength(35);
    await flow.getByRole('button', { name: 'Delete selected captures', exact: true }).click();
    await expect(flow.getByRole('status')).toContainText('Deleted 2');
    await flow.getByLabel('Search automation results').fill('');
    await expect(flow.locator('tbody tr')).toHaveCount(20);
});

test('visible outcome-storage failure retains raw capture and suppresses the next command across reload', async ({
    page,
}) => {
    let flow = await prepare(page);
    await page.evaluate(() => {
        const original = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...args: Parameters<typeof original>) {
            if (this.name === 'results')
                throw new DOMException('Synthetic outcome quota exhausted.', 'QuotaExceededError');
            return original.apply(this, args);
        };
    });
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.serialTest.writes.length)).toBe(1);
    await page.evaluate(() =>
        window.serialTest.push([...new TextEncoder().encode('RAW-PREFIX-PRESERVED\r\nboard# ')]),
    );
    await expect(flow.locator('.automation-state')).toContainText('outcome quota');
    await expect(flow.locator('.error-banner')).toContainText('Raw capture retained');
    expect(await page.evaluate(() => window.serialTest.writes.length)).toBe(1);
    await expect(flow.locator('tbody tr')).toHaveCount(1);
    await expect(flow.locator('tbody')).toContainText('metadata-missing');
    await page.reload();
    flow = await showStored(page);
    await expect(flow.locator('tbody tr')).toHaveCount(1);
    await expect(flow.locator('tbody')).toContainText('RAW-PREFIX-PRESERVED');
    await expect(flow.locator('tbody')).toContainText('metadata-missing');
    expect(await page.evaluate(() => window.serialTest.writes.length)).toBe(0);
    const data = await download(page, flow);
    expect(data.captures[0].outcome).toBeNull();
    expect(data.captures[0].captureComplete).toBe(true);
});
