import assert from 'node:assert/strict';
import test from 'node:test';
import { constants } from 'node:fs';
import { mkdtemp, writeFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    boundedSetupJSON,
    SetupMetadataReadFailure,
} from '../electron/installation-maintenance.ts';

function fixture(text = '{"value":"kept"}') {
    const bytes = Buffer.from(text),
        calls: any[] = [],
        controls: any = {};
    const node: any = {
        dev: 1,
        ino: 2,
        size: bytes.length,
        mtimeMs: 1,
        ctimeMs: 1,
        nlink: 1,
        mode: 0o100600,
        isFile: () => true,
        isSymbolicLink: () => false,
    };
    let pathNode = node,
        closes = 0,
        reads = 0;
    let entered!: () => void;
    const closeEntered = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const handle: any = {
        stat: async () => ({ ...node }),
        async read(buffer: Buffer, offset: number, length: number, position: number) {
            calls.push(['read', length, position]);
            reads++;
            if (controls.readHook) controls.readHook({ node, position, reads });
            if (controls.readReject) throw controls.readError;
            const source = controls.content ?? bytes;
            const count = Math.min(
                length,
                controls.short ?? length,
                Math.max(0, source.length - position),
            );
            source.copy(buffer, offset, position, position + count);
            return { bytesRead: controls.badRead === undefined ? count : controls.badRead };
        },
        async close() {
            closes++;
            calls.push(['close']);
            entered();
            if (controls.closeGate) await controls.closeGate;
            if (controls.closeError) throw controls.closeError;
            return controls.closeReturn;
        },
    };
    const io: any = {
        async lstat(file: string) {
            calls.push(['lstat', file]);
            if (controls.absent) throw Object.assign(Error('missing'), { code: 'ENOENT' });
            return { ...pathNode };
        },
        async open(file: string, flags: number) {
            calls.push(['open', file, flags]);
            assert.equal(
                flags,
                constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
            );
            if (controls.openHook) controls.openHook();
            if (controls.openReject) throw controls.openError;
            return handle;
        },
        readFile() {
            assert.fail('Unbounded pathname readFile must not be used');
        },
    };
    return {
        bytes,
        calls,
        controls,
        node,
        handle,
        io,
        closeEntered,
        reads: () => reads,
        closes: () => closes,
        replacePath(next: any) {
            pathNode = next;
        },
    };
}
test('actual setup metadata reader accepts normal JSON and closes one owned descriptor before returning', async () => {
    const f = fixture();
    const value = await boundedSetupJSON('/owned/metadata.json', 16384, f.io);
    assert.deepEqual(value, { value: 'kept' });
    assert.equal(f.closes(), 1);
    assert.ok(
        f.calls.filter((row) => row[0] === 'read').every((row) => row[1] <= f.bytes.length + 1),
    );
    assert.equal(f.calls.at(-1)[0], 'close');
});
test('short descriptor reads reconstruct multibyte UTF8 without replacement or repeated positions', async () => {
    const f = fixture('{"unicode":"中😀"}');
    f.controls.short = 1;
    assert.deepEqual(await boundedSetupJSON('/owned/metadata.json', 64, f.io), { unicode: '中😀' });
    assert.deepEqual(
        f.calls.filter((row) => row[0] === 'read').map((row) => row[2]),
        Array.from({ length: f.bytes.length + 1 }, (_, i) => i),
    );
    assert.equal(f.closes(), 1);
});
for (const mode of [
    'symlink',
    'hardlink',
    'not-file',
    'too-large',
    'invalid-size',
    'invalid-inode',
])
    test('unsafe initial metadata refuses before open: ' + mode, async () => {
        const f = fixture();
        if (mode === 'symlink') f.node.isSymbolicLink = () => true;
        if (mode === 'hardlink') f.node.nlink = 2;
        if (mode === 'not-file') f.node.isFile = () => false;
        if (mode === 'too-large') f.node.size = 100;
        if (mode === 'invalid-size') f.node.size = -1;
        if (mode === 'invalid-inode') f.node.ino = 0;
        await assert.rejects(boundedSetupJSON('/owned/metadata.json', 64, f.io));
        assert.equal(
            f.calls.some((row) => row[0] === 'open'),
            false,
        );
    });
for (const mode of ['larger-file', 'different-inode', 'symlink-target', 'special-file'])
    test('replacement between lstat and open refuses before any read: ' + mode, async () => {
        const f = fixture();
        f.controls.openHook = () => {
            if (mode === 'larger-file') f.node.size = 2 ** 40;
            if (mode === 'different-inode') f.node.ino++;
            if (mode === 'symlink-target') f.node.isSymbolicLink = () => true;
            if (mode === 'special-file') f.node.isFile = () => false;
        };
        await assert.rejects(boundedSetupJSON('/owned/metadata.json', 64, f.io));
        assert.equal(f.reads(), 0);
        assert.equal(f.closes(), 1);
    });
for (const mode of ['growth', 'truncation', 'changed-mtime', 'path-replaced'])
    test('reading refuses ' + mode + ' and still acknowledges close once', async () => {
        const f = fixture();
        if (mode === 'growth') f.controls.content = Buffer.concat([f.bytes, Buffer.from('extra')]);
        if (mode === 'truncation') f.controls.content = f.bytes.subarray(0, 3);
        f.controls.readHook = () => {
            if (mode === 'changed-mtime') f.node.mtimeMs++;
            if (mode === 'path-replaced') f.replacePath({ ...f.node, ino: 90 });
        };
        await assert.rejects(boundedSetupJSON('/owned/metadata.json', 64, f.io));
        assert.ok(
            f.calls
                .filter((row) => row[0] === 'read')
                .every((row) => row[1] <= 65536 && row[1] + row[2] <= f.bytes.length + 1),
        );
        assert.equal(f.closes(), 1);
    });
