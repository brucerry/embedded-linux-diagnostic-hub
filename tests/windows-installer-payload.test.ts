import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
    compareWindowsInstalledPayload,
    nodeWindowsPayloadIo,
    WINDOWS_PAYLOAD_LIMITS,
    WindowsPayloadCloseError,
    type PayloadFileHandle,
    type PinnedPayloadFile,
    type WindowsPayloadIo,
} from './fixtures/windows-installer-payload.ts';
import { createWindowsFixedLaunchAttempt } from './fixtures/windows-installer-fixed-launch.ts';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const bytes = new Map([
    ['Diagnostic Hub.exe', Buffer.from('MZ controlled executable fixture')],
    ['resources/app.asar', Buffer.from('controlled application archive fixture')],
    ['runtime.dll', Buffer.from('controlled runtime fixture')],
]);
const pins = (): PinnedPayloadFile[] =>
    [...bytes].map(([relativePath, value]) => ({
        relativePath,
        size: value.length,
        sha256: sha(value),
    }));

function memoryIo() {
    type Node = {
        kind: 'file' | 'directory' | 'link';
        ino: bigint;
        bytes: Buffer;
        nlink: bigint;
        time: bigint;
    };
    const nodes = new Map<string, Node>();
    const opened: string[] = [];
    let identity = 1n,
        reads = 0,
        opens = 0,
        closes = 0,
        calls = 0;
    const add = (file: string, kind: Node['kind'], data = Buffer.alloc(0)) =>
        nodes.set(file, { kind, ino: identity++, bytes: Buffer.from(data), nlink: 1n, time: 1n });
    add('C:\\', 'directory');
    add('C:\\Hub', 'directory');
    add('C:\\Hub\\resources', 'directory');
    for (const [name, value] of bytes) add('C:\\Hub\\' + name.replaceAll('/', '\\'), 'file', value);
    const lookup = (file: string) => {
        const node = nodes.get(file);
        if (!node) throw Error('ENOENT fixture');
        return node;
    };
    const stat = (node: Node): BigIntStats =>
        ({
            dev: 5n,
            ino: node.ino,
            size: BigInt(node.bytes.length),
            nlink: node.nlink,
            mtimeNs: node.time,
            ctimeNs: node.time,
            isFile: () => node.kind === 'file',
            isDirectory: () => node.kind === 'directory',
            isSymbolicLink: () => node.kind === 'link',
        }) as BigIntStats;
    const hooks = {
        open: (_file: string) => {},
        read: (_file: string, _offset: number) => {},
        lstat: (_file: string) => {},
        realpath: (file: string) => file,
    };
    const io: WindowsPayloadIo = {
        platform: 'win32',
        async lstat(file) {
            calls++;
            hooks.lstat(file);
            return stat(lookup(file));
        },
        async realpath(file) {
            calls++;
            return hooks.realpath(file);
        },
        async *entries(directory) {
            calls++;
            for (const file of nodes.keys())
                if (path.win32.dirname(file) === directory && file !== directory)
                    yield path.win32.basename(file);
        },
        async open(file) {
            calls++;
            opens++;
            opened.push(file);
            hooks.open(file);
            const node = lookup(file);
            return {
                async stat() {
                    return stat(node);
                },
                async read(buffer, offset) {
                    reads++;
                    hooks.read(file, offset);
                    const count = Math.min(buffer.length, Math.max(0, node.bytes.length - offset));
                    node.bytes.copy(buffer, 0, offset, offset + count);
                    return count;
                },
                async close() {
                    closes++;
                },
            };
        },
    };
    return { io, nodes, hooks, add, opened, counts: () => ({ reads, opens, closes, calls }) };
}

