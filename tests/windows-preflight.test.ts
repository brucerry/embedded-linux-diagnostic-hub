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
    existingOwnershipPaths,
    parseOwnershipContext,
    ownershipReviewSummary,
    ownershipSnapshotPlan,
    parseOwnershipSnapshot,
    ownershipSnapshotSummary,
    PreflightJournal,
    preflightLimits,
    writeReport,
    dependencyFacts,
} from '../scripts/lib/windows-preflight.mjs';
import {
    aclScript,
    ownershipContextScript,
    ownershipSnapshotScript,
    runPreflightCommand,
    parseAclObservation,
    productPreflight,
} from '../scripts/memory-product-preflight.mts';
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

// This models the documented pwsh -> Node -> WinPS inherited-module-path failure.
// It invokes the actual preflight command helper and actual unchanged ACL script; no PowerShell runs.
for (const moduleKeys of [
    ['PSModulePath'],
    ['PSMODULEPATH'],
    ['psmodulepath'],
    ['PSModulePath', 'PSMODULEPATH'],
])
    for (const paths of [['D:\\owned root'], ['D:\\owned root', 'C:\\Users\\runner\\Temp']])
        test(`WinPS command removes inherited ${moduleKeys.join('/')} for ${paths.length} ACL paths without changing parent or policy`, () => {
            const inherited = Object.freeze(
                    Object.fromEntries([
                        ...moduleKeys.map((key) => [
                            key,
                            'C:\\Program Files\\PowerShell\\7\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
                        ]),
                        ['Path', 'C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32'],
                        ['PSExecutionPolicyPreference', 'RemoteSigned'],
                        ['SystemRoot', 'C:\\Windows'],
                        ['USERPROFILE', 'C:\\Users\\runner'],
                    ]),
                ),
                extra = Object.freeze({ HUB_PREFLIGHT_PATHS: JSON.stringify(paths) }),
                exe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
            const value = {
                principal: 'S-1-5-21-1',
                rows: paths.map((path) => ({ path, owner: 'S-1-5-21-1', sddl: 'D:observed' })),
            };
            let calls = 0;
            const output = runPreflightCommand(exe, aclScript, extra, {
                windowsPowerShell: true,
                environment: inherited,
                timeout: 1500,
                spawn(actualExe, args, options) {
                    calls++;
                    assert.equal(actualExe, exe);
                    assert.deepEqual(args, [
                        '-NoProfile',
                        '-NonInteractive',
                        '-Command',
                        aclScript,
                    ]);
                    assert.equal(options.shell, false);
                    assert.equal(options.windowsHide, true);
                    assert.equal(options.encoding, 'utf8');
                    assert.equal(options.timeout, 1500);
                    assert.equal(options.maxBuffer, preflightLimits.commandBytes);
                    assert.equal(options.env.PSExecutionPolicyPreference, 'RemoteSigned');
                    assert.equal(options.env.Path, inherited.Path);
                    assert.equal(options.env.SystemRoot, inherited.SystemRoot);
                    assert.deepEqual(JSON.parse(options.env.HUB_PREFLIGHT_PATHS), paths);
                    if (
                        Object.keys(options.env).some((key) => key.toUpperCase() === 'PSMODULEPATH')
                    )
                        return {
                            status: 1,
                            signal: null,
                            stderr: 'Get-Acl: Microsoft.PowerShell.Security could not be loaded (modeled inherited PS7 module)',
                            stdout: '',
                        };
                    return { status: 0, signal: null, stderr: '', stdout: JSON.stringify(value) };
                },
            });
            assert.equal(calls, 1);
            assert.deepEqual(parseAclObservation(output, paths), value);
            assert.deepEqual(
                Object.keys(inherited).filter((key) => key.toUpperCase() === 'PSMODULEPATH'),
                moduleKeys,
            );
            assert.equal(extra.HUB_PREFLIGHT_PATHS, JSON.stringify(paths));
        });
