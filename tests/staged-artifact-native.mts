import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const executable = process.env.HUB_TEST_EXECUTABLE;
const destination = process.env.HUB_STAGED_IDENTITY;
assert.ok(
    executable && path.isAbsolute(executable),
    'An actual staged executable is required; no development fallback.',
);
assert.ok(destination && path.isAbsolute(destination));
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const profile = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-staged-profile-')));
const environment = Object.fromEntries(
    Object.entries(process.env).filter(
        ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
) as Record<string, string>;
if (process.env.HUB_TEST_APPIMAGE === '1') environment.APPIMAGE_EXTRACT_AND_RUN = '1';
const application = await electron.launch({
    executablePath: executable,
    args: ['--user-data-dir=' + profile],
    env: environment,
    chromiumSandbox: true,
    timeout: 30000,
});
const child = application.process();
const termination = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
);
let identity;
try {
    const page = await application.firstWindow();
    await page.waitForURL('app://bundle/index.html');
    await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
    identity = await application.evaluate(
        async ({ app, BrowserWindow }, marker) => {
            const contents = BrowserWindow.getAllWindows()[0].webContents;
            // Public APIs observe separate worlds and the actual OS renderer. Preload process
            // globals need not remain globally exposed after its sandbox wrapper returns.
            const key = JSON.stringify(marker);
            await contents.executeJavaScriptInIsolatedWorld(999, [
                { code: `globalThis[${key}]=true` },
            ]);
            let isolated;
            try {
                isolated = await contents.executeJavaScript(
                    `typeof globalThis[${key}] === 'undefined'`,
                );
            } finally {
                await contents.executeJavaScriptInIsolatedWorld(999, [
                    { code: `delete globalThis[${key}]` },
                ]);
            }
            const noPageNode = await contents.executeJavaScript(
                'typeof process === "undefined" && typeof require === "undefined"',
            );
            const rendererPID = contents.getOSProcessId();
            const metric = app.getAppMetrics().find((item) => item.pid === rendererPID);
            return {
                asset: process.env.HUB_STAGED_ASSET,
                packaged: app.isPackaged,
                version: app.getVersion(),
                platform: process.platform,
                arch: process.arch,
                executable: process.execPath,
                asar: app.getAppPath(),
                rendererPID,
                osSandboxed: metric?.sandboxed ?? null,
                contextsSeparated: isolated === true,
                pageNodeAbsent: noPageNode === true,
                versions: {
                    node: process.versions.node,
                    electron: process.versions.electron,
                    chrome: process.versions.chrome,
                },
                sandbox:
                    isolated === true &&
                    noPageNode === true &&
                    !process.argv.includes('--no-sandbox'),
            };
        },
        '__stagedQualification_' + randomUUID().replaceAll('-', ''),
    );
    if (process.platform === 'linux') {
        const status = await readFile(`/proc/${identity.rendererPID}/status`, 'utf8');
        identity.osSandboxed = /^NoNewPrivs:\s+1$/m.test(status) && /^Seccomp:\s+2$/m.test(status);
    }
    identity.sandbox = identity.sandbox && identity.osSandboxed === true;
    assert.equal(identity.packaged, true);
    assert.equal(identity.version, version);
    assert.equal(identity.platform, process.platform);
    assert.equal(identity.arch, process.arch);
    assert.equal(identity.sandbox, true);
    assert.equal(path.basename(identity.asar), 'app.asar');
    const hash = async (file: string) =>
        createHash('sha256')
            .update(await readFile(file))
            .digest('hex');
    Object.assign(identity, {
        executableSHA256: await hash(identity.executable),
        asarSHA256: await hash(identity.asar),
    });
} finally {
    await application.close();
}
assert.deepEqual(
    await termination,
    { code: 0, signal: null },
    'Packaged app must actually exit normally.',
);
await writeFile(destination, JSON.stringify(identity, null, 2) + '\n', { flag: 'wx' });
