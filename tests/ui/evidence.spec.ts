import { expect, test } from '@playwright/test';
import { createReport } from '../../shared/report';
import { demoSnapshot } from '../fixtures/snapshots';

const services = {
    dnsmasq: {
        instances: {
            cfg: {
                running: false,
                pid: 321,
                command: ['/usr/sbin/dnsmasq', '-k'],
                respawn: { timeout: 5 },
                empty: null,
            },
        },
    },
    cron: {},
};
const fixtures = () => {
    const fixture = demoSnapshot();
    const set = (id: string, stdout: string) => {
        Object.assign(
            fixture.results.find((r) => r.id === id)!,
            { stdout, stderr: '', status: 'collected', exitCode: 0 },
        );
    };
    set(
        'board',
        JSON.stringify({
            model: 'Test board',
            release: { distribution: 'OpenWrt', version: '25.12' },
        }),
    );
    set('services', JSON.stringify(services));
    set(
        'interfaces',
        '1: lo: <UP> mtu 65536\n    inet 127.0.0.1/8\n2: eth0: <UP> mtu 1500\n    inet 192.168.1.1/24',
    );
    set(
        'logs',
        'Wed Sep 16 22:50:11 2026 authpriv.info dropbear[13420]: Child connection from 192.168.1.10:1767\nOct 06 12:34:56 board systemd[1]: Starting  network...\n[ 123.456789] pci 0000:00:00.0: link up',
    );
    set('uart', 'Driver did not expose structured serial port records.');
    fixture.results.find((r) => r.id === 'uart')!.stderr = 'No advanced view is available.';
    return fixture;
};

