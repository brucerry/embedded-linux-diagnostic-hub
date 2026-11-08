import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
    mkdtemp,
    mkdir,
    writeFile,
    readFile,
    rm,
    symlink,
    rename,
    realpath,
    unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    INSTALLATION_PRODUCT,
    INSTALLATION_MANIFEST,
    INSTALLATION_RECORD,
    installationActions,
    supportedInstallHost,
    validateInstallationRecord,
    validateInstallationManifest,
    type InstallationManifest,
} from '../shared/installation';
import { observeInstallation, observeInstallationLocation } from '../electron/installation';

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function manifest(
    layout: InstallationManifest['layout'] = 'windows-folder',
    arch: InstallationManifest['arch'] = 'x64',
): InstallationManifest {
    const entry = {
        'windows-nsis': 'Diagnostic Hub.exe',
        'windows-folder': 'app/Diagnostic Hub.exe',
        'macos-bundle': 'Diagnostic Hub.app/Contents/MacOS/Diagnostic Hub',
        'linux-folder': 'app/diagnostic-hub',
        'linux-appimage': 'Diagnostic-Hub-linux-x64.AppImage',
    }[layout];
    return {
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        layout,
        platform: layout.startsWith('windows')
            ? 'win32'
            : layout === 'macos-bundle'
              ? 'darwin'
              : 'linux',
        arch,
        version: '0.6.0',
        sourceCommit: 'a'.repeat(40),
        entryPoint: entry,
        files: [{ kind: 'file', path: entry, bytes: 7, sha256: digest('payload') }],
    };
}

test('installed layouts accept only current supported native architectures and fixed entry points', () => {
    for (const layout of [
        'windows-nsis',
        'windows-folder',
        'macos-bundle',
        'linux-folder',
        'linux-appimage',
    ] as const)
        assert.equal(validateInstallationManifest(manifest(layout)).layout, layout);
    assert.equal(validateInstallationManifest(manifest('macos-bundle', 'arm64')).arch, 'arm64');
    for (const platform of ['win32', 'linux'])
        assert.equal(supportedInstallHost(platform, 'arm64'), false);
    assert.equal(supportedInstallHost('darwin', 'arm64'), true);
    assert.throws(() => validateInstallationManifest({ ...manifest(), arch: 'arm64' }));
    assert.throws(() => validateInstallationManifest({ ...manifest(), entryPoint: 'outside.exe' }));
});

test('installation metadata rejects path escape, normalized collisions, reserved names and unsupported schema', () => {
    const original = manifest();
    for (const filename of [
        '../escape',
        '/absolute',
        'C:/drive',
        'app/../escape',
        'app/CON.txt',
        'app/file.',
        'app/file:stream',
        'app/a\\b',
    ]) {
        assert.throws(
            () =>
                validateInstallationManifest({
                    ...original,
                    files: [
                        ...original.files,
                        { kind: 'file', path: filename, bytes: 0, sha256: digest('') },
                    ],
                }),
            filename,
        );
    }
    assert.throws(() =>
        validateInstallationManifest({
            ...original,
            files: [...original.files, { ...original.files[0], path: 'APP/Diagnostic Hub.exe' }],
        }),
    );
    assert.throws(() => validateInstallationManifest({ ...original, schemaVersion: 2 }));
    assert.throws(() => validateInstallationManifest({ ...original, arbitraryPath: '/outside' }));
    assert.throws(() =>
        validateInstallationRecord({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            installationId: randomUUID(),
            manifestSHA256: 'f'.repeat(64),
            profile: 'dedicated',
            executable: 'arbitrary.exe',
        }),
    );
});

test('Mac framework links are permitted within the bundle while escaping or Windows links are rejected', () => {
    const mac = manifest('macos-bundle');
    const link = {
        kind: 'link' as const,
        path: 'Diagnostic Hub.app/Contents/Frameworks/Test.framework/Current',
        target: 'Versions/A',
    };
    assert.equal(
        validateInstallationManifest({ ...mac, files: [...mac.files, link] }).files.length,
        2,
    );
    assert.throws(() =>
        validateInstallationManifest({
            ...mac,
            files: [...mac.files, { ...link, target: '../../../../../../outside' }],
        }),
    );
    assert.throws(() =>
        validateInstallationManifest({
            ...manifest(),
            files: [
                ...manifest().files,
                { kind: 'link', path: 'app/link', target: 'Diagnostic Hub.exe' },
            ],
        }),
    );
});

