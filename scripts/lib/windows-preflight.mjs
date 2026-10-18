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
/** Read existing fixed candidate directories only; never select/create a replacement root. */
export function existingOwnershipPaths(outputRoot, canonicalTmp, environment = process.env) {
    const candidates = [
            ['output-root', outputRoot],
            ['canonical-temp', canonicalTmp],
            ['runner-temp', environment.RUNNER_TEMP],
            ['localappdata-temp', environment.LOCALAPPDATA, ['Temp']],
            ['userprofile-temp', environment.USERPROFILE, ['AppData', 'Local', 'Temp']],
        ],
        paths = [],
        rows = [];
    for (const [name, raw, suffix = []] of candidates) {
        if (raw === undefined) {
            rows.push({ name, status: 'not-set' });
            continue;
        }
        try {
            assert(
                typeof raw === 'string' &&
                    raw.length > 0 &&
                    raw.length <= 4096 &&
                    !raw.includes('\0'),
            );
            assert(path.isAbsolute(raw));
            const requested = path.join(raw, ...suffix);
            assert(requested.length <= 4096);
            assert(
                path.relative(path.parse(requested).root, requested).split(path.sep).length < 32,
                'Candidate ancestry bound.',
            );
            const ancestry = ancestryIdentity(requested);
            assert(ancestry.length <= 32, 'Candidate ancestry bound.');
            const identity = metadataIdentity(requested);
            assert(identity.directory);
            if (!paths.includes(identity.realpath)) paths.push(identity.realpath);
            rows.push({ name, status: 'observed', identity, ancestryDepth: ancestry.length });
        } catch (error) {
            rows.push({ name, status: 'unavailable', error: String(error).slice(0, 1024) });
        }
    }
    assert(paths.length <= 5 && Buffer.byteLength(JSON.stringify(paths)) <= 32768);
    return { paths, rows, directorySelected: false, settingsChanged: false };
}
/** Validate diagnostic structure; this does not implement AccessCheck or approve any path. */
export function parseOwnershipContext(text, paths, expectedPrincipal) {
    assert(Buffer.byteLength(text) <= preflightLimits.commandBytes, 'Ownership JSON bound.');
    const value = JSON.parse(text.replace(/^\uFEFF/, '')),
        sid = (v) => typeof v === 'string' && /^S-1-\d+(?:-\d+)+$/.test(v);
    assert(paths.length > 0 && paths.length <= 5 && new Set(paths).size === paths.length);
    assert(sid(value.principal) && sid(value.tokenOwner));
    if (expectedPrincipal !== undefined) assert.equal(value.principal, expectedPrincipal);
    assert.equal(value.accessCheckPerformed, false);
    assert.equal(value.privatePathApproved, false);
    assert(Array.isArray(value.rows) && value.rows.length === paths.length);
    for (let i = 0; i < paths.length; i++) {
        const row = value.rows[i];
        assert.equal(row.path, paths[i]);
        assert(sid(row.owner) && typeof row.sddl === 'string' && row.sddl.length > 0);
        for (const key of ['ownerRoleEnabled', 'daclPresent', 'daclNull', 'daclCanonical'])
            assert.equal(typeof row[key], 'boolean');
        assert(Array.isArray(row.aces) && row.aces.length <= 128);
        assert(!row.daclNull || row.aces.length === 0);
        assert(row.daclPresent || (row.daclNull && row.aces.length === 0));
        for (const ace of row.aces) {
            assert(Number.isInteger(ace.type) && ace.type >= 0 && ace.type <= 255);
            assert(Number.isInteger(ace.flags) && ace.flags >= 0 && ace.flags <= 255);
            assert.equal(typeof ace.known, 'boolean');
            if (ace.known) {
                assert(sid(ace.sid));
                assert(
                    Number.isInteger(ace.mask) && ace.mask >= -2147483648 && ace.mask <= 2147483647,
                );
            } else assert(ace.sid === null && ace.mask === null);
        }
    }
    return value;
}
/** Potential allow entries are review leads, never effective permission or privacy proof. */
export function ownershipReviewSummary(value) {
    return {
        accessCheckPerformed: false,
        privatePathApproved: false,
        admissionChanged: false,
        rows: value.rows.map((row) => ({
            path: row.path,
            ownerRelation:
                row.owner === value.principal
                    ? 'current-user'
                    : row.ownerRoleEnabled
                      ? 'enabled-token-group'
                      : 'unconfirmed-relation',
            ownerMatchesTokenDefault: row.owner === value.tokenOwner,
            daclReviewRequired: true,
            nullOrAbsentDacl: !row.daclPresent || row.daclNull,
            unsupportedAceTypes: [
                ...new Set(
                    row.aces
                        .filter((ace) => !ace.known || ![0, 1].includes(ace.type))
                        .map((ace) => ace.type),
                ),
            ],
            potentialAllowWriters: row.aces
                .filter(
                    (ace) => ace.known && ace.type === 0 && ((ace.mask >>> 0) & 0x500d0156) !== 0,
                )
                .map((ace) => ({
                    sid: ace.sid,
                    mask: ace.mask >>> 0,
                    appliesToThisDirectory: (ace.flags & 8) === 0,
                    inheritOnly: (ace.flags & 8) !== 0,
                })),
        })),
    };
}
/** One fixed ancestor closure: no discovery, content reads or path substitution. */
export function ownershipSnapshotPlan(paths) {
    assert(paths.length > 0 && paths.length <= 5 && new Set(paths).size === paths.length);
    const plan = { schema: 1, paths: [], volumes: [], files: [], chains: [] };
    for (const candidate of paths) {
        const ancestry = ancestryIdentity(candidate),
            chain = [];
        assert(ancestry.length <= 32);
        for (const row of ancestry) {
            let index = plan.paths.indexOf(row.path);
            if (index < 0) {
                index = plan.paths.length;
                assert(index < 24, 'Fixed ancestor closure exceeds24; no expansion/retry.');
                assert(
                    row.path.length <= 4096 && /^\d+$/.test(row.dev) && /^[1-9]\d*$/.test(row.ino),
                );
                plan.paths.push(row.path);
                plan.volumes.push(row.dev);
                plan.files.push(row.ino);
            } else
                assert(
                    plan.volumes[index] === row.dev && plan.files[index] === row.ino,
                    'Ancestor rebound during planning.',
                );
            chain.push(index);
        }
        plan.chains.push(chain);
    }
    assert(Buffer.byteLength(JSON.stringify(plan)) <= 24576, 'Ownership plan JSON bound.');
    return plan;
}
/** Validate a native snapshot without turning a snapshot into directory authorization. */
export function parseOwnershipSnapshot(text, plan, expectedPrincipal) {
    assert(Buffer.byteLength(text) <= 32768, 'Native snapshot JSON bound.');
    const value = JSON.parse(text.replace(/^\uFEFF/, '')),
        uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff,
        sid = (v) => typeof v === 'string' && /^S-1-\d+(?:-\d+)+$/.test(v);
    const exact = (object, keys) => assert.deepEqual(Object.keys(object).sort(), keys.sort());
    exact(value, [
        'schema',
        'profile',
        'token',
        'nodes',
        'tokenProjectionComplete',
        'snapshotConsistent',
        'tokenRechecked',
        'pinsHeldDuringSnapshot',
        'handleClosureComplete',
        'directorySelected',
        'privatePathApproved',
        'admissionChanged',
        'protectionAfterReturn',
        'kernelWriteabilityDetermined',
        'accessScope',
        'decision',
        'errors',
        'errorCount',
    ]);
    assert.equal(value.schema, 1);
    assert.equal(value.profile, 'local-ntfs-common-dacl-snapshot-v1');
    assert.equal(
        value.accessScope,
        'AccessCheck MAXIMUM_ALLOWED with actual impersonation token; DACL snapshot, not full kernel or all-principal privacy proof',
    );
    assert.equal(
        value.decision,
        'indeterminate: explicit trust policy and continuing custody are required',
    );
    for (const key of [
        'directorySelected',
        'privatePathApproved',
        'admissionChanged',
        'protectionAfterReturn',
        'kernelWriteabilityDetermined',
    ])
        assert.equal(value[key], false);
    for (const key of [
        'tokenProjectionComplete',
        'snapshotConsistent',
        'tokenRechecked',
        'pinsHeldDuringSnapshot',
        'handleClosureComplete',
    ])
        assert.equal(typeof value[key], 'boolean');
    assert(Number.isInteger(value.errorCount) && value.errorCount >= 0);
    assert(
        Array.isArray(value.errors) &&
            value.errors.length <= 8 &&
            value.errorCount >= value.errors.length,
    );
    assert(value.errors.every((v) => typeof v === 'string' && v.length <= 256));
    assert(value.errorCount === value.errors.length || value.errors.length === 8);
    if (value.token !== null) {
        const token = value.token;
        exact(token, [
            'source',
            'user',
            'owner',
            'primaryGroup',
            'integrity',
            'defaultDaclSddl',
            'uiAccess',
            'virtualizationEnabled',
            'userAttributes',
            'tokenType',
            'impersonationLevel',
            'elevationType',
            'elevated',
            'mandatoryPolicy',
            'hasRestrictions',
            'isAppContainer',
            'groups',
            'restrictedSids',
            'relevantPrivileges',
            'unsupportedContextCounts',
        ]);
        if (token.unsupportedContextCounts !== null)
            assert(
                Array.isArray(token.unsupportedContextCounts) &&
                    token.unsupportedContextCounts.length === 4 &&
                    token.unsupportedContextCounts.every(uint),
            );
        assert(['thread', 'process'].includes(token.source));
        for (const key of ['user', 'owner', 'primaryGroup', 'integrity']) assert(sid(token[key]));
        assert(
            token.defaultDaclSddl === null ||
                (typeof token.defaultDaclSddl === 'string' &&
                    token.defaultDaclSddl.length <= 16384),
        );
        assert(uint(token.uiAccess) && uint(token.virtualizationEnabled));
        if (expectedPrincipal !== undefined) assert.equal(token.user, expectedPrincipal);
        for (const key of [
            'userAttributes',
            'tokenType',
            'impersonationLevel',
            'elevationType',
            'elevated',
            'mandatoryPolicy',
            'hasRestrictions',
            'isAppContainer',
        ])
            assert(uint(token[key]));
        for (const key of ['groups', 'restrictedSids']) {
            assert(Array.isArray(token[key]) && token[key].length <= 128);
            token[key].forEach((row) => {
                exact(row, ['sid', 'attributes']);
                assert(sid(row.sid) && uint(row.attributes));
            });
        }
        const names = [
            'SeBackupPrivilege',
            'SeRestorePrivilege',
            'SeTakeOwnershipPrivilege',
            'SeSecurityPrivilege',
            'SeChangeNotifyPrivilege',
        ];
        assert(
            Array.isArray(token.relevantPrivileges) &&
                token.relevantPrivileges.length === names.length,
        );
        token.relevantPrivileges.forEach((row, i) => {
            exact(row, ['name', 'present', 'attributes']);
            assert.equal(row.name, names[i]);
            assert.equal(typeof row.present, 'boolean');
            assert(uint(row.attributes));
        });
    }
    assert(Array.isArray(value.nodes) && value.nodes.length <= plan.paths.length);
    value.nodes.forEach((node, i) => {
        exact(node, [
            'path',
            'volume',
            'fileId',
            'fileSystem',
            'sddl',
            'daclPresent',
            'daclNull',
            'aces',
            'grantedMaximum',
            'accessCheckSucceeded',
            'accessStatus',
            'identityRechecked',
            'descriptorRechecked',
            'privilegesUsed',
            'unsupportedAceTypes',
            'unsupportedSaclTypes',
        ]);
        assert.equal(node.path, plan.paths[i]);
        assert.equal(node.volume, plan.volumes[i]);
        assert.equal(node.fileId, plan.files[i]);
        assert.equal(node.fileSystem, 'NTFS');
        assert(typeof node.sddl === 'string' && node.sddl.length > 0);
        for (const key of [
            'daclPresent',
            'daclNull',
            'accessCheckSucceeded',
            'accessStatus',
            'identityRechecked',
            'descriptorRechecked',
        ])
            assert.equal(typeof node[key], 'boolean');
        assert(uint(node.grantedMaximum));
        assert(
            Number.isInteger(node.privilegesUsed) &&
                node.privilegesUsed >= 0 &&
                node.privilegesUsed <= 64,
        );
        assert(Array.isArray(node.aces) && node.aces.length <= 128);
        for (const ace of node.aces) {
            exact(ace, ['type', 'flags', 'sid', 'mask']);
            assert(
                Number.isInteger(ace.type) &&
                    ace.type >= 0 &&
                    ace.type <= 255 &&
                    Number.isInteger(ace.flags) &&
                    ace.flags >= 0 &&
                    ace.flags <= 255,
            );
            assert(ace.sid === null || sid(ace.sid));
            assert(
                ace.mask === null ||
                    (Number.isInteger(ace.mask) &&
                        ace.mask >= -2147483648 &&
                        ace.mask <= 2147483647),
            );
        }
        assert(
            Array.isArray(node.unsupportedAceTypes) &&
                node.unsupportedAceTypes.length <= 128 &&
                node.unsupportedAceTypes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255),
        );
        assert(
            Array.isArray(node.unsupportedSaclTypes) &&
                node.unsupportedSaclTypes.length <= 128 &&
                node.unsupportedSaclTypes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255),
        );
        if (!node.accessStatus) assert.equal(node.grantedMaximum, 0);
    });
    if (value.errorCount === 0) {
        assert(
            value.tokenProjectionComplete &&
                value.token?.unsupportedContextCounts?.every((count) => count === 0),
        );
        assert(
            value.token &&
                value.token.isAppContainer === 0 &&
                value.token.virtualizationEnabled === 0 &&
                (value.token.tokenType === 1 ||
                    (value.token.tokenType === 2 && value.token.impersonationLevel >= 2)),
        );
        assert(
            value.snapshotConsistent &&
                value.tokenRechecked &&
                value.pinsHeldDuringSnapshot &&
                value.handleClosureComplete,
        );
        assert.equal(value.nodes.length, plan.paths.length);
        assert(
            value.nodes.every(
                (n) =>
                    n.accessCheckSucceeded &&
                    n.identityRechecked &&
                    n.descriptorRechecked &&
                    n.unsupportedAceTypes.length === 0 &&
                    n.unsupportedSaclTypes.length === 0,
            ),
        );
    }
    return value;
}
export function ownershipSnapshotSummary(value, plan) {
    const masks = {
        createFile: 2,
        createDirectory: 4,
        deleteChild: 64,
        delete: 65536,
        writeDacl: 262144,
        writeOwner: 524288,
    };
    return {
        snapshotComplete: value.errorCount === 0,
        tokenProjectionComplete: value.tokenProjectionComplete,
        directoryDecision: 'indeterminate: no approved trust policy or continuing handle custody',
        privatePathApproved: false,
        admissionChanged: false,
        protectionAfterReturn: false,
        nativeErrorCount: value.errorCount,
        candidates: plan.chains.map((chain) => ({
            leaf: plan.paths[chain[chain.length - 1]],
            ancestors: chain.map((index) => {
                const node = value.nodes[index];
                return {
                    path: plan.paths[index],
                    currentTokenDiscretionaryRights: !node?.accessCheckSucceeded
                        ? null
                        : Object.fromEntries(
                              Object.entries(masks).map(([key, mask]) => [
                                  key,
                                  (node.grantedMaximum & mask) === mask,
                              ]),
                          ),
                    allPrincipalPrivacyDetermined: false,
                };
            }),
        })),
    };
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