test('board and logs use parsed columns while prose keeps only raw tabs', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'structured.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(createReport(fixtures()))),
    });
    await page.getByRole('button', { name: 'Diagnostics 36' }).click();
    const open = async (title: string) => {
        await page
            .locator('.probe-card')
            .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
            .click();
        return page.getByRole('dialog');
    };
    let dialog = await open('Board identity');
    await expect(dialog.getByRole('tab', { name: 'Standard output' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await dialog.getByRole('tab', { name: 'Table view' }).click();
    await expect(dialog.locator('table')).toContainText('release.version');
    await expect(dialog.locator('table')).toContainText('25.12');
    await expect(dialog.getByRole('tab', { name: 'Tree view' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    dialog = await open('Recent system logs');
    await dialog.getByRole('tab', { name: 'Table view' }).click();
    await expect(dialog.locator('thead')).toContainText('Facility / level');
    const row = dialog.locator('tbody tr').first();
    await expect(row).toContainText('2026-09-16');
    await expect(row).toContainText('22:50:11');
    await expect(row).toContainText('dropbear');
    await expect(row).toContainText('13420');
    await expect(row).toContainText('Child connection from');
    for (const cell of await row.locator('td:not(:last-child)').all()) {
        expect(await cell.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap');
    }
    await page.keyboard.press('Escape');
    dialog = await open('UART / serial ports');
    await expect(dialog.getByRole('tab', { name: 'Table view' })).toHaveCount(0);
    await expect(dialog.getByRole('tab', { name: 'Tree view' })).toHaveCount(0);
    await expect(dialog.getByRole('tab', { name: 'Standard output' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(dialog.locator('.evidence-output')).toContainText('Driver did not expose');
    await expect(dialog.getByRole('tab')).toHaveText(['Standard output', 'Standard error']);
    await dialog.getByRole('tab', { name: 'Standard error', exact: true }).click();
    await expect(dialog.locator('.evidence-output')).toContainText(
        'No advanced view is available.',
    );
});

test('service and interface trees expand/collapse without sentence tables', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'structured.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(createReport(fixtures()))),
    });
    await page.getByRole('button', { name: 'Diagnostics 36' }).click();
    const open = async (title: string) => {
        await page
            .locator('.probe-card')
            .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
            .click();
        return page.getByRole('dialog');
    };
    let dialog = await open('Service inventory');
    await expect(dialog.getByRole('tab', { name: 'Standard output' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await dialog.getByRole('tab', { name: 'Tree view' }).click();
    await expect(dialog.getByRole('tab', { name: 'Table view' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Expand all' }).click();
    await expect(
        dialog.locator('.tree-value').filter({ hasText: '/usr/sbin/dnsmasq' }),
    ).toBeVisible();
    await expect(dialog.getByText('false', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Collapse all' }).click();
    await expect(dialog.locator('.tree-content details[open]')).toHaveCount(0);
    await dialog.getByText('dnsmasq', { exact: true }).click();
    await expect(dialog.getByText('instances', { exact: true })).toBeVisible();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain('instances');
    await page.keyboard.press('Space');
    await expect(dialog.getByText('cfg', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    dialog = await open('Network interfaces');
    await expect(dialog.getByRole('tab', { name: 'Standard output' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await dialog.getByRole('tab', { name: 'Tree view' }).click();
    await dialog.getByText('eth0', { exact: true }).click();
    await expect(dialog.getByText('inet 192.168.1.1/24', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
});

test('live tree updates retain expansion, focus and scroll positions', async ({ page }) => {
    const clockTime = new Date('2026-10-06T00:00:00Z');
    // Leave a margin for real time spent between installing and pausing the clock.
    await page.clock.install({ time: new Date(clockTime.getTime() - 3_600_000) });
    await page.clock.pauseAt(clockTime);
    await page.addInitScript((data) => {
        let count = 0;
        window.diagnosticHub = {
            connect: async () => {},
            disconnect: async () => {},
            pickKey: async () => null,
            openRepository: async () => {},
            copyText: async () => {},
            exportReport: async () => true,
            onDisconnected: () => () => {},
            collect: async () => {
                const snapshot = structuredClone(data);
                snapshot.mode = 'ssh';
                snapshot.capturedAt = new Date(Date.now()).toISOString();
                snapshot.results.find((r) => r.id === 'services')!.stdout = JSON.stringify({
                    dnsmasq: {
                        instances: {
                            cfg: {
                                running: !!(++count % 2),
                                pid: count,
                                command: ['/usr/sbin/dnsmasq'],
                                options: Object.fromEntries(
                                    Array.from({ length: 50 }, (_, i) => [`field${i}`, i]),
                                ),
                            },
                        },
                    },
                });
                return snapshot;
            },
        };
    }, fixtures());
    await page.goto('/');
    await page.getByLabel('Live update interval').selectOption('5');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Services', exact: true }).click();
    await page.locator('.probe-card').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Tree view' }).click();
    await dialog.getByRole('button', { name: 'Expand all' }).click();
    await dialog.getByText('command', { exact: true }).click();
    const branch = dialog.locator('.tree-content details').filter({
        has: page.locator(':scope > summary .tree-key').filter({ hasText: /^command$/ }),
    });
    await expect(branch).not.toHaveAttribute('open');
    await dialog.locator('.tree-content').evaluate((el) => {
        el.scrollTop = 200;
    });
    const top = await dialog.locator('.tree-content').evaluate((el) => el.scrollTop);
    const openBefore = await dialog.locator('.tree-content details[open]').count();
    const focusBefore = await page.evaluate(() => document.activeElement?.textContent);
    await page.clock.runFor(5100);
    const pid = dialog
        .locator('.tree-leaf')
        .filter({ has: page.getByText('pid', { exact: true }) });
    await expect(pid.locator('.tree-value')).toHaveText('2');
    await expect(branch).not.toHaveAttribute('open');
    expect(await dialog.locator('.tree-content details[open]').count()).toBe(openBefore);
    expect(await dialog.locator('.tree-content').evaluate((el) => el.scrollTop)).toBe(top);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(focusBefore);
});

test('header repository link and computer/chip artwork stay clear at desktop sizes', async ({
    page,
}) => {
    await page.addInitScript((data) => {
        (window as any).repositoryClicks = 0;
        window.diagnosticHub = {
            connect: async () => {},
            disconnect: async () => {},
            collect: async () => ({ ...data, mode: 'ssh' }),
            pickKey: async () => null,
            copyText: async () => {},
            openRepository: async () => {
                (window as any).repositoryClicks++;
            },
            exportReport: async () => true,
            onDisconnected: () => () => {},
        };
    }, fixtures());
    await page.goto('/');
    await expect(page.getByText('Desktop · Offline ready', { exact: true })).toHaveCount(0);
    const repository = page.getByRole('link', { name: 'GitHub repository' });
    await expect(repository).toHaveAttribute(
        'href',
        'https://github.com/brucerry/embedded-linux-diagnostic-hub',
    );
    await repository.hover();
    await expect
        .poll(() => repository.evaluate((el) => getComputedStyle(el).transform))
        .not.toBe('none');
    await repository.click();
    expect(await page.evaluate(() => (window as any).repositoryClicks)).toBe(1);
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(page.locator('.device-art')).toBeVisible();
    for (const width of [1440, 1000]) {
        await page.setViewportSize({ width, height: 950 });
        await expect(page.locator('.art-caption')).toHaveCount(0);
        const art = (await page.locator('.device-art').boundingBox())!;
        const computer = (await page.locator('.transfer-computer').boundingBox())!,
            chip = (await page.locator('.transfer-chip').boundingBox())!;
        expect(computer.x).toBeGreaterThanOrEqual(art.x);
        expect(chip.x + chip.width).toBeLessThanOrEqual(art.x + art.width);
        expect(computer.x + computer.width).toBeLessThan(chip.x);
    }
    await page.screenshot({
        path: 'validation/2026-10-06/evidence-views/overview.png',
        fullPage: true,
    });
});

test('LAN warnings retain valid interfaces, parsed table, live graph and raw diagnostics', async ({
    page,
}) => {
    const fixture = fixtures();
    Object.assign(
        fixture.results.find((r) => r.id === 'ethernet')!,
        {
            status: 'collected',
            exitCode: 0,
            stdout: '/sys/class/net/lan0/operstate=up\n/sys/class/net/lan0/carrier=1\n/sys/class/net/lan0/statistics/rx_packets=123\n/sys/class/net/lan1/operstate=down\n/sys/class/net/lan1/statistics/rx_packets=5\n',
            stderr: 'Warning: /sys/class/net/lan1/carrier could not be read (Invalid argument). Other valid readings are retained.\n',
        },
    );
    await page.addInitScript((data) => {
        window.diagnosticHub = {
            connect: async () => {},
            disconnect: async () => {},
            collect: async () => ({ ...data, mode: 'ssh' }),
            pickKey: async () => null,
            copyText: async () => {},
            openRepository: async () => {},
            exportReport: async () => true,
            onDisconnected: () => () => {},
        };
    }, fixture);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
    const load = page.locator('.metric-card').filter({ hasText: 'System load' });
    await expect(load).toContainText('Average task count');
    await expect(load.locator('.load-description')).toHaveAttribute('title', /averaging windows/);
    await expect(page.getByText('LAN: some attributes unavailable', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All hardware', exact: true }).click();
    await page
        .locator('.probe-card')
        .filter({ has: page.getByRole('heading', { name: 'LAN / Ethernet', exact: true }) })
        .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.badge')).toHaveText('Collected');
    await expect(dialog.locator('.ethernet-warning')).toContainText(
        'Valid readings remain available',
    );
    await dialog.getByRole('tab', { name: 'Table view', exact: true }).click();
    await expect(dialog.locator('table')).toContainText('/sys/class/net/lan0/carrier');
    await expect(dialog.locator('table')).toContainText('/sys/class/net/lan1/operstate');
    await expect(dialog.locator('table')).not.toContainText('/sys/class/net/lan1/carrier');
    await dialog.getByRole('tab', { name: 'Graph view', exact: true }).click();
    await expect(dialog.locator('.live-graph')).toBeVisible();
    await dialog.getByRole('tab', { name: 'Standard error', exact: true }).click();
    await expect(dialog.locator('.evidence-output')).toContainText('Invalid argument');
});
