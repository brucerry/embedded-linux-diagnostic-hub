import { maintenancePaths } from '../electron/installation-maintenance';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    INSTALLATION_MANIFEST,
    INSTALLATION_PRODUCT,
    INSTALLATION_RECORD,
} from '../shared/installation';
import {
    canonicalProfilePath,
    selectDesktopStartup,
    type DesktopStartupContext,
} from '../electron/installation-startup';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-installation-startup-'));
    const application = path.join(root, 'app with spaces');
    const data = path.join(root, 'user data');
    await mkdir(application);
    await mkdir(data);
    const executable = path.join(application, 'Diagnostic Hub.exe');
    await writeFile(executable, 'payload');
    const id = randomUUID();
    const manifest = {
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        layout: 'windows-nsis',
        platform: 'win32',
        arch: 'x64',
        version: '0.6.0',
        sourceCommit: 'a'.repeat(40),
        entryPoint: 'Diagnostic Hub.exe',
        files: [
            {
                kind: 'file',
                path: 'Diagnostic Hub.exe',
                bytes: 7,
                sha256: createHash('sha256').update('payload').digest('hex'),
            },
        ],
    };
    const bytes = JSON.stringify(manifest);
    await writeFile(path.join(application, INSTALLATION_MANIFEST), bytes);
    await writeFile(
        path.join(application, INSTALLATION_RECORD),
        JSON.stringify({
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            installationId: id,
            manifestSHA256: createHash('sha256').update(bytes).digest('hex'),
            profile: 'dedicated',
        }),
    );
    t.after(async () => {
        const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
        if (
            !relative ||
            relative.startsWith('..') ||
            path.isAbsolute(relative) ||
            !path.basename(root).startsWith('hub-installation-startup-')
        )
            throw Error('Unsafe startup fixture cleanup.');
        await rm(root, { recursive: true, force: true });
    });
    const context: DesktopStartupContext = {
        platform: 'win32',
        arch: 'x64',
        packaged: true,
        version: '0.6.0',
        executable,
        appData: data,
        environment: {},
    };
    return { root, application, data, executable, id, context };
}

test('native startup selects dedicated canonical profile before Electron initialization without payload hashing', async (t) => {
    const f = await fixture(t);
    await writeFile(f.executable, 'changed');
    const result = selectDesktopStartup(f.context);
    assert.equal(result.delivery, 'installed');
    assert.equal(result.installation?.payloadIntegrity, 'not-checked');
    assert.equal(result.currentPath, f.executable);
    assert.equal(
        result.profilePath,
        canonicalProfilePath(path.join(f.data, 'DiagnosticHub', 'profiles', f.id)),
    );
    assert.ok(!result.profilePath?.startsWith(f.application + path.sep));
});

test('native startup rejects bad identity instead of falling back to a shared legacy profile', async (t) => {
    const f = await fixture(t);
    await assert.rejects(access(path.join(f.data, 'DiagnosticHub', 'profiles', f.id)), {
        code: 'ENOENT',
    });
    assert.throws(() => selectDesktopStartup({ ...f.context, version: '0.5.2' }), /identity/);
    assert.throws(
        () =>
            selectDesktopStartup({
                ...f.context,
                profileOverride: path.join(f.application, 'profile'),
            }),
        /outside/,
    );
    await writeFile(path.join(f.application, INSTALLATION_RECORD), '{}');
    assert.throws(() => selectDesktopStartup(f.context), /identity/);
});

test('actual native layout classification preserves portable wrappers and refuses unknown/unqualified directory updates', async (t) => {
    const f = await fixture(t);
    const outside = path.join(f.root, 'temporary extraction', 'Diagnostic Hub.exe');
    const wrapper = path.join(f.root, 'Diagnostic-Hub.exe');
    const ordinary = { ...f.context, executable: outside };
    assert.equal(
        selectDesktopStartup({ ...ordinary, environment: { PORTABLE_EXECUTABLE_FILE: wrapper } })
            .delivery,
        'portable',
    );
    assert.equal(selectDesktopStartup(ordinary).delivery, 'unavailable');
    assert.equal(selectDesktopStartup({ ...ordinary, packaged: false }).currentPath, null);
    const linux = { ...ordinary, platform: 'linux', environment: { APPIMAGE: wrapper } };
    assert.equal(selectDesktopStartup(linux).delivery, 'portable');
});

