// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sourceFingerprint } from './fixtures/memory-resource-identity';
import {
    existingOwnershipPaths,
    PreflightJournal,
    writeReport,
} from '../scripts/lib/windows-preflight.mjs';
import {
    directoryFactsScope,
    directoryCandidateLabels,
    parseDirectoryDescriptorReport,
    directoryEvidence,
} from '../scripts/lib/directory-security-facts.mjs';
import {
    observeDirectoryFacts,
    runPreflightCommand,
    directoryFactsScript,
    directoryFactsInput,
    recordJournalClosure,
} from '../scripts/memory-product-preflight.mts';
const ace = (type = 127, flags = 17) => {
    const b = Buffer.from([type, flags, 8, 0, 0xaa, 0xbb, 0xcc, 0xdd]);
    return { type, flags, binary: b.toString('base64') };
};
function descriptor(literal, state = 'nonempty') {
    const absent = state === 'absent',
        nil = absent || state === 'null',
        entries = state === 'nonempty' ? [ace()] : nil ? null : [];
    return {
        path: literal,
        availability: 'observed',
        owner: 'S-1-5-32-544',
        group: 'S-1-5-21-1-513',
        sddl: absent
            ? 'O:BAG:BA'
            : state === 'null'
              ? 'O:BAG:BAD:NO_ACCESS_CONTROL'
              : state === 'empty'
                ? 'O:BAG:BAD:'
                : 'O:BAG:BAD:(XA;;GA;;;WD;(@User.X == "opaque S:()"))',
        descriptorBytes: 96,
        daclPresent: !absent,
        daclNull: nil,
        daclState: state,
        aceCount: nil ? null : entries.length,
        aces: entries,
        error: null,
    };
}
function response(paths, state = 'nonempty') {
    const rows = paths.map((p) => descriptor(p, state));
    return {
        ...directoryFactsScope,
        complete: true,
        descriptorBytes: rows.reduce((n, r) => n + r.descriptorBytes, 0),
        descriptorUtf8Bytes: rows.reduce((n, r) => n + Buffer.byteLength(r.sddl), 0),
        rows,
        stoppedAt: null,
        error: null,
    };
}
const unavailable = (literal) => ({
    path: literal,
    availability: 'unavailable',
    owner: null,
    group: null,
    sddl: null,
    descriptorBytes: null,
    daclPresent: null,
    daclNull: null,
    daclState: 'unavailable',
    aceCount: null,
    aces: null,
    error: 'UnauthorizedAccessException: access denied',
});
function recalc(r) {
    r.descriptorBytes = r.rows.reduce((n, x) => n + (x.descriptorBytes ?? 0), 0);
    r.descriptorUtf8Bytes = r.rows.reduce(
        (n, x) => n + (x.sddl ? Buffer.byteLength(x.sddl) : 0),
        0,
    );
    return r;
}
for (const state of ['absent', 'null', 'empty', 'nonempty'])
    test(`directory report preserves ${state} DACL without an access conclusion`, () => {
        const r = response(['C:\\literal'], state),
            parsed = parseDirectoryDescriptorReport(JSON.stringify(r), ['C:\\literal']);
        assert.equal(parsed.rows[0].daclState, state);
        assert.equal(parsed.tokenContext, 'not-collected');
        assert.equal(parsed.effectiveAccess, 'not-evaluated');
        assert.equal(parsed.sacl, 'not-requested');
        assert.equal(parsed.cap, 'not-requested');
        assert.equal(parsed.atomicCustody, false);
        assert.equal(parsed.privatePathApproved, false);
        assert(!Object.hasOwn(parsed, 'token'));
        assert(!Object.hasOwn(parsed, 'accessCheckSucceeded'));
    });