test('WinPS environment omission also removes an extra override while preserving literal JSON path transport', () => {
    const paths = ["D:\\a b\\'quoted'\\$([never-run])`;[literal]"],
        extra = Object.freeze({
            HUB_PREFLIGHT_PATHS: JSON.stringify(paths),
            pSmOdUlEpAtH: 'C:\\PS7',
        });
    runPreflightCommand('absolute-WinPS', aclScript, extra, {
        windowsPowerShell: true,
        environment: {},
        spawn(exe, args, options) {
            assert.equal(exe, 'absolute-WinPS');
            assert.equal(args[3], aclScript);
            assert(!args[3].includes(paths[0]));
            assert.deepEqual(JSON.parse(options.env.HUB_PREFLIGHT_PATHS), paths);
            assert(!Object.keys(options.env).some((key) => key.toUpperCase() === 'PSMODULEPATH'));
            return { status: 0, signal: null, stdout: '{}', stderr: '' };
        },
    });
    assert.equal(extra.pSmOdUlEpAtH, 'C:\\PS7');
});
test('the separate PowerShell7 compile-only command retains its inherited module path and policy', () => {
    const environment = Object.freeze({
        PSModulePath: 'PS7-default-modules',
        PSExecutionPolicyPreference: 'AllSigned',
    });
    runPreflightCommand(
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'Add-Type -Path $env:HUB_PREFLIGHT_CS',
        { HUB_PREFLIGHT_CS: 'file.cs' },
        {
            environment,
            spawn(_exe, args, options) {
                assert.deepEqual(options.env, { ...environment, HUB_PREFLIGHT_CS: 'file.cs' });
                assert.equal(options.shell, false);
                assert(!args.includes('-ExecutionPolicy'));
                return { status: 0, signal: null, stdout: '{}', stderr: '' };
            },
        },
    );
});
for (const result of [
    {
        error: Object.assign(Error('real timeout'), { code: 'ETIMEDOUT' }),
        signal: null,
        status: null,
    },
    { signal: 'SIGTERM', status: null },
    { signal: null, status: 1, stderr: 'real module import failure' },
])
    test(`WinPS process failure ${result.error?.code ?? result.signal ?? result.status} remains a failed observation`, () => {
        assert.throws(() =>
            runPreflightCommand(
                'absolute-WinPS',
                aclScript,
                {},
                {
                    windowsPowerShell: true,
                    environment: {},
                    spawn: () => ({ stdout: 'untrusted partial result', ...result }),
                },
            ),
        );
    });