test('comparison hashes every installed file and cannot admit or implicitly launch a native process', async () => {
    const f = memoryIo();
    const result = await compareWindowsInstalledPayload('C:\\Hub', pins(), f.io);
    assert.equal(result.nativeLaunchAdmitted, false);
    assert.equal(result.files.length, 3);
    for (const file of result.files) {
        assert.equal(file.sha256, sha(bytes.get(file.relativePath)!));
        assert.equal(file.size, bytes.get(file.relativePath)!.length);
        assert.match(file.fileId, /^5:\d+$/);
    }
    assert.equal(f.counts().opens, 3);
    assert.equal(f.counts().closes, 3);
    assert.equal(f.counts().reads, 6);
    assert.ok(Object.isFrozen(result.files[0]));
    assert.throws(
        () => createWindowsFixedLaunchAttempt(result.installRoot),
        /NATIVE_ADMISSION_DISABLED/,
    );
    assert.throws(() => createWindowsFixedLaunchAttempt('C:\\Hub'), /NATIVE_ADMISSION_DISABLED/);
});

test('changed executable or app archive bytes fail even at the expected size, and descriptors close', async () => {
    for (const target of ['Diagnostic Hub.exe', 'resources/app.asar']) {
        const f = memoryIo(),
            file = 'C:\\Hub\\' + target.replaceAll('/', '\\');
        f.nodes.get(file)!.bytes[0] ^= 0xff;
        await assert.rejects(
            compareWindowsInstalledPayload('C:\\Hub', pins(), f.io),
            /DIGEST_MISMATCH/,
        );
        assert.equal(f.counts().opens, f.counts().closes);
    }
});

test('missing, extra and case-colliding files fail the complete file inventory', async () => {
    for (const mutate of [
        (f: ReturnType<typeof memoryIo>) => f.nodes.delete('C:\\Hub\\runtime.dll'),
        (f: ReturnType<typeof memoryIo>) =>
            f.add('C:\\Hub\\unexpected.dll', 'file', Buffer.from('injection')),
        (f: ReturnType<typeof memoryIo>) =>
            f.add('C:\\Hub\\RUNTIME.DLL', 'file', Buffer.from('collision')),
        (f: ReturnType<typeof memoryIo>) =>
            f.add('C:\\Hub\\unexpected-empty-directory', 'directory'),
    ]) {
        const f = memoryIo();
        mutate(f);
        await assert.rejects(
            compareWindowsInstalledPayload('C:\\Hub', pins(), f.io),
            /INVENTORY_MISMATCH/,
        );
        assert.equal(f.counts().opens, f.counts().closes);
    }
});

test('unsafe or incomplete pinned inventories are rejected before filesystem work', async () => {
    for (const invalid of [
        [],
        pins().filter((x) => x.relativePath !== 'resources/app.asar'),
        [...pins(), { ...pins()[0] }],
        [...pins(), { ...pins()[0], relativePath: 'DIAGNOSTIC HUB.EXE' }],
        [...pins(), { ...pins()[0], relativePath: '../outside.exe' }],
        [...pins(), { ...pins()[0], relativePath: 'resources/CON.txt' }],
        [...pins(), { ...pins()[0], relativePath: 'runtime.dll:stream' }],
        [...pins(), { ...pins()[0], relativePath: 'resources\\alternate.dll' }],
        [
            ...pins(),
            {
                ...pins()[0],
                relativePath: 'resources/new.dll',
                size: WINDOWS_PAYLOAD_LIMITS.fileBytes + 1,
            },
        ],
        [...pins(), { ...pins()[0], relativePath: 'resources/new.dll', sha256: 'not a hash' }],
        [...pins(), { ...pins()[0], relativePath: 'runtime.dll/child' }],
    ]) {
        const f = memoryIo();
        await assert.rejects(
            compareWindowsInstalledPayload('C:\\Hub', invalid, f.io),
            /WINDOWS_PAYLOAD_/,
        );
        assert.equal(f.counts().calls, 0);
    }
});

