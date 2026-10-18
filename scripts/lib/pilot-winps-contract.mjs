import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sourceFingerprint } from '../../tests/fixtures/memory-resource-identity.ts';
import { pilotHostedContext, parsePilotSecurity } from './hosted-pilot-security.mjs';
import {
    ancestryIdentity,
    checkAncestry,
    fileIdentity,
    metadataIdentity,
    digest,
    closeDescriptor,
} from './windows-preflight.mjs';
import { PilotEvidence } from './pilot-evidence.mjs';
import { createOwnershipHold } from './product-entry-custody.mjs';
import { runSecurityCommand, requireSecurityProcess } from './pilot-security-command.mjs';
export const legacyWinpsControl = Object.freeze({
    commit: '14f8c0008146150bf1d44e32ec615bab73757abb',
    providerSHA256: '6ffba693856004b516c9c0d2a619e381d3b411d6b3d0efb14eb79ff068a21117',
    scope: 'Exact failed capture/Get-Item/bitwise chain; instrumented read-only red control, never admitted facts',
});
export const winpsContractLimits = Object.freeze({
    totalMs: 180000,
    reserveMs: 30000,
    commandMs: 10000,
    commandBytes: 65536,
    evidenceBytes: 1048576,
    rows: 512,
});
const clock = () => Number(process.hrtime.bigint() / 1000000n);
export function winpsContractCases(directories, sentinel, missing) {
    const a = { path: directories[0], kind: 'directory' },
        b = { path: directories[1], kind: 'directory' },
        f = { path: sentinel, kind: 'file' };
    const invalid = [
        ['empty', []],
        ['scalar', 'not-an-array'],
        ['object-root', a],
        ['null-root', null],
        ['nested', [[a, b]]],
        ['count-value-wrapper', { Count: 2, Value: [a, b] }],
        ['wrapped-row', [{ Count: 2, Value: [a, b] }]],
        ['number-row', [1]],
        ['null-row', [null]],
        ['path-array', [{ path: directories, kind: 'directory' }]],
        ['kind-array', [{ path: directories[0], kind: ['directory'] }]],
        ['missing-path', [{ kind: 'directory' }]],
        ['missing-kind', [{ path: directories[0] }]],
        ['extra-field', [{ ...a, extra: true }]],
        ['null-path', [{ ...a, path: null }]],
        ['null-kind', [{ ...a, kind: null }]],
        ['number-path', [{ ...a, path: 2 }]],
        ['number-kind', [{ ...a, kind: 2 }]],
        ['invalid-kind', [{ ...a, kind: 'unknown' }]],
        ['relative-path', [{ ...a, path: 'relative' }]],
        [
            'nul-path',
            [
                {
                    ...a,
                    path: 'C:' + String.fromCharCode(92) + 'bad' + String.fromCharCode(0) + 'path',
                },
            ],
        ],
        ['overlong-path', [{ ...a, path: 'C:' + String.fromCharCode(92) + 'x'.repeat(1024) }]],
        ['four-rows', [a, b, a, b]],
    ].map(([name, value]) => ({ name, plans: value, expected: 'reject-before-provider' }));
    return [
        { name: 'legacy-two-directories', plans: [a, b], expected: 'legacy-red' },
        { name: 'one-directory', plans: [a], expected: 'green' },
        { name: 'two-directories', plans: [a, b], expected: 'green' },
        { name: 'directories-and-file', plans: [a, b, f], expected: 'green' },
        ...invalid,
        {
            name: 'file-as-directory',
            plans: [{ ...f, kind: 'directory' }],
            expected: 'reject-kind',
        },
        { name: 'directory-as-file', plans: [{ ...a, kind: 'file' }], expected: 'reject-kind' },
        {
            name: 'missing-literal',
            plans: [{ path: missing, kind: 'file' }],
            expected: 'reject-missing',
        },
    ];
}
export function requireWinpsContractReply(reply, testCase, powershell, script, principal) {
    assert.equal(reply.schema, 1);
    assert(reply.interpreter && reply.trace);
    const i = reply.interpreter;
    assert.equal(i.edition, 'Desktop');
    assert(/^5\.1\.\d+\.\d+$/.test(i.version));
    assert.equal(i.x64, true);
    assert.equal(
        path.win32.normalize(i.path).toLowerCase(),
        path.win32.normalize(powershell).toLowerCase(),
    );
    assert.equal(
        path.win32.normalize(i.script).toLowerCase(),
        path.win32.normalize(script).toLowerCase(),
    );
    const t = reply.trace;
    if (testCase.expected === 'legacy-red') {
        assert.equal(reply.complete, false);
        assert.equal(t.root.type, 'System.Object[]');
        assert.equal(t.root.count, 1);
        assert.equal(t.rootElements.length, 1);
        assert.equal(t.rootElements[0].type, 'System.Object[]');
        assert.equal(t.rootElements[0].count, 2);
        for (const key of ['plan', 'path', 'item', 'attributes']) {
            assert.equal(t.red[key].array, true);
            assert.equal(t.red[key].count, 2);
        }
        assert.deepEqual(t.red.itemTypes, ['System.IO.DirectoryInfo', 'System.IO.DirectoryInfo']);
        assert.equal(t.getItemCalls, 1);
        assert.equal(t.getAclCalls, 0);
        assert.match(reply.error.message, /op_BitwiseAnd/);
        assert.match(reply.error.id, /MethodNotFound/);
        return null;
    }
    if (testCase.expected === 'green') {
        assert.equal(reply.complete, true);
        assert.equal(t.root.type, 'System.Object[]');
        assert.equal(t.root.count, testCase.plans.length);
        assert.equal(t.rootElements.length, testCase.plans.length);
        for (const element of t.rootElements) {
            assert.equal(element.type, 'System.Management.Automation.PSCustomObject');
            assert.equal(element.count, 1);
            assert.equal(element.array, false);
        }
        assert.equal(t.getItemCalls, testCase.plans.length);
        assert.equal(t.getAclCalls, testCase.plans.length);
        assert.equal(t.rows.length, testCase.plans.length);
        t.rows.forEach((row, index) => {
            const kind = testCase.plans[index].kind;
            for (const [key, type] of [
                ['plan', 'System.Management.Automation.PSCustomObject'],
                ['path', 'System.String'],
                ['kind', 'System.String'],
                ['attributes', 'System.IO.FileAttributes'],
                ['container', 'System.Boolean'],
                ['item', kind === 'file' ? 'System.IO.FileInfo' : 'System.IO.DirectoryInfo'],
                [
                    'acl',
                    kind === 'file'
                        ? 'System.Security.AccessControl.FileSecurity'
                        : 'System.Security.AccessControl.DirectorySecurity',
                ],
            ]) {
                assert.equal(row[key].type, type);
                assert.equal(row[key].count, 1);
                assert.equal(row[key].array, false);
            }
        });
        return parsePilotSecurity(JSON.stringify(reply), testCase.plans, principal);
    }
    assert.equal(reply.complete, false);
    assert(reply.error && typeof reply.error.message === 'string');
    assert.deepEqual(reply.rows, []);
    if (testCase.expected === 'reject-before-provider') {
        assert.equal(t.getItemCalls, 0);
        assert.equal(t.getAclCalls, 0);
    }
    if (testCase.expected === 'reject-kind') {
        assert.equal(t.getItemCalls, 1);
        assert.equal(t.getAclCalls, 1);
    }
    if (testCase.expected === 'reject-missing') {
        assert.equal(t.getItemCalls, 1);
        assert.equal(t.getAclCalls, 0);
    }
    return null;
}
/** Same production script/provider/parser, real System32 WinPS5.1; standalone mode never resolves Electron. */
export async function runWinpsSecurityContract(
    {
        sourceRoot,
        outputRoot,
        expectedSourceSHA256,
        environment = process.env,
        mode = 'winps-contract',
        signal,
        outerDeadline = Infinity,
    },
    {
        now = clock,
        context: contextPort,
        command = runSecurityCommand,
        fingerprint = sourceFingerprint,
        identity = fileIdentity,
        resolvePowerShell = (env) =>
            fs.realpathSync(
                path.win32.join(
                    env.SystemRoot,
                    'System32',
                    'WindowsPowerShell',
                    'v1.0',
                    'powershell.exe',
                ),
            ),
        hold = createOwnershipHold,
        evidenceFactory = (root) => new PilotEvidence(root),
    } = {},
) {
    const startedAt = now(),
        deadline = Math.min(startedAt + winpsContractLimits.totalMs, outerDeadline),
        workDeadline = deadline - winpsContractLimits.reserveMs;
    assert(/^[a-f0-9]{64}$/.test(expectedSourceSHA256));
    assert(deadline > startedAt + winpsContractLimits.reserveMs);
    assert(path.isAbsolute(outputRoot) && fs.realpathSync(outputRoot) === outputRoot);
    assert.deepEqual(fs.readdirSync(outputRoot), []);
    const outputAncestry = ancestryIdentity(outputRoot),
        evidence = evidenceFactory(outputRoot);
    let charge = 0,
        records = 0,
        unknown = false,
        heldOwner,
        fixture,
        bindings,
        principal,
        failure = null;
    const check = (work = true) => {
        if (work) signal?.throwIfAborted();
        assert(now() < (work ? workDeadline : deadline), 'Immutable WinPS contract deadline');
        checkAncestry(outputAncestry);
    };
    const record = (stage, data) => {
        const bytes = Buffer.byteLength(JSON.stringify({ stage, data })) + 256;
        assert(
            records < winpsContractLimits.rows &&
                charge + bytes <= winpsContractLimits.evidenceBytes,
        );
        evidence.append(stage, data);
        charge += bytes;
        records++;
    };
    const holdUnknown = (reason) => {
        unknown = true;
        return (heldOwner ??= hold(
            {
                kind: 'winps-contract-custody-unknown',
                reason: String(reason).slice(0, 1024),
                fixture,
                deadline,
                ownedDescriptors,
            },
            record,
        ));
    };
    const results = [],
        ownedDescriptors = [];
    let context,
        powershell,
        executable,
        provider,
        interpreterReport,
        casesRequired = 0;
    try {
        record('contract-start', {
            expectedSourceSHA256,
            startedAt,
            deadline,
            workDeadline,
            limits: winpsContractLimits,
            mode,
            nativeLaunches: 0,
            canonicalMarkerAcquisition: false,
        });
        check();
        context = contextPort ?? pilotHostedContext(environment, { mode });
        context.check();
        assert.equal(await fingerprint(sourceRoot), expectedSourceSHA256);
        check();
        const systemRoot = ['C:', 'Windows'].join(String.fromCharCode(92));
        assert(
            typeof environment.SystemRoot === 'string' &&
                environment.SystemRoot.toLowerCase() === systemRoot.toLowerCase(),
        );
        powershell = resolvePowerShell(environment);
        assert.equal(
            path.win32.normalize(powershell).toLowerCase(),
            path.win32
                .join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
                .toLowerCase(),
        );
        executable = identity(powershell, { pe: true, check });
        assert.equal(executable.pe.architecture, 'x64');
        provider = identity(path.join(sourceRoot, 'scripts/lib/hosted-pilot-security.ps1'), {
            check,
        });
        record('contract-identities', {
            sourceSHA256: expectedSourceSHA256,
            host: context.host,
            interpreter: executable,
            provider,
            legacyControl: legacyWinpsControl,
        });
        fixture = path.join(context.parent, 'diagnostic-hub-winps-contract-' + randomUUID());
        fs.mkdirSync(fixture);
        const directories = [
                path.join(fixture, "literal [brackets] $dollar 'quote'"),
                path.join(fixture, 'second directory'),
            ],
            sentinel = path.join(fixture, 'regular sentinel.bin');
        for (const d of directories) fs.mkdirSync(d);
        const fd = fs.openSync(sentinel, 'wx', 0o600);
        const sentinelHandle = { fd, synced: false, closed: false, errors: [] };
        ownedDescriptors.push(sentinelHandle);
        let writeError;
        try {
            fs.writeFileSync(fd, 'synthetic WinPS5.1 contract\n');
        } catch (e) {
            writeError = e;
        }
        const closed = closeDescriptor(fd);
        Object.assign(sentinelHandle, closed);
        if (!closed.closed || !closed.synced || closed.errors.length) {
            holdUnknown('Sentinel descriptor closure');
            record('sentinel-closed', {
                ...closed,
                writeError: writeError ? String(writeError) : null,
            });
            throw Error('Sentinel descriptor closure');
        }
        record('sentinel-closed', {
            ...closed,
            writeError: writeError ? String(writeError) : null,
        });
        if (writeError) throw writeError;
        bindings = [fixture, ...directories, sentinel].map((p) => metadataIdentity(p));
        const ancestors = ancestryIdentity(fixture),
            sentinelSHA = digest(fs.readFileSync(sentinel));
        const checkFixture = () => {
            context.check();
            checkAncestry(ancestors);
            for (const before of bindings) {
                const current = metadataIdentity(before.path);
                for (const key of ['path', 'realpath', 'directory', 'file', 'dev', 'ino', 'nlink'])
                    assert.equal(current[key], before[key]);
            }
            assert.equal(digest(fs.readFileSync(sentinel)), sentinelSHA);
            assert.deepEqual(
                fs.readdirSync(fixture).sort(),
                [...directories.map((d) => path.basename(d)), path.basename(sentinel)].sort(),
            );
        };
        record('contract-fixture', { fixture, bindings, expectedSentinelSHA256: sentinelSHA });
        const cases = winpsContractCases(
            directories,
            sentinel,
            path.join(fixture, 'absent literal'),
        );
        casesRequired = cases.length;
        for (const testCase of cases) {
            await new Promise((resolve) => setImmediate(resolve));
            check();
            checkFixture();
            assert(now() + winpsContractLimits.commandMs < workDeadline);
            assert(
                charge + 262144 <= winpsContractLimits.evidenceBytes,
                'Reserve bounded command evidence before launch',
            );
            const rawJSON = JSON.stringify(testCase.plans);
            const reply = command(sourceRoot, powershell, rawJSON, {
                environment,
                red: testCase.expected === 'legacy-red',
                timeout: winpsContractLimits.commandMs,
                identity,
                check,
                onProcessState: (state) => {
                    if (!state.closed) holdUnknown('PowerShell query close unconfirmed');
                },
                record: (stage, data) => record(stage, { case: testCase.name, ...data }),
            });
            if (
                reply.result.error ||
                reply.result.signal ||
                !Number.isInteger(reply.result.status)
            ) {
                holdUnknown('PowerShell query close unconfirmed');
                throw Error('PowerShell query close unconfirmed');
            }
            assert(
                Object.values(reply.result.streams).every((s) => !s.truncated),
                'Bounded provider reply required',
            );
            assert.equal(reply.result.status, testCase.expected === 'green' ? 0 : 1);
            const parsed = JSON.parse(reply.stdout.replace(/^\uFEFF/, ''));
            interpreterReport ??= parsed.interpreter;
            const admitted = requireWinpsContractReply(
                parsed,
                testCase,
                powershell,
                path.join(sourceRoot, 'scripts/lib/hosted-pilot-security.ps1'),
                principal,
            );
            if (admitted) principal ??= admitted.principal;
            checkFixture();
            results.push({
                case: testCase.name,
                expected: testCase.expected,
                passed: true,
                trace: parsed.trace,
            });
            record('contract-case-passed', {
                case: testCase.name,
                expected: testCase.expected,
                principal: parsed.principal,
                trace: parsed.trace,
            });
        }
        check(false);
        assert.equal(await fingerprint(sourceRoot), expectedSourceSHA256);
        assert.deepEqual(identity(powershell, { pe: true, check: () => check(false) }), executable);
        assert.deepEqual(
            identity(path.join(sourceRoot, 'scripts/lib/hosted-pilot-security.ps1'), {
                check: () => check(false),
            }),
            provider,
        );
        checkFixture();
    } catch (error) {
        failure = String(error).slice(0, 2048);
        try {
            record('contract-failed', { error: failure, unknown, nativeLaunches: 0 });
        } catch (persistence) {
            holdUnknown(persistence);
        }
    }
    let cleanup = { removed: false, retained: Boolean(fixture), error: null };
    if (fixture && !unknown) {
        try {
            check(false);
            assert(bindings, 'Fixture identity inventory incomplete');
            assert(
                ownedDescriptors.every((d) => d.closed && d.synced && !d.errors.length),
                'Owned descriptor closure incomplete',
            );
            for (const before of bindings) {
                const current = metadataIdentity(before.path);
                for (const key of ['dev', 'ino', 'file', 'directory', 'realpath', 'nlink'])
                    assert.equal(current[key], before[key]);
            }
            const file = bindings.find((b) => b.file);
            assert(file);
            fs.unlinkSync(file.path);
            for (const dir of bindings.filter((b) => b.directory && b.path !== fixture))
                fs.rmdirSync(dir.path);
            fs.rmdirSync(fixture);
            cleanup = { removed: true, retained: false, error: null };
        } catch (error) {
            cleanup.error = String(error).slice(0, 1024);
            failure ??= cleanup.error;
        }
    }
    if (unknown) {
        const owner = holdUnknown(failure ?? 'Unknown contract custody');
        await owner.outcome;
        throw Error('Unknown contract custody retained');
    }
    if (signal?.aborted) failure ??= String(signal.reason).slice(0, 1024);
    const result = {
        schema: 1,
        kind: 'real-winps51-production-provider-contract',
        sourceSHA256: expectedSourceSHA256,
        passed: !failure && cleanup.removed,
        casesPassed: results.length,
        casesRequired,
        results,
        interpreter: executable,
        interpreterReport,
        provider,
        principal,
        failure,
        cleanup,
        startedAt,
        deadline,
        elapsedMs: now() - startedAt,
        limits: winpsContractLimits,
        nativeLaunches: 0,
        canonicalMarkerAcquisition: false,
        ElectronResolution: false,
        TEMP_TMPChanged: false,
    };
    try {
        record('contract-result', result);
    } catch (error) {
        const owner = holdUnknown(error);
        await owner.outcome;
        throw error;
    }
    const closure = evidence.close();
    if (!closure.complete) {
        const owner = holdUnknown('Contract evidence sync/close incomplete');
        await owner.outcome;
        throw Error('Contract evidence sync/close incomplete');
    }
    return { ...result, evidenceClosure: closure, evidenceBytes: charge };
}
