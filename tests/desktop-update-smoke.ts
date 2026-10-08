import { _electron as electron, chromium, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inc } from 'semver';
import { gatewayFixture } from './fixtures/gateway';
import { stopProfileProcesses } from './fixtures/processes';

// A future-release fixture serves the real local AppImage, then exercises the actual relaunch.
// It changes neither GitHub releases nor the user's application profile.
async function main() {
    if (process.platform !== 'linux') throw Error('Run this AppImage relaunch test on Linux.');
    const image = path.resolve('release/Diagnostic-Hub-linux-x64.AppImage');
    const size = (await stat(image)).size;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(image)) hash.update(chunk);
    const checksum = `${hash.digest('hex')}  Diagnostic-Hub-linux-x64.AppImage\n`;
    const temporary = await mkdtemp(path.join(tmpdir(), 'hub-native-update-'));
    const profile = path.join(temporary, 'profile');
    const relaunchLog = path.join(temporary, 'relaunch.log');
    const diagnostics: string[] = [];
    const fixture = await gatewayFixture();
    const server = http.createServer((req, res) => {
        if (req.url?.endsWith('.sha256')) res.end(checksum);
        else createReadStream(image).pipe(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const debug = http.createServer();
    await new Promise<void>((resolve) => debug.listen(0, '127.0.0.1', resolve));
    const debugPort = (debug.address() as { port: number }).port;
    await new Promise<void>((resolve) => debug.close(() => resolve()));
    let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
    let receiver: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    let updatePage: Page | undefined;
    try {
        await mkdir(profile);
        await writeFile(
            path.join(profile, 'known-hosts.json'),
            JSON.stringify({
                [`${fixture.options.host}:${fixture.options.port}`]: fixture.pinned,
            }),
        );
        const sandbox = Boolean(process.env.HUB_TEST_SANDBOX);
        desktop = await electron.launch({
            executablePath: image,
            chromiumSandbox: sandbox,
            args: [
                '--appimage-extract-and-run',
                `--user-data-dir=${profile}`,
                ...(!sandbox ? ['--no-sandbox'] : []),
            ],
            env: Object.fromEntries(
                Object.entries(process.env).filter(
                    (entry): entry is [string, string] =>
                        entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
                ),
            ),
            timeout: 30000,
        });
        desktop.process().stderr?.on('data', (chunk: Buffer) => {
            diagnostics.push(chunk.toString());
            if (diagnostics.length > 100) diagnostics.shift();
        });
        const current = await desktop.evaluate(({ app }) => app.getVersion());
        const version = inc(current, 'minor')!;
        await desktop.evaluate(
            ({ app }, data) => {
                const request = globalThis.fetch;
                const name = 'Diagnostic-Hub-linux-x64.AppImage';
                const base = `https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v${data.version}/`;
                globalThis.fetch = async (url, init) =>
                    String(url).includes('/repos/')
                        ? Response.json([
                              {
                                  tag_name: `v${data.version}`,
                                  prerelease: true,
                                  draft: false,
                                  assets: [
                                      { name, size: data.size, browser_download_url: base + name },
                                      {
                                          name: `${name}.sha256`,
                                          size: 100,
                                          browser_download_url: `${base}${name}.sha256`,
                                      },
                                  ],
                              },
                          ])
                        : request(`${data.endpoint}/${String(url).split('/').at(-1)}`, init);
                const relaunch = app.relaunch.bind(app);
                app.relaunch = (options) =>
                    relaunch({
                        ...options,
                        args: [
                            ...(options?.args ?? []),
                            `--remote-debugging-port=${data.debugPort}`,
                            '--enable-logging=file',
                            `--log-file=${data.relaunchLog}`,
                            ...(!data.sandbox ? ['--no-sandbox'] : []),
                        ],
                    });
            },
            { endpoint, size, version, debugPort, sandbox, relaunchLog },
        );
        const page = await desktop.firstWindow();
        updatePage = page;
        await page.evaluate(
            async (options) => {
                await window.diagnosticHub!.connect(options);
                await window.diagnosticHub!.collect();
            },
            fixture.options as Parameters<NonNullable<Window['diagnosticHub']>['connect']>[0],
        );
        await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
        const modal = page.getByRole('dialog', { name: 'Application updates' });
        await expect(modal).toContainText(`v${version}`);
        await modal.getByRole('radio', { name: 'Save, update & reopen report' }).check();
        await modal.getByRole('button', { name: 'Start update' }).click();
        const downloaded = path.join(
            profile,
            'updates',
            version,
            'Diagnostic-Hub-linux-x64.AppImage',
        );

        await expect
            .poll(
                async () => {
                    try {
                        return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;
                    } catch {
                        return false;
                    }
                },
                { timeout: 45000 },
            )
            .toBe(true);
        receiver = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
        const context = receiver.contexts()[0];
        const relaunched = context.pages()[0] ?? (await context.waitForEvent('page'));
        await relaunched.waitForURL('app://bundle/index.html');
        await expect(relaunched.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        expect((await stat(downloaded)).size).toBe(size);
        await expect(relaunched.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
        await expect(
            relaunched.getByRole('button', { name: 'Connect device', exact: true }),
        ).toBeEnabled();
        await expect(relaunched.getByRole('switch', { name: 'Live updates' })).not.toBeChecked();
        await expect(
            relaunched.getByText('Report reopened after update', { exact: true }),
        ).toBeVisible();

        const result = await relaunched.evaluate(
            async (options) => {
                await window.diagnosticHub!.connect(options);
                const snapshot = await window.diagnosticHub!.collect();
                await window.diagnosticHub!.disconnect();
                return snapshot;
            },
            fixture.options as Parameters<NonNullable<Window['diagnosticHub']>['connect']>[0],
        );
        expect(result.endpoint).toBe(`${fixture.options.host}:${fixture.options.port}`);
        expect(result.mode).toBe('ssh');
        // Existing trust was reused; a changed profile would instead wait for host approval.
        expect(
            JSON.parse(await readFile(path.join(profile, 'known-hosts.json'), 'utf8'))[
                `${fixture.options.host}:${fixture.options.port}`
            ],
        ).toBe(fixture.pinned);
        console.log(
            'Actual portable update passed: real AppImage download, SHA-256 verification, native quit/relaunch, preserved profile and trusted loopback SSH.',
        );
    } catch (error) {
        console.error('Original AppImage process exit code:', desktop?.process().exitCode);
        console.error('Original AppImage stderr:', diagnostics.join(''));
        console.error(
            'Update dialog:',
            await updatePage
                ?.getByRole('dialog', { name: 'Application updates' })
                .innerText({ timeout: 1000 })
                .catch(() => 'The original update dialog is no longer available.'),
        );
        console.error(
            'Relaunch Chromium log:',
            await readFile(relaunchLog, 'utf8')
                .then((log) => log.slice(-24000))
                .catch(() => 'No relaunch log was created.'),
        );
        throw error;
    } finally {
        await receiver?.close().catch(() => {});
        await desktop?.close().catch(() => {});
        await stopProfileProcesses(profile);
        await fixture.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(temporary, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