test('symbolic nodes, hard links and redirected ancestors are rejected without opening their bytes', async () => {
    for (const target of ['C:\\', 'C:\\Hub', 'C:\\Hub\\resources', 'C:\\Hub\\Diagnostic Hub.exe']) {
        const f = memoryIo();
        f.nodes.get(target)!.kind = 'link';
        await assert.rejects(
            compareWindowsInstalledPayload('C:\\Hub', pins(), f.io),
            /NODE_INVALID/,
        );
        assert.equal(f.opened.includes(target), false);
    }
    const f = memoryIo();
    f.nodes.get('C:\\Hub\\Diagnostic Hub.exe')!.nlink = 2n;
    await assert.rejects(compareWindowsInstalledPayload('C:\\Hub', pins(), f.io), /NODE_INVALID/);
    const g = memoryIo();
    g.hooks.realpath = (file) => (file === 'C:\\Hub' ? 'C:\\Other' : file);
    await assert.rejects(
        compareWindowsInstalledPayload('C:\\Hub', pins(), g.io),
        /PATH_REDIRECTED/,
    );
});

test('same-byte replacement between path sampling and descriptor open fails identity comparison', async () => {
    const f = memoryIo();
    f.hooks.open = (file) => {
        f.nodes.get(file)!.ino++;
    };
    await assert.rejects(
        compareWindowsInstalledPayload('C:\\Hub', pins(), f.io),
        /OPEN_IDENTITY_CHANGED/,
    );
    assert.equal(f.counts().opens, 1);
    assert.equal(f.counts().closes, 1);
});

test('file growth, short reads and metadata changes during hashing reject and close the opened file', async () => {
    for (const mutation of ['grow', 'shrink', 'metadata']) {
        const f = memoryIo();
        f.hooks.read = (file, offset) => {
            if (offset) return;
            const node = f.nodes.get(file)!;
            if (mutation === 'grow') node.bytes = Buffer.concat([node.bytes, Buffer.from('extra')]);
            if (mutation === 'shrink') node.bytes = node.bytes.subarray(0, node.bytes.length - 1);
            if (mutation === 'metadata') node.time++;
        };
        await assert.rejects(
            compareWindowsInstalledPayload('C:\\Hub', pins(), f.io),
            /SIZE_MISMATCH|READ_IDENTITY_CHANGED/,
        );
        assert.equal(f.counts().opens, 1);
        assert.equal(f.counts().closes, 1);
    }
});

test('replaced root or file after hashing is detected by final path sampling', async () => {
    for (const target of ['C:\\Hub', 'C:\\Hub\\Diagnostic Hub.exe']) {
        const f = memoryIo();
        f.hooks.read = (file, offset) => {
            if (file === 'C:\\Hub\\runtime.dll' && offset) f.nodes.get(target)!.ino++;
        };
        await assert.rejects(
            compareWindowsInstalledPayload('C:\\Hub', pins(), f.io),
            /PATH_IDENTITY_CHANGED/,
        );
        assert.equal(f.counts().opens, f.counts().closes);
    }
});

test('comparison snapshots caller pins before awaiting filesystem work', async () => {
    const f = memoryIo(),
        expected = pins();
    f.hooks.lstat = () => {
        Object.assign(expected[0], { sha256: '0'.repeat(64) });
        expected.length = 0;
        f.hooks.lstat = () => {};
    };
    const result = await compareWindowsInstalledPayload('C:\\Hub', expected, f.io);
    assert.equal(result.files.length, 3);
    assert.equal(
        result.files.find((x) => x.relativePath === 'Diagnostic Hub.exe')!.sha256,
        sha(bytes.get('Diagnostic Hub.exe')!),
    );
});

test('non-Windows default or injected IO never reads a payload', async () => {
    const f = memoryIo();
    f.io.platform = 'linux';
    await assert.rejects(
        compareWindowsInstalledPayload('C:\\Hub', pins(), f.io),
        /WINDOWS_REQUIRED/,
    );
    assert.equal(f.counts().calls, 0);
});