function ownershipFixture() {
    return {
        principal: 'S-1-5-21-1',
        tokenOwner: 'S-1-5-32-544',
        accessCheckPerformed: false,
        privatePathApproved: false,
        rows: [
            {
                path: 'D:\\observed',
                owner: 'S-1-5-32-544',
                ownerRoleEnabled: true,
                sddl: 'O:BAG:SYD:(A;;FA;;;BA)(A;CIID;DC;;;BU)(A;CIID;LC;;;BU)',
                daclPresent: true,
                daclNull: false,
                daclCanonical: true,
                aces: [
                    { type: 0, flags: 0, known: true, sid: 'S-1-5-32-544', mask: 0x1f01ff },
                    { type: 0, flags: 18, known: true, sid: 'S-1-5-32-545', mask: 2 },
                    { type: 0, flags: 18, known: true, sid: 'S-1-5-32-545', mask: 4 },
                ],
            },
        ],
    };
}
test('group-owner relation and actual Users add-file/add-directory masks are review leads, not a privacy verdict', () => {
    const value = parseOwnershipContext(
            JSON.stringify(ownershipFixture()),
            ['D:\\observed'],
            'S-1-5-21-1',
        ),
        review = ownershipReviewSummary(value),
        row = review.rows[0];
    assert.equal(row.ownerRelation, 'enabled-token-group');
    assert.equal(row.ownerMatchesTokenDefault, true);
    assert.deepEqual(
        row.potentialAllowWriters
            .filter((ace) => ace.sid === 'S-1-5-32-545')
            .map((ace) => ace.mask),
        [2, 4],
    );
    assert(row.potentialAllowWriters.every((ace) => ace.appliesToThisDirectory));
    assert.equal(review.accessCheckPerformed, false);
    assert.equal(review.privatePathApproved, false);
    assert.equal(review.admissionChanged, false);
    assert.equal(row.daclReviewRequired, true);
});
test('disabled/deny-only or unknown group relation is not equated with an enabled owner role', () => {
    const value = ownershipFixture();
    value.rows[0].ownerRoleEnabled = false;
    const review = ownershipReviewSummary(
        parseOwnershipContext(JSON.stringify(value), ['D:\\observed']),
    );
    assert.equal(review.rows[0].ownerRelation, 'unconfirmed-relation');
    assert.equal(review.privatePathApproved, false);
});
test('exact user ownership, null/absent DACL, deny order and unsupported ACEs cannot become private-path approval', () => {
    for (const mutate of [
        (v) => {
            v.rows[0].owner = v.principal;
        },
        (v) => {
            v.rows[0].daclNull = true;
            v.rows[0].aces = [];
        },
        (v) => {
            v.rows[0].daclPresent = false;
            v.rows[0].daclNull = true;
            v.rows[0].aces = [];
        },
        (v) => {
            v.rows[0].daclCanonical = false;
            v.rows[0].aces.unshift({ type: 1, flags: 0, known: true, mask: 2, sid: v.principal });
        },
        (v) => {
            v.rows[0].aces.push({ type: 9, flags: 0, known: true, mask: 2, sid: v.principal });
        },
        (v) => {
            v.rows[0].aces.push({ type: 255, flags: 0, known: false, mask: null, sid: null });
        },
    ]) {
        const value = ownershipFixture();
        mutate(value);
        const review = ownershipReviewSummary(
            parseOwnershipContext(JSON.stringify(value), ['D:\\observed']),
        );
        assert.equal(review.privatePathApproved, false);
        assert.equal(review.admissionChanged, false);
        assert.equal(review.accessCheckPerformed, false);
        assert.equal(review.rows[0].daclReviewRequired, true);
    }
});
test('inherit-only generic grants are distinguished from this-directory grants without treating them as harmless', () => {
    const value = ownershipFixture();
    value.rows[0].aces = [
        { type: 0, flags: 27, known: true, mask: 0x10000000, sid: 'S-1-3-0' },
        { type: 1, flags: 0, known: true, mask: 0x1f01ff, sid: value.principal },
    ];
    const review = ownershipReviewSummary(
        parseOwnershipContext(JSON.stringify(value), ['D:\\observed']),
    );
    assert.equal(review.rows[0].potentialAllowWriters.length, 1);
    assert.equal(review.rows[0].potentialAllowWriters[0].appliesToThisDirectory, false);
    assert.equal(review.rows[0].potentialAllowWriters[0].inheritOnly, true);
    assert.equal(review.privatePathApproved, false);
});
for (const [name, mutate] of [
    [
        'principal drift',
        (v) => {
            v.principal = 'S-1-5-21-2';
        },
    ],
    [
        'missing token owner',
        (v) => {
            delete v.tokenOwner;
        },
    ],
    [
        'wrong path',
        (v) => {
            v.rows[0].path = 'different';
        },
    ],
    [
        'missing row',
        (v) => {
            v.rows = [];
        },
    ],
    [
        'coerced membership',
        (v) => {
            v.rows[0].ownerRoleEnabled = 'true';
        },
    ],
    [
        'missing DACL status',
        (v) => {
            delete v.rows[0].daclPresent;
        },
    ],
    [
        'null DACL with entries',
        (v) => {
            v.rows[0].daclNull = true;
        },
    ],
    [
        'over-128 ACE list',
        (v) => {
            v.rows[0].aces = Array(129).fill(v.rows[0].aces[0]);
        },
    ],
    [
        'invalid ACE mask',
        (v) => {
            v.rows[0].aces[0].mask = 2 ** 32;
        },
    ],
    [
        'invalid ACE flags',
        (v) => {
            v.rows[0].aces[0].flags = 256;
        },
    ],
    [
        'unknown ACE pretending known data',
        (v) => {
            v.rows[0].aces[0].known = false;
        },
    ],
    [
        'invented AccessCheck',
        (v) => {
            v.accessCheckPerformed = true;
        },
    ],
    [
        'invented private approval',
        (v) => {
            v.privatePathApproved = true;
        },
    ],
])
    test(`ownership diagnostic rejects ${name}`, () => {
        const value = ownershipFixture();
        mutate(value);
        assert.throws(() =>
            parseOwnershipContext(JSON.stringify(value), ['D:\\observed'], 'S-1-5-21-1'),
        );
    });
