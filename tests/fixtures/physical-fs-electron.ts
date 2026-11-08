import assert from 'node:assert/strict';
import * as virtualFS from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { physicalFS } from '../../electron/physical-fs';
import { SetupTransaction, type SetupContext } from '../../electron/setup-transaction';
import { copyOwnedFile, unlinkOwnedFile } from '../../electron/setup-paths';
import { observeInstallation } from '../../electron/installation';
import { selectDesktopStartup } from '../../electron/installation-startup';
import { INSTALLATION_PRODUCT } from '../../shared/installation';
import { SETUP_PAYLOAD, SETUP_UNINSTALLER } from '../../electron/installation-maintenance';

const home = process.argv[2];
const output = path.join(home, 'result.json');
const app = process.env.ELECTRON_RUN_AS_NODE === '1' ? null : require('electron').app;
if (app) {
    app.setPath('userData', path.join(home, 'electron-profile'));
    app.setPath('sessionData', path.join(home, 'electron-profile'));
}
const fs = physicalFS.promises;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function run() {
    const sourceRoot = path.join(home, 'source');
    const archive = path.join(sourceRoot, 'resources', 'app.asar');
    const raw = await fs.readFile(archive);
    assert.equal(process.noAsar || false, false);
    assert.equal(virtualFS.lstatSync(archive).isDirectory(), true);
    assert.equal((await virtualFS.promises.lstat(archive)).isDirectory(), true);
    assert.equal(physicalFS.lstatSync(archive).isFile(), true);
    assert.equal((await fs.lstat(archive)).size, raw.length);
    assert.equal(
        virtualFS.readFileSync(path.join(archive, 'inside.txt'), 'utf8'),
        'archive member',
    );

    const executable = 'Diagnostic Hub.exe';
    const entry = Buffer.from('synthetic executable; never launched');
    await fs.writeFile(path.join(sourceRoot, executable), entry);
    await fs.writeFile(path.join(home, SETUP_UNINSTALLER), 'synthetic uninstaller; never launched');
    await fs.writeFile(
        path.join(sourceRoot, SETUP_PAYLOAD),
        JSON.stringify({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            layout: 'windows-nsis',
            platform: 'win32',
            arch: 'x64',
            version: '0.6.0',
            sourceCommit: 'a'.repeat(40),
            entryPoint: executable,
            files: [
                { kind: 'file', path: executable, bytes: entry.length, sha256: digest(entry) },
                {
                    kind: 'file',
                    path: 'resources/app.asar',
                    bytes: raw.length,
                    sha256: digest(raw),
                },
            ],
        }),
    );
    const context: SetupContext = {
        sourceRoot,
        home,
        appData: path.join(home, 'roaming'),
        version: '0.6.0',
        platform: 'win32',
        arch: 'x64',
        busy: async () => false,
        ownerAlive: async (owner) => owner.pid === process.pid,
        processIdentity: async () => ({
            pid: process.pid,
            executable: process.execPath,
            createdAt: 'synthetic-owner',
        }),
        integrate: async (_root, _id, _v, _choices, _previous, save) => {
            await save([]);
            return [];
        },
        validateIntegrations: () => {},
        removeIntegrations: async () => {},
        launch: async () => {
            throw Error('Synthetic fixture must never launch');
        },
        successorObserved: async () => false,
    };
    const root = path.join(home, 'synthetic-installed');
    const engine = new SetupTransaction(context);
    const probe = await engine.probe(root);
    await engine.install(
        root,
        'install',
        { startMenu: false, desktop: false, launch: false },
        probe.reviewToken,
        true,
        path.join(home, SETUP_UNINSTALLER),
    );
    const installedArchive = path.join(root, 'resources', 'app.asar');
    assert.equal(digest(await fs.readFile(installedArchive)), digest(raw));
    assert.equal((await engine.probe(root)).state, 'owned');
    const observed = {
        platform: 'win32',
        arch: 'x64',
        version: '0.6.0',
        executable: path.join(root, executable),
    };
    assert.equal(
        (await observeInstallation(root, observed)).payloadIntegrity,
        'declared-files-verified',
    );
    assert.equal(
        selectDesktopStartup({
            ...observed,
            packaged: true,
            environment: {},
            appData: context.appData,
        }).delivery,
        'installed',
    );

    // Inventory sees the archive as one file, but still refuses unknown on-disk data.
    const unknown = path.join(root, 'operator.txt');
    await fs.writeFile(unknown, 'preserve unknown data');
    const repair = await engine.probe(root);
    await assert.rejects(
        engine.install(
            root,
            'repair',
            { startMenu: false, desktop: false, launch: false },
            repair.reviewToken,
            true,
            path.join(home, SETUP_UNINSTALLER),
        ),
        /unknown|unrecognized|unowned|unexpected/i,
    );
    assert.equal(await fs.readFile(unknown, 'utf8'), 'preserve unknown data');
    await fs.unlink(unknown);

    // Actual file-handle identity, exclusive copy and physical unlink remain enforced.
    const copy = path.join(home, 'copy.asar');
    await copyOwnedFile(archive, copy);
    assert.equal(digest(await fs.readFile(copy)), digest(raw));
    await assert.rejects(copyOwnedFile(archive, copy), { code: 'EEXIST' });
    const linked = path.join(home, 'hardlink.asar');
    await fs.link(copy, linked);
    await assert.rejects(copyOwnedFile(copy, path.join(home, 'refused.asar')), /plain file/);
    await assert.rejects(unlinkOwnedFile(copy), /plain file/);
    await fs.unlink(linked);
    await unlinkOwnedFile(copy);
    await assert.rejects(fs.lstat(copy), { code: 'ENOENT' });
    const alias = path.join(home, 'alias');
    await fs.symlink(
        path.join(sourceRoot, 'resources'),
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
        copyOwnedFile(path.join(alias, 'app.asar'), path.join(home, 'alias-copy.asar')),
        /aliases/,
    );
    await fs.appendFile(installedArchive, 'corrupt');
    await assert.rejects(
        observeInstallation(root, observed),
        /size|digest|checksum|bytes|integrity/i,
    );
    assert.equal(process.noAsar || false, false);
    assert.equal(virtualFS.lstatSync(archive).isDirectory(), true);
    return {
        electron: process.versions.electron,
        runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
        physicalSHA256: digest(raw),
        checks: [
            'virtual-loading-preserved',
            'physical-sync-and-promises',
            'transaction-install-copy-hash',
            'owned-inventory',
            'installation-stream-hash',
            'startup-identity',
            'unknown-data-refused',
            'exclusive-copy',
            'hardlink-refused',
            'alias-refused',
            'physical-unlink',
            'corruption-refused',
        ],
        nativeIntegration: false,
        diagnosticHubLaunched: false,
        windowCreated: false,
        noAsar: process.noAsar || false,
    };
}
run()
    .then((result) => {
        physicalFS.writeFileSync(output, JSON.stringify(result, null, 2));
        if (app) app.exit(0);
    })
    .catch((error) => {
        physicalFS.writeFileSync(output, JSON.stringify({ error: error.stack }, null, 2));
        if (app) app.exit(1);
        else process.exitCode = 1;
    });
