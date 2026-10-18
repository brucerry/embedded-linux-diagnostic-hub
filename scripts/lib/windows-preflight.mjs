// @ts-nocheck
/** Inert metadata-only helpers. No collector, Electron, PTY or installer imports. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const preflightLimits = Object.freeze({
    budgetMs: 300000,
    reserveMs: 30000,
    commandMs: 10000,
    commandBytes: 65536,
    journalRows: 128,
    journalBytes: 262144,
    reportBytes: 524288,
    dependencyBytes: 2147483648,
    dependencyFiles: 30000,
});
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function metadataIdentity(file) {
    const s = fs.lstatSync(file, { bigint: true });
    assert(!s.isSymbolicLink(), 'Metadata aliases refused.');
    return {
        path: file,
        realpath: fs.realpathSync(file),
        directory: s.isDirectory(),
        file: s.isFile(),
        dev: String(s.dev),
        ino: String(s.ino),
        nlink: String(s.nlink),
        size: String(s.size),
    };
}
export function ancestryIdentity(root) {
    let p = root,
        rows = [];
    for (;;) {
        const info = metadataIdentity(p);
        assert(info.directory && info.realpath === p);
        const { path: binding, realpath, directory, dev, ino } = info;
        rows.unshift({ path: binding, realpath, directory, dev, ino });
        const parent = path.dirname(p);
        if (parent === p) break;
        p = parent;
    }
    return rows;
}
export function checkAncestry(rows) {
    for (const old of rows) {
        const { path: binding, realpath, directory, dev, ino } = metadataIdentity(old.path);
        assert.deepEqual(
            { path: binding, realpath, directory, dev, ino },
            old,
            'Preflight ancestry rebound.',
        );
    }
}
export function refuseMarker(tmp) {
    const marker = path.join(tmp, 'diagnostic-hub-v060-check.lock');
    try {
        const s = fs.lstatSync(marker);
        throw Error(
            'Canonical marker exists; preflight will not acquire, clear or replace it: ' +
                String(s.isFile()),
        );
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return { path: marker, absent: true, mutated: false };
}
export function peMachine(bytes) {
    assert(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'Not a DOS/PE header.');
    const offset = bytes.readUInt32LE(60);
    assert(offset >= 64 && offset + 26 <= bytes.length, 'PE header offset unavailable/bounded.');
    assert.equal(bytes.readUInt32LE(offset), 0x4550);
    const machine = bytes.readUInt16LE(offset + 4);
    return {
        machine,
        architecture: { 332: 'x86', 34404: 'x64', 43620: 'arm64' }[machine] ?? 'unknown',
    };
}
export function fileIdentity(file, { pe = false, check = () => {} } = {}) {
    check();
    const before = metadataIdentity(file);
    assert(before.file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)),
        hash = createHash('sha256');
    let bytes = 0,
        header = Buffer.alloc(0);
    try {
        const opened = fs.fstatSync(fd, { bigint: true });
        assert.equal(String(opened.ino), before.ino);
        assert.equal(String(opened.dev), before.dev);
        const buffer = Buffer.alloc(65536);
        for (;;) {
            check();
            const n = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!n) break;
            bytes += n;
            assert(bytes <= preflightLimits.dependencyBytes);
            hash.update(buffer.subarray(0, n));
            if (header.length < 1048576)
                header = Buffer.concat([
                    header,
                    buffer.subarray(0, Math.min(n, 1048576 - header.length)),
                ]);
        }
        assert.equal(String(bytes), before.size);
        assert.deepEqual(metadataIdentity(file), before);
    } finally {
        fs.closeSync(fd);
    }
    return { ...before, sha256: hash.digest('hex'), ...(pe ? { pe: peMachine(header) } : {}) };
}
export function dependencyFacts(root, check) {
    const hash = createHash('sha256');
    let files = 0,
        bytes = 0;
    function walk(dir) {
        for (const item of fs
            .readdirSync(dir, { withFileTypes: true })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            check();
            const file = path.join(dir, item.name);
            assert(!item.isSymbolicLink(), 'Dependency alias requires explicit review.');
            if (item.isDirectory()) walk(file);
            else {
                const row = fileIdentity(file, { check });
                files++;
                bytes += Number(row.size);
                assert(
                    files <= preflightLimits.dependencyFiles &&
                        bytes <= preflightLimits.dependencyBytes,
                );
                hash.update(
                    path.relative(root, file).replaceAll('\\', '/') + '\0' + row.sha256 + '\n',
                );
            }
        }
    }
    walk(root);
    return { root, files, bytes, sha256: hash.digest('hex') };
}
export function closeDescriptor(fd, io = fs) {
    const errors = [];
    let synced = false,
        closed = false;
    try {
        io.fsyncSync(fd);
        synced = true;
    } catch (error) {
        errors.push('sync: ' + String(error));
    }
    try {
        io.closeSync(fd);
        closed = true;
    } catch (error) {
        errors.push('close: ' + String(error));
        try {
            fs.closeSync(fd);
            closed = true;
        } catch (final) {
            errors.push('final close: ' + String(final));
        }
    }
    return { synced, closed, errors };
}
/** Only a fresh nonce-named disposable metadata file; no app/storage/native backend is opened. */
export function metadataFileProbe(root, { fault = null, check = () => {}, io = fs } = {}) {
    assert([null, 'sync', 'close'].includes(fault));
    check();
    const file = path.join(root, 'metadata-' + randomUUID() + '.tmp'),
        bytes = Buffer.from('nonqualifying Windows metadata fsync control\n');
    let fd,
        created = false,
        proof = {
            fault,
            write: false,
            read: false,
            reopen: false,
            removed: false,
            handles: [],
            errors: [],
        },
        injected = false;
    const selected = {
        ...io,
        fsyncSync(handle) {
            if (fault === 'sync' && !injected) {
                injected = true;
                throw Error('Injected metadata fsync failure');
            }
            return io.fsyncSync(handle);
        },
        closeSync(handle) {
            if (fault === 'close' && !injected) {
                injected = true;
                throw Error('Injected metadata close failure');
            }
            return io.closeSync(handle);
        },
    };
    try {
        fd = io.openSync(file, 'wx', 0o600);
        created = true;
        io.writeFileSync(fd, bytes);
        proof.write = true;
        proof.handles.push(closeDescriptor(fd, selected));
        fd = undefined;
        check();
        fd = io.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
        const stat = io.fstatSync(fd);
        assert(stat.isFile() && stat.nlink === 1 && stat.size === bytes.length);
        const actual = Buffer.alloc(bytes.length + 1),
            n = io.readSync(fd, actual, 0, actual.length, 0);
        assert.equal(n, bytes.length);
        assert(actual.subarray(0, n).equals(bytes));
        proof.read = true;
        proof.handles.push(closeDescriptor(fd, io));
        fd = undefined;
        check();
        fd = io.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
        const reopened = Buffer.alloc(bytes.length);
        assert.equal(io.readSync(fd, reopened, 0, reopened.length, 0), bytes.length);
        assert(reopened.equals(bytes));
        proof.reopen = true;
    } catch (error) {
        proof.errors.push(String(error));
    } finally {
        if (fd !== undefined) proof.handles.push(closeDescriptor(fd, io));
        if (created && proof.handles.every((h) => h.closed)) {
            try {
                check();
                io.unlinkSync(file);
                proof.removed = true;
            } catch (error) {
                proof.errors.push('cleanup: ' + String(error));
            }
        }
    }
    proof.injected = injected;
    proof.observedHandleErrors = proof.handles.flatMap((h) => h.errors);
    proof.actualCleanupComplete =
        proof.handles.length > 0 && proof.handles.every((h) => h.closed) && proof.removed;
    proof.controlPassed =
        proof.write &&
        proof.read &&
        proof.reopen &&
        proof.actualCleanupComplete &&
        !proof.errors.length &&
        (fault
            ? injected && proof.observedHandleErrors.length === 1
            : proof.observedHandleErrors.length === 0 && proof.handles.every((h) => h.synced));
    return proof;
}
export class PreflightJournal {
    constructor(root) {
        this.file = path.join(root, 'preflight.jsonl');
        this.fd = fs.openSync(this.file, 'wx', 0o600);
        this.rows = 0;
        this.bytes = 0;
        this.closed = false;
    }
    append(stage, data) {
        assert(!this.closed);
        const bytes = Buffer.from(JSON.stringify({ sequence: this.rows, stage, data }) + '\n');
        assert(
            this.rows < preflightLimits.journalRows &&
                this.bytes + bytes.length <= preflightLimits.journalBytes &&
                bytes.length <= 65536,
            'Preflight journal pre-write cap.',
        );
        fs.writeFileSync(this.fd, bytes);
        fs.fsyncSync(this.fd);
        this.rows++;
        this.bytes += bytes.length;
    }
    close() {
        if (this.closed) return this.proof;
        this.proof = closeDescriptor(this.fd);
        this.closed = true;
        return this.proof;
    }
}
export function writeReport(root, report) {
    const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
    assert(bytes.length <= preflightLimits.reportBytes, 'Preflight report pre-write cap.');
    const fd = fs.openSync(path.join(root, 'preflight.json'), 'wx', 0o600);
    let failure;
    try {
        fs.writeFileSync(fd, bytes);
    } catch (error) {
        failure = error;
    }
    const proof = closeDescriptor(fd);
    if (failure || !proof.synced || !proof.closed || proof.errors.length)
        throw new AggregateError(
            [failure, ...proof.errors].filter(Boolean),
            'Preflight report closure failed.',
        );
    return { bytes: bytes.length, sha256: digest(bytes), proof };
}