test('maintenance offers existing offline launch and same-version repair without silent downgrade/reinstall', () => {
    assert.deepEqual(installationActions(null, '0.6.0'), ['install']);
    assert.deepEqual(installationActions(null, null), []);
    assert.deepEqual(installationActions('0.6.0', null), ['launch']);
    assert.deepEqual(installationActions('0.6.0', '0.6.0'), ['launch', 'repair']);
    assert.deepEqual(installationActions('0.5.2', '0.6.0'), ['launch', 'update']);
    assert.deepEqual(installationActions('0.6.0', '0.5.2'), ['launch']);
    assert.throws(() => installationActions('invalid', '0.6.0'));
});

async function fixture(t: { after(callback: () => Promise<void>): void }) {
    const anchor = await mkdtemp(path.join(tmpdir(), 'hub-installation-contract-'));
    const root = path.join(anchor, 'real parent', 'installed app with spaces');
    await mkdir(path.join(root, 'app'), { recursive: true });
    await mkdir(path.join(anchor, 'profile'));
    await writeFile(path.join(anchor, 'profile', 'marker'), 'preserved');
    t.after(async () => {
        const absolute = path.resolve(anchor);
        const relative = path.relative(path.resolve(tmpdir()), absolute);
        if (
            !relative ||
            relative.startsWith('..') ||
            path.isAbsolute(relative) ||
            !path.basename(absolute).startsWith('hub-installation-contract-')
        )
            throw Error('Unsafe test cleanup root.');
        await rm(absolute, { recursive: true, force: true });
    });
    const release = manifest();
    const bytes = JSON.stringify(release);
    await writeFile(path.join(root, ...release.entryPoint.split('/')), 'payload');
    await writeFile(path.join(root, INSTALLATION_MANIFEST), bytes);
    await writeFile(
        path.join(root, INSTALLATION_RECORD),
        JSON.stringify({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            installationId: randomUUID(),
            manifestSHA256: digest(bytes),
            profile: 'dedicated',
        }),
    );
    const observed = {
        platform: 'win32',
        arch: 'x64',
        version: '0.6.0',
        executable: path.join(root, ...release.entryPoint.split('/')),
    };
    return { anchor, root, observed };
}

test('native installed observation binds real path, version, manifest and declared payload without enabling updates', async (t) => {
    const f = await fixture(t);
    const result = await observeInstallation(f.root, f.observed);
    assert.equal(result.manifest.version, '0.6.0');
    assert.equal(result.automaticUpdateQualified, false);
    await assert.rejects(
        observeInstallation(f.root, { ...f.observed, version: '0.5.2' }),
        /identity/,
    );
    await assert.rejects(
        observeInstallation(f.root, {
            ...f.observed,
            executable: path.join(f.anchor, 'other.exe'),
        }),
        /identity/,
    );
    await writeFile(f.observed.executable, 'mutated');
    await assert.rejects(observeInstallation(f.root, f.observed), /integrity/);
    assert.equal(await readFile(path.join(f.anchor, 'profile', 'marker'), 'utf8'), 'preserved');
});

test('native installed observation rejects changed/oversized metadata and an aliased root', async (t) => {
    const f = await fixture(t);
    const record = path.join(f.root, INSTALLATION_RECORD);
    const original = await readFile(record);
    await writeFile(record, ' '.repeat(16 * 1024 + 1));
    await assert.rejects(observeInstallation(f.root, f.observed), /bound/);
    await writeFile(record, original);
    const alias = path.join(f.anchor, 'alias');
    await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(observeInstallation(alias, f.observed), /real directory/);
    await writeFile(path.join(f.root, INSTALLATION_MANIFEST), '{}');
    await assert.rejects(observeInstallation(f.root, f.observed), /manifest has changed/);
});

test('manifest bounds and Unicode-equivalent names reject unsafe release inventory', () => {
    const original = manifest();
    assert.throws(
        () =>
            validateInstallationManifest({
                ...original,
                files: [
                    ...original.files,
                    { kind: 'file', path: 'app/e\u0301.txt', bytes: 0, sha256: digest('') },
                    { kind: 'file', path: 'app/é.txt', bytes: 0, sha256: digest('') },
                ],
            }),
        /Duplicate/,
    );
    assert.throws(
        () =>
            validateInstallationManifest({
                ...original,
                files: [
                    ...original.files,
                    {
                        kind: 'file',
                        path: 'app/large.bin',
                        bytes: 2 * 1024 ** 3,
                        sha256: digest(''),
                    },
                ],
            }),
        /bound/,
    );
    assert.throws(
        () =>
            validateInstallationManifest({
                ...original,
                files: original.files.map((entry) => ({ ...entry, path: 'app/other.exe' })),
            }),
        /entry point/,
    );
});

