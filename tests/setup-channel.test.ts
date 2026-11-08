import assert from 'node:assert/strict';
import test from 'node:test';
import {
    mkdtemp,
    writeFile,
    readFile,
    mkdir,
    link,
    symlink,
    unlink,
    rename,
    access,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setupChannel, decodeSetupINI } from '../electron/setup-channel';
async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hub-setup-channel-'));
    const request = path.join(root, 'setup-request.ini'),
        response = path.join(root, 'setup-response.ini');
    await writeFile(request, '[setup]\noperation=probe\nroot=fixture\n');
    return { root, request, response };
}
test('setup channel atomically writes owned Unicode INI and retains non-setup files', async () => {
    const f = await fixture(),
        channel = await setupChannel(f.request, f.response);
    await channel.write({ ok: 1, message: '測試 🏝', profile: 'C:\\User\\測試' });
    assert.match(decodeSetupINI(await readFile(f.response)), /測試 🏝/);
    await channel.write({ ok: 0, message: 'safe error' });
    assert.match(decodeSetupINI(await readFile(f.response)), /safe error/);
    await unlink(f.response);
    await writeFile(f.response, 'not setup-owned');
    await assert.rejects(channel.write({ ok: 1 }), /not owned/);
    assert.equal(await readFile(f.response, 'utf8'), 'not setup-owned');
});
test('response hardlink and parent junction/alias refuse without changing external sentinel', async () => {
    const f = await fixture(),
        outside = await mkdtemp(path.join(os.tmpdir(), 'hub-channel-outside-')),
        sentinel = path.join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'external data');
    await link(sentinel, f.response);
    const channel = await setupChannel(f.request, f.response);
    await assert.rejects(channel.write({ ok: 1 }), /regular file|aliases/);
    assert.equal(await readFile(sentinel, 'utf8'), 'external data');
    const alias = path.join(f.root, 'parent alias');
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(
        path.join(outside, 'setup-request.ini'),
        '[setup]\noperation=probe\nroot=fixture\n',
    );
    await assert.rejects(
        setupChannel(path.join(alias, 'setup-request.ini'), path.join(alias, 'setup-response.ini')),
        /aliases|identity/,
    );
});
test('channel oversized request refuses before response mutation', async () => {
    const f = await fixture();
    await writeFile(f.request, 'x'.repeat(16385));
    await assert.rejects(setupChannel(f.request, f.response), /bounded/);
});

test('replaced channel parent refuses without writing into replacement or previous directory', async () => {
    const f = await fixture(),
        channel = await setupChannel(f.request, f.response),
        retained = f.root + '-retained';
    await rename(f.root, retained);
    await mkdir(f.root);
    await writeFile(f.response, 'replacement operator file');
    await assert.rejects(channel.write({ ok: 1 }), /directory changed/);
    assert.equal(await readFile(f.response, 'utf8'), 'replacement operator file');
    await assert.rejects(access(path.join(retained, 'setup-response.ini')), { code: 'ENOENT' });
});
test('dangling response alias refuses without creating its external target', async (t) => {
    const f = await fixture(),
        outside = await mkdtemp(path.join(os.tmpdir(), 'hub-dangling-channel-')),
        target = path.join(outside, 'does-not-exist.ini');
    try {
        await symlink(target, f.response, 'file');
    } catch (error) {
        if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
            t.skip('Host does not grant file-symlink creation; no permission change attempted.');
            return;
        }
        throw error;
    }
    const channel = await setupChannel(f.request, f.response);
    await assert.rejects(channel.write({ ok: 1 }), /regular file|aliases/);
    await assert.rejects(access(target), { code: 'ENOENT' });
});
