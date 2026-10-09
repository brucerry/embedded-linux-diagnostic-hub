import { _electron as electron, expect } from '@playwright/test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server } from 'ssh2';
import { inc } from 'semver';
import { probes } from '../shared/diagnostics/probes';
import { demoSnapshot } from './fixtures/snapshots';
import { attachTerminalFixture, terminalFixtureState } from './fixtures/terminal';
import { DEVICE_CLOCK_COMMAND } from '../shared/diagnostics/device-clock';
import { clockOutput } from './fixtures/device-clock';

async function main() {
    const temporary = await mkdtemp(path.join(tmpdir(), 'diagnostic-hub-smoke-'));
    const reportFile = path.join(temporary, 'report.json');
    const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        format: 'pem',
        type: 'pkcs1',
    });
    const fixture = demoSnapshot();
    const terminalState = terminalFixtureState();
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
                const session = accept();
                attachTerminalFixture(session, terminalState);
                session.on('exec', (acceptExec, _reject, info) => {
                    const stream = acceptExec();
                    if (info.command.endsWith(DEVICE_CLOCK_COMMAND)) {
                        stream.write(clockOutput());
                        stream.exit(0);
                        stream.end();
                        return;
                    }
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
                `--user-data-dir=${temporary}`,
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
                (
                    clipboard as typeof clipboard & { nativeWriteText?: typeof clipboard.writeText }
                ).nativeWriteText = clipboard.writeText.bind(clipboard);
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
        const updateVersion = inc(await desktop.evaluate(({ app }) => app.getVersion()), 'minor')!;
        const updateBinary =
            process.platform === 'win32'
                ? Buffer.from('MZnative-update-fixture')
                : Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0x41, 0x49, 0x02, 0]);
        await desktop.evaluate(
            (_electron, data) => {
                const filename =
                    process.platform === 'win32'
                        ? 'Diagnostic-Hub.exe'
                        : 'Diagnostic-Hub-linux-x64.AppImage';
                const base = `https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v${data.version}/`;
                globalThis.fetch = async (url) => {
                    if (String(url).includes('/repos/'))
                        return Response.json([
                            {
                                tag_name: `v${data.version}`,
                                prerelease: true,
                                draft: false,
                                body: 'Native update fixture',
                                assets: [
                                    {
                                        name: filename,
                                        size: data.bytes.length,
                                        browser_download_url: base + filename,
                                    },
                                    {
                                        name: filename + '.sha256',
                                        size: 100,
                                        browser_download_url: base + filename + '.sha256',
                                    },
                                ],
                            },
                        ]);
                    if (String(url).endsWith('.sha256'))
                        return new Response(`${data.hash}  ${filename}`);
                    return new Response(new Uint8Array(data.bytes));
                };
            },
            {
                version: updateVersion,
                bytes: [...updateBinary],
                hash: createHash('sha256').update(updateBinary).digest('hex'),
            },
        );
        const page = await desktop.firstWindow();
        let historyWorkers = 0;
        page.on('worker', () => historyWorkers++);
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
        const packaged = await desktop.evaluate(({ app }) => app.isPackaged);
        await page.evaluate(() => {
            const testing = window as unknown as {
                terminalSmoke: { id: string; stop: () => void };
            };
            testing.terminalSmoke = { id: '', stop() {} };
            testing.terminalSmoke.stop = window.diagnosticHub!.onTerminalEvent!((event) => {
                if (event.type === 'state' && event.state === 'open')
                    testing.terminalSmoke.id = event.id;
            });
        });
        await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
        const updateDialog = page.getByRole('dialog', { name: 'Application updates' });
        await expect(updateDialog).toContainText(`v${updateVersion}`);
        await expect(updateDialog.getByRole('button', { name: 'Start update' })).toBeVisible();
        await updateDialog
            .getByRole('link', { name: 'GitHub releases (opens in your browser)' })
            .click();
        expect(
            await desktop.evaluate(
                ({ shell }) =>
                    (shell as typeof shell & { openedRepository?: string }).openedRepository,
            ),
        ).toBe('https://github.com/brucerry/embedded-linux-diagnostic-hub/releases');
        if (!packaged)
            await expect(updateDialog.getByRole('button', { name: 'Start update' })).toBeDisabled();
        await updateDialog.getByRole('button', { name: 'Close dialog' }).click();
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
        await expect(page.evaluate(() => window.diagnosticHub!.readDeviceClock!())).rejects.toThrow(
            'current connection',
        );
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
        expect(
            historyWorkers,
            'Native app:// collection uses the background history worker',
        ).toBeGreaterThan(0);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(page.getByLabel('Animations', { exact: true })).toHaveCount(0);
        expect(
            await page.locator('main').evaluate((el) => getComputedStyle(el).animationName),
        ).toBe('page-enter');
        expect(
            await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
        ).toBe(true);
        const animatedTile = page.locator('.hardware-tile').first();
        await animatedTile.hover();
        await expect
            .poll(() =>
                animatedTile.evaluate(
                    (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42,
                ),
            )
            .toBeLessThan(-2);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
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
        await expect(page.getByRole('region', { name: 'Device time', exact: true })).toContainText(
            '2026-10-09',
        );
        const nativeClock = await page.evaluate(() => window.diagnosticHub!.readDeviceClock!());
        expect(nativeClock.status).toBe('available');
        expect(
            await desktop.evaluate(({ ipcMain }) => {
                const handler = (
                    ipcMain as unknown as {
                        _invokeHandlers: Map<string, (event: unknown) => unknown>;
                    }
                )._invokeHandlers.get('hub:device-clock')!;
                try {
                    handler({ sender: null, senderFrame: null });
                    return false;
                } catch (error) {
                    return (error as Error).message === 'Untrusted application frame.';
                }
            }),
        ).toBe(true);
        await expect(page.locator('.terminal-screen')).not.toContainText('DIAGNOSTIC_HUB_CLOCK');
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
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        const terminalPanel = page.getByRole('region', { name: 'Connected device terminal' });

        await expect(terminalPanel.getByText('Ready', { exact: true })).toBeVisible();
        await expect(terminalPanel.locator('.xterm-viewport')).not.toHaveCSS(
            'overflow-y',
            'scroll',
        );
        await terminalPanel.locator('.xterm-screen').hover();
        await expect(
            terminalPanel.locator('.xterm-scrollable-element > .scrollbar.vertical'),
        ).toHaveCSS('opacity', '0');
        const terminalInput = page.getByLabel('Device terminal input');
        await desktop.evaluate(({ clipboard }) => {
            clipboard.writeText = (
                clipboard as typeof clipboard & { nativeWriteText: typeof clipboard.writeText }
            ).nativeWriteText;
        });
        const savedClipboard = await page.evaluate(() => window.diagnosticHub!.readClipboard!());
        try {
            await page.evaluate(() => window.diagnosticHub!.copyText('echo NATIVE_CLIPBOARD_OK'));
            expect(await page.evaluate(() => window.diagnosticHub!.readClipboard!())).toBe(
                'echo NATIVE_CLIPBOARD_OK',
            );
            await terminalInput.focus();
            await page.keyboard.press('Control+v');
            await page.keyboard.press('Enter');
            await expect(terminalPanel.locator('.terminal-screen')).toContainText(
                'NATIVE_CLIPBOARD_OK',
            );
            expect(
                await desktop.evaluate(({ ipcMain }) => {
                    try {
                        (
                            ipcMain as unknown as {
                                _invokeHandlers: Map<string, (event: unknown) => unknown>;
                            }
                        )._invokeHandlers.get('hub:read-clipboard')!({
                            sender: null,
                            senderFrame: null,
                        });
                        return false;
                    } catch (error) {
                        return (error as Error).message === 'Untrusted application frame.';
                    }
                }),
            ).toBe(true);
        } finally {
            await page.evaluate((text) => window.diagnosticHub!.copyText(text), savedClipboard);
        }
        await terminalInput.focus();
        await page.keyboard.type('cd /tmp');
        await page.keyboard.press('Enter');
        await page.keyboard.type('unicode');
        await page.keyboard.press('Enter');
        await expect(terminalPanel.locator('.terminal-screen')).toContainText('裝置✓');
        await page.keyboard.type('watch');
        await page.keyboard.press('Enter');
        await expect(terminalPanel.locator('.terminal-screen')).toContainText('watching');
        await page.keyboard.press('Control+c');
        await expect(terminalPanel.locator('.terminal-screen')).toContainText('^C');
        await desktop.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setSize(1100, 850),
        );
        await expect.poll(() => terminalState.sizes.length).toBeGreaterThan(1);
        expect(readyConnections).toBe(1);
        expect(
            await page.evaluate(async () => {
                const id = (window as unknown as { terminalSmoke: { id: string } }).terminalSmoke
                    .id;
                const bridge = window.diagnosticHub!;
                const operations = [
                    () => bridge.writeTerminal!(id, 'invalid!'),
                    () => bridge.resizeTerminal!(id, { cols: 501, rows: 24 }),
                    () => bridge.acknowledgeTerminal!(id, 999999),
                    () => bridge.writeTerminal!('terminal-stale-0001', 'YQ=='),
                ];
                return Promise.all(
                    operations.map(async (operation) => {
                        try {
                            await operation();
                            return false;
                        } catch {
                            return true;
                        }
                    }),
                );
            }),
        ).toEqual([true, true, true, true]);
        expect(
            await desktop.evaluate(({ ipcMain }) => {
                const handlers = (
                    ipcMain as unknown as {
                        _invokeHandlers: Map<
                            string,
                            (event: unknown, ...args: unknown[]) => unknown
                        >;
                    }
                )._invokeHandlers;
                return ['open', 'input', 'resize', 'ack', 'close'].every((operation) => {
                    try {
                        handlers.get(`hub:terminal-${operation}`)!(
                            { sender: null, senderFrame: null },
                            {},
                        );
                        return false;
                    } catch (error) {
                        return (error as Error).message === 'Untrusted application frame.';
                    }
                });
            }),
        ).toBe(true);
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        await terminalInput.focus();
        await page.keyboard.type('pwd');
        await page.keyboard.press('Enter');
        await expect(terminalPanel.locator('.terminal-screen')).toContainText('/tmp');
        expect(terminalState.opens).toBe(1);
        await terminalPanel.getByRole('button', { name: 'Clear terminal' }).click();
        await expect(terminalInput).toBeFocused();
        await expect(terminalPanel.locator('.xterm-accessibility-tree')).not.toContainText(
            'watching',
        );
        await expect(terminalPanel.locator('.xterm-accessibility-tree')).toContainText('/tmp $');
        await terminalInput.focus();
        await page.keyboard.press('Control+l');
        await expect.poll(() => Buffer.concat(terminalState.inputs).toString()).toContain('\x0c');
        await expect(terminalPanel.locator('.xterm-cursor').locator('..')).toContainText('/tmp $');
        const terminalBounds = await terminalPanel.locator('.terminal-frame').boundingBox();
        const terminalScreen = await terminalPanel.locator('.xterm-screen').boundingBox();
        expect(terminalScreen!.y + terminalScreen!.height).toBeLessThanOrEqual(
            terminalBounds!.y + terminalBounds!.height - 8,
        );
        await page.keyboard.type('echo NATIVE_HISTORY_BEFORE_EXIT');
        await page.keyboard.press('Enter');
        await expect(terminalPanel.locator('.terminal-screen')).toContainText(
            'NATIVE_HISTORY_BEFORE_EXIT',
        );
        await page.keyboard.type('exit');
        await page.keyboard.press('Enter');
        await expect(terminalPanel.locator('.terminal-screen')).toContainText('Shell restarted.');
        await expect(terminalPanel.getByText('Ready', { exact: true })).toBeVisible();
        await expect(terminalInput).toBeFocused();
        await expect(terminalPanel.locator('.xterm-cursor').locator('..')).toContainText(
            '/home/engineer $',
        );
        await expect(terminalPanel.locator('.terminal-screen')).toContainText(
            'NATIVE_HISTORY_BEFORE_EXIT',
        );
        expect(terminalState.opens).toBe(2);
        expect(readyConnections).toBe(1);
        expect(openConnections).toBe(1);
        await page.screenshot({ path: 'test-results/desktop-terminal.png', fullPage: true });
        await page.evaluate(() =>
            (window as unknown as { terminalSmoke: { stop: () => void } }).terminalSmoke.stop(),
        );
        await page.getByRole('button', { name: 'Memory', exact: true }).click();
        await page
            .locator('.probe-card')
            .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
            .click();
        await page.getByRole('tab', { name: 'Graph view' }).click();
        await expect(page.getByRole('dialog').locator('.live-graph circle').first()).toBeVisible();
        await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await page.getByRole('button', { name: 'Export report', exact: true }).click();
        await expect(page.getByRole('status')).toContainText('Diagnostic report saved');
        const report = JSON.parse(await readFile(reportFile, 'utf8'));
        expect(report.mode).toBe('ssh');
        expect(report.endpoint).toBe(`127.0.0.1:${port}`);
        expect(report.diagnostics).toHaveLength(probes.length);
        expect(JSON.stringify(report)).not.toContain('test-only-secret');
        expect(JSON.stringify(report)).not.toContain('watching');
        expect(JSON.stringify(report)).not.toContain('NATIVE_CLIPBOARD_OK');
        const hosts = JSON.parse(await readFile(path.join(temporary, 'known-hosts.json'), 'utf8'));
        expect(hosts[`127.0.0.1:${port}`]).toMatch(/^SHA256:/);
        // A paused reset clears evidence while preserving this authenticated SSH session.
        const authenticationsBeforeReset = readyConnections;
        await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
        await expect(
            page.getByRole('dialog', { name: 'Resetting session data' }),
        ).not.toBeVisible();
        await page.locator('.hardware-tile').first().click();
        await expect(
            page.getByRole('dialog').getByRole('tab', { name: 'Standard output' }),
        ).toBeVisible();
        await expect(
            page.getByRole('dialog', { name: 'Connect a Linux device' }),
        ).not.toBeVisible();
        expect(readyConnections).toBe(authenticationsBeforeReset);
        expect(openConnections).toBe(1);
        await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
        await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
        await page.getByRole('switch', { name: 'Live updates' }).click();
        await page.getByRole('button', { name: 'Disconnect device', exact: true }).click();
        await expect.poll(() => terminalState.closes).toBe(2);
        await expect(page.getByText('SAVED SNAPSHOT', { exact: true })).toBeVisible();
        await expect(page.getByRole('switch', { name: 'Live updates' })).toBeChecked();
        await expect(page.getByRole('button', { name: 'Refresh snapshot' })).toBeDisabled();
        await page.getByRole('button', { name: 'Memory', exact: true }).click();
        await page
            .locator('.probe-card')
            .filter({ has: page.getByRole('heading', { name: 'Memory overview', exact: true }) })
            .click();
        await page.getByRole('dialog').getByRole('tab', { name: 'Graph view' }).click();
        await expect(page.getByRole('dialog').locator('.live-graph circle').first()).toBeVisible();
        const retainedBeforeReconnect = await page
            .getByRole('dialog')
            .locator('.live-graph circle')
            .count();
        await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
        await page.getByRole('switch', { name: 'Live updates' }).click();
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
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
        await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
        const renewed = JSON.parse(
            await readFile(path.join(temporary, 'known-hosts.json'), 'utf8'),
        );
        expect(renewed[`127.0.0.1:${port}`]).toBe(hosts[`127.0.0.1:${port}`]);
        expect(renewed[otherEndpoint]).toBe(staleFingerprint);
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        await page.getByRole('button', { name: 'Memory', exact: true }).click();
        await page.locator('.probe-card').first().click();
        await page.getByRole('dialog').getByRole('tab', { name: 'Graph view' }).click();
        await expect(page.getByRole('dialog').locator('.live-graph circle')).toHaveCount(
            retainedBeforeReconnect + 2,
        );
        await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
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
        await page.evaluate(() => window.diagnosticHub!.collect());
        await page.getByRole('button', { name: 'Reset session data', exact: true }).click();
        const resetCover = page.getByRole('dialog', { name: 'Resetting session data' });
        await expect(resetCover).toBeVisible();
        await expect(page.locator('.connection-start')).toHaveCount(0);
        await expect(page.locator('.metric-card')).toHaveCount(4);
        await expect(resetCover).not.toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Reset session data', exact: true }),
        ).toBeDisabled();
        await expect(page.evaluate(() => window.diagnosticHub!.exportReport())).rejects.toThrow(
            /Collect a diagnostic snapshot/,
        );
        expect(openConnections).toBe(1);
        await page.evaluate(() => window.diagnosticHub!.collect());
        await page.evaluate(async () => {
            const bridge = window.diagnosticHub!;
            bridge.onTerminalEvent!(async (event) => {
                if (event.id === 'terminal-update-0001' && event.type === 'data')
                    await bridge.acknowledgeTerminal!(event.id, event.sequence).catch(() => {});
            });
            await bridge.openTerminal!({ id: 'terminal-update-0001', cols: 80, rows: 24 });
            await bridge.writeTerminal!(
                'terminal-update-0001',
                btoa('echo UPDATE_TERMINAL_ONLY_MARKER\r'),
            );
        });
        const finalShells = terminalState.opens;
        if (!packaged) {
            await expect(
                page.evaluate(() => window.diagnosticHub!.startUpdate({ mode: 'clean' })),
            ).rejects.toThrow(/packaged application/);
            expect(openConnections).toBe(1);
        }
        if (packaged) {
            await desktop.evaluate(({ app }) => {
                const testingApp = app as typeof app & {
                    realQuit?: typeof app.quit;
                    updateRestart?: unknown;
                    updateQuit?: boolean;
                };
                testingApp.realQuit = app.quit;
                app.relaunch = (options) => {
                    testingApp.updateRestart = options;
                };
                app.quit = () => {
                    testingApp.updateQuit = true;
                };
            });
            await page.evaluate(() => window.diagnosticHub!.startUpdate({ mode: 'smart' }));
            await expect.poll(() => openConnections).toBe(0);
            await expect.poll(() => terminalState.closes).toBe(finalShells);
            await expect(
                page.evaluate(() =>
                    window.diagnosticHub!.writeTerminal!('terminal-update-0001', 'YQ=='),
                ),
            ).rejects.toThrow(/paused/);
            await expect(page.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
            const recovered = await page.evaluate(() => window.diagnosticHub!.readUpdateReport());
            expect(recovered?.mode).toBe('smart');
            expect(recovered?.snapshot?.endpoint).toBe(`127.0.0.1:${port}`);
            expect(JSON.stringify(recovered)).not.toContain('UPDATE_TERMINAL_ONLY_MARKER');
            expect(
                await page.evaluate(async () => {
                    try {
                        await window.diagnosticHub!.connect({
                            host: '127.0.0.1',
                            port: 22,
                            username: 'root',
                            auth: 'password',
                        });
                        return false;
                    } catch (error) {
                        return String(error).includes('update is in progress');
                    }
                }),
            ).toBe(true);
            await expect(
                page.evaluate(() => window.diagnosticHub!.readDeviceClock!()),
            ).rejects.toThrow('update');
            const restart = await desktop.evaluate(
                ({ app }) =>
                    (
                        app as typeof app & {
                            updateRestart: { execPath: string; args: string[] };
                        }
                    ).updateRestart,
            );
            expect(restart.execPath).toContain(path.join(temporary, 'updates', updateVersion));
            expect(restart.args).toContain(`--user-data-dir=${temporary}`);
            if (process.platform === 'linux')
                expect(restart.args).toContain('--appimage-extract-and-run');
            await expect
                .poll(() =>
                    desktop.evaluate(
                        ({ app }) => (app as typeof app & { updateQuit?: boolean }).updateQuit,
                    ),
                )
                .toBe(true);
            await desktop.evaluate(({ app }) => {
                app.quit = (app as typeof app & { realQuit: typeof app.quit }).realQuit;
            });
        }
        console.log(
            'Native update smoke passed: trusted IPC, release check, restart guards' +
                (packaged
                    ? ', verified download and portable relaunch arguments.'
                    : ' and development-build install restriction.'),
        );
        console.log(
            'Desktop smoke passed: packaged UI, isolated bridge, SSH collection, trusted-key replacement/cancel/reuse, native report export and disconnect.',
        );
    } finally {
        await desktop.close();
        await expect.poll(() => openConnections).toBe(0);
        await expect.poll(() => terminalState.closes).toBe(terminalState.opens);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