test('unknown/conditional opaque data and order are returned byte-exact without masks or interpretation', () => {
    const r = response(['C:\\literal']);
    r.rows[0].aces = [ace(127), ace(9), ace(5)];
    r.rows[0].aceCount = 3;
    const p = parseDirectoryDescriptorReport(JSON.stringify(r), ['C:\\literal']);
    assert.deepEqual(p.rows[0].aces, r.rows[0].aces);
    assert.equal(p.rows[0].sddl, r.rows[0].sddl);
    assert(p.rows[0].aces.every((x) => !Object.hasOwn(x, 'mask')));
});
test('partial inaccessible row remains unknown rather than empty, retaining completed prefix', () => {
    const r = response(['C:\\one', 'C:\\two']);
    r.complete = false;
    r.rows[1] = unavailable('C:\\two');
    r.stoppedAt = 1;
    r.error = r.rows[1].error;
    recalc(r);
    const p = parseDirectoryDescriptorReport(JSON.stringify(r), ['C:\\one', 'C:\\two']);
    assert.equal(p.rows[0].availability, 'observed');
    assert.equal(p.rows[1].aceCount, null);
    assert.equal(p.rows[1].aces, null);
    assert.equal(p.rows[1].daclState, 'unavailable');
});
for (const [name, mutate] of [
    [
        'old schema',
        (r) => {
            r.schema = 2;
        },
    ],
    [
        'old profile',
        (r) => {
            r.profile = 'local-ntfs-reduced-token-snapshot-v2';
        },
    ],
    [
        'fake token absence',
        (r) => {
            r.tokenContext = 'empty';
        },
    ],
    [
        'fake effective access',
        (r) => {
            r.effectiveAccess = 'evaluated';
        },
    ],
    [
        'SACL claim',
        (r) => {
            r.sacl = 'absent';
        },
    ],
    [
        'CAP claim',
        (r) => {
            r.cap = 'empty';
        },
    ],
    [
        'custody claim',
        (r) => {
            r.atomicCustody = true;
        },
    ],
    [
        'permission approval',
        (r) => {
            r.privatePathApproved = true;
        },
    ],
    [
        'unexpected rights',
        (r) => {
            r.grantedMaximum = 0;
        },
    ],
    [
        'missing row',
        (r) => {
            r.rows = [];
        },
    ],
    [
        'unplanned row',
        (r) => {
            r.rows[0].path = 'C:\\other';
        },
    ],
    [
        'malformed SDDL',
        (r) => {
            r.rows[0].sddl = 'malformed';
            recalc(r);
        },
    ],
    [
        'descriptor bound',
        (r) => {
            r.rows[0].descriptorBytes = 16385;
            recalc(r);
        },
    ],
    [
        'raw descriptor truncation',
        (r) => {
            r.rows[0].descriptorBytes = 4;
            recalc(r);
        },
    ],
    [
        'SDDL bound',
        (r) => {
            r.rows[0].sddl = 'O:BAG:BAD:' + 'x'.repeat(16385);
            recalc(r);
        },
    ],
    [
        'null-as-empty',
        (r) => {
            r.rows[0].daclState = 'null';
        },
    ],
    [
        'absent-as-empty',
        (r) => {
            r.rows[0].daclPresent = false;
        },
    ],
    [
        'ACE overflow',
        (r) => {
            r.rows[0].aceCount = 129;
        },
    ],
    [
        'opaque nonbase64',
        (r) => {
            r.rows[0].aces[0].binary = '!';
        },
    ],
    [
        'opaque header mismatch',
        (r) => {
            r.rows[0].aces[0].type = 1;
        },
    ],
    [
        'opaque size mismatch',
        (r) => {
            r.rows[0].aces[0].binary = Buffer.from([127, 17, 40, 0]).toString('base64');
        },
    ],
    [
        'dropped opaque ACE',
        (r) => {
            r.rows[0].aces = [];
        },
    ],
    [
        'unknown ACE fields',
        (r) => {
            r.rows[0].aces[0].mask = 0;
        },
    ],
    [
        'conversion-as-empty',
        (r) => {
            r.rows[0].availability = 'unavailable';
            r.rows[0].error = null;
        },
    ],
    [
        'wrong aggregate',
        (r) => {
            r.descriptorBytes = 0;
        },
    ],
    [
        'wrong text aggregate',
        (r) => {
            r.descriptorUtf8Bytes = 0;
        },
    ],
])
    test(`directory parser rejects ${name}`, () => {
        const r = response(['C:\\literal']);
        mutate(r);
        assert.throws(() => parseDirectoryDescriptorReport(JSON.stringify(r), ['C:\\literal']));
    });