test('explicit profile aliases resolve to one canonical lock path and cannot redirect into app', async (t) => {
    const f = await fixture(t);
    const canonical = path.join(f.root, 'private profile');
    await mkdir(canonical);
    const alias = path.join(f.root, 'profile alias');
    await symlink(canonical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(canonicalProfilePath(alias), canonicalProfilePath(canonical));
    const selected = selectDesktopStartup({ ...f.context, profileOverride: alias });
    assert.equal(selected.profilePath, canonicalProfilePath(canonical));
    const appAlias = path.join(f.root, 'app alias');
    await symlink(f.application, appAlias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
        () =>
            selectDesktopStartup({ ...f.context, profileOverride: path.join(appAlias, 'profile') }),
        /outside/,
    );
});

test('either installed marker requires complete identity despite inherited portable variables', async (t) => {
    const f = await fixture(t);
    const recordFile = path.join(f.application, INSTALLATION_RECORD);
    const original = await readFile(recordFile);
    await rm(recordFile);
    for (const environment of [
        { PORTABLE_EXECUTABLE_FILE: f.executable },
        { APPIMAGE: f.executable },
    ]) {
        assert.throws(() => selectDesktopStartup({ ...f.context, environment }), /incomplete/);
    }
    await writeFile(recordFile, original);
    await rm(path.join(f.application, INSTALLATION_MANIFEST));
    assert.throws(
        () =>
            selectDesktopStartup({
                ...f.context,
                environment: { PORTABLE_EXECUTABLE_FILE: f.executable },
            }),
        /incomplete/,
    );
    await assert.rejects(access(path.join(f.data, 'DiagnosticHub', 'profiles', f.id)), {
        code: 'ENOENT',
    });
});

test('marked managed AppImage refuses startup rather than selecting a legacy profile', async (t) => {
    const f = await fixture(t);
    const context = {
        ...f.context,
        platform: 'linux',
        executable: path.join(f.root, 'temporary extraction', 'diagnostic-hub'),
        environment: { APPIMAGE: path.join(f.application, 'Diagnostic-Hub-linux-x64.AppImage') },
    };
    assert.throws(() => selectDesktopStartup(context), /Managed AppImage startup is not qualified/);
    await rm(path.join(f.application, INSTALLATION_RECORD));
    assert.throws(() => selectDesktopStartup(context), /incomplete/);
    await assert.rejects(access(path.join(f.data, 'DiagnosticHub', 'profiles', f.id)), {
        code: 'ENOENT',
    });
});

test('maintenance lock refuses startup before a dedicated profile is created', async (t) => {
    const f = await fixture(t),
        files = maintenancePaths(f.application);
    await mkdir(files.work);
    await writeFile(files.lock, JSON.stringify({ product: 'DiagnosticHub' }));
    assert.throws(() => selectDesktopStartup(f.context), /maintenance is in progress/);
    await assert.rejects(access(path.join(f.data, 'DiagnosticHub', 'profiles', f.id)), {
        code: 'ENOENT',
    });
    await rm(files.lock);
    assert.equal(selectDesktopStartup(f.context).delivery, 'installed');
});

test('owned stage and previous slots observe the logical installation maintenance lock before profile creation', async (t) => {
    for (const slot of ['stage', 'previous']) {
        const f = await fixture(t),
            files = maintenancePaths(f.application),
            moved = path.join(files.work, slot + '-' + randomUUID());
        await writeFile(
            path.join(f.application, '.diagnostic-hub-ownership.json'),
            JSON.stringify({
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                installationId: f.id,
                root: f.application,
            }),
        );
        await mkdir(files.work);
        await writeFile(files.lock, JSON.stringify({ product: INSTALLATION_PRODUCT }));
        await rename(f.application, moved);
        const context = { ...f.context, executable: path.join(moved, 'Diagnostic Hub.exe') };
        assert.throws(() => selectDesktopStartup(context), /maintenance is in progress/);
        await assert.rejects(access(path.join(f.data, 'DiagnosticHub', 'profiles', f.id)), {
            code: 'ENOENT',
        });
        await rm(files.lock);
        assert.equal(selectDesktopStartup(context).delivery, 'installed');
    }
});
