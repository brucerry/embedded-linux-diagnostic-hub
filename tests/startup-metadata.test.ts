import assert from 'node:assert/strict';
import test from 'node:test';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, writeFile, lstat, realpath, access, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
    readSetupMetadataBytesSync,
    SetupMetadataReadFailure,
    maintenancePaths,
    SETUP_OWNER,
} from '../electron/installation-maintenance.ts';
import {
    selectDesktopStartup,
    type DesktopStartupContext,
} from '../electron/installation-startup.ts';
import {
    INSTALLATION_MANIFEST,
    INSTALLATION_RECORD,
    INSTALLATION_PRODUCT,
} from '../shared/installation.ts';

function fixture(text = '{"x":"中😀"}') {
    const content = Buffer.from(text),
        calls: any[] = [],
        controls: any = {};
    const node: any = {
        dev: 1,
        ino: 2,
        size: content.length,
        mtimeMs: 1,
        ctimeMs: 1,
        nlink: 1,
        mode: 0o100600,
        isFile: () => true,
        isSymbolicLink: () => false,
    };
    let pathNode = node;
    const io: any = {
        lstatSync(file: string) {
            calls.push(['lstat', file]);
            if (controls.absent) throw Object.assign(Error('missing'), { code: 'ENOENT' });
            return { ...pathNode };
        },
        openSync(file: string, flags: number) {
            calls.push(['open', file, flags]);
            assert.equal(
                flags,
                constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
            );
            if (controls.openReject) throw controls.openError;
            if (controls.openHook) controls.openHook();
            return controls.returnFD === undefined ? 7 : controls.returnFD;
        },
        fstatSync(fd: number) {
            calls.push(['stat', fd]);
            return { ...node };
        },
        readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
            calls.push(['read', fd, length, position]);
            if (controls.readHook) controls.readHook();
            if (controls.readReject) throw controls.readError;
            const source = controls.content ?? content;
            const count = Math.min(
                length,
                controls.short ?? length,
                Math.max(0, source.length - position),
            );
            source.copy(buffer, offset, position, position + count);
            return controls.badRead === undefined ? count : controls.badRead;
        },
        closeSync(fd: number) {
            calls.push(['close', fd]);
            if (controls.closeError) throw controls.closeError;
            return controls.closeReturn;
        },
        readFileSync() {
            assert.fail('Unbounded pathname read must not execute');
        },
    };
    const read = (prior?: any) => readSetupMetadataBytesSync('/owned/record.json', 64, io, prior);
    return {
        content,
        calls,
        controls,
        node,
        io,
        read,
        replacePath(next: any) {
            pathNode = next;
        },
    };
}
test('sync metadata reads close one exact descriptor and return unchanged raw bytes including short multibyte reads', () => {
    const f = fixture();
    f.controls.short = 1;
    assert.deepEqual(f.read(), f.content);
    assert.equal(f.calls.filter((row) => row[0] === 'close').length, 1);
    assert.equal(f.calls.at(-1)[0], 'close');
    assert.deepEqual(
        f.calls.filter((row) => row[0] === 'read').map((row) => row[3]),
        Array.from({ length: f.content.length + 1 }, (_, i) => i),
    );
});
test('descriptor zero is a valid owned result and is closed exactly once', () => {
    const f = fixture();
    f.controls.returnFD = 0;
    assert.deepEqual(f.read(), f.content);
    assert.deepEqual(
        f.calls.filter((row) => row[0] === 'close'),
        [['close', 0]],
    );
});
for (const mode of ['symlink', 'hardlink', 'not-file', 'oversize', 'bad-size', 'bad-inode'])
    test('sync unsafe initial metadata refuses before acquisition: ' + mode, () => {
        const f = fixture();
        if (mode === 'symlink') f.node.isSymbolicLink = () => true;
        if (mode === 'hardlink') f.node.nlink = 2;
        if (mode === 'not-file') f.node.isFile = () => false;
        if (mode === 'oversize') f.node.size = 100;
        if (mode === 'bad-size') f.node.size = -1;
        if (mode === 'bad-inode') f.node.ino = 0;
        assert.throws(() => f.read());
        assert.equal(
            f.calls.some((row) => row[0] === 'open'),
            false,
        );
    });
