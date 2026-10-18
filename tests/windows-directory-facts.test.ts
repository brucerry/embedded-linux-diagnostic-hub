// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    directorySerializationCases,
    providerReplyRecords,
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
        serializationContract: {
            schema: 1,
            suite: 'directory-input-serialization-v1',
            passed: directorySerializationCases,
            failed: 0,
            error: null,
        },
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
        if (
            name === 'directory-provider-reply' &&
            data.recordIndex === options.journalFault?.index
        ) {
            const write = fs.writeFileSync,
                sync = fs.fsyncSync;
            let injected = false;
            fs.writeFileSync = (fd, bytes, ...args) => {
                if (fd === journal.fd && !injected && options.journalFault.kind !== 'sync') {
                    injected = true;
                    if (options.journalFault.kind === 'partial')
                        write(fd, bytes.subarray(0, Math.floor(bytes.length / 2)));
                    throw Error('Injected transport journal write failure');
                }
                return write(fd, bytes, ...args);
            };
            fs.fsyncSync = (fd) => {
                if (fd === journal.fd && !injected && options.journalFault.kind === 'sync') {
                    injected = true;
                    throw Error('Injected transport journal sync failure');
                }
                return sync(fd);
            };
            try {
                journal.append(name, data);
            } finally {
                fs.writeFileSync = write;
                fs.fsyncSync = sync;
            }
            assert(injected);
        } else journal.append(name, data);
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
    const command = (exe, script, extra, { onResult } = {}) => {
        admit();
        const stdout = runPreflightCommand(exe, script, extra, {
            windowsPowerShell: true,
            onResult,
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
            observe,
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

// Read only complete, sequential, physically written journal rows; ignore final report copies.
function journalPrefix(lines) {
    const rows = [];
    for (const line of lines.split('\n').slice(0, -1)) {
        let row;
        try {
            row = JSON.parse(line);
        } catch {
            break;
        }
        if (row.sequence !== rows.length) break;
        rows.push(row);
    }
    return rows;
}
function reconstructRecords(records) {
    const header = records[0],
        footer = records.at(-1);
    assert(header && header.kind === 'unvalidated-directory-provider-transport');
    assert.equal(records.length, header.recordCount);
    records.forEach((record, i) => {
        assert.equal(record.recordIndex, i);
        assert.equal(record.recordCount, records.length);
        assert.equal(record.acceptedAsDescriptorReport, false);
        assert.equal(record.schema, 1);
    });
    assert.equal(footer.kind, 'directory-provider-transport-complete');
    assert.equal(footer.chunks, records.length - 2);
    const result = { ...header };
    for (const name of ['stdout', 'stderr']) {
        const meta = header[name],
            data = records.slice(1, -1).filter((r) => r.stream === name);
        assert.equal(data.length, meta.chunks);
        data.forEach((chunk, i) => {
            assert.equal(chunk.kind, 'directory-provider-transport-chunk');
            assert.equal(chunk.chunkIndex, i);
            assert.equal(chunk.offset, meta.truncated && i === 1 ? meta.bytes - 32768 : i * 32768);
            const bytes = Buffer.from(chunk.base64, 'base64');
            assert.equal(bytes.toString('base64'), chunk.base64);
            assert.equal(bytes.length, chunk.bytes);
            assert(bytes.length > 0 && bytes.length <= 32768);
        });
        const bytes = Buffer.concat(data.map((r) => Buffer.from(r.base64, 'base64')));
        assert.equal(bytes.length, meta.retainedBytes);
        if (!meta.truncated)
            assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256);
        result[name] = {
            ...meta,
            headBase64: (meta.truncated ? bytes.subarray(0, 32768) : bytes).toString('base64'),
            tailBase64: (meta.truncated ? bytes.subarray(32768) : Buffer.alloc(0)).toString(
                'base64',
            ),
        };
    }
    assert.equal(footer.retainedBytes, result.stdout.retainedBytes + result.stderr.retainedBytes);
    return result;
}
function transportFromJournal(r) {
    const rows = journalPrefix(r.lines);
    for (const row of rows) assert(Buffer.byteLength(JSON.stringify(row) + '\n') <= 65536);
    const records = rows
        .filter((row) => row.stage === 'directory-provider-reply')
        .map((row) => row.data);
    return reconstructRecords(records);
}
const decodeTransport = (stream) =>
    Buffer.concat([
        Buffer.from(stream.headBase64, 'base64'),
        Buffer.from(stream.tailBase64, 'base64'),
    ]);
test('actual failed WinPS Count/value row is refused and its entire reply/error is journaled before parsing', async () => {
    const wrapper = JSON.parse(
        fs.readFileSync(
            new URL('./fixtures/windows-directory-failed-row.json', import.meta.url),
            'utf8',
        ),
    );
    assert.equal(wrapper.Count, 14);
    assert.equal(wrapper.value.length, 14);
    const raw = JSON.stringify({
        ...response(wrapper.value),
        complete: false,
        stoppedAt: 0,
        error: 'Fixed absolute literal string path required.',
        rows: [
            {
                ...unavailable('unused'),
                path: wrapper,
                error: 'Fixed absolute literal string path required.',
            },
        ],
        descriptorBytes: 0,
        descriptorUtf8Bytes: 0,
    });
    const r = await exercise({ stdout: raw });
    assert.equal(r.io, 0);
    assert.equal(r.facts.complete, false);
    assert(r.facts.rows.every((row) => row.descriptor === null));
    assert.match(r.facts.failures[0].error, /Unplanned\/reordered descriptor row/);
    const transport = transportFromJournal(r);
    assert.equal(transport.acceptedAsDescriptorReport, false);
    assert.equal(transport.stdout.truncated, false);
    assert.equal(decodeTransport(transport.stdout).toString('utf8'), raw);
    assert.equal(
        JSON.parse(decodeTransport(transport.stdout).toString()).error,
        'Fixed absolute literal string path required.',
    );
    assert(
        r.retained.observations.findIndex((o) => o.name === 'directory-provider-reply') <
            r.retained.observations.findIndex((o) => o.name === 'directory-security-facts'),
    );
    assert(r.lines.includes(transport.stdout.headBase64));
    assert.equal(r.retained.journalClosure.closed, true);
});
for (const malformed of [
    'bad JSON\nprovider error at end',
    JSON.stringify({ Count: 1, value: ['C:\\literal'] }),
    '\ufeff[1]',
    '',
])
    test('unparseable provider reply remains byte-exact UTF8 transport and never supplies paths', async () => {
        const r = await exercise({ stdout: malformed });
        const transport = transportFromJournal(r);
        assert.equal(decodeTransport(transport.stdout).toString('utf8'), malformed);
        assert.equal(transport.stdout.truncated, false);
        assert.equal(r.io, 0);
        assert.equal(r.facts.descriptorAvailability, 'unavailable');
    });
test('provider stdout and stderr survive process rejection, cancellation and deadline before any parser assertion', async () => {
    for (const extra of [
        { process: { status: 1, stderr: 'provider failed after partial reply' } },
        { cancelAfter: true },
        { expireAfter: true },
        { process: { status: null, signal: 'SIGTERM', stderr: 'terminated' } },
        { process: { status: null, error: new Error('ETIMEDOUT'), stderr: 'timeout details' } },
    ]) {
        const raw = '{"partial":"retained"}';
        const r = await exercise({ stdout: raw, ...extra });
        const transport = transportFromJournal(r);
        assert.equal(decodeTransport(transport.stdout).toString(), raw);
        assert.equal(decodeTransport(transport.stderr).toString(), extra.process?.stderr ?? '');
        assert.equal(r.io, 0);
        assert.equal(r.retained.journalClosure.closed, true);
    }
});
test('transport caps total bytes, preserves head/tail and full hashes, declares truncation without parsing fallback', async () => {
    const { createHash } = await import('node:crypto');
    const stdout = 'header-' + 'é'.repeat(65536) + '-provider-error-at-end',
        stderr = 'begin-' + '失'.repeat(40000) + '-final-error';
    const records = providerReplyRecords({ stdout, stderr, status: 1, signal: null });
    const e = reconstructRecords(records);
    assert(e.stdout.truncated && e.stderr.truncated);
    assert(e.stdout.retainedBytes + e.stderr.retainedBytes <= 131072);
    assert(Buffer.byteLength(JSON.stringify(records)) <= 180224);
    for (const [stream, text] of [
        [e.stdout, stdout],
        [e.stderr, stderr],
    ]) {
        const bytes = Buffer.from(text);
        assert.equal(stream.bytes, bytes.length);
        assert.equal(stream.sha256, createHash('sha256').update(bytes).digest('hex'));
        assert(
            Buffer.from(stream.headBase64, 'base64').equals(
                bytes.subarray(0, Math.ceil(stream.retainedBytes / 2)),
            ),
        );
        assert(
            Buffer.from(stream.tailBase64, 'base64').equals(
                bytes.subarray(bytes.length - Math.floor(stream.retainedBytes / 2)),
            ),
        );
    }
    assert.equal(e.acceptedAsDescriptorReport, false);
    const r = await exercise({ stdout: 'x'.repeat(65536) });
    const captured = transportFromJournal(r);
    assert.equal(captured.stdout.truncated, false);
    assert.equal(decodeTransport(captured.stdout).length, 65536);
    assert(
        r.facts.failures.some((failure) => failure.error.includes('Directory response JSON bound')),
    );
    assert.equal(r.io, 0);
});
test('within-budget provider reply preserves Unicode/escaped/control text byte-exact, distinguishes absent output', () => {
    const stdout = '\ufeff{"error":"失敗 é \\u0000 \\" quote"}\r\n',
        stderr = 'provider: é\r\n';
    const e = reconstructRecords(providerReplyRecords({ stdout, stderr, status: 0 }));
    assert.equal(decodeTransport(e.stdout).toString(), stdout);
    assert.equal(decodeTransport(e.stderr).toString(), stderr);
    const absent = reconstructRecords(
        providerReplyRecords({ stdout: null, stderr: null, status: null }),
    );
    assert.equal(absent.stdout.present, false);
    assert.equal(absent.stdout.bytes, 0);
});
for (const paths of [[], ['C:\\one'], ['C:\\one', 'D:\\two']])
    test(`strict report serialization preserves ${paths.length}row array shape`, () => {
        const r = response(paths);
        const p = parseDirectoryDescriptorReport(JSON.stringify(r), paths);
        assert(Array.isArray(p.rows));
        assert.equal(p.rows.length, paths.length);
        if (paths.length) {
            r.rows = r.rows[0];
            assert.throws(() => parseDirectoryDescriptorReport(JSON.stringify(r), paths));
        }
    });
for (const [name, mutate] of [
    ['contract absent', (r) => delete r.serializationContract],
    ['wrong suite', (r) => (r.serializationContract.suite = 'other')],
    ['incomplete passes', (r) => r.serializationContract.passed--],
    ['fake success error', (r) => (r.serializationContract.error = 'failed')],
    [
        'failed while complete',
        (r) => {
            r.serializationContract.failed = 1;
            r.serializationContract.error = 'failed';
        },
    ],
    ['root Count/value wrapper', (r) => (r.rows[0].path = { Count: 1, value: [r.rows[0].path] })],
    ['nested path array', (r) => (r.rows[0].path = [r.rows[0].path])],
    ['single ACE scalar', (r) => (r.rows[0].aces = r.rows[0].aces[0])],
    ['single ACE wrapper', (r) => (r.rows[0].aces = { Count: 1, value: r.rows[0].aces })],
])
    test(`strict parser refuses ${name} without coercion`, () => {
        const r = response(['C:\\one']);
        mutate(r);
        assert.throws(() => parseDirectoryDescriptorReport(JSON.stringify(r), ['C:\\one']));
    });
test('failed native serialization contract report is retained and blocks later admission', async () => {
    const r = await exercise({
        mutate: (x) => {
            x.complete = false;
            x.rows = [];
            x.stoppedAt = 0;
            x.error = 'Directory serialization contract failed; no Get-Acl admission.';
            x.serializationContract = {
                schema: 1,
                suite: 'directory-input-serialization-v1',
                passed: 2,
                failed: 1,
                error: 'Directory serialization contract: literal/order roundtrip',
            };
            recalc(x);
        },
    });
    assert.equal(r.io, 0);
    assert.equal(r.facts.providerComplete, false);
    assert.equal(r.facts.serializationContract.failed, 1);
    assert.match(r.lines, /literal\/order roundtrip/);
});
test('same-child native contract runs exact decoder and serializer before first Get-Acl; no pipeline JSON/array nesting', () => {
    const ps = fs.readFileSync(
        new URL('../scripts/lib/windows-directory-facts.ps1', import.meta.url),
        'utf8',
    );
    assert.match(ps, /\$decoded = ConvertFrom-Json -InputObject \$json -ErrorAction Stop/);
    assert.match(ps, /foreach \(\$item in \$decoded\)/);
    assert.match(ps, /\$item -isnot \[string\]/);
    assert.match(ps, /return ,\(\$typed.ToArray\(\)\)/);
    assert.match(
        ps,
        /\[string\[\]\]\$paths = ConvertTo-DirectoryPaths \$env:HUB_PREFLIGHT_DIRECTORY_PATHS/,
    );
    assert(
        ps.indexOf('$report.serializationContract = Test-DirectorySerializationContract') <
            ps.indexOf('Get-Acl -LiteralPath'),
    );
    assert.match(ps, /ConvertTo-Json -InputObject \$value -Depth 8 -Compress/);
    assert.doesNotMatch(ps, /@\(ConvertFrom-Json|\| ConvertTo-Json|Select-Object -First/);
    const wrapper = JSON.parse(
        fs.readFileSync(
            new URL('./fixtures/windows-directory-failed-row.json', import.meta.url),
            'utf8',
        ),
    );
    assert(ps.includes(JSON.stringify([wrapper])));
    assert(ps.includes(`$report.serializationContract.passed -ne ${directorySerializationCases}`));
});

test('both streams at the unchanged command cap are retained in full by the real bounded journal/report', async () => {
    const stdout = 'x'.repeat(65536),
        stderr = 'y'.repeat(65536);
    const r = await exercise({ stdout, process: { status: 1, stderr } });
    const e = transportFromJournal(r);
    assert.equal(e.stdout.truncated, false);
    assert.equal(e.stderr.truncated, false);
    assert.equal(decodeTransport(e.stdout).toString(), stdout);
    assert.equal(decodeTransport(e.stderr).toString(), stderr);
    assert(Buffer.byteLength(r.lines) <= 262144);
    assert.equal(r.io, 0);
    assert.equal(r.retained.journalClosure.synced, true);
    assert.equal(r.retained.journalClosure.closed, true);
});

for (const [stdoutBytes, stderrBytes] of [
    [32768, 0],
    [65536, 0],
    [32768, 32768],
    [65536, 65536],
])
    test(`actual journal reconstructs ${stdoutBytes}/${stderrBytes}streams under unchanged row cap`, async (t) => {
        const stdout = 'x'.repeat(stdoutBytes),
            stderr = 'provider-error:' + 'y'.repeat(Math.max(0, stderrBytes - 15));
        // Empty stderr remains empty; nonempty cases retain a distinct process rejection.
        const err = stderrBytes ? stderr.slice(0, stderrBytes) : '';
        const r = await exercise({ stdout, process: { status: 1, stderr: err } });
        const e = transportFromJournal(r),
            rows = journalPrefix(r.lines),
            capture = rows.filter((row) => row.stage === 'directory-provider-reply');
        assert.equal(decodeTransport(e.stdout).toString(), stdout);
        assert.equal(decodeTransport(e.stderr).toString(), err);
        assert.equal(e.status, 1);
        assert(capture.at(-1).data.kind === 'directory-provider-transport-complete');
        assert(
            capture
                .filter((row) => row.data.kind === 'directory-provider-transport-chunk')
                .every((row) => row.data.bytes <= 32768),
        );
        assert.equal(r.io, 0);
        assert(r.facts.failures.some((failure) => failure.error.includes('AssertionError')));
        assert(
            r.facts.failures.every((failure) => !failure.error.includes('journal pre-write cap')),
        );
        assert.equal(r.retained.journalClosure.synced, true);
        assert.equal(r.retained.journalClosure.closed, true);
        t.diagnostic(
            'JOURNAL_CHUNK_CASE ' +
                JSON.stringify({
                    stdoutBytes,
                    stderrBytes: Buffer.byteLength(err),
                    captureRows: capture.length,
                    rowBytes: capture.map((row) => Buffer.byteLength(JSON.stringify(row) + '\n')),
                    journalBytes: Buffer.byteLength(r.lines),
                    reconstructedFromJournal: true,
                    processRejectionReached: true,
                    closure: r.retained.journalClosure,
                }),
        );
    });
for (const kind of ['write', 'partial', 'sync'])
    test(`actual ${kind}failure retains a truthful transport prefix without a completion record`, async (t) => {
        const r = await exercise({
            stdout: 'x'.repeat(65536),
            process: { status: 1, stderr: 'provider-error:' + 'y'.repeat(65521) },
            journalFault: { kind, index: 2 },
        });
        const rows = journalPrefix(r.lines),
            records = rows
                .filter((row) => row.stage === 'directory-provider-reply')
                .map((row) => row.data);
        assert.equal(records[0].kind, 'unvalidated-directory-provider-transport');
        assert.equal(records[0].status, 1);
        assert.equal(records[0].stdout.bytes, 65536);
        assert.equal(records[0].stderr.bytes, 65536);
        assert.equal(records[1].kind, 'directory-provider-transport-chunk');
        assert.equal(records[1].stream, 'stdout');
        assert.equal(records[1].offset, 0);
        assert.equal(Buffer.from(records[1].base64, 'base64').toString(), 'x'.repeat(32768));
        assert(!records.some((record) => record.kind === 'directory-provider-transport-complete'));
        assert.throws(() => reconstructRecords(records));
        // Final-report copies may include the unwritten/unsynced chunk; never use them as journal proof.
        assert(
            r.retained.observations.filter((o) => o.name === 'directory-provider-reply').length >
                records.length || kind === 'sync',
        );
        assert.equal(r.io, 0);
        assert.equal(r.retained.status, 'BLOCKED_PREFLIGHT');
        assert(r.facts.failures.some((failure) => failure.error.includes('transport journal')));
        assert.equal(r.retained.journalClosure.closed, true);
        t.diagnostic(
            'JOURNAL_FAILURE_CASE ' +
                JSON.stringify({
                    kind,
                    completeSequentialPrefixRows: rows.length,
                    capturePrefixRecords: records.length,
                    completionRecord: false,
                    reconstructionRefused: true,
                    malformedOrSequenceTail: kind !== 'write',
                    blocked: true,
                    closure: r.retained.journalClosure,
                }),
        );
    });
test('positive native contract paths remain legal ordinary paths; quote escaping stays serializer-only', () => {
    const ps = fs.readFileSync(
            new URL('../scripts/lib/windows-directory-facts.ps1', import.meta.url),
            'utf8',
        ),
        single = ps.match(/\$single = \[string\[\]\]@\('([^']+)'\)/)[1],
        multiple = ps.match(/\$multiple = \[string\[\]\]@\(([^\n]+)\)/)[1];
    assert.equal(single, 'C:\\literal [x] $value legal');
    assert(!single.includes('"'));
    assert(multiple.includes("'" + single + "'"));
    assert(!multiple.includes('"'));
    assert.match(ps, /-not \[IO.Path\]::IsPathRooted\(\$item\)/);
    assert.match(ps, /sddl = 'O:BAG:BAD:\(XA;;GA;;;WD;\(@User.X == "literal S:\(\)"\)\)'/);
    assert(ps.includes(`$report.serializationContract.passed -ne ${directorySerializationCases}`));
});