test('large payload files hash through bounded descriptor reads rather than whole-file buffers', async () => {
    const f = memoryIo(),
        expected = pins();
    const payload = Buffer.alloc(WINDOWS_PAYLOAD_LIMITS.readBytes * 2 + 11, 0x5a);
    f.nodes.get('C:\\Hub\\Diagnostic Hub.exe')!.bytes = payload;
    Object.assign(expected[0], { size: payload.length, sha256: sha(payload) });
    const open = f.io.open;
    let largestRead = 0;
    f.io.open = async (file) => {
        const handle = await open(file);
        return {
            ...handle,
            async read(buffer, position) {
                largestRead = Math.max(largestRead, buffer.length);
                return handle.read(buffer, position);
            },
        };
    };
    const result = await compareWindowsInstalledPayload('C:\\Hub', expected, f.io);
    assert.equal(
        result.files.find((x) => x.relativePath === 'Diagnostic Hub.exe')!.sha256,
        sha(payload),
    );
    assert.equal(largestRead, WINDOWS_PAYLOAD_LIMITS.readBytes);
    assert.equal(f.counts().closes, 3);
});

test('inventory count and total-size limits reject before any filesystem activity', async () => {
    const many = Array.from({ length: WINDOWS_PAYLOAD_LIMITS.entries + 1 }, (_, index) => ({
        relativePath: 'file-' + index,
        size: 0,
        sha256: sha(''),
    }));
    const large = pins().map((file) => ({ ...file, size: WINDOWS_PAYLOAD_LIMITS.fileBytes }));
    for (const expected of [many, large]) {
        const f = memoryIo();
        await assert.rejects(
            compareWindowsInstalledPayload('C:\\Hub', expected, f.io),
            /INVENTORY_INVALID|INVENTORY_LIMIT/,
        );
        assert.equal(f.counts().calls, 0);
    }
});

test('invalid reads, read errors and close errors cannot produce successful comparison or retry', async () => {
    for (const mode of ['negative', 'oversized', 'nan', 'read-error', 'close-error']) {
        const f = memoryIo(),
            originalOpen = f.io.open,
            closeFailure = Error('fake close failure');
        f.io.open = async (file) => {
            const handle = await originalOpen(file);
            return {
                ...handle,
                async read(buffer, position) {
                    if (mode === 'negative') return -1;
                    if (mode === 'oversized') return buffer.length + 1;
                    if (mode === 'nan') return NaN;
                    if (mode === 'read-error') throw Error('fake read failure');
                    return handle.read(buffer, position);
                },
                async close() {
                    await handle.close();
                    if (mode === 'close-error') throw closeFailure;
                },
            };
        };
        await assert.rejects(
            compareWindowsInstalledPayload('C:\\Hub', pins(), f.io),
            (error: unknown) => {
                if (mode === 'close-error') {
                    assert.ok(error instanceof WindowsPayloadCloseError);
                    assert.equal(error.cause, closeFailure);
                    assert.deepEqual(error.errors, [closeFailure]);
                    assert.equal(error.custody.closeObserved, false);
                } else assert.match(String(error), /READ_INVALID|fake read failure/);
                return true;
            },
        );
        assert.equal(f.counts().opens, 1);
        assert.equal(f.counts().closes, 1);
    }
});

