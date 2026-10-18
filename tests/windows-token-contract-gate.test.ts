// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sourceFingerprint } from './fixtures/memory-resource-identity';
import {
    parseTokenContractReport,
    requireTokenContractSuccess,
    PreflightJournal,
    writeReport,
    preflightLimits,
} from '../scripts/lib/windows-preflight.mjs';
import {
    runQualifiedOwnershipSnapshot,
    runPreflightCommand,
    tokenContractInputs,
    tokenContractScript,
    ownershipSnapshotScript,
} from '../scripts/memory-product-preflight.mts';
const envelope = () => ({
    schema: 1,
    observerSHA256: tokenContractInputs.observer.sha256,
    fixtureSHA256: tokenContractInputs.fixture.sha256,
    result: {
        schema: 1,
        suite: 'reduced-token-v2-injected-replies',
        passed: 76,
        failed: 0,
        compiledCSharpExecuted: true,
        windowsTokenApisCalled: false,
        directorySelected: false,
        admissionChanged: false,
        errors: [],
    },
});
const expected = {
    observerSHA256: tokenContractInputs.observer.sha256,
    fixtureSHA256: tokenContractInputs.fixture.sha256,
};
const unknownSnapshot = () => ({
    schema: 2,
    profile: 'local-ntfs-reduced-token-snapshot-v2',
    token: null,
    nodes: [],
    tokenProjectionComplete: false,
    snapshotConsistent: false,
    tokenRechecked: false,
    pinsHeldDuringSnapshot: false,
    handleClosureComplete: true,
    errorCount: 1,
    errors: ['Injected command-port snapshot; no native API executed'],
    directorySelected: false,
    privatePathApproved: false,
    admissionChanged: false,
    protectionAfterReturn: false,
    kernelWriteabilityDetermined: false,
    accessScope:
        'AccessCheck MAXIMUM_ALLOWED with actual impersonation token; DACL snapshot, not full kernel or all-principal privacy proof',
    decision: 'indeterminate: explicit trust policy and continuing custody are required',
});
// Real gate + real command helper, disposable real source identities/journal/closure/report.
// Spawn is injected. No PowerShell, compiler, Windows API, process or native workload is executed.
async function exercise(options = {}) {
    const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-contract-gate-'));
    const root = path.join(temp, 'source [literal] $value'),
        output = path.join(temp, 'metadata');
    fs.mkdirSync(root);
    fs.mkdirSync(output);
    const workspace = path.resolve(import.meta.dirname, '..');
    for (const input of Object.values(tokenContractInputs)) {
        const target = path.join(root, input.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(workspace, input.path), target);
    }
    const powershell = path.join(temp, 'powershell.exe'),
        pe = Buffer.alloc(128);
    pe.write('MZ');
    pe.writeUInt32LE(64, 60);
    pe.writeUInt32LE(0x4550, 64);
    pe.writeUInt16LE(34404, 68);
    fs.writeFileSync(powershell, pe);
    let sha = await sourceFingerprint(root);
    if (options.before) await options.before({ root, powershell });
    if (options.rehash) sha = await sourceFingerprint(root);
    const journal = new PreflightJournal(output),
        report = { observations: [], failures: [], status: null },
        requests = [];
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
            const data = observe(name, await work());
            if (name === 'compiled-token-contracts' && options.cancelAfterObserve) cancelled = true;
            if (name === 'compiled-token-contracts' && options.expireAfterObserve) remaining = 0;
            return name === 'compiled-token-contracts' && options.nullStep ? null : data;
        } catch (error) {
            observe(name, {
                status: 'blocked-or-unavailable',
                error: String(error).slice(0, 4096),
            });
            report.failures.push(String(error).slice(0, 4096));
            return null;
        }
    };
    const command = (exe, script, extra) => {
        admit();
        const text = runPreflightCommand(exe, script, extra, {
            windowsPowerShell: true,
            environment: {
                PSModulePath: 'PS7',
                psmodulepath: 'PS7-case',
                PSExecutionPolicyPreference: 'AllSigned',
            },
            timeout: Math.min(preflightLimits.commandMs, remaining),
            spawn(actualExe, args, settings) {
                requests.push({ exe: actualExe, args, settings });
                if (script === tokenContractScript) {
                    const value = envelope();
                    options.mutate?.(value);
                    options.during?.({ root, powershell });
                    if (options.cancelAfterCommand) cancelled = true;
                    return {
                        status: 0,
                        signal: null,
                        stdout: options.stdout ?? JSON.stringify(value),
                        stderr: '',
                        ...options.process,
                    };
                }
                assert.equal(script, ownershipSnapshotScript);
                return {
                    status: 0,
                    signal: null,
                    stdout: JSON.stringify(unknownSnapshot()),
                    stderr: '',
                };
            },
        });
        assert(!cancelled, 'Model cancellation after command');
        return text;
    };
    try {
        await runQualifiedOwnershipSnapshot({
            root,
            powershell,
            sourceSHA256: options.sourceSHA === undefined ? sha : options.sourceSHA,
            candidates: { paths: [output] },
            principal: 'S-1-5-21-1',
            command,
            step,
            admit,
        });
        io++;
        report.status = 'MODEL_CONTINUATION';
    } catch (error) {
        report.status = 'BLOCKED_PREFLIGHT';
        report.failures.push(String(error).slice(0, 4096));
    } finally {
        report.journalClosure = journal.close();
        writeReport(output, report);
    }
    const retained = JSON.parse(fs.readFileSync(path.join(output, 'preflight.json'), 'utf8')),
        journalText = fs.readFileSync(journal.file, 'utf8');
    const summary = {
        retained,
        requests,
        io,
        journalText,
        fixture: retained.observations.find((x) => x.name === 'compiled-token-contracts'),
        snapshots: requests.filter((x) => x.args[3] === ownershipSnapshotScript),
    };
    assert.deepEqual(retained.journalClosure, { synced: true, closed: true, errors: [] });
    fs.rmSync(temp, { recursive: true });
    return summary;
}
test('actual gate allows exactly one separate snapshot only after76/0, with pinned sources and isolated fresh command calls', async () => {
    const run = await exercise({ remaining: 2300 });
    assert.equal(run.io, 1);
    assert.equal(run.snapshots.length, 1);
    assert.equal(run.requests.length, 2);
    assert.equal(run.retained.observations[0].name, 'compiled-token-contracts');
    assert.equal(run.retained.observations[1].name, 'ownership-snapshot');
    assert.equal(run.fixture.data.report.result.passed, 76);
    assert.equal(run.fixture.data.sources.runner.sha256, tokenContractInputs.runner.sha256);
    assert.equal(run.fixture.data.powershell51.pe.architecture, 'x64');
    for (const request of run.requests) {
        assert.deepEqual(request.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
        assert.equal(request.settings.shell, false);
        assert.equal(request.settings.timeout, 2300);
        assert.equal(request.settings.maxBuffer, 65536);
        assert.equal(request.settings.env.PSExecutionPolicyPreference, 'AllSigned');
        assert(!Object.keys(request.settings.env).some((x) => x.toUpperCase() === 'PSMODULEPATH'));
    }
    assert.equal(run.requests[0].args[3], tokenContractScript);
    assert.match(
        run.requests[0].settings.env.HUB_PREFLIGHT_TOKEN_CONTRACT_PS1,
        /source \[literal\] \$value/,
    );
    assert.equal(run.requests[1].settings.env.HUB_PREFLIGHT_TOKEN_CONTRACT_PS1, undefined);
    assert(run.requests[1].settings.env.HUB_PREFLIGHT_OWNER_PLAN);
    assert.equal(run.requests[0].settings.env.HUB_PREFLIGHT_OWNER_PLAN, undefined);
});
test('valid failed75/1report is journaled before outside-step refusal and prevents snapshot and I/O', async () => {
    const run = await exercise({
        mutate: (v) => {
            v.result.passed = 75;
            v.result.failed = 1;
            v.result.errors = ['poisoned-tail control failed'];
        },
    });
    assert.equal(run.io, 0);
    assert.equal(run.snapshots.length, 0);
    assert.equal(run.requests.length, 1);
    assert.equal(run.fixture.data.report.result.failed, 1);
    assert.deepEqual(run.fixture.data.report.result.errors, ['poisoned-tail control failed']);
    assert.match(run.journalText, /poisoned-tail control failed/);
    assert.equal(run.retained.status, 'BLOCKED_PREFLIGHT');
    assert(run.retained.failures.some((x) => x.includes('Required compiled contracts failed')));
});
for (const [label, mutate] of [
    [
        'zero count',
        (v) => {
            v.result.passed = 0;
        },
    ],
    [
        'partial count',
        (v) => {
            v.result.passed = 75;
        },
    ],
    [
        'negative count',
        (v) => {
            v.result.passed = -1;
        },
    ],
    [
        'fraction count',
        (v) => {
            v.result.passed = 75.5;
        },
    ],
    [
        'over count',
        (v) => {
            v.result.passed = 77;
        },
    ],
    [
        'wrong outer schema',
        (v) => {
            v.schema = 2;
        },
    ],
    [
        'wrong inner schema',
        (v) => {
            v.result.schema = 2;
        },
    ],
    [
        'wrong suite',
        (v) => {
            v.result.suite = 'other';
        },
    ],
    [
        'wrong observer hash',
        (v) => {
            v.observerSHA256 = 'a'.repeat(64);
        },
    ],
    [
        'wrong fixture hash',
        (v) => {
            v.fixtureSHA256 = 'b'.repeat(64);
        },
    ],
    [
        'uncompiled',
        (v) => {
            v.result.compiledCSharpExecuted = false;
        },
    ],
    [
        'native flag',
        (v) => {
            v.result.windowsTokenApisCalled = true;
        },
    ],
    [
        'selection flag',
        (v) => {
            v.result.directorySelected = true;
        },
    ],
    [
        'admission flag',
        (v) => {
            v.result.admissionChanged = true;
        },
    ],
    [
        'unexpected envelope field',
        (v) => {
            v.handle = 123;
        },
    ],
    [
        'unexpected result field',
        (v) => {
            v.result.handle = 123;
        },
    ],
    [
        'mixed shape',
        (v) => {
            v.result.rows = [];
        },
    ],
    [
        'missing field',
        (v) => {
            delete v.result.passed;
        },
    ],
    [
        'spurious errors',
        (v) => {
            v.result.errors = ['unexpected'];
        },
    ],
    [
        'oversize error',
        (v) => {
            v.result.passed = 75;
            v.result.failed = 1;
            v.result.errors = ['x'.repeat(257)];
        },
    ],
    [
        'too many errors',
        (v) => {
            v.result.passed = 67;
            v.result.failed = 9;
            v.result.errors = Array(9).fill('failed');
        },
    ],
])
    test(`gate rejects ${label} with retained bounded blocked observation and closure`, async () => {
        const run = await exercise({ mutate });
        assert.equal(run.io, 0);
        assert.equal(run.snapshots.length, 0);
        assert.equal(run.requests.length, 1);
        assert.equal(run.fixture.data.status, 'blocked-or-unavailable');
        assert(run.fixture.data.error.length <= 4096);
        assert.equal(run.retained.status, 'BLOCKED_PREFLIGHT');
    });
for (const [label, options] of [
    ['malformed JSON', { stdout: 'not-json' }],
    ['oversize JSON', { stdout: ' '.repeat(32769) }],
    ['nonzero exit', { process: { status: 1, stderr: 'compiler failed' } }],
    ['signal', { process: { status: null, signal: 'SIGTERM' } }],
    [
        'timeout',
        {
            process: {
                status: null,
                error: Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }),
            },
        },
    ],
    ['cancellation after command', { cancelAfterCommand: true }],
    ['cancellation after observed report', { cancelAfterObserve: true }],
    ['deadline after observed report', { expireAfterObserve: true }],
    ['null step after observation', { nullStep: true }],
])
    test(`gate stops after ${label}; no snapshot or I/O continuation`, async () => {
        const run = await exercise(options);
        assert.equal(run.io, 0);
        assert.equal(run.snapshots.length, 0);
        assert.equal(run.requests.length, 1);
        assert.equal(run.retained.status, 'BLOCKED_PREFLIGHT');
        assert(run.retained.failures.length > 0);
    });