for (const mode of ['inode', 'huge', 'special', 'symlink'])
    test('sync path-to-descriptor replacement refuses before reads: ' + mode, () => {
        const f = fixture();
        f.controls.openHook = () => {
            if (mode === 'inode') f.node.ino++;
            if (mode === 'huge') f.node.size = 2 ** 40;
            if (mode === 'special') f.node.isFile = () => false;
            if (mode === 'symlink') f.node.isSymbolicLink = () => true;
        };
        assert.throws(() => f.read());
        assert.equal(
            f.calls.some((row) => row[0] === 'read'),
            false,
        );
        assert.equal(f.calls.filter((row) => row[0] === 'close').length, 1);
    });
test('caller original presence sample remains binding instead of being replaced by a newer path sample', () => {
    const f = fixture(),
        prior = f.io.lstatSync('/owned/record.json');
    f.node.ino++;
    assert.throws(() => f.read(prior), /identity changed/);
    assert.equal(f.calls.filter((row) => row[0] === 'lstat').length, 1);
    assert.equal(
        f.calls.some((row) => row[0] === 'read'),
        false,
    );
});
for (const mode of ['growth', 'truncation', 'mtime', 'path'])
    test('sync read refuses ' + mode + ' while retaining a bounded read range', () => {
        const f = fixture();
        if (mode === 'growth')
            f.controls.content = Buffer.concat([f.content, Buffer.from('extra')]);
        if (mode === 'truncation') f.controls.content = f.content.subarray(0, 2);
        f.controls.readHook = () => {
            if (mode === 'mtime') f.node.mtimeMs++;
            if (mode === 'path') f.replacePath({ ...f.node, ino: 90 });
        };
        assert.throws(() => f.read());
        assert.equal(f.calls.filter((row) => row[0] === 'close').length, 1);
        assert.ok(
            f.calls
                .filter((row) => row[0] === 'read')
                .every((row) => row[2] <= 65536 && row[2] + row[3] <= f.content.length + 1),
        );
    });
for (const count of [-1, 0.5, NaN, 100000])
    test('invalid sync read acknowledgement refuses: ' + String(count), () => {
        const f = fixture();
        f.controls.badRead = count;
        assert.throws(() => f.read());
        assert.equal(f.calls.filter((row) => row[0] === 'close').length, 1);
    });
test('sync initial absence preserves ENOENT before any descriptor is acquired', () => {
    const f = fixture();
    f.controls.absent = true;
    assert.throws(() => f.read(), { code: 'ENOENT' });
    assert.equal(f.calls.length, 1);
});
test('raced open absence retains unknown acquisition instead of becoming an optional missing marker', () => {
    const f = fixture();
    f.controls.openReject = true;
    f.controls.openError = Object.assign(Error('raced missing'), { code: 'ENOENT' });
    assert.throws(
        () => f.read(),
        (error: any) => {
            assert.ok(error instanceof SetupMetadataReadFailure);
            assert.equal(error.cause, f.controls.openError);
            assert.equal(Object.hasOwn(error, 'code'), false);
            assert.equal(error.owner.snapshot().phase, 'retained');
            return true;
        },
    );
    assert.equal(
        f.calls.some((row) => row[0] === 'close'),
        false,
    );
});
for (const fd of [-1, 0.5, NaN, {}, false])
    test(
        'unacknowledged sync descriptor is retained and never passed to close: ' + String(fd),
        () => {
            const f = fixture();
            f.controls.returnFD = fd;
            assert.throws(
                () => f.read(),
                (error: any) => {
                    assert.ok(error instanceof SetupMetadataReadFailure);
                    assert.equal(error.owner.snapshot().phase, 'retained');
                    return true;
                },
            );
            assert.equal(
                f.calls.some((row) => row[0] === 'close'),
                false,
            );
        },
    );
test('unsupported async open result remains retained after its late value without an unhandled rejection or retry', async () => {
    const f = fixture();
    f.controls.returnFD = Promise.resolve(7);
    assert.throws(() => f.read(), SetupMetadataReadFailure);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
        f.calls.some((row) => row[0] === 'close'),
        false,
    );
});
test('primary sync read and failed close both survive, including a falsy primary', () => {
    for (const primary of [Error('read failed'), false]) {
        const f = fixture();
        f.controls.readReject = true;
        f.controls.readError = primary;
        f.controls.closeError = Error('close failed');
        assert.throws(
            () => f.read(),
            (error: any) => {
                assert.ok(error instanceof SetupMetadataReadFailure);
                assert.equal(error.errors[0], primary);
                assert.equal(error.cause, primary);
                assert.equal(error.errors[1], f.controls.closeError);
                assert.equal(error.owner.snapshot().closeAcknowledged, false);
                return true;
            },
        );
        assert.equal(f.calls.filter((row) => row[0] === 'close').length, 1);
    }
});
for (const returned of [false, Promise.resolve(undefined)])
    test(
        'unsupported sync close result cannot manufacture a returned value: ' + typeof returned,
        () => {
            const f = fixture();
            f.controls.closeReturn = returned;
            assert.throws(() => f.read(), SetupMetadataReadFailure);
            assert.equal(f.calls.filter((row) => row[0] === 'close').length, 1);
        },
    );
