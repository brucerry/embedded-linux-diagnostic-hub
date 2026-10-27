import assert from 'node:assert/strict';
import { _electron as electron, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installDesktop } from './ui/fixtures/desktop';

// Exercises the production renderer and worker bundle under a secure local scheme,
// sandbox/contextIsolation and CSP. Transport is synthetic; this is not storage ACK proof.
async function main() {
    const root = process.cwd(),
        evidence = path.join(root, 'evidence');
    await mkdir(evidence, { recursive: true });
    const main = path.join(evidence, 'flow-native-main.cjs');
    await writeFile(
        main,
        `
const { app, BrowserWindow, protocol, net, session } = require('electron');
const path = require('node:path'); const { pathToFileURL } = require('node:url');
const root = ${JSON.stringify(root)};
app.setPath('userData', path.join(root, 'evidence', 'native-profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'flow', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.whenReady().then(() => {
  const dist = path.join(root, 'dist');
  protocol.handle('flow', request => {
    let relative = decodeURIComponent(new URL(request.url).pathname);
    while (relative.startsWith('/')) relative = relative.slice(1);
    relative = relative || 'index.html';
    const file = path.resolve(dist, relative);
    if (!file.startsWith(dist + path.sep)) return new Response('', { status: 403 });
    return net.fetch(pathToFileURL(file).href);
  });
  let count = 0;
  session.defaultSession.on('will-download', (_event, item) => {
    item.setSavePath(path.join(root, 'evidence', 'native-export-' + (++count) + '.' + item.getFilename().split('.').pop()));
  });
  const window = new BrowserWindow({ show: false, width: 1440, height: 1050, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.loadURL('flow://hub/');
});
app.on('window-all-closed', () => app.quit());
`,
    );
    execFileSync(process.execPath, ['--check', main], { stdio: 'pipe' });
    await writeFile(
        path.join(evidence, 'native-syntax-check.log'),
        `${process.execPath} --check ${main}\nPassed before Electron launch.\n`,
    );
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
        ),
    ) as Record<string, string>;
    const app = await electron.launch({ args: [main], env, chromiumSandbox: true, timeout: 30000 });
    try {
        const page = await app.firstWindow();
        // tsx preserves function names through this helper in serialized fixture callbacks.
        await page.evaluate('globalThis.__name = (value) => value;');
        // Electron does not replay Page.addInitScript on this custom-scheme reload.
        // Install the test-only bridge in the current document; opening the dialog rerenders App.
        await installDesktop({
            addInitScript: async (script: any, arg: any) => page.evaluate(script, arg),
        } as unknown as Page);
        await page.evaluate(() => {
            const state = { commands: [] as string[], completed: 0, active: 0, maximum: 0 };
            (window as any).nativeFlow = state;
            window.diagnosticHub!.automationConnection = () => 'native-flow-fixture-001';
            window.diagnosticHub!.cancelAutomation = async () => {};
            window.diagnosticHub!.runAutomation = async (request) => {
                state.commands.push(request.command);
                state.active++;
                state.maximum = Math.max(state.maximum, state.active);
                await new Promise((resolve) => setTimeout(resolve, 180));
                state.active--;
                state.completed++;
                return {
                    stdout: 'synthetic capture',
                    stderr: '',
                    exitCode: 0,
                    completion: 'exit',
                    truncated: false,
                    chunks: [],
                };
            };
        });
        assert.equal(await page.evaluate(() => Boolean(window.diagnosticHub)), true);
        if (await page.evaluate(() => document.hidden))
            await app.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0].showInactive(),
            );
        await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
        const connection = page.getByRole('dialog', { name: 'Connect a Linux device' });
        await connection.getByLabel('Hostname or IP address').fill('fixture.invalid');
        await connection.getByLabel('SSH username').fill('fixture');
        await connection.getByLabel('Password', { exact: true }).fill('synthetic-fixture');
        await page.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
        await page.getByRole('button', { name: 'Automation', exact: true }).click();
        const flow = page.getByRole('region', { name: 'Automation', exact: true });
        const stages = flow.getByRole('navigation', { name: 'Automation setup steps' });
        await stages.getByRole('button', { name: /Commands/ }).click();
        for (let i = 1; i <= 20; i++) {
            if (i > 1) await flow.getByRole('button', { name: 'Add command', exact: true }).click();
            await flow.getByLabel(`Command ${i} script`).fill(`native command ${i} 日本語 😀`);
        }
        await stages.getByRole('button', { name: /Timing/ }).click();
        await flow.getByLabel('Repeat completed flow', { exact: true }).check();
        await flow.getByLabel('Repetition delay', { exact: true }).fill('1');
        await stages.getByRole('button', { name: /Review/ }).click();
        await flow.getByRole('button', { name: 'Start flow', exact: true }).click();
        await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Automation flow', exact: true });
        await expect(dialog.locator('.flow-kind')).toHaveText('Active snapshot');
        for (const [index, format] of ['SVG', 'PNG', 'PDF'].entries()) {
            await dialog.getByRole('button', { name: `Export ${format}`, exact: true }).click();
            await expect(dialog.getByRole('status', { name: 'Flow export status' })).toContainText(
                `${format} exported`,
                { timeout: 30000 },
            );
            const output = path.join(
                evidence,
                `native-export-${index + 1}.${format.toLowerCase()}`,
            );
            await expect
                .poll(async () => {
                    try {
                        return (await readFile(output)).length;
                    } catch {
                        return 0;
                    }
                })
                .toBeGreaterThan(100);
        }
        await page.screenshot({ path: path.join(evidence, 'native-active.png') });
        await page.keyboard.press('Escape');
        await expect
            .poll(() => page.evaluate(() => (window as any).nativeFlow.completed), {
                timeout: 15000,
            })
            .toBeGreaterThanOrEqual(40);
        await flow.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).nativeFlow.active)).toBe(0);
        const state = await page.evaluate(() => (window as any).nativeFlow);
        assert.equal(state.maximum, 1);
        assert.deepEqual(
            state.commands,
            Array.from(
                { length: state.commands.length },
                (_, i) => `native command ${(i % 20) + 1} 日本語 😀`,
            ),
        );
        const pdf = await readFile(path.join(evidence, 'native-export-3.pdf'));
        assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
        await writeFile(
            path.join(evidence, 'native-result.json'),
            JSON.stringify(
                {
                    engine: await app.evaluate(({ app }) => app.getVersion()),
                    scheme: 'flow://',
                    sandbox: true,
                    contextIsolation: true,
                    nodeIntegration: false,
                    commands: state.commands.length,
                    completed: state.completed,
                    maximumOverlap: state.maximum,
                    pdfBytes: pdf.length,
                },
                null,
                2,
            ),
        );
        console.log(
            'Native production renderer flow/export continuity passed:',
            state.commands.length,
            'commands, no overlap.',
        );
    } finally {
        await app.close();
    }
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
