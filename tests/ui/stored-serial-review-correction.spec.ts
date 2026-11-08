import { test, expect, type Page, type Locator } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import { installSerial } from './fixtures/serial';
import type { CaptureScope } from '../../shared/capture-query';

declare global {
    interface Window {
        visibleReview: {
            hold: 'export' | 'delete' | null;
            held: boolean;
            release?: () => void;
            calls: string[];
            completed: number;
            exports: { scope: CaptureScope; ids: string[] }[];
        };
    }
}
const stage = (flow: Locator, name: string) =>
    flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(name) })
        .click();
async function prepare(page: Page, pausedSearch = false) {
    await installDesktop(page);
    await installSerial(page);
    await page.addInitScript(() => {
        const api = window.diagnosticHub!,
            original = api.captureStorage!;
        window.visibleReview = { hold: null, held: false, calls: [], completed: 0, exports: [] };
        api.automationConnection = () => 'review-synthetic-ssh';
        api.cancelAutomation = async () => {};
        api.runAutomation = async () => {
            throw Error('The review tests must never send SSH commands.');
        };
        api.captureStorage = async (request) => {
            const state = window.visibleReview,
                r = request as { op?: string; scope?: CaptureScope };
            if (r.op !== 'export' && r.op !== 'delete') return original(request);
            state.calls.push(r.op);
            if (state.hold === r.op) {
                state.hold = null;
                state.held = true;
                await new Promise<void>((resolve) => {
                    state.release = resolve;
                });
            }
            try {
                const reply = await original(request);
                if (r.op === 'export' && reply.ok) {
                    // Two small synthetic rows only: inspect the same real streaming report
                    // used by the desktop fixture, with the exact request scope.
                    const storePath = new URL(
                            '/src/features/automation/capture/indexeddb-store.ts',
                            location.href,
                        ).href,
                        reportPath = new URL('/shared/capture-report.ts', location.href).href;
                    const [{ IndexedDbCaptureStore }, { streamCaptureReport }] = await Promise.all([
                        import(storePath),
                        import(reportPath),
                    ]);
                    const store = await IndexedDbCaptureStore.open();
                    try {
                        let json = '';
                        for await (const bytes of streamCaptureReport(store, 'json', r.scope)) {
                            json += new TextDecoder().decode(bytes);
                            if (json.length > 32768)
                                throw Error(
                                    'Review fixture exceeded its bounded observation budget.',
                                );
                        }
                        const data = JSON.parse(json);
                        state.exports.push({
                            scope: data.scope,
                            ids: data.captures.map(
                                (row: { capture: { id: string } }) => row.capture.id,
                            ),
                        });
                    } finally {
                        await store.close();
                    }
                }
                return reply;
            } finally {
                state.completed++;
            }
        };
    });
    if (pausedSearch) await page.clock.install({ time: new Date('2028-02-29T11:59:00Z') });
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow.getByLabel('Automation transport').selectOption('serial');
    await expect(
        flow.getByRole('button', { name: 'Refresh stored results', exact: true }),
    ).toBeEnabled();
    await flow.getByLabel('Serial completion prompt').fill('board# ');
    await stage(flow, 'Commands');
    await flow.getByLabel('Command 1 script').fill('never execute review draft');
    await stage(flow, 'Review');
    const ids = await page.evaluate(async () => {
        const storePath = '/src/features/automation/capture/indexeddb-store.ts',
            writerPath = '/shared/capture-writer.ts';
        const [{ IndexedDbCaptureStore }, { CaptureWriter }] = await Promise.all([
            import(storePath),
            import(writerPath),
        ]);
        const store = await IndexedDbCaptureStore.open(),
            ids: string[] = [];
        try {
            for (const [index, output] of ['needle', 'ordinary'].entries()) {
                const writer = await CaptureWriter.begin(store, {
                    transport: 'serial',
                    receiveTimeSource: 'local-client',
                    runId: 'review',
                    stepId: 'step-' + index,
                    name: 'Row ' + index,
                    command: 'fixture',
                    startedAt: '2026-10-15T00:00:00.000Z',
                });
                await writer.append(
                    new TextEncoder().encode(output),
                    '2026-10-15T00:00:00.000Z',
                    'serial',
                );
                ids.push((await writer.finish('prompt-observed')).id);
            }
        } finally {
            await store.close();
        }
        return ids;
    });
    await flow.getByRole('button', { name: 'Refresh stored results', exact: true }).click();
    await expect(flow.locator('tbody tr')).toHaveCount(2);
    await expect(flow.getByRole('button', { name: 'Start flow', exact: true })).toBeEnabled();
    if (pausedSearch) {
        const now = await page.evaluate(() => Date.now());
        await page.clock.pauseAt(new Date(now + 1000));
    }
    return { flow, ids };
}

