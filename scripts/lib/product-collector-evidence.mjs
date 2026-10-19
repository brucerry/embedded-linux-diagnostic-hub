// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { limits } from './product-collector-controller.mjs';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Fixed allocation; refuse links/large files before read and growth after stat. */
function readBoundedDescriptor(file, max, io, register, owned = false) {
    const before = io.lstatSync(file);
    assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= max);
    if (owned && typeof process.getuid === 'function') assert.equal(before.uid, process.getuid());
    const fd = io.openSync(
        file,
        (owned ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | (fs.constants.O_NOFOLLOW ?? 0),
    );
    register(fd, before);
    const opened = io.fstatSync(fd);
    assert(opened.isFile());
    assert.equal(opened.ino, before.ino);
    assert.equal(opened.dev, before.dev);
    assert.equal(opened.size, before.size);
    assert.equal(opened.uid, before.uid);
    const buffer = Buffer.alloc(max + 1);
    let n = 0;
    while (n < buffer.length) {
        const got = io.readSync(fd, buffer, n, buffer.length - n, null);
        if (!got) break;
        n += got;
    }
    assert(n <= max && n === before.size, 'Evidence grew or changed size.');
    const after = io.fstatSync(fd);
    assert(after.isFile());
    assert.equal(after.size, before.size);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    assert.equal(after.uid, before.uid);
    const rebound = io.lstatSync(file);
    assert(rebound.isFile() && !rebound.isSymbolicLink());
    for (const key of ['dev', 'ino', 'size', 'uid'])
        assert.equal(rebound[key], before[key], 'Evidence path rebound during bounded read.');
    return buffer.subarray(0, n);
}
/** Fixed allocation and original no-follow/identity checks; descriptor always closed. */
export function boundedRead(file, max, io = fs) {
    let fd;
    try {
        return readBoundedDescriptor(file, max, io, (value) => {
            fd = value;
        });
    } finally {
        if (fd !== undefined) io.closeSync(fd);
    }
}
/** Explicitly sync every acquired required raw descriptor, even after an earlier read/sync failure. */
export function readDurableArtifacts(specs, { io = fs, check = () => {} } = {}) {
    const entries = [],
        raw = {},
        inventory = [],
        readErrors = [];
    let closure;
    try {
        for (const spec of specs) {
            if (spec.optional && !io.existsSync(spec.path)) continue;
            const item = {
                path: spec.path,
                name: spec.name,
                bytes: null,
                maximumBytes: spec.max,
                sha256: null,
            };
            inventory.push(item);
            try {
                check(spec.path);
                item.bytes = io.lstatSync(spec.path).size;
                const bytes = readBoundedDescriptor(
                    spec.path,
                    spec.max,
                    io,
                    (fd, identity) => {
                        const verify = () => {
                            check(spec.path);
                            const current = io.lstatSync(spec.path),
                                opened = io.fstatSync(fd);
                            assert(
                                current.isFile() && !current.isSymbolicLink() && opened.isFile(),
                            );
                            for (const key of ['dev', 'ino', 'uid', 'size']) {
                                assert.equal(
                                    current[key],
                                    identity[key],
                                    'Raw path changed before durable acceptance.',
                                );
                                assert.equal(
                                    opened[key],
                                    identity[key],
                                    'Raw descriptor changed before durable acceptance.',
                                );
                            }
                        };
                        entries.push({
                            fd,
                            name: spec.name,
                            path: spec.path,
                            errors: [],
                            synced: false,
                            closed: false,
                            attempted: false,
                            beforeSync: verify,
                            afterSync: verify,
                        });
                    },
                    true,
                );
                raw[spec.name] = bytes;
                item.sha256 = digest(bytes);
            } catch (error) {
                readErrors.push({ name: spec.name, error: String(error).slice(0, 4096) });
            }
        }
    } finally {
        closure = closeEntries(entries, io);
    }
    return {
        raw,
        inventory,
        durability: {
            complete: readErrors.length === 0 && closure.complete,
            readErrors,
            errors: closure.errors,
            handles: entries.map((e) => ({
                name: e.name,
                path: e.path,
                openObserved: true,
                syncObserved: e.synced,
                closeObserved: e.closed,
                closeAttempted: e.attempted,
                errors: [...e.errors],
            })),
        },
    };
}
export function inspectDurableArtifacts(specs, binding, options) {
    assert.equal(
        binding.parentLifecycle?.closeObserved,
        true,
        'Raw synchronization requires actual parent close.',
    );
    const { raw, inventory, durability } = readDurableArtifacts(specs, options);
    const inspected = binding.inspect(raw);
    return {
        ...inspected,
        valid: inspected.valid && durability.complete,
        error: durability.complete ? inspected.error : 'Raw artifact read/sync/close incomplete.',
        inventory,
        rawDurability: durability,
    };
}
export function writeAll(fd, bytes, io = fs) {
    let offset = 0;
    while (offset < bytes.length) {
        const n = io.writeSync(fd, bytes, offset, bytes.length - offset);
        assert(Number.isSafeInteger(n) && n > 0 && n <= bytes.length - offset);
        offset += n;
    }
}
export function closeEntries(entries, io = fs) {
    for (const e of entries) {
        if (e.attempted) continue;
        e.attempted = true;
        try {
            e.beforeSync?.();
            io.fsyncSync(e.fd);
            e.synced = true;
            e.afterSync?.();
        } catch (x) {
            e.errors.push(String(x));
        }
        try {
            io.closeSync(e.fd);
            e.closed = true;
        } catch (x) {
            e.errors.push(String(x));
        }
    }
    return {
        complete: entries.every((e) => e.synced && e.closed && !e.errors.length),
        errors: entries.flatMap((e) => e.errors),
    };
}
export function streamCollector(
    fd,
    { max = limits.streamBytes, io = fs, onFailure = () => {}, admit = () => {} } = {},
) {
    let attempted = 0,
        written = 0,
        failed = false;
    const full = createHash('sha256'),
        retained = createHash('sha256');
    return {
        write(bytes) {
            attempted += bytes.length;
            full.update(bytes);
            if (failed) return;
            try {
                assert(attempted <= max, 'Parent stream evidence cap exceeded.');
                admit(bytes.length);
                writeAll(fd, bytes, {
                    writeSync(...args) {
                        const n = io.writeSync(...args);
                        if (Number.isSafeInteger(n) && n > 0 && n <= args[3]) {
                            written += n;
                            retained.update(args[1].subarray(args[2], args[2] + n));
                        }
                        return n;
                    },
                });
            } catch (e) {
                failed = true;
                onFailure(e);
            }
        },
        snapshot: () => ({
            attempted,
            written,
            failed,
            truncated: failed || attempted !== written,
            fullStreamSHA256: full.copy().digest('hex'),
            retainedAcknowledgedSHA256: retained.copy().digest('hex'),
            partialWriteUncertainty: failed,
        }),
    };
}