test('combined read and close failures preserve the exact primary, including undefined', async () => {
    for (const primary of [Error('private read failure'), undefined]) {
        for (const closeFails of [false, true]) {
            const f = memoryIo(),
                originalOpen = f.io.open,
                closeFailure = Error('private close failure');
            let returned: PayloadFileHandle | null = null,
                closeCalls = 0;
            f.io.open = async (file) => {
                const handle = await originalOpen(file);
                returned = {
                    ...handle,
                    async read() {
                        throw primary;
                    },
                    async close() {
                        closeCalls++;
                        if (closeFails) throw closeFailure;
                        await handle.close();
                    },
                };
                return returned;
            };
            await assert.rejects(
                compareWindowsInstalledPayload('C:\\Hub', pins(), f.io),
                (error) => {
                    if (!closeFails) assert.equal(error, primary);
                    else {
                        assert.ok(error instanceof WindowsPayloadCloseError);
                        assert.equal(error.message, 'WINDOWS_PAYLOAD_CLOSE_UNCONFIRMED');
                        assert.equal(error.cause, primary);
                        assert.deepEqual(error.errors, [primary, closeFailure]);
                        assert.equal(error.custody.handle, returned);
                        assert.equal(error.custody.file, f.opened[0]);
                        assert.equal(error.custody.acquisitionSubmitted, true);
                        assert.equal(error.custody.acquisitionReturned, true);
                        assert.equal(error.custody.closeRequested, true);
                        assert.equal(error.custody.closeObserved, false);
                    }
                    return true;
                },
            );
            assert.equal(closeCalls, 1);
            assert.equal(f.counts().opens, 1);
            assert.equal(f.counts().closes, closeFails ? 0 : 1);
        }
    }
});

test('a pre-read descriptor failure and rejected close retain the actual handle without retry', async () => {
    const f = memoryIo(),
        originalOpen = f.io.open,
        primary = Error('private descriptor failure'),
        closeFailure = Error('private close failure');
    let returned: PayloadFileHandle | null = null,
        closeCalls = 0;
    f.io.open = async (file) => {
        const handle = await originalOpen(file);
        returned = {
            ...handle,
            async stat() {
                throw primary;
            },
            async close() {
                closeCalls++;
                throw closeFailure;
            },
        };
        return returned;
    };
    await assert.rejects(compareWindowsInstalledPayload('C:\\Hub', pins(), f.io), (error) => {
        assert.ok(error instanceof WindowsPayloadCloseError);
        assert.deepEqual(error.errors, [primary, closeFailure]);
        assert.equal(error.cause, primary);
        assert.equal(error.custody.handle, returned);
        assert.equal(error.custody.closeObserved, false);
        return true;
    });
    assert.equal(closeCalls, 1);
    assert.equal(f.counts().reads, 0);
    assert.equal(f.counts().closes, 0);
});

test('unconfirmed close custody is private and cannot serialize raw handles or paths', async () => {
    const f = memoryIo(),
        originalOpen = f.io.open,
        closeFailure = Object.freeze(Error('private close failure'));
    let returned: PayloadFileHandle | null = null,
        closeCalls = 0;
    f.io.open = async (file) => {
        const handle = await originalOpen(file);
        returned = {
            ...handle,
            async close() {
                closeCalls++;
                throw closeFailure;
            },
        };
        return returned;
    };
    await assert.rejects(compareWindowsInstalledPayload('C:\\Hub', pins(), f.io), (error) => {
        assert.ok(error instanceof WindowsPayloadCloseError);
        assert.equal(error.cause, closeFailure);
        assert.deepEqual(error.errors, [closeFailure]);
        assert.equal(error.custody.handle, returned);
        assert.ok(Object.isFrozen(error.custody));
        assert.equal(Object.getOwnPropertyDescriptor(error, 'custody')?.enumerable, false);
        assert.deepEqual(Object.keys(error), []);
        assert.equal(JSON.stringify(error), '{}');
        assert.equal(error.custody.closeObserved, false);
        return true;
    });
    assert.equal(closeCalls, 1);
    assert.equal(f.counts().opens, 1);
    assert.equal(f.counts().closes, 0);
});

