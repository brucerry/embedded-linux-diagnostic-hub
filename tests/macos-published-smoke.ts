import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FixtureCdp } from './fixtures/cdp-document';

async function verifyPublishedMac() {
    assert.equal(process.platform, 'darwin');
    const { version } = JSON.parse(await readFile('package.json', 'utf8'));
    const tag = 'v' + version;
    const root = await mkdtemp(path.join(tmpdir(), 'hub-published-mac-'));
    const directory = path.join(root, 'Applications with spaces');
    async function port() {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const value = (server.address() as { port: number }).port;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return value;
    }
    const mainPort = await port(),
        rendererPort = await port();
    const url =
        'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest/download/download-run-macos.sh';
    const args = [
        '--directory',
        directory,
        '--',
        '--inspect=127.0.0.1:' + mainPort,
        '--remote-debugging-port=' + rendererPort,
        '--user-data-dir=' + path.join(root, 'profile'),
    ];
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = 'curl -fsSL ' + quote(url) + ' | /bin/bash -s -- ' + args.map(quote).join(' ');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const installed = spawnSync('/bin/bash', ['-o', 'pipefail', '-c', command], {
        env,
        encoding: 'utf8',
        timeout: 180000,
    });
    assert.equal(installed.status, 0, installed.stderr + installed.stdout);
    const app = path.join(directory, 'Diagnostic Hub.app');
    const manifestResponse = await fetch(
        'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/' +
            tag +
            '/macos-build-info-' +
            process.arch +
            '.json',
    );
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.commit, process.env.GITHUB_SHA);
    assert.equal(manifest.version, version);
    assert.equal(manifest.arch, process.arch);
    assert.equal(
        createHash('sha256')
            .update(await readFile(path.join(app, 'Contents/Resources/app.asar')))
            .digest('hex'),
        manifest.asarSHA256,
    );
    async function inspector(port: number, renderer: boolean) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            try {
                const response = await fetch('http://127.0.0.1:' + port + '/json/list');
                const targets = (await response.json()) as {
                    type: string;
                    webSocketDebuggerUrl: string;
                }[];
                const target = targets.find((item) => !renderer || item.type === 'page');
                if (target) return FixtureCdp.connect(target.webSocketDebuggerUrl);
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw Error('Published app inspector did not open.');
    }
    let main: FixtureCdp | undefined, renderer: FixtureCdp | undefined;
    try {
        main = await inspector(mainPort, false);
        renderer = await inspector(rendererPort, true);
        const state = await main.evaluate(
            "(()=>{const e=process.mainModule.require('electron');return {version:e.app.getVersion(),packaged:e.app.isPackaged,arch:process.arch,executable:process.execPath,visible:e.BrowserWindow.getAllWindows().some(w=>w.isVisible())}})()",
        );
        assert.equal(state.version, version);
        assert.equal(state.packaged, true);
        assert.equal(state.arch, process.arch);
        assert.equal(state.executable, path.join(app, 'Contents/MacOS/Diagnostic Hub'));
        assert.equal(state.visible, true);
        const deadline = Date.now() + 5000;
        while (
            !(await renderer.evaluate(
                "document.readyState==='complete' && typeof window.diagnosticHub?.connect==='function' && document.body.innerText.includes('Connect')",
            ))
        ) {
            if (Date.now() >= deadline)
                throw Error('Published renderer/bridge did not become ready.');
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const running = spawnSync(
            '/bin/bash',
            [
                path.resolve('public/download-run-macos.sh'),
                '--version',
                tag,
                '--directory',
                directory,
                '--no-launch',
            ],
            { env, encoding: 'utf8', timeout: 15000 },
        );
        assert.notEqual(running.status, 0);
        assert.match(running.stderr, /Quit Diagnostic Hub/);
        console.log(
            JSON.stringify({
                publishedCommandPassed: true,
                source: manifest.commit,
                tag,
                arch: process.arch,
                visible: true,
                rendererBridgeReady: true,
                runningUpdateRefused: true,
                quarantinedBrowserAcceptance: false,
            }),
        );
    } finally {
        if (main) {
            await main
                .evaluate(
                    "setImmediate(()=>process.mainModule.require('electron').app.quit());true",
                )
                .catch(() => {});
            main.close();
        }
        renderer?.close();
    }
    const deadline = Date.now() + 5000;
    while (
        spawnSync('/usr/sbin/lsof', ['-t', path.join(app, 'Contents/MacOS/Diagnostic Hub')])
            .status === 0
    ) {
        if (Date.now() >= deadline) throw Error('Published app did not quit.');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (process.env.GITHUB_ENV)
        await writeFile(
            process.env.GITHUB_ENV,
            'HUB_TEST_EXECUTABLE=' + path.join(app, 'Contents/MacOS/Diagnostic Hub') + '\n',
            { flag: 'a' },
        );
}

verifyPublishedMac().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
