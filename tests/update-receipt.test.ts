import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