for (const change of ['type', 'clear'] as const)
    test(`immediate filtered export snapshots current ${change} input before the display debounce`, async ({
        page,
    }) => {
        const { flow, ids } = await prepare(page, true),
            input = flow.getByLabel('Search automation results');
        if (change === 'clear') {
            await input.fill('needle');
            await page.clock.runFor(300);
            await expect(flow.locator('tbody tr')).toHaveCount(1);
        }
        await input.fill(change === 'type' ? 'needle' : '');
        // Browser time is paused: the 250 ms display debounce cannot race this action.
        await flow.getByRole('button', { name: 'Download QA results', exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.visibleReview.exports.length)).toBe(1);
        const exported = await page.evaluate(() => window.visibleReview.exports[0]);
        expect(exported.ids).toEqual(change === 'type' ? [ids[0]] : ids);
        expect(exported.scope.filter?.query).toBe(change === 'type' ? 'needle' : undefined);
        expect(await page.evaluate(() => window.serialTest.writes)).toEqual([]);
    });

for (const operation of ['export', 'delete'] as const)
    test(`transport changes retain the ${operation} owner until delayed cleanup settles`, async ({
        page,
    }) => {
        const { flow, ids } = await prepare(page),
            start = flow.getByRole('button', { name: 'Start flow', exact: true });
        if (operation === 'delete')
            await flow.locator('tr[data-capture-id="' + ids[0] + '"] input[type=checkbox]').check();
        await page.evaluate((op) => {
            window.visibleReview.hold = op;
        }, operation);
        try {
            await flow
                .getByRole('button', {
                    name:
                        operation === 'export' ? 'Download QA results' : 'Delete selected captures',
                    exact: true,
                })
                .click();
            await expect.poll(() => page.evaluate(() => window.visibleReview.held)).toBe(true);
            await expect(start).toBeDisabled();
            await stage(flow, 'Connection');
            await flow.getByLabel('Automation transport').selectOption('ssh');
            await stage(flow, 'Review');
            await expect(start).toBeDisabled();
            await stage(flow, 'Connection');
            await flow.getByLabel('Automation transport').selectOption('serial');
            await stage(flow, 'Review');
            await expect(flow.locator('.automation-results')).toHaveAttribute('aria-busy', 'false');
            const download = flow.getByRole('button', { name: 'Download QA results', exact: true });
            // An HTML-disabled action cannot create a replacement operation that clears shared busy state.
            await download.evaluate((button) => (button as HTMLButtonElement).click());
            const calls = await page.evaluate(() => window.visibleReview.calls.length);
            if (calls > 1)
                await expect
                    .poll(() => page.evaluate(() => window.visibleReview.completed))
                    .toBeGreaterThan(0);
            await expect(start).toBeDisabled();
            expect(calls).toBe(1);
            await expect(download).toBeDisabled();
            await expect(
                flow.getByRole('button', { name: 'Clear retained results', exact: true }),
            ).toBeDisabled();
            expect(await page.evaluate(() => window.serialTest.writes)).toEqual([]);
            await page.evaluate(() => window.visibleReview.release!());
            await expect.poll(() => page.evaluate(() => window.visibleReview.completed)).toBe(1);
            await expect(start).toBeEnabled();
            await expect(flow.locator('tbody tr')).toHaveCount(operation === 'delete' ? 1 : 2);
            expect(await page.evaluate(() => window.serialTest.writes)).toEqual([]);
        } finally {
            await page.evaluate(() => window.visibleReview.release?.());
        }
    });