test('invalid sync caller bounds refuse before filesystem access', () => {
    for (const limit of [0, -1, 0.5, NaN, Infinity, 4 * 1024 ** 2 + 65537]) {
        const f = fixture();
        assert.throws(() => readSetupMetadataBytesSync('/owned/record.json', limit, f.io));
        assert.deepEqual(f.calls, []);
    }
});

async function startupFixture(t: { diagnostic(message: string): void }, recordOverride?: string) {
    const parent = await realpath(tmpdir()),
        home = await mkdtemp(path.join(parent, 'hub-startup-metadata-'));
    assert.equal(path.dirname(home), parent);
    assert.ok(path.basename(home).startsWith('hub-startup-metadata-'));
    const info = await lstat(home);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    const root = path.join(home, 'app with spaces'),
        data = path.join(home, 'user data');
    await mkdir(root);
    await mkdir(data);
    const id = randomUUID(),
        executable = path.join(root, 'Diagnostic Hub.exe');
    await writeFile(executable, 'payload', { flag: 'wx' });
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
    await writeFile(path.join(root, INSTALLATION_MANIFEST), bytes, { flag: 'wx' });
    await writeFile(
        path.join(root, INSTALLATION_RECORD),
        recordOverride ??
            JSON.stringify({
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                installationId: id,
                manifestSHA256: createHash('sha256').update(bytes).digest('hex'),
                profile: 'dedicated',
            }),
        { flag: 'wx' },
    );
    const context: DesktopStartupContext = {
        platform: 'win32',
        arch: 'x64',
        packaged: true,
        executable,
        version: '0.6.0',
        environment: {},
        appData: data,
    };
    t.diagnostic('Retained owned synthetic startup directory: ' + home);
    return {
        home,
        root,
        data,
        id,
        context,
        profile: path.join(data, 'DiagnosticHub', 'profiles', id),
    };
}
test('actual Node startup uses both bounded identity readers and creates only its outside synthetic profile', async (t) => {
    const f = await startupFixture(t),
        out = selectDesktopStartup(f.context);
    assert.equal(out.delivery, 'installed');
    assert.equal(out.profilePath, await realpath(f.profile));
    assert.equal(out.installation?.payloadIntegrity, 'not-checked');
    assert.ok(!out.profilePath!.startsWith(f.root + path.sep));
});
test('actual Node startup keeps initial unsafe owner error and creates no profile', async (t) => {
    const f = await startupFixture(t);
    await writeFile(path.join(f.root, SETUP_OWNER), ' '.repeat(16385), { flag: 'wx' });
    assert.throws(() => selectDesktopStartup(f.context), /Unsafe setup ownership at startup/);
    await assert.rejects(access(f.profile), { code: 'ENOENT' });
});
test('actual Node startup preserves JSON SyntaxError and refuses profile fallback', async (t) => {
    const f = await startupFixture(t, '{invalid');
    assert.throws(() => selectDesktopStartup(f.context), SyntaxError);
    await assert.rejects(access(f.profile), { code: 'ENOENT' });
});
test('actual Node moved stage and previous ownership still enforce the logical installation lock', async (t) => {
    for (const slot of ['stage', 'previous']) {
        const f = await startupFixture(t),
            files = maintenancePaths(f.root);
        await writeFile(
            path.join(f.root, SETUP_OWNER),
            JSON.stringify({
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                installationId: f.id,
                root: f.root,
            }),
            { flag: 'wx' },
        );
        await mkdir(files.work);
        await writeFile(files.lock, '{}', { flag: 'wx' });
        const moved = path.join(files.work, slot + '-' + randomUUID());
        await rename(f.root, moved);
        assert.throws(
            () =>
                selectDesktopStartup({
                    ...f.context,
                    executable: path.join(moved, 'Diagnostic Hub.exe'),
                }),
            /maintenance is in progress/,
        );
        await assert.rejects(access(f.profile), { code: 'ENOENT' });
    }
    // No deletion or cleanup: every owned fixture and moved payload remains retained.
});