test('delayed acquisition and pending close remain unsettled until the actual close outcome', async () => {
    const f = memoryIo(),
        originalOpen = f.io.open,
        closeFailure = Error('private delayed close failure');
    let releaseOpen!: (handle: PayloadFileHandle) => void,
        rejectClose!: (error: unknown) => void,
        noteOpen!: () => void,
        noteClose!: () => void;
    const delayedOpen = new Promise<PayloadFileHandle>((resolve) => {
        releaseOpen = resolve;
    });
    const delayedClose = new Promise<void>((_resolve, reject) => {
        rejectClose = reject;
    });
    void delayedClose.catch(() => {});
    const openRequested = new Promise<void>((resolve) => {
        noteOpen = resolve;
    });
    const closeRequested = new Promise<void>((resolve) => {
        noteClose = resolve;
    });
    let returned!: PayloadFileHandle,
        closeCalls = 0,
        settled = false;
    f.io.open = async (file) => {
        const handle = await originalOpen(file);
        returned = {
            ...handle,
            async close() {
                closeCalls++;
                noteClose();
                await delayedClose;
            },
        };
        noteOpen();
        return delayedOpen;
    };
    const comparison = compareWindowsInstalledPayload('C:\\Hub', pins(), f.io);
    void comparison.then(
        () => (settled = true),
        () => (settled = true),
    );
    try {
        await openRequested;
        assert.equal(settled, false);
        assert.equal(closeCalls, 0);
        releaseOpen(returned);
        await closeRequested;
        assert.equal(settled, false);
        assert.equal(closeCalls, 1);
        assert.equal(f.counts().opens, 1);
        assert.equal(f.counts().closes, 0);
        rejectClose(closeFailure);
        await assert.rejects(comparison, (error) => {
            assert.ok(error instanceof WindowsPayloadCloseError);
            assert.equal(error.custody.handle, returned);
            assert.equal(error.custody.acquisitionReturned, true);
            assert.equal(error.custody.closeRequested, true);
            assert.equal(error.custody.closeObserved, false);
            assert.deepEqual(error.errors, [closeFailure]);
            assert.equal(error.cause, closeFailure);
            return true;
        });
    } finally {
        releaseOpen(returned);
        rejectClose(closeFailure);
        await comparison.catch(() => {});
    }
    assert.equal(closeCalls, 1);
    assert.equal(f.counts().closes, 0);
});

test('the real Node filesystem adapter hashes controlled disk bytes without launching them', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'windows-payload-bytes-'));
    const base = await realpath(temporary),
        native = nodeWindowsPayloadIo();
    const local = (file: string) => path.join(base, ...file.slice(3).split('\\'));
    const io: WindowsPayloadIo = {
        platform: 'win32',
        lstat: (file) => native.lstat(local(file)),
        async realpath(file) {
            const canonical = await native.realpath(local(file)),
                relative = path.relative(base, canonical);
            if (relative.startsWith('..') || path.isAbsolute(relative)) return canonical;
            return 'C:\\' + relative.split(path.sep).join('\\');
        },
        entries: (file) => native.entries(local(file)),
        open: (file) => native.open(local(file)),
    };
    try {
        await mkdir(path.join(base, 'Hub', 'resources'), { recursive: true });
        for (const [file, content] of bytes)
            await writeFile(path.join(base, 'Hub', ...file.split('/')), content);
        const matched = await compareWindowsInstalledPayload('C:\\Hub', pins(), io);
        assert.equal(matched.files.length, 3);
        assert.equal(matched.nativeLaunchAdmitted, false);
        await writeFile(
            path.join(base, 'Hub', 'resources', 'app.asar'),
            Buffer.alloc(bytes.get('resources/app.asar')!.length),
        );
        await assert.rejects(
            compareWindowsInstalledPayload('C:\\Hub', pins(), io),
            /DIGEST_MISMATCH/,
        );
        await writeFile(
            path.join(base, 'Hub', 'resources', 'app.asar'),
            bytes.get('resources/app.asar')!,
        );
        await rm(path.join(base, 'Hub', 'runtime.dll'));
        await symlink(
            path.join(base, 'Hub', 'Diagnostic Hub.exe'),
            path.join(base, 'Hub', 'runtime.dll'),
        );
        await assert.rejects(compareWindowsInstalledPayload('C:\\Hub', pins(), io), /NODE_INVALID/);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});
