import assert from 'node:assert/strict';
import path from 'node:path';
import { constants } from 'node:fs';
const retained = new Set();

export class WebFileCustodyFailure extends Error {
    constructor(cause, owner) {
        super('Web file operation failed; unacknowledged custody retained.', { cause });
        this.owner = owner;
    }
}
/** Explicit native filesystem ports only; no deletion, retry, chmod or implicit cleanup. */
export function createOwnedWebFiles(native) {
    for (const k of ['realpath', 'lstat', 'open', 'opendir', 'mkdir'])
        assert.equal(typeof native?.[k], 'function');
    const leases = new Set(),
        namespaces = new Map(),
        diagnostics = [];
    let pending = 0,
        primary;
    const fail = (error) => {
        if (primary && error !== primary && !diagnostics.includes(error) && diagnostics.length < 16)
            diagnostics.push(error);
        primary ??= error;
    };
    const snapshot = () =>
        Object.freeze({
            pending,
            handles: leases.size,
            uncertainPublications: [...namespaces.values()].filter((v) => v !== 'acknowledged')
                .length,
            acknowledgedPublications: [...namespaces.values()].filter((v) => v === 'acknowledged')
                .length,
            primaryFailure: Boolean(primary),
            diagnostics: diagnostics.length,
            processGroupRetirement: null,
        });
    const owner = Object.freeze({
        snapshot,
        diagnostics: () => [...diagnostics],
        assertSettled() {
            assert.equal(pending, 0);
            assert.equal(leases.size, 0);
            assert.equal(snapshot().uncertainPublications, 0);
            if (primary) throw new WebFileCustodyFailure(primary, owner);
            retained.delete(owner);
        },
    });
    const io = async (fn) => {
        retained.add(owner);
        pending++;
        try {
            const operation = fn();
            assert.ok(
                operation && typeof operation.then === 'function',
                'Unsupported synchronous filesystem port.',
            );
            return await operation;
        } catch (e) {
            fail(e);
            throw e;
        } finally {
            pending--;
        }
    };
    const absolute = (file) => {
        assert.ok(
            typeof file === 'string' &&
                file.startsWith('/') &&
                file !== '/' &&
                Buffer.byteLength(file) <= 4096 &&
                path.posix.normalize(file) === file &&
                !/[\\\x00-\x1f\x7f]/.test(file),
        );
    };
    async function parentOf(file) {
        const parent = path.posix.dirname(file);
        absolute(parent);
        assert.equal(await filesystem.realpath(parent), parent);
        const stat = await filesystem.lstat(parent);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
        return { parent, stat };
    }
    async function acquire(file, flags, directory = false) {
        absolute(file);
        const lease = { file, handle: null, closed: false };
        leases.add(lease);
        let handle;
        try {
            handle = await io(() => (directory ? native.opendir(file) : native.open(file, flags)));
            lease.handle = handle;
            assert.ok(handle && typeof handle.close === 'function');
        } catch (e) {
            fail(e);
            throw new WebFileCustodyFailure(e, owner);
        }
        let closing;
        const call = (method, ...args) => {
            assert.ok(!lease.closed && !closing);
            return io(() => handle[method](...args));
        };
        const wrapped = {
            stat: () => call('stat'),
            sync: () => call('sync'),
            read: async (...a) => {
                try {
                    const v = await call('read', ...a);
                    if (!directory)
                        assert.ok(
                            Number.isSafeInteger(v.bytesRead) &&
                                v.bytesRead >= 0 &&
                                v.bytesRead <= a[2],
                        );
                    return v;
                } catch (e) {
                    fail(e);
                    throw new WebFileCustodyFailure(e, owner);
                }
            },
            write: async (...a) => {
                const v = await call('write', ...a);
                assert.ok(
                    Number.isSafeInteger(v.bytesWritten) &&
                        v.bytesWritten > 0 &&
                        v.bytesWritten <= a[2],
                );
                return v;
            },
            close() {
                if (closing) return closing;
                closing = io(() => handle.close()).then(() => {
                    lease.closed = true;
                    lease.handle = null;
                    leases.delete(lease);
                });
                closing.catch(() => {});
                return closing;
            },
        };
        return wrapped;
    }
    const filesystem = {
        realpath: (p) => {
            absolute(p);
            return io(() => native.realpath(p));
        },
        lstat: (p) => {
            absolute(p);
            return io(() => native.lstat(p));
        },
        async readdir(p, o) {
            absolute(p);
            assert.ok(o === undefined || (o.withFileTypes === true && Object.keys(o).length === 1));
            const before = await filesystem.lstat(p);
            assert.ok(before.isDirectory() && !before.isSymbolicLink());
            let handle, first;
            const entries = [];
            try {
                handle = await acquire(p, undefined, true);
                for (;;) {
                    const entry = await handle.read();
                    if (!entry) break;
                    assert.ok(entries.length < 20000);
                    entries.push(entry);
                }
                const after = await filesystem.lstat(p);
                for (const k of ['dev', 'ino', 'mtimeMs', 'ctimeMs'])
                    assert.equal(after[k], before[k]);
            } catch (e) {
                first = e;
                fail(e);
            }
            if (handle)
                try {
                    await handle.close();
                } catch (e) {
                    first ??= e;
                    fail(e);
                }
            if (first) throw new WebFileCustodyFailure(first, owner);
            return o ? entries : entries.map((e) => e.name);
        },
        mkdir: async (p) => {
            absolute(p);
            await parentOf(p);
            return io(() => native.mkdir(p));
        },
        opendir: (p) => acquire(p, undefined, true),
        open: (p, flags) => {
            assert.equal(flags, 'r');
            return acquire(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        },
        async writeFile(file, bytes, options) {
            absolute(file);
            assert.deepEqual(options, { flag: 'wx' });
            assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 128 * 1024 ** 2);
            bytes = Buffer.from(bytes);
            assert.ok(!namespaces.has(file));
            namespaces.set(file, 'uncertain');
            let handle, directory, first, parentBefore;
            try {
                parentBefore = await parentOf(file);
                handle = await acquire(
                    file,
                    constants.O_WRONLY |
                        constants.O_CREAT |
                        constants.O_EXCL |
                        constants.O_NOFOLLOW,
                );
                let offset = 0;
                while (offset < bytes.length) {
                    const n = Math.min(65536, bytes.length - offset);
                    const v = await handle.write(bytes, offset, n, offset);
                    offset += v.bytesWritten;
                }
                const stat = await handle.stat();
                assert.ok(
                    stat.isFile() &&
                        !stat.isSymbolicLink() &&
                        stat.nlink === 1 &&
                        stat.size === bytes.length,
                );
                await handle.sync();
            } catch (e) {
                first = e;
                fail(e);
            }
            if (handle)
                try {
                    await handle.close();
                } catch (e) {
                    first ??= e;
                    fail(e);
                }
            if (!first)
                try {
                    const { parent, stat: before } = await parentOf(file);
                    assert.equal(before.dev, parentBefore.stat.dev);
                    assert.equal(before.ino, parentBefore.stat.ino);
                    directory = await acquire(
                        parent,
                        constants.O_RDONLY |
                            constants.O_DIRECTORY |
                            constants.O_NOFOLLOW |
                            constants.O_NONBLOCK,
                    );
                    const after = await directory.stat();
                    assert.ok(
                        after.isDirectory() && after.dev === before.dev && after.ino === before.ino,
                    );
                    await directory.sync();
                } catch (e) {
                    first = e;
                    fail(e);
                }
            if (directory)
                try {
                    await directory.close();
                } catch (e) {
                    first ??= e;
                    fail(e);
                }
            if (first) throw new WebFileCustodyFailure(first, owner);
            namespaces.set(file, 'acknowledged');
        },
    };
    return Object.freeze({ owner, filesystem: Object.freeze(filesystem) });
}
