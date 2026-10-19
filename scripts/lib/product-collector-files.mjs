// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { boundedRead, writeAll, closeEntries, digest } from './product-collector-evidence.mjs';

export const canonicalMarker = () =>
    path.join(fs.realpathSync(os.tmpdir()), 'diagnostic-hub-v060-check.lock');
const identity = (s) => [s.dev, s.ino, s.uid].join('/');
const within = (root, file) =>
    file === root ||
    (!path.isAbsolute(path.relative(root, file)) &&
        !path.relative(root, file).split(path.sep).includes('..'));
/** Read-only Windows principal/ACL observation; no credential, owner or ACL mutation. */
export function windowsPrincipalObserver(profile) {
    const many = (files) => {
        assert.equal(process.platform, 'win32');
        const script =
            '$ErrorActionPreference="Stop";$i=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$paths=ConvertFrom-Json $env:HUB_COLLECTOR_ACL_PATHS;$rows=@(foreach($p in $paths){$a=Get-Acl -LiteralPath $p;$o=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;[pscustomobject]@{path=$p;principal=$i;owner=$o;sddl=$a.Sddl}});ConvertTo-Json -InputObject $rows -Compress';
        const encoded = JSON.stringify(files);
        assert(Buffer.byteLength(encoded) <= 32768, 'ACL batch environment bound.');
        const result = spawnSync(
            profile.powershell.path,
            ['-NoProfile', '-NonInteractive', '-Command', script],
            {
                windowsHide: true,
                encoding: 'utf8',
                timeout: 10000,
                maxBuffer: 1024 ** 2,
                env: { ...process.env, HUB_COLLECTOR_ACL_PATHS: encoded },
            },
        );
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        const rows = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
        assert(Array.isArray(rows) && rows.length === files.length);
        rows.forEach((row, i) => {
            assert.equal(row.path, files[i]);
            assert.equal(row.principal, profile.principalSID);
            assert.equal(
                row.owner,
                profile.principalSID,
                'Windows owner differs from reviewed current principal.',
            );
            if (row.path === profile.outputRoot)
                assert.equal(digest(row.sddl), profile.outputRootSDDLSHA256);
            if (row.path === profile.canonicalTmp)
                assert.equal(digest(row.sddl), profile.canonicalTmpSDDLSHA256);
        });
        return rows;
    };
    const single = (file) => many([file])[0];
    single.many = many;
    return single;
}
/** Reviewed temporal path binding, not an atomic NTFS handle-capability guarantee. */
export class RootGuard {
    constructor(root, { ownerCheck = () => {}, io = fs, writeAdmission = () => {} } = {}) {
        assert(path.isAbsolute(root) && path.resolve(root) === root);
        this.root = root;
        this.io = io;
        this.ownerCheck = ownerCheck;
        this.writeAdmission = writeAdmission;
        this.bindings = new Map();
        let current = root,
            ancestry = [];
        while (true) {
            ancestry.unshift(current);
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        for (const item of ancestry) this.bind(item, false);
        this.ownerCheck(root);
        if (typeof process.getuid === 'function')
            assert.equal(io.statSync(root).uid, process.getuid());
    }
    bind(file, owned = true) {
        const s = this.io.lstatSync(file);
        assert(s.isDirectory() && !s.isSymbolicLink());
        assert.equal(this.io.realpathSync(file), file);
        if (owned) {
            this.ownerCheck(file);
            if (typeof process.getuid === 'function') assert.equal(s.uid, process.getuid());
        }
        const old = this.bindings.get(file);
        if (old) assert.equal(identity(s), old, 'Rebound ancestry: ' + file);
        else this.bindings.set(file, identity(s));
    }
    check(file = this.root) {
        assert(within(this.root, file), 'Output escaped private root.');
        for (const [p, expected] of this.bindings) {
            const s = this.io.lstatSync(p);
            assert(s.isDirectory() && !s.isSymbolicLink());
            assert.equal(this.io.realpathSync(p), p);
            assert.equal(identity(s), expected, 'Rebound ancestry.');
        }
        let p = file;
        while (p !== this.root) {
            if (this.io.existsSync(p))
                assert(!this.io.lstatSync(p).isSymbolicLink(), 'Aliased output.');
            p = path.dirname(p);
        }
    }
    mkdir(relative) {
        const target = path.resolve(this.root, relative);
        this.check(target);
        let p = this.root;
        for (const name of path.relative(this.root, target).split(path.sep).filter(Boolean)) {
            p = path.join(p, name);
            if (!this.io.existsSync(p)) this.io.mkdirSync(p, { mode: 0o700 });
            this.bind(p);
        }
        return target;
    }
    write(relative, bytes) {
        const file = path.resolve(this.root, relative);
        this.check(file);
        this.bind(path.dirname(file));
        this.writeAdmission(Buffer.byteLength(bytes));
        const fd = this.io.openSync(file, 'wx', 0o600);
        const entry = { fd, errors: [], attempted: false };
        try {
            writeAll(fd, Buffer.from(bytes), this.io);
        } finally {
            const result = closeEntries([entry], this.io);
            assert.equal(result.complete, true, 'Record sync/close failed.');
        }
        this.check(file);
        return file;
    }
}
export class ProductLease {
    constructor(file, owner, { io = fs, ownerCheck = () => {} } = {}) {
        this.file = file;
        this.owner = owner;
        this.io = io;
        this.ownerCheck = ownerCheck;
        this.bytes = Buffer.from(JSON.stringify(owner) + '\n');
        assert(this.bytes.length <= 4096);
        this.guard = new RootGuard(io.realpathSync(path.dirname(file)), { io, ownerCheck });
        this.created = false;
        this.released = false;
        this.identity = null;
    }
    acquire() {
        this.guard.check();
        const fd = this.io.openSync(
            this.file,
            this.io.constants.O_WRONLY |
                this.io.constants.O_CREAT |
                this.io.constants.O_EXCL |
                (this.io.constants.O_NOFOLLOW ?? 0),
            0o600,
        );
        this.created = true;
        const entry = { fd, errors: [], attempted: false };
        try {
            writeAll(fd, this.bytes, this.io);
            this.identity = identity(this.io.fstatSync(fd));
        } finally {
            assert.equal(closeEntries([entry], this.io).complete, true);
        }
        this.check();
    }
    check() {
        this.guard.check();
        assert(this.identity);
        const s = this.io.lstatSync(this.file);
        assert(s.isFile() && !s.isSymbolicLink() && s.nlink === 1);
        assert.equal(identity(s), this.identity);
        if (typeof process.getuid === 'function') assert.equal(s.uid, process.getuid());
        this.ownerCheck(this.file);
        assert(
            boundedRead(this.file, 4096, this.io).equals(this.bytes),
            'Complete marker bytes changed.',
        );
    }
    state() {
        return {
            created: this.created,
            retained: this.created && !this.released && this.io.existsSync(this.file),
            identityConfirmed: this.identity !== null || this.released,
            released: this.released,
        };
    }
    release(proof) {
        assert.deepEqual(Object.keys(proof).sort(), [
            'admissionCertain',
            'directParentsClosed',
            'evidenceClosed',
            'inputsUnchanged',
            'leafReceiptsClosed',
            'resultClosed',
        ]);
        assert(Object.values(proof).every((v) => v === true));
        this.check();
        this.io.unlinkSync(this.file);
        this.released = true;
        this.identity = null;
    }
}
export class ProductJournal {
    constructor(guard, file) {
        this.guard = guard;
        this.file = file;
        guard.check(file);
        this.fd = fs.openSync(file, 'wx', 0o600);
        this.bytes = 0;
        this.rows = 0;
        this.errors = [];
        this.entry = { fd: this.fd, errors: this.errors, attempted: false };
    }
    append(stage, data) {
        try {
            this.guard.check(this.file);
            assert(!this.entry.attempted);
            const bytes = Buffer.from(JSON.stringify({ sequence: this.rows, stage, data }) + '\n');
            this.guard.writeAdmission(bytes.length);
            assert(
                bytes.length <= 65536 && this.rows < 1024 && this.bytes + bytes.length <= 1048576,
                'Collector journal pre-write bound.',
            );
            writeAll(this.fd, bytes);
            fs.fsyncSync(this.fd);
            this.rows++;
            this.bytes += bytes.length;
        } catch (e) {
            this.errors.push(String(e));
            throw e;
        }
    }
    close() {
        const result = closeEntries([this.entry]);
        assert.equal(result.complete, true);
    }
    proof() {
        return Boolean(this.entry.synced && this.entry.closed && !this.errors.length);
    }
}
