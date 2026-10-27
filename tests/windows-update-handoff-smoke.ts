import assert from 'node:assert/strict';
import { _electron as electron, chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
async function main() {
    if (process.platform !== 'win32')
        throw Error('Windows packaged handoff test requires Windows.');
    const metadata = process.env.HUB_UPDATE_CURRENT
        ? null
        : JSON.parse(
              await readFile(
                  process.env.HUB_UPDATE_FIXTURE ?? 'validation/update-handoff/fixture.json',
                  'utf8',
              ),
          );
    const current = process.env.HUB_UPDATE_CURRENT ?? metadata?.baseExecutable,
        future = process.env.HUB_UPDATE_FUTURE ?? metadata?.futureExecutable;
    const baseVersion: string = metadata?.baseVersion ?? '0.5.0',
        nextVersion: string = metadata?.nextVersion ?? '0.5.1';
    if (!current || !future) throw Error('Provide isolated current/future packaged fixtures.');
    const size = (await stat(future)).size;
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(future)) digest.update(chunk);
    const hash = digest.digest('hex');
    const temporary = await mkdtemp(path.join(tmpdir(), 'hub-windows-handoff-'));
    const profile = path.join(temporary, 'profile');
    await mkdir(profile);
    let releaseDownload: (() => void) | undefined;
    const server = http.createServer((req, res) => {
        if (req.url?.endsWith('.sha256')) res.end(hash + '  Diagnostic-Hub.exe\n');
        else {
            const first = createReadStream(future, { start: 0, end: 262143 });
            first.pipe(res, { end: false });
            first.on('end', () => {
                releaseDownload = () => createReadStream(future, { start: 262144 }).pipe(res);
            });
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const reserve = http.createServer();
    await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
    const debugPort = (reserve.address() as { port: number }).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined,
        receiver: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    try {
        const env = Object.fromEntries(
            Object.entries(process.env).filter(
                ([k, v]) => k !== 'ELECTRON_RUN_AS_NODE' && v !== undefined,
            ),
        ) as Record<string, string>;
        app = await electron.launch({
            executablePath: current,
            args: ['--user-data-dir=' + profile],
            env,
            chromiumSandbox: true,
        });
        assert.equal(await app.evaluate(({ app }) => app.getVersion()), baseVersion);
        assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
        await app.evaluate(
            ({ app }, data) => {
                const request = globalThis.fetch;
                const base =
                    'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v' +
                    data.nextVersion +
                    '/';
                globalThis.fetch = async (url, init) =>
                    String(url).includes('/repos/')
                        ? Response.json([
                              {
                                  tag_name: 'v' + data.nextVersion,
                                  draft: false,
                                  prerelease: false,
                                  assets: [
                                      {
                                          name: 'Diagnostic-Hub.exe',
                                          size: data.size,
                                          browser_download_url: base + 'Diagnostic-Hub.exe',
                                      },
                                      {
                                          name: 'Diagnostic-Hub.exe.sha256',
                                          size: 100,
                                          browser_download_url: base + 'Diagnostic-Hub.exe.sha256',
                                      },
                                  ],
                              },
                          ])
                        : request(data.endpoint + '/' + String(url).split('/').at(-1), init);
                const relaunch = app.relaunch.bind(app);
                app.relaunch = (options) =>
                    relaunch({
                        ...options,
                        args: [
                            ...(options?.args ?? []),
                            '--remote-debugging-port=' + data.debugPort,
                        ],
                    });
            },
            { size, endpoint, debugPort, nextVersion },
        );
        const page = await app.firstWindow();
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
        const modal = page.getByRole('dialog', { name: 'Application updates' });
        await expect(modal).toContainText('v' + nextVersion);
        await modal.getByRole('radio', { name: 'Update without saving', exact: false }).check();
        await modal.getByRole('button', { name: 'Start update', exact: true }).click();
        await expect.poll(() => Boolean(releaseDownload)).toBe(true);
        await expect
            .poll(
                async () =>
                    Number(
                        await modal
                            .getByRole('progressbar', { name: 'Release download progress' })
                            .getAttribute('value'),
                    ) > 0,
            )
            .toBe(true);
        assert.equal(
            await modal
                .getByRole('progressbar', { name: 'Release download progress' })
                .getAttribute('max'),
            String(size),
        );
        if (process.env.HUB_FEATURE_EVIDENCE)
            await page.screenshot({
                path: path.join(process.env.HUB_FEATURE_EVIDENCE, 'updater-native-download.png'),
                fullPage: true,
            });
        releaseDownload!();
        await expect
            .poll(
                async () => {
                    try {
                        return (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).ok;
                    } catch {
                        return false;
                    }
                },
                { timeout: 60000 },
            )
            .toBe(true);
        receiver = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort);
        const context = receiver.contexts()[0];
        const relaunched = context.pages()[0] ?? (await context.waitForEvent('page'));
        await relaunched.waitForURL('app://bundle/index.html');
        await expect(relaunched.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        await expect(relaunched.locator('.update-receipt-notice')).toContainText(
            'New version confirmed running',
        );
        const info = await relaunched.evaluate(() => window.diagnosticHub!.readUpdateInfo!());
        const expected = path.join(profile, 'updates', nextVersion, 'Diagnostic-Hub.exe');
        assert.equal(info.currentVersion, nextVersion);
        assert.equal(info.currentPath, expected);
        assert.equal(info.receipt?.executable, expected);
        assert.equal(info.receipt?.previousVersion, baseVersion);
        assert.equal(info.receipt?.hash, hash);
        assert.equal(info.handoffConfirmed, true);
        assert.equal((await stat(expected)).size, size);
        await assert.rejects(
            () =>
                relaunched.evaluate(() =>
                    window.diagnosticHub!.openUpdateFolder!('C:\\outside.exe' as 'verified'),
                ),
            /application-owned/,
        );
        const originalClipboard = await relaunched.evaluate(() =>
            window.diagnosticHub!.readClipboard!(),
        );
        try {
            await relaunched.evaluate(() => window.diagnosticHub!.copyUpdatePath!('verified'));
            assert.ok(
                (await relaunched.evaluate(() => window.diagnosticHub!.readClipboard!())) ===
                    expected,
                'Native copy did not match the verified destination.',
            );
        } finally {
            await relaunched.evaluate(
                (text) => window.diagnosticHub!.copyText(text),
                originalClipboard,
            );
        }
        const proof = {
            platform: 'win32-x64',
            sourceFixture: true,
            publicReleaseMutated: false,
            chromiumSandbox: true,
            loopbackDownload: true,
            downloadBytes: size,
            sha256: hash,
            currentVersion: info.currentVersion,
            previousVersion: info.receipt?.previousVersion,
            durablePortablePath: info.currentPath,
            verifiedPath: info.receipt?.executable,
            handoffConfirmed: info.handoffConfirmed,
            cleanModeReceipt: true,
            nativeCopyPath: true,
            arbitraryFolderRejected: true,
            physicalPortsOpened: 0,
        };
        if (process.env.HUB_FEATURE_EVIDENCE) {
            await mkdir(process.env.HUB_FEATURE_EVIDENCE, { recursive: true });
            await writeFile(
                path.join(process.env.HUB_FEATURE_EVIDENCE, 'windows-update-handoff-proof.json'),
                JSON.stringify(proof, null, 2) + '\n',
            );
            await relaunched.locator('.update-receipt-notice summary').click();
            await relaunched.screenshot({
                path: path.join(process.env.HUB_FEATURE_EVIDENCE, 'updater-native-confirmed.png'),
                fullPage: true,
            });
        }
        console.log(JSON.stringify(proof, null, 2));
        await relaunched.evaluate(() => window.close()).catch(() => {});
    } finally {
        await receiver?.close().catch(() => {});
        await app?.close().catch(() => {});
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // Preserve the isolated profile and executable for review; do not delete a running wrapper's files.
        console.log('Isolated handoff profile retained: ' + temporary);
    }
}
void main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