test('native installed observation refuses missing payload and declared file paths through directory aliases', async (t) => {
    const f = await fixture(t);
    const missing = path.join(f.root, INSTALLATION_MANIFEST);
    const saved = await readFile(missing);
    await rm(missing);
    await assert.rejects(observeInstallation(f.root, f.observed));
    await writeFile(missing, saved);
    const other = path.join(f.anchor, 'other payload');
    await mkdir(other);
    await writeFile(path.join(other, 'Diagnostic Hub.exe'), 'payload');
    const original = path.join(f.root, 'app');
    // Fixture-owned paths only; no host directories are removed or moved.
    const source = path.resolve(original);
    const destination = path.resolve(path.join(f.root, 'app-before-alias'));
    for (const target of [source, destination]) {
        const relative = path.relative(f.anchor, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            throw Error('Unsafe fixture move.');
    }
    await rename(source, destination);
    await symlink(other, original, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(observeInstallation(f.root, f.observed), /redirects/);
});

test('lightweight native location observation does not claim or perform payload hash qualification', async (t) => {
    const f = await fixture(t);
    await writeFile(f.observed.executable, 'mutated');
    const fast = await observeInstallationLocation(f.root, f.observed);
    assert.equal(fast.payloadIntegrity, 'not-checked');
    assert.equal(fast.automaticUpdateQualified, false);
    await assert.rejects(observeInstallation(f.root, f.observed), /integrity/);
});

test('approved ancestor aliases canonicalize without accepting aliases inside the payload', async (t) => {
    const f = await fixture(t);
    const alias = path.join(f.anchor, 'approved parent alias');
    await symlink(path.dirname(f.root), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const selected = path.join(alias, path.basename(f.root));
    const observed = {
        ...f.observed,
        executable: path.join(selected, 'app', 'Diagnostic Hub.exe'),
    };
    const result = await observeInstallationLocation(selected, observed);
    assert.equal(result.root, await realpath(f.root));
    await assert.rejects(observeInstallationLocation(f.root, observed), /identity/);
});

test(
    'macOS native filesystem preserves declared framework links and rejects escape',
    { skip: process.platform !== 'darwin' },
    async (t) => {
        const f = await fixture(t);
        const release = manifest('macos-bundle');
        const native = path.join(f.root, ...release.entryPoint.split('/'));
        await mkdir(path.dirname(native), { recursive: true });
        await writeFile(native, 'payload');
        const framework = 'Diagnostic Hub.app/Contents/Frameworks/Test.framework';
        const realFile = framework + '/Versions/A/Test';
        await mkdir(path.dirname(path.join(f.root, ...realFile.split('/'))), { recursive: true });
        await writeFile(path.join(f.root, ...realFile.split('/')), 'framework');
        const link = framework + '/Current';
        await symlink('Versions/A', path.join(f.root, ...link.split('/')));
        release.files.push(
            { kind: 'file', path: realFile, bytes: 9, sha256: digest('framework') },
            { kind: 'link', path: link, target: 'Versions/A' },
        );
        const bytes = JSON.stringify(release);
        await writeFile(path.join(f.root, INSTALLATION_MANIFEST), bytes);
        await writeFile(
            path.join(f.root, INSTALLATION_RECORD),
            JSON.stringify({
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                installationId: randomUUID(),
                manifestSHA256: digest(bytes),
                profile: 'existing-mac',
            }),
        );
        const result = await observeInstallation(f.root, {
            platform: 'darwin',
            arch: 'x64',
            version: '0.6.0',
            executable: native,
        });
        assert.equal(result.payloadIntegrity, 'declared-files-verified');
        await unlink(path.join(f.root, ...link.split('/')));
        await symlink(f.anchor, path.join(f.root, ...link.split('/')));
        await assert.rejects(
            observeInstallation(f.root, {
                platform: 'darwin',
                arch: 'x64',
                version: '0.6.0',
                executable: native,
            }),
            /link does not match/,
        );
    },
);
