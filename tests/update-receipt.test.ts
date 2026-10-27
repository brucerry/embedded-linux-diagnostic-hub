import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
    mkdtemp,
    mkdir,
    writeFile,
    readFile,
    rm,
    symlink,
    realpath,
    rename,
    unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UpdateReceipts, portableExecutable } from '../electron/update-receipt';
test('Mac native executable resolves to its launchable bundle', () => {
    const bundle = path.join(tmpdir(), 'Applications with spaces', 'Diagnostic Hub.app');
    assert.equal(
        portableExecutable(
            'darwin',
            true,
            path.join(bundle, 'Contents', 'MacOS', 'Diagnostic Hub'),
            {},
        ),
        bundle,
    );
});
test('portable location uses the durable wrapper and does not invent extraction fallbacks', () => {
    const file = path.join(tmpdir(), 'Diagnostic-Hub.exe');
    assert.equal(
        portableExecutable('win32', true, 'temporary-extraction.exe', {
            PORTABLE_EXECUTABLE_FILE: file,
        }),
        file,
    );
    assert.equal(portableExecutable('win32', true, file, {}), null);
    assert.equal(
        portableExecutable('linux', true, 'temporary-extraction', { APPIMAGE: file }),
        file,
    );
    assert.equal(portableExecutable('linux', true, file, {}), null);
    assert.equal(
        portableExecutable('win32', false, file, { PORTABLE_EXECUTABLE_FILE: file }),
        null,
    );
    assert.equal(portableExecutable('darwin', true, file, {}), file);
});
for (const platform of ['win32', 'linux'])
    test(
        platform +
            ' handoff persists through clean mode, confirms version AND path AND hash, rejects arbitrary paths',
        async () => {
            const directory = await mkdtemp(path.join(tmpdir(), 'hub-receipt-'));
            try {
                const receipts = new UpdateReceipts(directory, platform);
                const file = path.join(
                    directory,
                    '0.5.1',
                    platform === 'win32'
                        ? 'Diagnostic-Hub.exe'
                        : 'Diagnostic-Hub-linux-x64.AppImage',
                );
                await mkdir(path.dirname(file));
                const data = Buffer.from('MZreceipt-fixture');
                await writeFile(file, data);
                const receipt = {
                    previousVersion: '0.5.0',
                    version: '0.5.1',
                    executable: file,
                    hash: createHash('sha256').update(data).digest('hex'),
                    state: 'restart-requested' as const,
                };
                await receipts.write(receipt);
                const old = await receipts.info('0.5.0', path.join(directory, 'original.exe'));
                assert.equal(old.handoffConfirmed, false);
                assert.equal(old.receipt?.state, 'restart-requested');
                assert.equal(
                    (await receipts.info('0.5.1', path.join(directory, 'other.exe')))
                        .handoffConfirmed,
                    false,
                );
                assert.equal((await receipts.info('0.5.1', file)).handoffConfirmed, true);
                assert.equal((await receipts.read())?.state, 'confirmed');
                assert.equal(await receipts.selectedPath('verified', null), file);
                await assert.rejects(() => receipts.selectedPath(file, file), /application-owned/);
                await receipts.write({ ...receipt, state: 'restart-failed' });
                assert.equal((await receipts.info('0.5.0', null)).receipt?.state, 'restart-failed');
                await assert.rejects(
                    () =>
                        receipts.write({
                            ...receipt,
                            executable: path.join(directory, 'outside.exe'),
                        }),
                    /Invalid/,
                );
                await writeFile(file, 'tampered');
                await assert.rejects(() => receipts.info('0.5.1', file), /changed/);
                await assert.rejects(() => receipts.selectedPath('verified', null), /changed/);
                await writeFile(path.join(directory, 'handoff.json'), 'x'.repeat(4097));
                await assert.rejects(() => receipts.read(), /Invalid/);
                await writeFile(
                    path.join(directory, 'handoff.json'),
                    JSON.stringify({
                        ...receipt,
                        executable: path.join(directory, '..', 'outside.exe'),
                        updatedAt: new Date().toISOString(),
                    }),
                );
                await assert.rejects(() => receipts.read(), /Invalid/);
            } finally {
                const absolute = path.resolve(directory);
                if (
                    !absolute.startsWith(path.resolve(tmpdir()) + path.sep) ||
                    !path.basename(absolute).startsWith('hub-receipt-')
                )
                    throw Error('Unexpected cleanup');
                await rm(absolute, { recursive: true, force: true });
            }
        },
    );

