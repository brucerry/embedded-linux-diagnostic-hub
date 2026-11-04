import { expect, test, type Locator, type Page } from '@playwright/test';
import { installDesktop } from './fixtures/desktop';
import {
    lanJsonFixtures,
    maximumCounter,
    primaryAddress,
} from '../fixtures/network-json-syntax-ui';

async function closeDialog(page: Page, dialog: Locator) {
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
}

test('LAN rejects malformed numeric-key JSON, retains address fallback and displays exact 64-bit counters', async ({
    page,
}, info) => {
    await installDesktop(page);
    await page.goto('/');
    const phases: { phase: string; interfaces: string[]; warnings: number; rawExact: boolean }[] =
        [];
    let primaryRawExact = false;
    for (const fixture of lanJsonFixtures()) {
        await page.getByLabel('Import diagnostic report', { exact: true }).setInputFiles({
            name: `${fixture.phase}.json`,
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(fixture.snapshot)),
        });
        // This marker changes only after this import's asynchronous history preparation.
        await expect(
            page.getByText(`Snapshot: ${fixture.snapshot.endpoint}`, { exact: true }),
        ).toBeVisible();
        await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: /LAN \/ Ethernet/ }).click();
        const dialog = page.getByRole('dialog');
        const summary = dialog.getByRole('region', { name: 'LAN summary', exact: true });
        await expect(dialog.getByRole('tab', { name: 'Summary', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(summary).toContainText('Historical imported evidence');
        const select = summary.getByLabel('Network interface', { exact: true });
        const warnings = summary.getByRole('status');
        if (fixture.warning) await expect(warnings).toHaveText([fixture.warning]);
        else await expect(warnings).toHaveCount(0);
        let labels: string[] = [];
        if (fixture.phase === 'malformed-link') {
            await expect(select).toHaveCount(0);
            await expect(summary.locator('.network-metric')).toHaveCount(0);
            await expect(
                summary.getByText('No recognized interface inventory was collected.', {
                    exact: false,
                }),
            ).toBeVisible();
        } else {
            await expect(select.locator('option')).toHaveText(['eth0 · ifindex 7']);
            await expect(select).toHaveValue('["eth0",7]');
            labels = await select.locator('option').allTextContents();
            if (fixture.phase === 'address-fallback') {
                const address = summary
                    .locator('.network-detail')
                    .filter({ hasText: 'Address (legacy text)' });
                await address.locator('summary').click();
                await expect(address.locator('dd')).toHaveText(
                    primaryAddress.split('\n')[1].trim(),
                );
            } else {
                const counters = summary
                    .locator('.network-detail')
                    .filter({ hasText: 'Cumulative kernel counters' });
                await counters.locator('summary').click();
                await expect(counters.locator('dt')).toHaveText('rx bytes (bytes)');
                await expect(counters.locator('dd')).toHaveText(maximumCounter);
                await expect(counters).not.toContainText('18446744073709552000');
            }
        }
        await summary.getByText('Command evidence and collection limits', { exact: true }).click();
        const command = summary.locator('.network-command').filter({ hasText: fixture.operation });
        await expect(command).toHaveCount(1);
        await command.locator('summary').click();
        const actualRaw = await command.locator('pre').nth(1).textContent();
        expect(actualRaw).toBe(fixture.raw);
        phases.push({
            phase: fixture.phase,
            interfaces: labels,
            warnings: await warnings.count(),
            rawExact: actualRaw === fixture.raw,
        });
        await closeDialog(page, dialog);
        if (fixture.phase === 'address-fallback') {
            const diagnostics = page
                .getByRole('navigation', { name: 'Workspace', exact: true })
                .getByRole('button', { name: /^Diagnostics \d+$/ });
            await diagnostics.click();
            await expect(diagnostics).toHaveAttribute('aria-current', 'page');
            await page.getByRole('button', { name: /Network interfaces/ }).click();
            const primary = page.getByRole('dialog');
            await primary.getByRole('tab', { name: 'Standard output', exact: true }).click();
            const raw = await primary.locator('.evidence-output').textContent();
            expect(raw).toBe(primaryAddress);
            primaryRawExact = raw === primaryAddress;
            await closeDialog(page, primary);
        }
    }
    const bridge = await page.evaluate(() => ({
        connects: window.desktopTest.connects,
        disconnects: window.desktopTest.disconnects,
        collects: window.desktopTest.collects,
        terminalOpens: window.desktopTest.terminal!.opens,
        terminalCloses: window.desktopTest.terminal!.closes,
        terminalInputs: window.desktopTest.terminal!.inputs.length,
        terminalOwnerEmpty: window.desktopTest.terminal!.id === '',
        captureExports: window.desktopTest.captureExports.length,
        updateRequests: window.desktopTest.requests.length,
    }));
    expect(bridge).toEqual({
        connects: 0,
        disconnects: 0,
        collects: 0,
        terminalOpens: 0,
        terminalCloses: 0,
        terminalInputs: 0,
        terminalOwnerEmpty: true,
        captureExports: 0,
        updateRequests: 0,
    });
    expect(primaryRawExact).toBe(true);
    const body = Buffer.from(
        JSON.stringify({
            schema: 1,
            boundary: 'synthetic-imported-lan',
            phases,
            primaryRawExact,
            maximumCounter,
            dialogsClosed: true,
            bridge,
        }),
    );
    if (body.length > 4096) throw Error('LAN JSON observation exceeded its bound.');
    await info.attach('lan-json-observation', { body, contentType: 'application/json' });
});