const durableReferences = new WeakMap();
/** Whole-tree durable verification with one64KiB buffer, no retained file bodies. */
export function readStreamedDurableArtifacts(specs, { io = fs, check = () => {} } = {}) {
    const raw = {},
        inventory = [],
        entries = [],
        readErrors = [];
    const scratch = Buffer.alloc(65536);
    for (const spec of specs) {
        if (spec.optional && !io.existsSync(spec.path)) continue;
        let entry,
            identity,
            bytes = 0,
            sha256;
        try {
            check(spec.path);
            identity = io.lstatSync(spec.path);
            assert(
                identity.isFile() &&
                    !identity.isSymbolicLink() &&
                    identity.nlink === 1 &&
                    identity.size <= spec.max,
            );
            const fd = io.openSync(spec.path, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
            entry = {
                fd,
                name: spec.name,
                path: spec.path,
                errors: [],
                synced: false,
                closed: false,
                attempted: false,
            };
            entries.push(entry);
            const verify = () => {
                check(spec.path);
                const a = io.fstatSync(fd),
                    b = io.lstatSync(spec.path);
                assert(a.isFile() && b.isFile() && !b.isSymbolicLink());
                for (const k of ['dev', 'ino', 'uid', 'size'])
                    assert(
                        a[k] === identity[k] && b[k] === identity[k],
                        'Streamed raw identity changed',
                    );
            };
            entry.beforeSync = verify;
            entry.afterSync = verify;
            verify();
            const hash = createHash('sha256');
            for (;;) {
                const n = io.readSync(fd, scratch, 0, scratch.length, null);
                if (!n) break;
                bytes += n;
                assert(bytes <= identity.size && bytes <= spec.max);
                hash.update(scratch.subarray(0, n));
            }
            assert(bytes === identity.size);
            verify();
            sha256 = hash.digest('hex');
        } catch (e) {
            readErrors.push({ name: spec.name, error: String(e).slice(0, 4096) });
        } finally {
            if (entry) closeEntries([entry], io);
        }
        inventory.push({
            name: spec.name,
            path: spec.path,
            bytes,
            maximumBytes: spec.max,
            sha256: sha256 ?? null,
        });
        if (sha256 && entry?.synced && entry.closed && !entry.errors.length) {
            const ref = Object.freeze({
                kind: 'durable-file-reference-v1',
                path: spec.path,
                bytes,
                sha256,
            });
            durableReferences.set(ref, { io, check, identity });
            raw[spec.name] = ref;
        }
        if (entry && !entry.closed) {
            readErrors.push({
                name: spec.name,
                error: 'Descriptor closure unknown; further file admission stopped.',
            });
            break;
        }
    }
    const complete =
        readErrors.length === 0 &&
        entries.every((e) => e.synced && e.closed && !e.errors.length) &&
        inventory.length === specs.filter((s) => !s.optional || io.existsSync(s.path)).length;
    return {
        raw,
        inventory,
        durability: {
            complete,
            readErrors,
            errors: entries.flatMap((e) => e.errors),
            handles: entries.map((e) => ({
                name: e.name,
                path: e.path,
                openObserved: true,
                syncObserved: e.synced,
                closeObserved: e.closed,
                closeAttempted: e.attempted,
                errors: [...e.errors],
            })),
            maximumReadBufferBytes: scratch.length,
            retainedRawBodyBytes: 0,
        },
    };
}
/** Reopens only a module-owned identity-checked reference; verifies exact EOF digest and close. */
export function* durableChunks(ref) {
    const owner = durableReferences.get(ref);
    assert(owner, 'Foreign durable file reference');
    const { io, check, identity } = owner;
    let fd;
    const buffer = Buffer.alloc(65536),
        hash = createHash('sha256');
    let bytes = 0;
    const verify = () => {
        check(ref.path);
        const p = io.lstatSync(ref.path),
            f = io.fstatSync(fd);
        assert(p.isFile() && !p.isSymbolicLink() && f.isFile());
        for (const k of ['dev', 'ino', 'uid', 'size'])
            assert(p[k] === identity[k] && f[k] === identity[k], 'Streamed reader rebound');
    };
    try {
        fd = io.openSync(ref.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        verify();
        for (;;) {
            const n = io.readSync(fd, buffer, 0, buffer.length, null);
            if (!n) break;
            bytes += n;
            assert(bytes <= ref.bytes);
            const value = buffer.subarray(0, n);
            hash.update(value);
            yield value;
        }
        assert(
            bytes === ref.bytes && hash.digest('hex') === ref.sha256,
            'Streamed reader EOF digest',
        );
        verify();
    } finally {
        if (fd !== undefined) io.closeSync(fd);
    }
}
/** Synchronous consumers borrow each row until the next iteration; no growing concat buffers. */
export function* artifactLines(input, maxLine = 1048576) {
    const chunks = Buffer.isBuffer(input) ? [input] : durableChunks(input),
        row = Buffer.alloc(maxLine);
    let used = 0;
    for (const chunk of chunks) {
        let start = 0;
        for (let i = 0; i < chunk.length; i++)
            if (chunk[i] === 10) {
                const n = i + 1 - start;
                assert(used + n <= maxLine, 'Artifact line bound');
                chunk.copy(row, used, start, i + 1);
                used += n;
                yield row.subarray(0, used);
                used = 0;
                start = i + 1;
            }
        assert(used + chunk.length - start <= maxLine, 'Artifact line bound');
        chunk.copy(row, used, start);
        used += chunk.length - start;
    }
    assert(!used, 'Artifact unterminated EOF');
}
export function smallArtifact(input, max = 4194304) {
    if (Buffer.isBuffer(input)) {
        assert(input.length <= max);
        return input;
    }
    assert(input.bytes <= max);
    const result = Buffer.alloc(input.bytes);
    let offset = 0;
    for (const chunk of durableChunks(input)) {
        chunk.copy(result, offset);
        offset += chunk.length;
    }
    assert(offset === result.length);
    return result;
}