for (const count of [-1, 0.5, 100000, NaN])
    test('invalid descriptor read acknowledgement refuses: ' + String(count), async () => {
        const f = fixture();
        f.controls.badRead = count;
        await assert.rejects(boundedSetupJSON('/owned/metadata.json', 64, f.io));
        assert.equal(f.closes(), 1);
    });
for (const text of ['', '{invalid', '\ufeff{"x":1}'])
    test('invalid JSON/BOM refuses after owned close: ' + JSON.stringify(text), async () => {
        const f = fixture(text);
        await assert.rejects(boundedSetupJSON('/owned/metadata.json', 64, f.io));
        assert.equal(f.closes(), 1);
    });
test('malformed UTF8 is rejected rather than replacing evidence characters', async () => {
    const f = fixture('{"x":"?"}');
    f.controls.content = Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]);
    await assert.rejects(boundedSetupJSON('/owned/metadata.json', 64, f.io));
    assert.equal(f.closes(), 1);
});
test('initial absence remains ENOENT without acquiring a descriptor', async () => {
    const f = fixture();
    f.controls.absent = true;
    await assert.rejects(boundedSetupJSON('/owned/metadata.json', 64, f.io), { code: 'ENOENT' });
    assert.equal(f.closes(), 0);
    assert.equal(f.calls.length, 1);
});
test('unknown open failure retains custody instead of being mistaken for initial absence', async () => {
    const f = fixture();
    f.controls.openReject = true;
    f.controls.openError = Object.assign(Error('raced absence'), { code: 'ENOENT' });
    await assert.rejects(boundedSetupJSON('/owned/metadata.json', 64, f.io), (error: any) => {
        assert.ok(error instanceof SetupMetadataReadFailure);
        assert.equal(error.cause, f.controls.openError);
        assert.equal(error.owner.snapshot().phase, 'retained');
        assert.equal(Object.hasOwn(error, 'code'), false);
        return true;
    });
    assert.equal(f.closes(), 0);
});
test('held close prevents a successful parsed value until its actual acknowledgement', async () => {
    const f = fixture();
    let release!: () => void,
        settled = false;
    f.controls.closeGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const read = boundedSetupJSON('/owned/metadata.json', 64, f.io).then((value) => {
        settled = true;
        return value;
    });
    await f.closeEntered;
    assert.equal(f.closes(), 1);
    assert.equal(settled, false);
    release();
    assert.deepEqual(await read, { value: 'kept' });
});
test('parse and close failures both survive with the first failure as cause and returned descriptor retained', async () => {
    const f = fixture('{invalid');
    f.controls.closeError = Error('close not acknowledged');
    await assert.rejects(boundedSetupJSON('/owned/metadata.json', 64, f.io), (error: any) => {
        assert.ok(error instanceof SetupMetadataReadFailure);
        assert.ok(error.errors[0] instanceof SyntaxError);
        assert.equal(error.errors[1], f.controls.closeError);
        assert.equal(error.cause, error.errors[0]);
        assert.equal(error.owner.snapshot().descriptorReturned, true);
        assert.equal(error.owner.snapshot().closeAcknowledged, false);
        return true;
    });
    assert.equal(f.closes(), 1);
});
test('falsy read failure is preserved alongside unacknowledged close', async () => {
    const f = fixture();
    f.controls.readReject = true;
    f.controls.readError = false;
    f.controls.closeError = Error('unacknowledged close');
    await assert.rejects(boundedSetupJSON('/owned/metadata.json', 64, f.io), (error: any) => {
        assert.equal(error.errors[0], false);
        assert.equal(error.cause, false);
        assert.equal(error.errors[1], f.controls.closeError);
        return true;
    });
});
test('invalid caller bounds reject before any filesystem access', async () => {
    for (const bound of [0, -1, NaN, Infinity, 0.5, 4 * 1024 ** 2 + 65537]) {
        const f = fixture();
        await assert.rejects(boundedSetupJSON('/owned/metadata.json', bound, f.io));
        assert.deepEqual(f.calls, []);
    }
});
test('unsupported close acknowledgement keeps the returned handle retained without retry', async () => {
    const f = fixture();
    f.controls.closeReturn = false;
    await assert.rejects(boundedSetupJSON('/owned/metadata.json', 64, f.io), (error: any) => {
        assert.ok(error instanceof SetupMetadataReadFailure);
        assert.equal(error.owner.snapshot().phase, 'retained');
        return true;
    });
    assert.equal(f.closes(), 1);
});
test('captured descriptor close cannot be replaced while its read awaits', async () => {
    const f = fixture();
    f.controls.readHook = () => {
        f.handle.close = async () => {
            assert.fail('Changed close must not replace captured owner method');
        };
    };
    assert.deepEqual(await boundedSetupJSON('/owned/metadata.json', 64, f.io), { value: 'kept' });
    assert.equal(f.closes(), 1);
});
test('real Node file-handle path reads owned synthetic multi-chunk JSON with outputs retained', async (t) => {
    const parent = await realpath(tmpdir());
    const directory = await mkdtemp(path.join(parent, 'hub-setup-metadata-'));
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('hub-setup-metadata-'));
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    const file = path.join(directory, 'metadata.json'),
        value = { text: '中'.repeat(25000) };
    await writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    assert.deepEqual(await boundedSetupJSON(file, 80000), value);
    await assert.rejects(boundedSetupJSON(file, 1024), /oversized/);
    assert.equal((await lstat(file)).size, Buffer.byteLength(JSON.stringify(value)));
    t.diagnostic('Retained owned synthetic metadata directory: ' + directory);
    // No unlink/rm/rmdir: all test-created files remain for inspection.
});