test('ownership context preserves single/multiple rows, rejects reorder/duplicate expectations and legacy insufficient facts', () => {
    const value = ownershipFixture();
    value.rows.push({ ...structuredClone(value.rows[0]), path: 'C:\\Temp' });
    assert.equal(
        parseOwnershipContext(JSON.stringify(value), ['D:\\observed', 'C:\\Temp']).rows.length,
        2,
    );
    assert.throws(() => parseOwnershipContext(JSON.stringify(value), ['C:\\Temp', 'D:\\observed']));
    assert.throws(() =>
        parseOwnershipContext(JSON.stringify(value), ['D:\\observed', 'D:\\observed']),
    );
    assert.throws(() =>
        parseOwnershipContext(
            JSON.stringify({
                principal: value.principal,
                rows: [{ path: 'D:\\observed', owner: 'S-1-5-32-544', sddl: value.rows[0].sddl }],
            }),
            ['D:\\observed'],
        ),
    );
});
test('fixed existing-directory inventory reads physical paths, deduplicates and never creates/selects a missing alternative', () => {
    const root = scratch(),
        out = path.join(root, 'out'),
        local = path.join(root, 'local');
    fs.mkdirSync(out);
    fs.mkdirSync(local);
    fs.mkdirSync(path.join(local, 'Temp'));
    try {
        const before = fs.readdirSync(root).sort(),
            marker = path.join(root, 'sentinel');
        fs.writeFileSync(marker, 'unchanged');
        const env = Object.freeze({
            RUNNER_TEMP: root,
            LOCALAPPDATA: local,
            USERPROFILE: path.join(root, 'missing'),
        });
        const result = existingOwnershipPaths(out, root, env);
        assert.deepEqual(result.paths, [out, root, path.join(local, 'Temp')]);
        assert.equal(result.rows.length, 5);
        assert.equal(result.rows[4].status, 'unavailable');
        assert.equal(result.directorySelected, false);
        assert.equal(result.settingsChanged, false);
        assert(!fs.existsSync(env.USERPROFILE));
        assert.equal(fs.readFileSync(marker, 'utf8'), 'unchanged');
        fs.unlinkSync(marker);
        assert.deepEqual(fs.readdirSync(root).sort(), before);
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('directory inventory reports aliases, non-directory, relative, malformed and over-bound candidates unavailable', () => {
    const root = scratch(),
        file = path.join(root, 'file'),
        alias = path.join(root, 'alias');
    fs.writeFileSync(file, 'x');
    fs.symlinkSync(root, alias);
    try {
        for (const candidate of [
            alias,
            file,
            'relative',
            null,
            '',
            'x'.repeat(4097),
            root + '\0bad',
        ]) {
            const result = existingOwnershipPaths(root, root, { RUNNER_TEMP: candidate });
            assert.equal(result.rows[2].status, 'unavailable');
            assert.equal(result.directorySelected, false);
            assert.deepEqual(result.paths, [root]);
        }
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('actual command helper transports fixed read-only ownership script with bounded literal path JSON and child module isolation', () => {
    const value = ownershipFixture();
    const output = runPreflightCommand(
        'absolute-WinPS',
        ownershipContextScript,
        { HUB_PREFLIGHT_PATHS: JSON.stringify(['D:\\observed']) },
        {
            windowsPowerShell: true,
            environment: { PSModulePath: 'PS7-paths', PSExecutionPolicyPreference: 'AllSigned' },
            spawn(exe, args, options) {
                assert.equal(exe, 'absolute-WinPS');
                assert.equal(args[3], ownershipContextScript);
                assert.equal(options.shell, false);
                assert.equal(options.timeout, preflightLimits.commandMs);
                assert.equal(options.maxBuffer, preflightLimits.commandBytes);
                assert.equal(options.env.PSExecutionPolicyPreference, 'AllSigned');
                assert(!Object.hasOwn(options.env, 'PSModulePath'));
                assert.deepEqual(JSON.parse(options.env.HUB_PREFLIGHT_PATHS), ['D:\\observed']);
                return { status: 0, signal: null, stdout: JSON.stringify(value), stderr: '' };
            },
        },
    );
    assert.equal(
        ownershipReviewSummary(parseOwnershipContext(output, ['D:\\observed'])).privatePathApproved,
        false,
    );
});
test('ownership diagnostics reject absent DACL with conflicting entries', () => {
    const value = ownershipFixture();
    value.rows[0].daclPresent = false;
    assert.throws(() => parseOwnershipContext(JSON.stringify(value), ['D:\\observed']));
});
test('ownership diagnostics reject oversized JSON before parsing', () => {
    assert.throws(
        () => parseOwnershipContext(' '.repeat(preflightLimits.commandBytes + 1), ['D:\\observed']),
        /Ownership JSON bound/,
    );
});
test('over-depth existing-directory candidates remain unavailable without creation', () => {
    const root = scratch();
    try {
        const deep = path.join(root, ...Array(34).fill('missing'));
        const result = existingOwnershipPaths(root, root, { RUNNER_TEMP: deep });
        assert.equal(result.rows[2].status, 'unavailable');
        assert.match(result.rows[2].error, /ancestry bound/);
        assert(!fs.existsSync(path.join(root, 'missing')));
        assert.equal(result.directorySelected, false);
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

// Native fixtures verify the JS contract, not Windows interop or AccessCheck semantics.
const snapshotFixture = () => {
    const sid = 'S-1-5-21-100-200-300-500';
    const plan = {
        schema: 1,
        paths: ['C:\\', 'C:\\Temp'],
        volumes: ['123', '123'],
        files: ['1', '2'],
        chains: [[0, 1]],
    };
    const value = {
        schema: 1,
        profile: 'local-ntfs-common-dacl-snapshot-v1',
        token: {
            source: 'process',
            user: sid,
            owner: 'S-1-5-32-544',
            primaryGroup: 'S-1-5-21-100-200-300-513',
            integrity: 'S-1-16-12288',
            defaultDaclSddl: 'D:(A;;FA;;;BA)',
            userAttributes: 0,
            tokenType: 1,
            impersonationLevel: 0,
            elevationType: 2,
            elevated: 1,
            mandatoryPolicy: 1,
            hasRestrictions: 1,
            isAppContainer: 0,
            uiAccess: 0,
            virtualizationEnabled: 0,
            groups: [
                { sid: 'S-1-5-32-544', attributes: 7 },
                { sid: 'S-1-5-32-545', attributes: 16 },
            ],
            restrictedSids: [{ sid: 'S-1-5-12', attributes: 7 }],
            relevantPrivileges: [
                'SeBackupPrivilege',
                'SeRestorePrivilege',
                'SeTakeOwnershipPrivilege',
                'SeSecurityPrivilege',
                'SeChangeNotifyPrivilege',
            ].map((name) => ({ name, present: true, attributes: 2 })),
            unsupportedContextCounts: [0, 0, 0, 0],
        },
        nodes: plan.paths.map((path, i) => ({
            path,
            volume: plan.volumes[i],
            fileId: plan.files[i],
            fileSystem: 'NTFS',
            sddl: 'O:BAG:BAD:(A;;FA;;;BA)',
            daclPresent: true,
            daclNull: false,
            aces: [{ type: 0, flags: 0, sid: 'S-1-5-32-544', mask: 2032127 }],
            grantedMaximum: 2032127,
            accessCheckSucceeded: true,
            accessStatus: true,
            identityRechecked: true,
            descriptorRechecked: true,
            privilegesUsed: 0,
            unsupportedAceTypes: [],
            unsupportedSaclTypes: [],
        })),
        tokenProjectionComplete: true,
        snapshotConsistent: true,
        tokenRechecked: true,
        pinsHeldDuringSnapshot: true,
        handleClosureComplete: true,
        errorCount: 0,
        errors: [],
        directorySelected: false,
        privatePathApproved: false,
        admissionChanged: false,
        protectionAfterReturn: false,
        kernelWriteabilityDetermined: false,
        accessScope:
            'AccessCheck MAXIMUM_ALLOWED with actual impersonation token; DACL snapshot, not full kernel or all-principal privacy proof',
        decision: 'indeterminate: explicit trust policy and continuing custody are required',
    };
    return { sid, plan, value };
};
test('snapshot keeps deny-only/enabled/restricted attributes and five privilege states without approving any directory', () => {
    const { sid, plan, value } = snapshotFixture();
    const parsed = parseOwnershipSnapshot(JSON.stringify(value), plan, sid),
        summary = ownershipSnapshotSummary(parsed, plan);
    assert.deepEqual(
        parsed.token.groups.map((r) => r.attributes),
        [7, 16],
    );
    assert.equal(parsed.token.restrictedSids.length, 1);
    assert.equal(parsed.token.relevantPrivileges.length, 5);
    assert.equal(summary.snapshotComplete, true);
    assert.equal(summary.privatePathApproved, false);
    assert.equal(summary.admissionChanged, false);
    assert.equal(summary.protectionAfterReturn, false);
    assert.match(summary.directoryDecision, /indeterminate/);
    assert.equal(summary.candidates[0].ancestors.length, 2);
    assert(summary.candidates[0].ancestors.every((r) => r.allPrincipalPrivacyDetermined === false));
});
for (const field of [
    'directorySelected',
    'privatePathApproved',
    'admissionChanged',
    'protectionAfterReturn',
    'kernelWriteabilityDetermined',
])
    test(`snapshot rejects forged ${field}`, () => {
        const { sid, plan, value } = snapshotFixture();
        value[field] = true;
        assert.throws(() => parseOwnershipSnapshot(JSON.stringify(value), plan, sid));
    });
for (const field of [
    'tokenProjectionComplete',
    'snapshotConsistent',
    'tokenRechecked',
    'pinsHeldDuringSnapshot',
    'handleClosureComplete',
])
    test(`zero-error snapshot requires ${field}`, () => {
        const { sid, plan, value } = snapshotFixture();
        value[field] = false;
        assert.throws(() => parseOwnershipSnapshot(JSON.stringify(value), plan, sid));
    });
for (const mutate of [
    (v) => v.nodes.pop(),
    (v) => (v.nodes[0].path = 'C:\\Other'),
    (v) => (v.nodes[0].fileId = '99'),
    (v) => (v.nodes[0].volume = '99'),
    (v) => (v.nodes[0].fileSystem = 'ReFS'),
    (v) => (v.nodes[0].unsupportedAceTypes = [5]),
    (v) => (v.nodes[0].unsupportedSaclTypes = [18]),
    (v) => (v.token.unsupportedContextCounts[0] = 1),
    (v) => (v.token.isAppContainer = 1),
    (v) => (v.token.virtualizationEnabled = 1),
    (v) => (v.token.tokenType = 2),
])
    test('snapshot rejects incomplete or unsupported claimed-complete state', () => {
        const { sid, plan, value } = snapshotFixture();
        mutate(value);
        assert.throws(() => parseOwnershipSnapshot(JSON.stringify(value), plan, sid));
    });
for (const place of ['root', 'token', 'group', 'node', 'ace'])
    test(`snapshot refuses extra ${place} fields rather than serialize handles or arbitrary context`, () => {
        const { sid, plan, value } = snapshotFixture();
        const obj = {
            root: value,
            token: value.token,
            group: value.token.groups[0],
            node: value.nodes[0],
            ace: value.nodes[0].aces[0],
        }[place];
        obj.handle = 123;
        assert.throws(() => parseOwnershipSnapshot(JSON.stringify(value), plan, sid));
    });
test('native API failure is unknown rights; successful AccessCheck denial is a distinct result', () => {
    const { sid, plan, value } = snapshotFixture();
    value.errorCount = 1;
    value.errors = ['AccessCheck API failure'];
    value.snapshotConsistent = false;
    value.nodes[1].accessCheckSucceeded = false;
    value.nodes[1].accessStatus = false;
    value.nodes[1].grantedMaximum = 0;
    let summary = ownershipSnapshotSummary(
        parseOwnershipSnapshot(JSON.stringify(value), plan, sid),
        plan,
    );
    assert.equal(summary.snapshotComplete, false);
    assert.equal(summary.candidates[0].ancestors[1].currentTokenDiscretionaryRights, null);
    value.nodes[1].accessCheckSucceeded = true;
    summary = ownershipSnapshotSummary(
        parseOwnershipSnapshot(JSON.stringify(value), plan, sid),
        plan,
    );
    assert(
        Object.values(summary.candidates[0].ancestors[1].currentTokenDiscretionaryRights).every(
            (v) => v === false,
        ),
    );
});
for (const failure of [
    'API buffer failure',
    'sharing violation',
    'descriptor drift',
    'token drift',
    'handle close unconfirmed',
])
    test(`partial ${failure} remains indeterminate without retry or admission`, () => {
        const { sid, plan, value } = snapshotFixture();
        value.errorCount = 1;
        value.errors = [failure];
        value.snapshotConsistent = false;
        value.handleClosureComplete = false;
        value.nodes = [];
        const summary = ownershipSnapshotSummary(
            parseOwnershipSnapshot(JSON.stringify(value), plan, sid),
            plan,
        );
        assert.equal(summary.snapshotComplete, false);
        assert.equal(summary.privatePathApproved, false);
        assert(
            summary.candidates[0].ancestors.every(
                (r) => r.currentTokenDiscretionaryRights === null,
            ),
        );
    });
for (const mutate of [
    (v) => (v.token.groups = Array(129).fill(v.token.groups[0])),
    (v) => (v.nodes[0].aces = Array(129).fill(v.nodes[0].aces[0])),
    (v) => (v.errors = Array(9).fill('error')),
    (v) => (v.errors = ['x'.repeat(257)]),
    (v) => v.token.relevantPrivileges.push({ name: 'extra', present: true, attributes: 2 }),
    (v) => (v.token.unsupportedContextCounts = [0]),
    (v) => (v.token.groups[0].attributes = -1),
    (v) => (v.nodes[0].grantedMaximum = 2 ** 32),
    (v) => (v.decision = 'approved'),
    (v) => (v.accessScope = 'full kernel access'),
])
    test('snapshot enforces exact bounded projection', () => {
        const { sid, plan, value } = snapshotFixture();
        mutate(value);
        assert.throws(() => parseOwnershipSnapshot(JSON.stringify(value), plan, sid));
    });
test('snapshot refuses mismatched calling principal and over-bound JSON', () => {
    const { sid, plan, value } = snapshotFixture();
    assert.throws(() => parseOwnershipSnapshot(JSON.stringify(value), plan, 'S-1-5-99'));
    assert.throws(() => parseOwnershipSnapshot(' '.repeat(32769), plan, sid));
});
test('fixed plan deduplicates real root-first ancestry without filesystem writes', () => {
    const root = scratch();
    try {
        const leaf = path.join(root, 'child');
        fs.mkdirSync(leaf);
        const before = fs.readdirSync(root);
        const plan = ownershipSnapshotPlan([root, leaf]);
        assert.deepEqual(fs.readdirSync(root), before);
        assert.equal(new Set(plan.paths).size, plan.paths.length);
        assert.deepEqual(
            plan.paths,
            ancestryIdentity(leaf).map((r) => r.path),
        );
        assert(plan.chains[1].every((v, i) => v === i));
        assert.equal(plan.paths.length, plan.volumes.length);
        assert.equal(plan.paths.length, plan.files.length);
        assert.throws(() => ownershipSnapshotPlan([]));
        assert.throws(() => ownershipSnapshotPlan([root, root]));
        assert.throws(() => ownershipSnapshotPlan(Array(6).fill(root)));
        const link = path.join(root, 'alias');
        fs.symlinkSync(leaf, link);
        assert.throws(() => ownershipSnapshotPlan([link]));
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('fixed plan refuses excessive ancestor closure instead of expanding or retrying', () => {
    const root = scratch();
    try {
        const leaf = path.join(root, ...Array.from({ length: 18 }, (_, i) => 'd' + i));
        fs.mkdirSync(leaf, { recursive: true });
        assert.throws(() => ownershipSnapshotPlan([leaf]), /closure exceeds24/);
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});
test('native observer source declares bounded read-only calls and one-shot projection; not native qualification', () => {
    const source = fs.readFileSync(
        new URL('../scripts/lib/windows-ownership-snapshot.cs', import.meta.url),
        'utf8',
    );
    assert.match(source, /MaxNodes = 24, MaxGroups = 128, MaxPrivileges = 64, MaxBuffer = 16384/);
    assert.match(source, /CreateFileW\([^\n]+0x20080,3,IntPtr.Zero,3,0x02200000/);
    assert.match(source, /GetSecurityInfo\(handle,1,0x77/);
    assert.match(source, /AccessCheck\(memory,duplicate,0x02000000/);
    assert.match(source, /Modified\(token\)==modified/);
    assert.match(source, /Directory handle close unconfirmed/);
    assert.match(source, /int\[\] kinds=\{33,34,37,38\}/);
    assert.doesNotMatch(source, /TokenValue\(duplicate,/);
    assert.doesNotMatch(
        source,
        /extern (?:bool|uint|IntPtr) (?:Set|Adjust|Impersonate|CreateProcess|ReadFile|WriteFile)/,
    );
    assert.match(ownershipSnapshotScript, /Add-Type -Path \$env:HUB_PREFLIGHT_OWNER_CS/);
    assert.match(ownershipSnapshotScript, /Observer\]::Inspect/);
    assert.match(ownershipSnapshotScript, /32768/);
    assert.doesNotMatch(ownershipSnapshotScript, /Set-Acl|Start-Process|while|Invoke-Expression/);
    const production = fs.readFileSync(
        new URL('../scripts/memory-product-preflight.mts', import.meta.url),
        'utf8',
    );
    assert.equal((production.match(/await step\('ownership-snapshot'/g) || []).length, 1);
    assert.doesNotMatch(production, /await step\('ownership-context'/);
});
test('actual command boundary carries one fixed snapshot plan/source and never invokes the native API in this fixture', () => {
    const { sid, plan, value } = snapshotFixture();
    let calls = 0;
    const output = runPreflightCommand(
        'absolute-WinPS',
        ownershipSnapshotScript,
        {
            HUB_PREFLIGHT_OWNER_CS: 'C:\\repo\\scripts\\lib\\windows-ownership-snapshot.cs',
            HUB_PREFLIGHT_OWNER_PLAN: JSON.stringify(plan),
        },
        {
            windowsPowerShell: true,
            environment: { PSModulePath: 'PS7', PSExecutionPolicyPreference: 'AllSigned' },
            spawn(exe, args, options) {
                calls++;
                assert.equal(exe, 'absolute-WinPS');
                assert.equal(args[3], ownershipSnapshotScript);
                assert.deepEqual(JSON.parse(options.env.HUB_PREFLIGHT_OWNER_PLAN), plan);
                assert.equal(
                    options.env.HUB_PREFLIGHT_OWNER_CS,
                    'C:\\repo\\scripts\\lib\\windows-ownership-snapshot.cs',
                );
                assert(!Object.hasOwn(options.env, 'PSModulePath'));
                assert.equal(options.env.PSExecutionPolicyPreference, 'AllSigned');
                assert.equal(options.timeout, preflightLimits.commandMs);
                assert.equal(options.maxBuffer, preflightLimits.commandBytes);
                assert.equal(options.shell, false);
                return { status: 0, signal: null, stdout: JSON.stringify(value), stderr: '' };
            },
        },
    );
    assert.equal(calls, 1);
    assert.equal(
        ownershipSnapshotSummary(parseOwnershipSnapshot(output, plan, sid), plan)
            .privatePathApproved,
        false,
    );
});
test('early native failure may return no token or nodes but cannot claim complete projection', () => {
    const { sid, plan, value } = snapshotFixture();
    Object.assign(value, {
        token: null,
        nodes: [],
        tokenProjectionComplete: false,
        snapshotConsistent: false,
        tokenRechecked: false,
        pinsHeldDuringSnapshot: false,
        errorCount: 1,
        errors: ['Token API unavailable; no retry'],
    });
    const parsed = parseOwnershipSnapshot(JSON.stringify(value), plan, sid);
    assert.equal(ownershipSnapshotSummary(parsed, plan).snapshotComplete, false);
    value.errorCount = 0;
    value.errors = [];
    assert.throws(() => parseOwnershipSnapshot(JSON.stringify(value), plan, sid));
});
