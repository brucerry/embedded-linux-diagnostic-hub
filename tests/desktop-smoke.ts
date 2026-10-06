import { _electron as electron, expect } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server } from 'ssh2';
import { probes } from '../shared/diagnostics/probes';
import { demoSnapshot } from './fixtures/snapshots';

async function main() {
    const temporary = await mkdtemp(path.join(tmpdir(), 'diagnostic-hub-smoke-'));
    const reportFile = path.join(temporary, 'report.json');
    const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        format: 'pem',
        type: 'pkcs1',
    });
    const fixture = demoSnapshot();
    fixture.results.find((r) => r.id === 'memory')!.stderr = 'Read-only diagnostic note\n';
    let openConnections = 0,
        readyConnections = 0,
        completedCollections = 0;
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
        let authenticated = false;
        client.on('error', () => {});
        client.on('close', () => {
            if (authenticated) openConnections--;
        });
        client.on('authentication', (context) => {
            if (
                context.method === 'password' &&
                context.username === 'engineer' &&
                context.password === 'test-only-secret'
            )
                context.accept();
            else context.reject();
        });
        client.on('ready', () => {
            authenticated = true;
            openConnections++;
            readyConnections++;
            client.on('session', (accept) => {
                accept().on('exec', (acceptExec, _reject, info) => {
                    const stream = acceptExec();
                    const probe = probes.find((item) => info.command.endsWith(item.command));
                    if (probe?.id === 'fans') completedCollections++;
                    const result = fixture.results.find((item) => item.id === probe?.id);
                    if (result) {
                        stream.write(result.stdout);
                        stream.stderr.write(result.stderr);
                        stream.exit(result.exitCode ?? 1);
                    } else {
                        stream.stderr.write('Unexpected command');
                        stream.exit(1);
                    }
                    stream.end();
                });
            });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const electronEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
                entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
        ),
    );
    const desktop = await electron
        .launch({
            chromiumSandbox: Boolean(process.env.HUB_TEST_SANDBOX),
            executablePath: process.env.HUB_TEST_EXECUTABLE,
            args: [
                ...(process.env.HUB_TEST_EXECUTABLE ? [] : ['.']),
                ...(process.env.HUB_TEST_APPIMAGE ? ['--appimage-extract-and-run'] : []),
                ...(process.platform === 'linux' && !process.env.HUB_TEST_SANDBOX
                    ? ['--no-sandbox']
                    : []),
            ],
            env: electronEnvironment,
            timeout: 30_000,
        })
        .catch(async (error: unknown) => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(temporary, { recursive: true, force: true });
            throw error;
        });
    try {
        if (process.env.HUB_TEST_SANDBOX)
            expect(await desktop.evaluate(() => process.argv.includes('--no-sandbox'))).toBe(false);
        await desktop.evaluate(
            ({ app, dialog, clipboard, shell }, args) => {
                app.setPath('userData', args.temporary);
                shell.openExternal = async (url) => {
                    (shell as typeof shell & { openedRepository?: string }).openedRepository = url;
                };
                clipboard.writeText = async (text: string) => {
                    (clipboard as typeof clipboard & { copiedCommand?: string }).copiedCommand =
                        text;
                };
                dialog.showMessageBox = async () => {
                    throw Error('SSH verification must not open an OS-modal dialog');
                };
                dialog.showSaveDialog = async () => ({
                    canceled: false,
                    filePath: args.reportFile,
                });
            },
            { temporary, reportFile },
        );
        const page = await desktop.firstWindow();
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
        await expect(page.locator('.metric-card, .hardware-tile')).toHaveCount(0);
        await expect(
            page.getByRole('button', { name: 'Export report', exact: true }),
        ).toBeDisabled();
        expect(await page.evaluate(() => typeof window.diagnosticHub?.connect)).toBe('function');
        await expect(page.getByRole('button', { name: 'Device files', exact: true })).toHaveCount(
            0,
        );
        expect(
            await page.evaluate(() => {
                const bridge = window.diagnosticHub as unknown as Record<string, unknown>;
                return ['readDeviceFile', 'writeDeviceFile'].every((name) => !(name in bridge));
            }),
        ).toBe(true);
        expect(
            await desktop.evaluate(({ ipcMain }) => {
                // IPC handlers must be absent as well as hidden from the preload bridge.
                const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })
                    ._invokeHandlers;
                return !handlers.has('hub:read-file') && !handlers.has('hub:write-file');
            }),
        ).toBe(true);

        expect(
            await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
        ).toBe('undefined');
        await mkdir('test-results', { recursive: true });
        await page.screenshot({ path: 'test-results/desktop-overview.png', fullPage: true });
        // The native SSH/report path must remain functional without any browser network access.
        await page.getByRole('link', { name: 'GitHub repository' }).click();
        expect(
            await desktop.evaluate(
                ({ shell }) =>
                    (shell as typeof shell & { openedRepository?: string }).openedRepository,
            ),
        ).toBe('https://github.com/brucerry/embedded-linux-diagnostic-hub');
        await expect(page.getByText('Desktop · Offline ready', { exact: true })).toHaveCount(0);
        await page.context().setOffline(true);
        await expect(page.getByRole('switch', { name: 'Live updates' })).toBeChecked();
        await expect(page.getByLabel('Live update interval')).toHaveValue('30');
        await page.getByLabel('Live update interval').selectOption('5');
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        const modal = page.getByRole('dialog');
        await modal.getByLabel('Hostname or IP address').fill('127.0.0.1');
        await modal.getByLabel('Port', { exact: true }).fill(String(port));
        await modal.getByLabel('SSH username').fill('engineer');
        await modal.getByLabel('Password', { exact: true }).fill('wrong-password');
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await expect(
            page.getByRole('alertdialog', { name: 'Verify SSH device identity' }),
        ).toBeVisible();
        expect(
            await desktop.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0].isEnabled(),
            ),
        ).toBe(true);
        await page.getByRole('button', { name: 'Trust device', exact: true }).click();
        await expect(modal.getByRole('alert')).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText('NOT CONNECTED', { exact: true })).toBeVisible();
        await expect(page.locator('.metric-card')).toHaveCount(0);
        await expect(
            page.getByRole('button', { name: 'Export report', exact: true }),
        ).toBeDisabled();
        await modal.getByLabel('Password', { exact: true }).fill('test-only-secret');
        await modal.getByRole('button', { name: 'Connect via SSH' }).click();
        await expect(modal).not.toBeVisible({ timeout: 20_000 });
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
        await expect(
            page.getByText(
                `${fixture.results.filter((item) => item.status === 'collected').length} of ${probes.length} checks collected`,
            ),
        ).toBeVisible();
        await expect.poll(() => openConnections).toBe(1);
        await expect
            .poll(() => completedCollections, { timeout: 15_000 })
            .toBeGreaterThanOrEqual(2);
        expect(readyConnections).toBe(1);
        expect(openConnections).toBe(1);
        await page.getByRole('button', { name: 'Memory', exact: true }).click();
        await page
            .locator('.probe-card')
            .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
            .click();
        const evidenceDialog = page.getByRole('dialog');
        await expect(evidenceDialog.locator('details')).not.toHaveAttribute('open', '');
        await evidenceDialog.getByText('Collection command', { exact: true }).click();
        await expect(evidenceDialog.locator('details')).toHaveAttribute('open', '');
        await evidenceDialog.getByRole('button', { name: 'Copy command', exact: true }).click();
        await expect(evidenceDialog.locator('.copy-feedback.success').last()).toHaveText('Copied!');
        expect(
            await desktop.evaluate(
                ({ clipboard }) =>
                    (clipboard as typeof clipboard & { copiedCommand?: string }).copiedCommand,
            ),
        ).toBe(probes.find((p) => p.id === 'memory')!.command);
        await evidenceDialog.getByRole('tab', { name: 'Standard output' }).click();
        await evidenceDialog
            .getByRole('button', { name: 'Copy standard output', exact: true })
            .click();
        await expect(evidenceDialog.locator('.copy-feedback.success').last()).toHaveText('Copied!');
        expect(
            await desktop.evaluate(
                ({ clipboard }) =>
                    (clipboard as typeof clipboard & { copiedCommand?: string }).copiedCommand,
            ),
        ).toBe(fixture.results.find((r) => r.id === 'memory')!.stdout);
        await evidenceDialog.getByRole('tab', { name: 'Standard error' }).click();
        await evidenceDialog
            .getByRole('button', { name: 'Copy standard error', exact: true })
            .click();
        await expect(evidenceDialog.locator('.copy-feedback.success').last()).toHaveText('Copied!');
        expect(
            await desktop.evaluate(
                ({ clipboard }) =>
                    (clipboard as typeof clipboard & { copiedCommand?: string }).copiedCommand,
            ),
        ).toBe('Read-only diagnostic note\n');
        // Evidence snippets can exceed the old command-only clipboard limit.
        await page.evaluate(() => window.diagnosticHub!.copyText('x'.repeat(16384)));
        expect(
            await desktop.evaluate(
                ({ clipboard }) =>
                    (clipboard as typeof clipboard & { copiedCommand?: string }).copiedCommand
                        ?.length,
            ),
        ).toBe(16384);
        expect(
            await page.evaluate(async () => {
                try {
                    await window.diagnosticHub!.copyText('x'.repeat(262145));
                    return false;
                } catch {
                    return true;
                }
            }),
        ).toBe(true);
        await evidenceDialog.getByRole('tab', { name: 'Table view' }).click();
        await expect(evidenceDialog.locator('table')).toContainText('MemTotal');
        await evidenceDialog.getByRole('tab', { name: 'Graph view' }).click();
        await expect(evidenceDialog.locator('.live-graph circle').first()).toBeVisible();
        await evidenceDialog.getByRole('button', { name: 'Close dialog' }).click();
        await page.getByRole('switch', { name: 'Live updates' }).click();
        // Pausing stops future polls; an already-running read-only collection may finish.
        await expect(
            page.getByRole('button', { name: 'Disconnect device', exact: true }),
        ).toBeEnabled();
        const pausedCollections = completedCollections;
        await new Promise((resolve) => setTimeout(resolve, 6000));
        expect(completedCollections).toBe(pausedCollections);
        expect(openConnections).toBe(1);
        await page
            .locator('.probe-card')
            .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
            .click();
        await expect(page.getByRole('tab', { name: 'Graph view' })).toHaveCount(0);
        await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await page.getByRole('button', { name: 'Export report', exact: true }).click();
        await expect(page.getByRole('status')).toContainText('Diagnostic report saved');
        const report = JSON.parse(await readFile(reportFile, 'utf8'));
        expect(report.mode).toBe('ssh');
        expect(report.endpoint).toBe(`127.0.0.1:${port}`);
        expect(report.diagnostics).toHaveLength(probes.length);
        expect(JSON.stringify(report)).not.toContain('test-only-secret');
        const hosts = JSON.parse(await readFile(path.join(temporary, 'known-hosts.json'), 'utf8'));
        expect(hosts[`127.0.0.1:${port}`]).toMatch(/^SHA256:/);
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
        await expect(page.getByText('SAVED SNAPSHOT', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Refresh snapshot' })).toBeDisabled();
        await expect.poll(() => openConnections).toBe(0);
        await desktop.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setSize(1000, 720),
        );
        // A replacement board at the same endpoint needs confirmation, not manual store edits.
        const staleFingerprint = 'SHA256:' + 'A'.repeat(43);
        const otherEndpoint = 'other-board.local:22';
        await writeFile(
            path.join(temporary, 'known-hosts.json'),
            JSON.stringify({
                ...hosts,
                [`127.0.0.1:${port}`]: staleFingerprint,
                [otherEndpoint]: staleFingerprint,
            }),
        );
        // Closing a connected window must also release SSH without an explicit Disconnect.
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        await page.getByRole('dialog').getByLabel('Hostname or IP address').fill('127.0.0.1');
        await page.getByRole('dialog').getByLabel('Port', { exact: true }).fill(String(port));
        await page.getByRole('dialog').getByLabel('SSH username').fill('engineer');
        await page
            .getByRole('dialog')
            .getByLabel('Password', { exact: true })
            .fill('test-only-secret');
        await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
        const verification = page.getByRole('alertdialog', { name: 'SSH host key changed' });
        await expect(verification).toBeVisible();
        await expect(
            verification.getByRole('button', { name: 'Cancel verification' }),
        ).toBeInViewport();
        await expect(verification.getByRole('heading')).toBeInViewport();
        await expect(verification).toContainText(staleFingerprint);
        await expect(verification).toContainText(hosts[`127.0.0.1:${port}`]);
        expect(
            await desktop.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0].isEnabled(),
            ),
        ).toBe(true);
        await expect(
            verification.getByRole('button', { name: 'Cancel verification' }),
        ).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
        await expect.poll(() => openConnections).toBe(0);
        expect(
            JSON.parse(await readFile(path.join(temporary, 'known-hosts.json'), 'utf8'))[
                `127.0.0.1:${port}`
            ],
        ).toBe(staleFingerprint);
        await page
            .getByRole('dialog')
            .getByLabel('Password', { exact: true })
            .fill('test-only-secret');
        await page.getByRole('dialog').getByRole('button', { name: 'Connect via SSH' }).click();
        await expect(verification).toBeVisible();
        await verification.getByRole('button', { name: 'Trust replacement device' }).hover();
        expect(
            await verification
                .getByRole('button', { name: 'Trust replacement device' })
                .evaluate((el) => getComputedStyle(el).cursor),
        ).toBe('pointer');
        await verification.getByRole('button', { name: 'Trust replacement device' }).click();
        await expect(page.getByText('SSH SESSION', { exact: true })).toBeVisible();
        expect(openConnections).toBe(1);
        const renewed = JSON.parse(
            await readFile(path.join(temporary, 'known-hosts.json'), 'utf8'),
        );
        expect(renewed[`127.0.0.1:${port}`]).toBe(hosts[`127.0.0.1:${port}`]);
        expect(renewed[otherEndpoint]).toBe(staleFingerprint);
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
        await expect.poll(() => openConnections).toBe(0);
        await page.evaluate(
            async (options) => {
                await window.diagnosticHub!.connect(options);
            },
            {
                host: '127.0.0.1',
                port,
                username: 'engineer',
                auth: 'password' as const,
                password: 'test-only-secret',
            },
        );
        expect(openConnections).toBe(1);
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        console.log(
            'Desktop smoke passed: packaged UI, isolated bridge, SSH collection, trusted-key replacement/cancel/reuse, native report export and disconnect.',
        );
    } finally {
        await desktop.close();
        await expect.poll(() => openConnections).toBe(0);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(temporary, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