for (const value of [null, '', 'wrong'])
    test('missing or invalid source identity stops before any child', async () => {
        const run = await exercise({ sourceSHA: value });
        assert.equal(run.requests.length, 0);
        assert.equal(run.io, 0);
        assert.equal(run.fixture.data.status, 'blocked-or-unavailable');
    });
for (const key of ['observer', 'fixture', 'runner'])
    test(`pinned ${key}content cannot be spoofed by a recomputed full-tree hash`, async () => {
        const run = await exercise({
            before: ({ root }) =>
                fs.appendFileSync(path.join(root, tokenContractInputs[key].path), '\n//mutated'),
            rehash: true,
        });
        assert.equal(run.requests.length, 0);
        assert.equal(run.io, 0);
        assert.match(run.fixture.data.error, /Reviewed contract input hash mismatch/);
    });
test('preexisting source drift blocks fixture; post-fixture source drift retains report and blocks snapshot', async () => {
    let run = await exercise({
        before: ({ root }) => fs.writeFileSync(path.join(root, 'drift'), 'x'),
    });
    assert.equal(run.requests.length, 0);
    assert.equal(run.io, 0);
    run = await exercise({ during: ({ root }) => fs.writeFileSync(path.join(root, 'drift'), 'x') });
    assert.equal(run.requests.length, 1);
    assert.equal(run.io, 0);
    assert.equal(run.snapshots.length, 0);
    assert.equal(run.fixture.data.report.result.passed, 76);
    assert(run.retained.failures.some((x) => x.includes('Source changed after')));
});
test('PowerShell executable rebound after fixture is refused before snapshot', async () => {
    const run = await exercise({ during: ({ powershell }) => fs.appendFileSync(powershell, 'x') });
    assert.equal(run.requests.length, 1);
    assert.equal(run.snapshots.length, 0);
    assert.equal(run.io, 0);
    assert.equal(run.fixture.data.report.result.passed, 76);
});
test('cancellation or exhausted budget before gate executes no child and closes journal', async () => {
    for (const options of [{ cancelBefore: true }, { remaining: 0 }]) {
        const run = await exercise(options);
        assert.equal(run.requests.length, 0);
        assert.equal(run.io, 0);
        assert.equal(run.retained.status, 'BLOCKED_PREFLIGHT');
    }
});
test('parser retains bounded all-failed case errors but success requirement rejects it', () => {
    const value = envelope();
    value.result.passed = 0;
    value.result.failed = 76;
    value.result.errors = Array(8).fill('bounded failed case');
    const parsed = parseTokenContractReport(JSON.stringify(value), expected);
    assert.equal(parsed.result.failed, 76);
    assert.throws(() => requireTokenContractSuccess(parsed));
});
test('runner returns structured failed suite without post-report throw; production gate precedes unchanged owner/I/O boundary', () => {
    const runner = fs.readFileSync(
        new URL('./windows-token-query-native-contract.ps1', import.meta.url),
        'utf8',
    );
    assert(runner.trim().endsWith('$json'));
    assert.doesNotMatch(runner, /if \(\$result.failed/);
    assert.match(runner, /throw 'Windows PowerShell 5.1/);
    assert.match(runner, /Compiled fixture source changed/);
    const source = fs.readFileSync(
        new URL('../scripts/memory-product-preflight.mts', import.meta.url),
        'utf8',
    );
    const entry = source.slice(source.indexOf('export async function productPreflight'));
    assert(
        entry.indexOf('await runQualifiedOwnershipSnapshot(') <
            entry.indexOf('const ownerConfirmed'),
    );
    assert(entry.indexOf('await runQualifiedOwnershipSnapshot(') < entry.indexOf("'metadata-io-'"));
    assert.equal((source.match(/await step\('ownership-snapshot'/g) || []).length, 1);
    assert.equal((source.match(/await step\('compiled-token-contracts'/g) || []).length, 1);
    assert.match(tokenContractScript, /& \$env:HUB_PREFLIGHT_TOKEN_CONTRACT_PS1/);
    assert.doesNotMatch(tokenContractScript, /Invoke-Expression|ExecutionPolicy/);
});