test('directory parser enforces aggregate/serialized/row bounds without alternate decoding', () => {
    const paths = Array.from({ length: 25 }, (_, i) => 'C:\\' + i);
    assert.throws(() => parseDirectoryDescriptorReport(JSON.stringify(response(paths)), paths));
    assert.throws(() => parseDirectoryDescriptorReport(' '.repeat(32769), ['C:\\literal']));
    const r = response(['C:\\one', 'C:\\two', 'C:\\three']);
    for (const row of r.rows) row.descriptorBytes = 16384;
    recalc(r);
    assert.throws(() =>
        parseDirectoryDescriptorReport(
            JSON.stringify(r),
            r.rows.map((x) => x.path),
        ),
    );
});
test('combined evidence bound omits whole descriptor records explicitly, retaining identities without claiming completeness', () => {
    const plan = {
        paths: ['C:\\one', 'C:\\two'],
        labels: directoryCandidateLabels.map((name) => ({
            name,
            availability: 'observed',
            pathIndex: 0,
        })),
    };
    const before = [
        { dev: '1', ino: '1' },
        { dev: '1', ino: '2' },
    ];
    const r = response(plan.paths);
    for (const row of r.rows) row.sddl = 'O:BAG:BAD:' + 'x'.repeat(16370);
    const evidence = directoryEvidence({
        sourceSHA256: 'a'.repeat(64),
        plan,
        before,
        after: before,
        response: r,
        failures: [],
    });
    assert.equal(evidence.complete, false);
    assert.equal(evidence.descriptorAvailability, 'omitted-by-bound');
    assert(evidence.rows.every((x) => x.descriptor === null && x.before && x.after));
    assert(Buffer.byteLength(JSON.stringify(evidence)) <= 32768);
});
// Actual orchestration/command boundary and real identities, journal durability and report writes.
// Injected spawn only: no Get-Acl, PowerShell, C#orWindows API executes in these controls.
async function exercise(options = {}) {
    const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-directory-control-')),
        root = path.join(temp, 'source [literal] $value'),
        output = path.join(temp, 'Temp'),
        other = path.join(temp, 'AppData/Local/Temp');
    fs.mkdirSync(root);
    fs.mkdirSync(output);
    fs.mkdirSync(other, { recursive: true });
    const source = path.join(root, directoryFactsInput.path);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.copyFileSync(new URL('../scripts/lib/windows-directory-facts.ps1', import.meta.url), source);
    const powershell = path.join(temp, 'powershell.exe'),
        pe = Buffer.alloc(128);
    pe.write('MZ');
    pe.writeUInt32LE(64, 60);
    pe.writeUInt32LE(0x4550, 64);
    pe.writeUInt16LE(34404, 68);
    fs.writeFileSync(powershell, pe);
    const candidates = existingOwnershipPaths(output, output, {
        RUNNER_TEMP: output,
        LOCALAPPDATA: temp,
        USERPROFILE: temp,
    });
    options.candidates?.(candidates);
    let sha = await sourceFingerprint(root);
    options.before?.({ root, source, other, powershell });
    if (options.rehash) sha = await sourceFingerprint(root);
    const journal = new PreflightJournal(output),
        report = { observations: [], failures: [], status: null },
        calls = [];
    let io = 0,
        cancelled = Boolean(options.cancelBefore),
        remaining = options.remaining ?? 10000;
    const admit = () => {
        assert(!cancelled, 'Model cancellation');
        assert(remaining > 0, 'Model deadline exhausted');
    };
    const observe = (name, data) => {
        report.observations.push({ name, data });
        journal.append(name, data);
        return data;
    };
    const step = async (name, work) => {
        admit();
        try {
            return observe(name, await work());
        } catch (error) {
            observe(name, {
                status: 'blocked-or-unavailable',
                error: String(error).slice(0, 4096),
            });
            report.failures.push(String(error));
            return null;
        }
    };
    const command = (exe, script, extra) => {
        admit();
        const stdout = runPreflightCommand(exe, script, extra, {
            windowsPowerShell: true,
            environment: {
                PSModulePath: 'PS7',
                psmodulepath: 'PS7again',
                PSExecutionPolicyPreference: 'AllSigned',
            },
            timeout: Math.min(10000, remaining),
            spawn(actualExe, args, settings) {
                calls.push({ exe: actualExe, args, settings });
                const paths = JSON.parse(settings.env.HUB_PREFLIGHT_DIRECTORY_PATHS),
                    r = response(paths);
                options.mutate?.(r);
                options.during?.({ root, source, other, powershell });
                if (options.cancelAfter) cancelled = true;
                if (options.expireAfter) remaining = 0;
                return {
                    status: 0,
                    signal: null,
                    stdout: options.stdout ?? JSON.stringify(r),
                    stderr: '',
                    ...options.process,
                };
            },
        });
        assert(!cancelled, 'Model cancelled after command');
        return stdout;
    };
    try {
        await observeDirectoryFacts({
            root,
            powershell,
            sourceSHA256: options.sourceSHA === undefined ? sha : options.sourceSHA,
            candidates,
            command,
            step,
            admit,
        });
        io++;
        report.status = 'MODEL_CONTINUATION';
    } catch (error) {
        report.status = 'BLOCKED_PREFLIGHT';
        report.failures.push(String(error));
    } finally {
        const sync = fs.fsyncSync,
            close = fs.closeSync;
        try {
            if (options.cleanup === 'sync')
                fs.fsyncSync = (fd) => {
                    if (fd === journal.fd) throw Error('Injected journal sync failure');
                    return sync(fd);
                };
            if (options.cleanup === 'close')
                fs.closeSync = (fd) => {
                    if (fd === journal.fd) {
                        close(fd);
                        throw Error('Injected unconfirmed journal close');
                    }
                    return close(fd);
                };
            recordJournalClosure(report, journal.close());
        } finally {
            fs.fsyncSync = sync;
            fs.closeSync = close;
        }
        writeReport(output, report);
    }
    const retained = JSON.parse(fs.readFileSync(path.join(output, 'preflight.json'), 'utf8')),
        lines = fs.readFileSync(journal.file, 'utf8');
    fs.rmSync(temp, { recursive: true });
    return {
        retained,
        calls,
        io,
        lines,
        facts: retained.observations.find((x) => x.name === 'directory-security-facts')?.data,
    };
}
test('basic path invokes only one fixed literal Get-Acl child, with filesystem pre/post IDs and no native/fixture gate', async () => {
    const r = await exercise({ remaining: 2300 });
    assert.equal(r.calls.length, 1);
    assert.equal(r.io, 1);
    assert.equal(r.calls[0].args[3], directoryFactsScript);
    assert.deepEqual(r.calls[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.equal(r.calls[0].settings.shell, false);
    assert.equal(r.calls[0].settings.timeout, 2300);
    assert.equal(r.calls[0].settings.maxBuffer, 65536);
    assert(!Object.keys(r.calls[0].settings.env).some((x) => x.toUpperCase() === 'PSMODULEPATH'));
    assert.equal(r.calls[0].settings.env.PSExecutionPolicyPreference, 'AllSigned');
    assert.equal(r.facts.complete, true);
    assert.equal(r.facts.identityComparison, 'no-drift-detected');
    assert(r.facts.rows.every((x) => x.before && x.after && x.descriptor));
    assert.equal(r.facts.atomicCustody, false);
    assert.equal(r.facts.tokenContext, 'not-collected');
    assert.deepEqual(r.retained.journalClosure, { synced: true, closed: true, errors: [] });
});
test('Get-Acl access failure retains completed and unavailable facts, closes journal, stops subsequent I/O', async () => {
    const r = await exercise({
        mutate: (x) => {
            x.rows = [x.rows[0], unavailable(x.rows[1].path)];
            x.complete = false;
            x.stoppedAt = 1;
            x.error = x.rows[1].error;
            recalc(x);
        },
    });
    assert.equal(r.calls.length, 1);
    assert.equal(r.io, 0);
    assert.equal(r.facts.complete, false);
    assert.equal(r.facts.rows[0].descriptor.availability, 'observed');
    assert.equal(r.facts.rows[1].descriptor.daclState, 'unavailable');
    assert.equal(r.facts.rows[1].descriptor.aces, null);
    assert.match(r.lines, /access denied/);
    assert.equal(r.retained.status, 'BLOCKED_PREFLIGHT');
    assert.equal(r.retained.journalClosure.closed, true);
});
for (const [name, options] of [
    ['malformed JSON', { stdout: 'bad JSON' }],
    ['oversize JSON', { stdout: ' '.repeat(32769) }],
    ['nonzero exit', { process: { status: 1, stderr: 'Get-Acl blocked' } }],
    [
        'timeout',
        {
            process: {
                status: null,
                error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
            },
        },
    ],
    ['signal', { process: { status: null, signal: 'SIGTERM' } }],
    ['cancellation', { cancelAfter: true }],
])
    test(`${name}retains filesystem partial evidence without an empty descriptor or retry`, async () => {
        const r = await exercise(options);
        assert.equal(r.calls.length, 1);
        assert.equal(r.io, 0);
        assert.equal(r.facts.complete, false);
        assert.equal(r.facts.descriptorAvailability, 'unavailable');
        assert(r.facts.rows.every((x) => x.descriptor === null));
        assert(r.facts.failures.length);
        assert.equal(r.retained.journalClosure.closed, true);
    });
test('filesystem identity drift is detected, distinct from atomic custody', async () => {
    const r = await exercise({
        during: ({ other }) => {
            fs.renameSync(other, other + '-old');
            fs.mkdirSync(other);
        },
    });
    assert.equal(r.io, 0);
    assert.equal(r.facts.identityComparison, 'drift-detected');
    assert.equal(r.facts.atomicCustody, false);
    assert.equal(r.facts.complete, false);
    assert(r.facts.rows.some((x) => x.before.ino !== x.after.ino));
});
test('post-observation reparse point is unavailable and stops after the one bounded command', async () => {
    const r = await exercise({
        during: ({ other }) => {
            fs.renameSync(other, other + '-old');
            fs.symlinkSync(other + '-old', other);
        },
    });
    assert.equal(r.io, 0);
    assert.equal(r.calls.length, 1);
    assert.equal(r.facts.identityComparison, 'not-complete');
    assert(r.facts.rows.some((x) => x.after === null));
});
test('pre-observation aliases/reparse points and unplanned candidates execute no child', async () => {
    let r = await exercise({
        before: ({ other }) => {
            fs.renameSync(other, other + '-old');
            fs.symlinkSync(other + '-old', other);
        },
    });
    assert.equal(r.calls.length, 0);
    assert.equal(r.io, 0);
    r = await exercise({
        candidates: (c) => {
            c.paths.push('/unplanned');
        },
    });
    assert.equal(r.calls.length, 0);
    assert.equal(r.io, 0);
});
for (const value of [null, 'invalid'])
    test('invalid source identity prevents directory command', async () => {
        const r = await exercise({ sourceSHA: value });
        assert.equal(r.calls.length, 0);
        assert.equal(r.io, 0);
        assert.equal(r.facts.complete, false);
    });
test('source script tamper cannot be hidden by rehash; source/runtime drift after response stops continuation', async () => {
    let r = await exercise({
        before: ({ source }) => fs.appendFileSync(source, '#modified'),
        rehash: true,
    });
    assert.equal(r.calls.length, 0);
    assert.equal(r.io, 0);
    r = await exercise({ during: ({ source }) => fs.appendFileSync(source, '#modified') });
    assert.equal(r.calls.length, 1);
    assert.equal(r.io, 0);
    assert(r.facts.rows[0].descriptor);
    r = await exercise({ during: ({ powershell }) => fs.appendFileSync(powershell, 'x') });
    assert.equal(r.io, 0);
});
for (const cleanup of ['sync', 'close'])
    test(`unconfirmed journal ${cleanup}cannot promote the attempt`, async () => {
        const r = await exercise({ cleanup });
        assert.equal(r.facts.complete, true);
        assert.equal(r.retained.status, 'BLOCKED_PREFLIGHT');
        assert(r.retained.failures.some((x) => x.includes('durability/closure')));
        assert(r.retained.journalClosure.errors.length);
    });
test('production path is directory-only; historical token/compiled fixtures remain separate and admission stays independent', () => {
    const source = fs.readFileSync(
            new URL('../scripts/memory-product-preflight.mts', import.meta.url),
            'utf8',
        ),
        ps = fs.readFileSync(
            new URL('../scripts/lib/windows-directory-facts.ps1', import.meta.url),
            'utf8',
        );
    assert.doesNotMatch(
        source,
        /runQualifiedOwnershipSnapshot|tokenContractInputs|ownershipSnapshotScript|GetTokenInformation|AccessCheck/,
    );
    assert.match(source, /await observeDirectoryFacts/);
    assert(source.indexOf('await observeDirectoryFacts(') < source.indexOf('const ownerConfirmed'));
    assert.match(ps, /Get-Acl -LiteralPath \$literal -ErrorAction Stop/);
    assert.match(ps, /GetSecurityDescriptorSddlForm\(\$sections\)/);
    assert.match(ps, /RawSecurityDescriptor/);
    assert.match(ps, /GetSecurityDescriptorBinaryForm\(\)/);
    assert.match(ps, /RawSecurityDescriptor\]::new\(\$binary, 0\)/);
    assert.match(ps, /GetBinaryForm/);
    assert.doesNotMatch(
        ps,
        /Add-Type|DllImport|AccessCheck|GetTokenInformation|WindowsIdentity|Set-Acl|AllCentralAccessPolicies|-Audit|AdjustToken|Impersonate/,
    );
    assert.match(ps, /PhysicalDirectory \$literal/);
    assert.match(ps, /ReparsePoint/);
    assert.match(ps, /GetSecurityDescriptorSddlForm/);
    assert.match(source, /requireDirectoryFactsComplete\(observation\)/);
});

test('deadline after a returned descriptor preserves that data but leaves post-identity association incomplete', async () => {
    const r = await exercise({ expireAfter: true });
    assert.equal(r.io, 0);
    assert.equal(r.calls.length, 1);
    assert.equal(r.facts.complete, false);
    assert.equal(r.facts.descriptorAvailability, 'reported');
    assert.equal(r.facts.identityComparison, 'not-complete');
    assert(r.facts.rows[0].descriptor);
});
