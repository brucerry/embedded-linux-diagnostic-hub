// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
    ancestryIdentity,
    checkAncestry,
    refuseMarker,
    peMachine,
    metadataFileProbe,
    PreflightJournal,
    preflightLimits,
    writeReport,
    dependencyFacts,
} from '../scripts/lib/windows-preflight.mjs';
import { parseAclObservation, productPreflight } from '../scripts/memory-product-preflight.mts';
const scratch = () =>
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-preflight-control-'));
for (const fault of [null, 'sync', 'close'])
    test(`disposable metadata ${fault ?? 'nominal'} control attempts actual read/fsync/close/reopen and leaves no file`, () => {
        const root = scratch();
        try {
            const proof = metadataFileProbe(root, { fault });
            assert.equal(proof.controlPassed, true);
            assert.equal(proof.actualCleanupComplete, true);
            assert.equal(proof.reopen, true);
            assert.equal(proof.handles.length, 3);
            assert(proof.handles.every((h) => h.closed));
            assert.equal(proof.observedHandleErrors.length, fault ? 1 : 0);
            assert.deepEqual(fs.readdirSync(root), []);
        } finally {
            fs.rmSync(root, { recursive: true });
        }
    });
// Model Windows FlushFileBuffers access on real disposable descriptors, including FD reuse.
for (const fault of [null, 'sync', 'close'])
    test(`Windows writable-fsync semantics preserve ${fault ?? 'nominal'} metadata control`, () => {
        const root = scratch(),
            access = new Map(),
            opens = [],
            synced = [];
        const io = {
            ...fs,
            openSync(file, flags, ...rest) {
                const fd = fs.openSync(file, flags, ...rest);
                const writable =
                    typeof flags === 'number'
                        ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0
                        : flags.includes('w') || flags.includes('+') || flags.includes('a');
                access.set(fd, writable);
                opens.push({ flags, writable });
                return fd;
            },
            fsyncSync(fd) {
                assert.equal(
                    access.get(fd),
                    true,
                    'Windows FlushFileBuffers requires writable access',
                );
                fs.fsyncSync(fd);
                synced.push(fd);
            },
            closeSync(fd) {
                fs.closeSync(fd);
                access.delete(fd);
            },
        };
        try {
            // Prove the access model refuses a real read-only FD even on macOS.
            const control = path.join(root, 'readonly-control');
            fs.writeFileSync(control, 'x');
            const fd = io.openSync(control, 'r');
            assert.throws(() => io.fsyncSync(fd), /requires writable access/);
            io.closeSync(fd);
            fs.unlinkSync(control);
            opens.length = 0;
            const proof = metadataFileProbe(root, { fault, io });
            assert.equal(proof.controlPassed, true);
            assert.equal(proof.actualCleanupComplete, true);
            assert.equal(opens.length, 3);
            assert(opens.every((row) => row.writable));
            for (const row of opens.slice(1)) {
                assert.equal(row.flags, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
            }
            assert.equal(synced.length, fault === 'sync' ? 2 : 3);
            assert.equal(proof.observedHandleErrors.length, fault ? 1 : 0);
            if (fault) assert.match(proof.observedHandleErrors[0], /Injected metadata/);
            assert(proof.handles.every((row) => row.closed));
            assert.deepEqual(fs.readdirSync(root), []);
        } finally {
            fs.rmSync(root, { recursive: true });
        }
    });
test('a genuine writable metadata fsync failure remains a failed control with independent closure', () => {
    const root = scratch();
    let syncAttempts = 0,
        closeAttempts = 0;
    try {
        const proof = metadataFileProbe(root, {
            io: {
                ...fs,
                fsyncSync() {
                    syncAttempts++;
                    throw Error('Actual writable flush failure');
                },
                closeSync(fd) {
                    closeAttempts++;
                    fs.closeSync(fd);
                },
            },
        });
        assert.equal(proof.controlPassed, false);
        assert.equal(proof.actualCleanupComplete, true);
        assert.equal(syncAttempts, 3);
        assert.equal(closeAttempts, 3);
        assert.equal(proof.observedHandleErrors.length, 3);
        assert(
            proof.observedHandleErrors.every((error) =>
                error.includes('Actual writable flush failure'),
            ),
        );
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('ancestry ignores new directory entries but rejects a rebound directory', () => {
    const root = scratch(),
        child = path.join(root, 'owned');
    try {
        fs.mkdirSync(child);
        const rows = ancestryIdentity(child);
        fs.writeFileSync(path.join(child, 'metadata'), 'x');
        checkAncestry(rows);
        fs.renameSync(child, path.join(root, 'retained'));
        fs.mkdirSync(child);
        assert.throws(() => checkAncestry(rows));
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('canonical marker is only observed; existing bytes or symlink cannot be replaced', () => {
    const root = scratch(),
        marker = path.join(root, 'diagnostic-hub-v060-check.lock');
    try {
        assert.equal(refuseMarker(root).absent, true);
        fs.writeFileSync(marker, 'foreign');
        assert.throws(() => refuseMarker(root));
        assert.equal(fs.readFileSync(marker, 'utf8'), 'foreign');
        fs.unlinkSync(marker);
        fs.symlinkSync('missing', marker);
        assert.throws(() => refuseMarker(root));
        assert.equal(fs.readlinkSync(marker), 'missing');
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('single/multi-path ACL observations preserve arrays, literal paths and unapproved owner differences', () => {
    for (const paths of [['C:\\custom root'], ['C:\\custom root', 'D:\\temp']]) {
        const value = {
            principal: 'S-1-5-21-1',
            rows: paths.map((p) => ({ path: p, owner: 'S-1-5-21-other', sddl: 'D:record-only' })),
        };
        assert.deepEqual(parseAclObservation('\uFEFF' + JSON.stringify(value), paths), value);
        assert.throws(() =>
            parseAclObservation(JSON.stringify({ ...value, rows: value.rows[0] }), paths),
        );
        assert.throws(() =>
            parseAclObservation(
                JSON.stringify({ ...value, rows: [...value.rows].reverse() }),
                paths.length > 1 ? paths : ['different'],
            ),
        );
    }
});
test('PE facts parse actual machine codes without loading DLLs and refuse missing/bounded headers', () => {
    for (const [machine, name] of [
        [0x8664, 'x64'],
        [0x14c, 'x86'],
        [0xaa64, 'arm64'],
        [0, 'unknown'],
    ]) {
        const bytes = Buffer.alloc(128);
        bytes.write('MZ');
        bytes.writeUInt32LE(64, 60);
        bytes.writeUInt32LE(0x4550, 64);
        bytes.writeUInt16LE(machine, 68);
        assert.equal(peMachine(bytes).architecture, name);
    }
    for (const bytes of [Buffer.alloc(2), Buffer.alloc(128)]) assert.throws(() => peMachine(bytes));
});
test('pre-write journal/report budgets preserve partial facts and close the actual journal', () => {
    const root = scratch();
    try {
        const journal = new PreflightJournal(root);
        journal.append('partial', { reviewed: false });
        const before = fs.statSync(journal.file).size;
        assert.throws(() => journal.append('oversize', 'x'.repeat(preflightLimits.journalBytes)));
        assert.equal(fs.statSync(journal.file).size, before);
        const proof = journal.close();
        assert(proof.synced && proof.closed && !proof.errors.length);
        writeReport(root, { reviewed: false, partial: true });
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(root, 'preflight.json'), 'utf8')).reviewed,
            false,
        );
        assert.throws(() => writeReport(root, { overwrite: true }));
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('dependency hash and path inventory refuse aliases and detect content changes', () => {
    const root = scratch();
    try {
        fs.writeFileSync(path.join(root, 'one'), 'a');
        const first = dependencyFacts(root, () => {});
        fs.writeFileSync(path.join(root, 'one'), 'b');
        assert.notEqual(dependencyFacts(root, () => {}).sha256, first.sha256);
        fs.symlinkSync('one', path.join(root, 'alias'));
        assert.throws(() => dependencyFacts(root, () => {}));
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('non-Windows entry is blocked before allocation and all early handlers/timers close', async () => {
    if (process.platform === 'win32') return;
    const events = new EventEmitter(),
        timers = new Set(),
        clock = {
            now: () => 0,
            set: (fn) => {
                timers.add(fn);
                return fn;
            },
            clear: (fn) => timers.delete(fn),
        };
    const result = await productPreflight('/not-used', { events, clock });
    assert.equal(result.status, 'BLOCKED_PREFLIGHT');
    assert.equal(result.productLaunches, 0);
    assert.equal(result.collectionApproval, false);
    assert.equal(timers.size, 0);
    for (const e of ['SIGINT', 'SIGTERM', 'disconnect']) assert.equal(events.listenerCount(e), 0);
});