test('Mac current bundle path is attested without inventing automatic update receipts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-mac-location-'));
    try {
        const bundle = path.join(root, 'Diagnostic Hub.app');
        const executable = path.join(bundle, 'Contents', 'MacOS', 'Diagnostic Hub');
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, 'native bundle fixture');
        const store = new UpdateReceipts(path.join(root, 'updates'), 'darwin');
        const current = portableExecutable('darwin', true, executable, {})!;
        const info = await store.info('0.5.0', current);
        assert.equal(info.currentPath, bundle);
        assert.equal(info.receipt, null);
        assert.equal(info.handoffConfirmed, false);
        assert.equal(await store.selectedPath('current', current), bundle);
        await assert.rejects(() => store.selectedPath(bundle, current), /application-owned/);
    } finally {
        if (
            !path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) ||
            !path.basename(root).startsWith('hub-mac-location-')
        )
            throw Error('Invalid cleanup');
        await rm(root, { recursive: true, force: true });
    }
});

async function aliasFixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-receipt-alias-'));
    const actual = path.join(root, 'actual'),
        alias = path.join(root, 'alias');
    await mkdir(actual);
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    return {
        root,
        actual,
        alias,
        close: async () => {
            const absolute = path.resolve(root);
            if (
                !absolute.startsWith(path.resolve(tmpdir()) + path.sep) ||
                !path.basename(absolute).startsWith('hub-receipt-alias-')
            )
                throw Error('Invalid alias cleanup');
            await rm(absolute, { recursive: true, force: true });
        },
    };
}
test('trusted ancestor aliases preserve verified destinations and checksum confirmation', async () => {
    const fixture = await aliasFixture();
    try {
        const directory = path.join(fixture.alias, 'updates'),
            file = path.join(directory, '0.5.1', 'Diagnostic-Hub.exe');
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'MZalias-fixture');
        const store = new UpdateReceipts(directory, 'win32');
        await store.write({
            previousVersion: '0.5.0',
            version: '0.5.1',
            executable: file,
            hash: createHash('sha256').update('MZalias-fixture').digest('hex'),
            state: 'restart-requested',
        });
        assert.notEqual(
            await realpath(file),
            file,
            'Controlled ancestor must change the canonical prefix',
        );
        assert.equal((await store.info('0.5.1', file)).handoffConfirmed, true);
        assert.equal(await store.selectedPath('verified', null), file);
        console.log(
            JSON.stringify({
                pathAliasHost: process.platform,
                tempPath: tmpdir(),
                canonicalTemp: await realpath(tmpdir()),
                trustedAncestorAliasAccepted: true,
            }),
        );
    } finally {
        await fixture.close();
    }
});
test('matching checksum cannot authorize a redirected version directory or symlink executable', async () => {
    const fixture = await aliasFixture();
    try {
        const directory = path.join(fixture.alias, 'updates'),
            outside = path.join(fixture.actual, 'outside');
        await mkdir(directory);
        await mkdir(outside);
        const data = 'MZsame-bytes';
        await writeFile(path.join(outside, 'Diagnostic-Hub.exe'), data);
        const version = path.join(directory, '0.5.1');
        await symlink(outside, version, process.platform === 'win32' ? 'junction' : 'dir');
        const file = path.join(version, 'Diagnostic-Hub.exe');
        const store = new UpdateReceipts(directory, 'win32');
        await store.write({
            previousVersion: '0.5.0',
            version: '0.5.1',
            executable: file,
            hash: createHash('sha256').update(data).digest('hex'),
            state: 'restart-requested',
        });
        await assert.rejects(() => store.info('0.5.1', file), /location changed|unavailable/);
        await assert.rejects(
            () => store.selectedPath('verified', null),
            /location changed|unavailable/,
        );
        if (process.platform !== 'win32') {
            await rm(version);
            await mkdir(version);
            await symlink(path.join(outside, 'Diagnostic-Hub.exe'), file);
            await assert.rejects(
                () => store.selectedPath('verified', null),
                /location changed|unavailable/,
            );
        }
    } finally {
        await fixture.close();
    }
});
test('Mac bundle accepts ancestor aliases but rejects redirected MacOS contents', async () => {
    const fixture = await aliasFixture();
    try {
        const bundle = path.join(fixture.alias, 'Applications', 'Diagnostic Hub.app'),
            macos = path.join(bundle, 'Contents', 'MacOS'),
            file = path.join(macos, 'Diagnostic Hub');
        await mkdir(macos, { recursive: true });
        await writeFile(file, 'bundle fixture');
        const store = new UpdateReceipts(path.join(fixture.alias, 'updates'), 'darwin');
        assert.equal(await store.selectedPath('current', bundle), bundle);
        const outside = path.join(fixture.actual, 'outside-macos');
        await rename(macos, outside);
        await symlink(outside, macos, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(
            () => store.selectedPath('current', bundle),
            /location changed|unavailable/,
        );
    } finally {
        await fixture.close();
    }
});

test('matching checksum cannot authorize a redirected update anchor', async () => {
    const fixture = await aliasFixture();
    try {
        const outside = path.join(fixture.actual, 'outside-updates');
        const directory = path.join(fixture.alias, 'updates');
        const file = path.join(directory, '0.5.1', 'Diagnostic-Hub.exe');
        await mkdir(path.join(outside, '0.5.1'), { recursive: true });
        await writeFile(path.join(outside, '0.5.1', 'Diagnostic-Hub.exe'), 'same verified bytes');
        await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
        const store = new UpdateReceipts(directory, 'win32');
        await store.write({
            previousVersion: '0.5.0',
            version: '0.5.1',
            executable: file,
            hash: createHash('sha256').update('same verified bytes').digest('hex'),
            state: 'restart-requested',
        });
        await assert.rejects(() => store.info('0.5.1', file), /location changed|unavailable/);
        await assert.rejects(
            () => store.selectedPath('verified', null),
            /location changed|unavailable/,
        );
    } finally {
        await fixture.close();
    }
});
test('ancestor retarget cannot confirm changed executable bytes or trust receipt state', async () => {
    const fixture = await aliasFixture();
    try {
        const directory = path.join(fixture.alias, 'updates');
        const file = path.join(directory, '0.5.1', 'Diagnostic-Hub.exe');
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'original verified bytes');
        const store = new UpdateReceipts(directory, 'win32');
        await store.write({
            previousVersion: '0.5.0',
            version: '0.5.1',
            executable: file,
            hash: createHash('sha256').update('original verified bytes').digest('hex'),
            state: 'restart-requested',
        });
        assert.equal((await store.info('0.5.1', file)).handoffConfirmed, true);
        const receipt = await readFile(path.join(directory, 'handoff.json'));
        const replacement = path.join(fixture.root, 'replacement');
        const replacementUpdates = path.join(replacement, 'updates');
        await mkdir(path.join(replacementUpdates, '0.5.1'), { recursive: true });
        await writeFile(
            path.join(replacementUpdates, '0.5.1', 'Diagnostic-Hub.exe'),
            'changed after retarget',
        );
        await writeFile(path.join(replacementUpdates, 'handoff.json'), receipt);
        const originalCanonical = await realpath(file);
        // Unlink only our owned alias; the original target remains present.
        await unlink(fixture.alias);
        await symlink(
            replacement,
            fixture.alias,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        assert.notEqual(await realpath(file), originalCanonical);
        assert.equal((await store.read())?.state, 'confirmed');
        await assert.rejects(() => store.info('0.5.1', file), /executable has changed/);
        await assert.rejects(() => store.selectedPath('verified', null), /executable has changed/);
    } finally {
        await fixture.close();
    }
});
