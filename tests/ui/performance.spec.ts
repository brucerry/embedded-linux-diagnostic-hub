import { expect, test } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';

// Keep the worker result pending to verify the UI stays interactive throughout preparation.
test('large process snapshots are prepared in a worker while the original animations and hover remain active', async ({
    page,
}) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installDesktop(page);
    await page.addInitScript(() => {
        const NativeWorker = window.Worker;
        const state = { workers: 0, hold: false, release: () => {}, bytes: 0 };
        (window as any).historyTest = state;
        window.Worker = class extends NativeWorker {
            constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options);
                if (options?.name !== 'diagnostic-history') return;
                state.workers++;
                this.addEventListener('message', (event) => {
                    if (!state.hold) return;
                    event.stopImmediatePropagation();
                    state.release = () => {
                        state.hold = false;
                        this.dispatchEvent(new MessageEvent('message', { data: event.data }));
                    };
                });
            }
        };
        const collect = window.diagnosticHub!.collect;
        window.diagnosticHub!.collect = async () => {
            const snapshot = await collect();
            const process = snapshot.results.find((r) => r.id === 'processes')!;
            process.stdout =
                'HUB_PROCESS_RESOURCES_V1\nSystemCPU: 100000\nMemTotal: 1024000 kB\n' +
                Array.from(
                    { length: 1500 },
                    (_, i) =>
                        `PID: ${i + 1}\nName: daemon-${i}\nState: S\nVmRSS: 1024 kB\nVmSize: 2048 kB\nVmSwap: 0 kB\n${i + 1} (daemon-${i}) ${Array.from({ length: 22 }, (_, j) => (j === 0 ? 'S' : j === 11 ? 100 : j === 19 ? 200 : 0)).join(' ')}\n`,
                ).join('');
            state.bytes = process.stdout.length;
            return snapshot;
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await page.evaluate(() => {
        (window as any).historyTest.hold = true;
    });
    await page.getByRole('button', { name: 'Refresh snapshot' }).click();
    await expect(page.locator('.bits-art')).toHaveAttribute('data-transfer', 'active');
    await expect.poll(() => page.evaluate(() => (window as any).historyTest.workers)).toBe(2);
    expect(await page.evaluate(() => (window as any).historyTest.bytes)).toBeGreaterThan(200000);
    await expect(
        page.getByRole('button', { name: 'Disconnect device', exact: true }),
    ).toBeDisabled();
    const bit = page.locator('.transfer-bit').first();
    const before = await bit.evaluate((el) => el.getAnimations()[0].currentTime as number);
    await expect
        .poll(() => bit.evaluate((el) => el.getAnimations()[0].currentTime as number))
        .toBeGreaterThan(before + 100);
    const tile = page.locator('.hardware-tile').first();
    await tile.hover();
    await expect
        .poll(() =>
            tile.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42),
        )
        .toBeLessThan(-2);
    await page.evaluate(() => (window as any).historyTest.release());
    await expect(page.getByRole('button', { name: 'Refresh snapshot' })).toBeEnabled();
    await expect(page.locator('.bits-art')).toHaveAttribute('data-transfer', 'idle');
    await page.getByRole('switch', { name: 'Live updates' }).click();
    await page.getByRole('button', { name: 'Processes', exact: true }).click();
    await page.locator('.probe-card').click();
    await page.getByRole('tab', { name: 'Graph view' }).click();
    await expect(page.locator('.graph-summary')).toContainText('1 MiB');
    await expect(page.locator('.graph-series option')).toHaveCount(4500);
});

test('worker restrictions use the yielding fallback without disabling collection or graph views', async ({
    page,
}) => {
    await installDesktop(page);
    await page.addInitScript(() => {
        window.Worker = class {
            constructor() {
                throw new Error('Workers restricted');
            }
        } as unknown as typeof Worker;
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Connect a Linux device' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Diagnostics 36' }).click();
    await page
        .locator('.probe-card')
        .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
        .click();
    await page.getByRole('tab', { name: 'Graph view' }).click();
    await expect(page.locator('g[data-series="used"] circle')).toHaveCount(1);
    await expect(page.locator('g[data-series="free"] circle')).toHaveCount(1);
});
