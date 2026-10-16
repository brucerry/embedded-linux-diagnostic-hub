import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Script } from 'node:vm';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => readFileSync(path.join(root, name), 'utf8');
const base = 'scripts/windows-token-ui-pilot/';
const model = read(base + 'Model.cs');
const native = read(base + 'Native.cs');
const program = read(base + 'Program.cs');
const prepare = read(base + 'prepare.ps1');
const workflow = read('.github/workflows/windows-token-ui-pilot.yml');

const referenceBase = 'tests/windows-token-ui-pilot/fixtures/';
const reviewedSourceSha = '11524f926e459f5af1ad091463f4b925de9decaad7a97e6090285ee5a2e179cd';
const reviewedSourceBytes = 21656;
const referenceBytes = readFileSync(path.join(root, referenceBase + 'setup-worker.ts.txt'));
const provenance = JSON.parse(read(referenceBase + 'guard-source-provenance.json'));
function workerGuard(source) {
    const matches = [
        ...source.matchAll(
            /const elevated = ps\(\s*'([^']+)'\s*,?\s*\);\s*if \(elevated\.toLowerCase\(\) !== 'false'\)\s*throw Error\('Run setup as your ordinary user, without administrator elevation\.'\);/g,
        ),
    ];
    assert.equal(matches.length, 1, 'one guard must reject every result other than false');
    return matches[0][1];
}
function verifyGuardReference(bytes, evidence, modelSource, applicationSource) {
    assert.ok(Buffer.isBuffer(bytes), 'reviewed guard fixture is mandatory');
    assert.equal(bytes.length, reviewedSourceBytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), reviewedSourceSha);
    assert.equal(evidence.schema, 'diagnostic-hub-reviewed-guard-source-v1');
    assert.equal(evidence.fixture, 'setup-worker.ts.txt');
    assert.equal(evidence.fixtureSha256, reviewedSourceSha);
    assert.equal(evidence.fixtureBytes, reviewedSourceBytes);
    assert.equal(evidence.source.path, 'electron/setup-worker.ts');
    assert.equal(evidence.source.kind, 'frozen-review-source');
    assert.equal(evidence.source.packet, 'platform-gates-1/review-packet');
    assert.equal(
        evidence.source.packetManifestSha256,
        'cd2490e612a18bebca914a66a37ac58175f75d0d8240d4fbba641f31598620ba',
    );
    assert.equal(
        evidence.source.snapshotFingerprintSha256,
        'fc22d1e65793e68dfcf1519c88d6d530ebd6c226980d269f5480fb657374a5b4',
    );
    assert.equal(
        evidence.source.sourceCommit,
        null,
        'do not invent a Git source commit for the frozen snapshot',
    );
    const guard = modelSource.match(/const string GuardExpression = "([^"]+)";/)?.[1];
    assert.ok(guard);
    assert.equal(guard, workerGuard(bytes.toString('utf8')));
    if (applicationSource !== undefined)
        assert.equal(
            workerGuard(applicationSource),
            guard,
            'present application source must agree with the reviewed guard',
        );
    return guard;
}
function readApplicationWorker(reader) {
    try {
        return reader();
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    }
}

test('pilot guard stays bound to mandatory reviewed worker source and its refusal rule', (t) => {
    const applicationPath = path.join(root, 'electron/setup-worker.ts');
    const applicationSource = readApplicationWorker(() => readFileSync(applicationPath, 'utf8'));
    verifyGuardReference(referenceBytes, provenance, model, applicationSource);
    t.diagnostic(
        `Reviewed guard fixture SHA256 ${reviewedSourceSha}; application source ${applicationSource === undefined ? 'not part of standalone pilot' : 'also checked'}`,
    );
    assert.match(program, /-NoLogo -NoProfile -NonInteractive -Command/);
    assert.match(program, /Quote\(Policy\.GuardExpression\)/);
});

test('guard reference rejects missing/tampered source, false provenance and changed pilot expression', () => {
    assert.throws(() => verifyGuardReference(null, provenance, model));
    const corrupt = Buffer.from(referenceBytes);
    corrupt[0] ^= 1;
    assert.throws(() => verifyGuardReference(corrupt, provenance, model));
    for (const edit of [
        (p) => (p.fixtureSha256 = '0'.repeat(64)),
        (p) => (p.source.path = 'unrelated.ts'),
        (p) => (p.source.snapshotFingerprintSha256 = '0'.repeat(64)),
        (p) => (p.source.sourceCommit = '5112038e16798382f7801d2406044f34e9006889'),
    ]) {
        const invalid = structuredClone(provenance);
        edit(invalid);
        assert.throws(() => verifyGuardReference(referenceBytes, invalid, model));
    }
    assert.throws(() =>
        verifyGuardReference(
            referenceBytes,
            provenance,
            model.replace('::Administrator)', '::User)'),
        ),
    );
});

test('present application source cannot change the expression, weaken refusal or add ambiguous guards', () => {
    const source = referenceBytes.toString('utf8');
    verifyGuardReference(referenceBytes, provenance, model, source);
    assert.throws(() =>
        verifyGuardReference(
            referenceBytes,
            provenance,
            model,
            source.replace('::Administrator)', '::User)'),
        ),
    );
    assert.throws(() =>
        verifyGuardReference(
            referenceBytes,
            provenance,
            model,
            source.replace(
                "elevated.toLowerCase() !== 'false'",
                "elevated.toLowerCase() === 'true'",
            ),
        ),
    );
    assert.throws(() =>
        verifyGuardReference(referenceBytes, provenance, model, source + '\n' + source),
    );
});

test('only actual absence permits standalone context; other application-source read failures remain failures', () => {
    assert.equal(
        readApplicationWorker(() => {
            throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        }),
        undefined,
    );
    for (const code of ['EACCES', 'ENOTDIR'])
        assert.throws(
            () =>
                readApplicationWorker(() => {
                    throw Object.assign(new Error(code), { code });
                }),
            { code },
        );
});

test('reviewed installer source remains inert test data outside the dummy compile and launch path', () => {
    assert.ok(provenance.fixture.endsWith('.txt'));
    assert.doesNotMatch(
        prepare + program + native,
        /fixtures|setup-worker\.ts\.txt|guard-source-provenance/,
    );
    assert.match(prepare, /'Model\.cs', 'Native\.cs', 'Program\.cs', 'SelfTests\.cs'/);
});

const pilotBranch = 'ci/windows-token-ui-pilot-20261016';
const pilotRef = 'refs/heads/' + pilotBranch;
function workflowMode(source, event, ref, runPilot) {
    const expression = source.match(/^\s+PILOT_EXECUTION_APPROVED:\s*\$\{\{([\s\S]*?)\}\}/m)?.[1];
    assert.ok(expression, 'mode expression is required');
    const inputs = runPilot === undefined ? {} : { run_pilot: runPilot };
    const result = new Script(expression).runInNewContext(
        { github: { event_name: event, ref }, inputs },
        { timeout: 100 },
    );
    assert.ok(['true', 'false'].includes(result), 'mode must be an explicit environment string');
    return result === 'true' ? 'HostedPilot' : 'SelfTest';
}
function branchTriggerContract(source) {
    const events = source.match(/^on:\r?\n([\s\S]*?)^\S/m)?.[1];
    assert.ok(events);
    assert.deepEqual(
        [...events.matchAll(/^ {4}([a-z_]+):/gm)].map((match) => match[1]),
        ['push', 'workflow_dispatch'],
    );
    const push = events.match(/^ {4}push:\r?\n((?: {8}.*\r?\n)+)/m)?.[1];
    assert.equal(
        push?.replaceAll('\r', ''),
        `        branches: [${pilotBranch}]\n`,
        'push must name only the reviewed branch, with no tags or wildcard',
    );
    assert.match(events, /type: boolean\s+default: false/);
    const cases = [
        ['push', pilotRef, undefined, 'HostedPilot'],
        ['push', pilotRef, false, 'HostedPilot'],
        ['push', pilotRef, true, 'HostedPilot'],
        ['push', 'refs/heads/main', true, 'SelfTest'],
        ['push', 'refs/heads/other', true, 'SelfTest'],
        ['push', 'refs/heads/' + pilotBranch + '-other', true, 'SelfTest'],
        ['push', 'refs/tags/' + pilotBranch, true, 'SelfTest'],
        ['workflow_dispatch', pilotRef, undefined, 'SelfTest'],
        ['workflow_dispatch', pilotRef, false, 'SelfTest'],
        ['workflow_dispatch', pilotRef, true, 'HostedPilot'],
        ['workflow_dispatch', 'refs/heads/other', true, 'HostedPilot'],
        ['pull_request', pilotRef, true, 'SelfTest'],
        ['schedule', pilotRef, true, 'SelfTest'],
        ['workflow_call', pilotRef, true, 'SelfTest'],
    ];
    for (const [event, ref, input, expected] of cases)
        assert.equal(
            workflowMode(source, event, ref, input),
            expected,
            `${event} ${ref} input=${input}`,
        );
}

test('only the exact branch push auto-selects the pilot; manual dispatch remains default-off', () => {
    branchTriggerContract(workflow);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /type: boolean\s+default: false/);
    assert.match(workflow, /runs-on: windows-latest/);
    assert.match(workflow, /contents: read/);
    assert.match(workflow, /if: \$\{\{ always\(\) && env\.PILOT_CASE != '' \}\}/);
    assert.match(workflow, /name: token-ui-pilot-v1-/);
    assert.doesNotMatch(
        workflow,
        /pull_request:|schedule:|workflow_call:|secrets\.|installer-qualification|release\.yml|npm (?:ci|install)|choco|winget|scoop/i,
    );
});

test('branch trigger and mode reject broader triggers, push self-test-only regression and manual default-on', () => {
    assert.throws(() =>
        branchTriggerContract(workflow.replace(`branches: [${pilotBranch}]`, 'branches: ["*"]')),
    );
    assert.throws(() =>
        branchTriggerContract(workflow.replace(`branches: [${pilotBranch}]`, 'branches: [main]')),
    );
    assert.throws(() =>
        branchTriggerContract(
            workflow.replace('    workflow_dispatch:', '    pull_request:\n    workflow_dispatch:'),
        ),
    );
    assert.throws(() =>
        branchTriggerContract(
            workflow.replace(
                /PILOT_EXECUTION_APPROVED:\s*\$\{\{[\s\S]*?\}\}/,
                "PILOT_EXECUTION_APPROVED: ${{ inputs.run_pilot && 'true' || 'false' }}",
            ),
        ),
    );
    assert.throws(() =>
        branchTriggerContract(
            workflow.replace(
                /PILOT_EXECUTION_APPROVED:\s*\$\{\{[\s\S]*?\}\}/,
                "PILOT_EXECUTION_APPROVED: ${{ (github.event_name == 'push' || inputs.run_pilot) && 'true' || 'false' }}",
            ),
        ),
    );
    assert.throws(() => branchTriggerContract(workflow.replace('default: false', 'default: true')));
});

test('operational entry is gated before native token or UI work', () => {
    const main = program.slice(program.indexOf('[STAThread] public static int Main'));
    assert.ok(main.indexOf('--self-test') < main.indexOf('HostedOnly()'));
    assert.ok(main.indexOf('HostedOnly()') < main.indexOf('return Run('));
    for (const key of [
        'GITHUB_ACTIONS',
        'CI',
        'RUNNER_ENVIRONMENT',
        'RUNNER_OS',
        'RUNNER_ARCH',
        'PILOT_EXECUTION_APPROVED',
        'GITHUB_RUN_ID',
        'GITHUB_RUN_ATTEMPT',
        'GITHUB_SHA',
    ])
        assert.ok(program.includes(key) && prepare.includes(key), key);
    assert.match(prepare, /\$Mode = 'Prepare'/);
    assert.match(prepare, /if \(\$Mode -eq 'HostedPilot'\) \{\s+#.*\s+& \$exe --run-hosted-pilot/);
    assert.match(prepare, /Refusing existing output\/case directory/);
});

test('only a reduced same-user token is created; no policy or manual privilege activation APIs', () => {
    assert.match(native, /SaferCreateLevel\(2,0x20000,1,/);
    assert.match(native, /SaferComputeTokenFromLevel\(level,original,out result,0,/);
    assert.match(native, /before\.IntegrityRid>=8192/);
    assert.match(native, /before\.IntegrityRid>8192/);
    assert.match(native, /SetTokenInformation\(result,25,/);
    assert.match(program, /Policy\.CanAttemptLaunch\(result\.Parent\.Process\.Token\)/);
    assert.match(
        program,
        /result\.LaunchQuotaState=Policy\.QuotaState\(result\.Parent\.Process\.Token\)/,
    );
    assert.doesNotMatch(program, /EnabledPrivileges\.Contains\("SeIncreaseQuotaPrivilege"/);
    const forbidden =
        /AdjustTokenPrivileges|SetThreadToken|ImpersonateLoggedOnUser|LogonUser\(|CreateProcessWithLogon|NetUser|NetLocalGroup|LsaAddAccountRights|SaferSet|SetSecurityInfo|SetNamedSecurityInfo|SetUserObjectSecurity|SetThreadDesktop|SwitchDesktop|CreateDesktop|LoadUserProfile|RegSetValue|RegistryKeyPermissionCheck\.ReadWriteSubTree|Set-ExecutionPolicy|ExecutionPolicy Bypass|runasinvoker|SANDBOX_INERT|SAFER_TOKEN_MAKE_INERT|SendInput|EnumWindows|GetProcesses\(/i;
    assert.doesNotMatch(native + program + prepare + workflow, forbidden);
});

test('reviewed child is suspended and job-contained before it can run', () => {
    assert.match(native, /false,0x4\|0x400\|0x08000000,IntPtr.Zero,cwd/);
    assert.match(native, /limits\.Basic\.Flags=0x2000/);
    assert.match(native, /AssignProcessToJobObject\(job,info\.Process\)/);
    assert.match(native, /TerminateProcess\(info\.Process,70\)/);
    assert.match(native, /SuspendedCleanupJoined=WaitForSingleObject/);
    assert.ok(
        program.indexOf('result.DriverSuspended=Native.ProcessFacts') <
            program.indexOf('Native.Resume(child)'),
    );
    assert.match(program, /result\.ForcedTermination=true;job\.Stop\(\)/);
    assert.match(model, /result\.ForcedTermination \|\| result\.JobActiveProcesses != 0/);
});

function ownedCaptureContract(source) {
    const capture = source.slice(source.indexOf('internal static void Capture('));
    assert.match(capture, /Policy\.RenderOwnedFrame\(handle\.ToInt64\(\),/);
    assert.match(capture, /PrintWindow\(new IntPtr\(owned\),dc,1\)/);
    assert.match(capture, /graphics\.Clear\(Color\.White\)/);
    assert.match(capture, /new Bitmap\(width,height,PixelFormat\.Format32bppRgb\)/);
    assert.match(capture, /finally\{graphics\.ReleaseHdc\(dc\);\}/);
    assert.match(capture, /FileMode\.CreateNew,FileAccess\.Write,FileShare\.None/);
    assert.match(capture, /AttestWindow\(handle,process\)/);
    assert.doesNotMatch(
        source,
        /CopyFromScreen|\b(?:BitBlt|StretchBlt|GetDC|GetWindowDC|GetDesktopWindow|DwmRegisterThumbnail)\s*\(/,
    );
}

test('UIA evidence stays scoped while capture accepts only the attested client renderer', () => {
    assert.match(program, /AutomationElement\.FromHandle\(handle\)/);
    assert.match(program, /AutomationElement\.ProcessIdProperty,pid/);
    assert.match(native, /pid==process\.Pid/);
    assert.match(native, /actual\.CreatedUtcTicks==process\.CreatedUtcTicks/);
    assert.match(native, /GetForegroundWindow\(\)==handle/);
    assert.match(native, /VirtualScreen\.Contains\(Rectangle\.FromLTRB\(outer\./);
    ownedCaptureContract(native);
    assert.match(native, /GetClientRect\(handle,out client\)/);
    assert.match(model, /d\.ScreenshotMethod!="PrintWindow\(PW_CLIENTONLY\)"/);
    assert.match(program, /"Pilot confirm "\+nonce/);
    assert.match(program, /"Pilot close "\+nonce/);
    assert.match(program, /dummy\.WaitForExit\(10000\)/);
    assert.match(program, /thread\.Join\(65000\)/);
    assert.match(program, /Native\.Wait\(child\.Process,90000\)/);
});

test('capture contracts reject the reviewed desktop-copy and unowned/full-window regressions', () => {
    assert.throws(() =>
        ownedCaptureContract(
            native.replace('PrintWindow(new IntPtr(owned),dc,1)', 'PrintWindow(IntPtr.Zero,dc,1)'),
        ),
    );
    assert.throws(() =>
        ownedCaptureContract(
            native.replace(
                'PrintWindow(new IntPtr(owned),dc,1)',
                'PrintWindow(new IntPtr(owned),dc,0)',
            ),
        ),
    );
    assert.throws(() =>
        ownedCaptureContract(
            native.replace(
                'PrintWindow(new IntPtr(owned),dc,1)',
                'CopyFromScreen(rect.Location,Point.Empty,rect.Size)',
            ),
        ),
    );
    assert.throws(() =>
        ownedCaptureContract(native.replace('finally{graphics.ReleaseHdc(dc);}', 'finally{}')),
    );
    assert.throws(() =>
        ownedCaptureContract(
            native.replace('PixelFormat.Format32bppRgb', 'PixelFormat.Format32bppArgb'),
        ),
    );
});

test('launch entry uses held privilege policy and keeps actual refusal/parent-modification evidence', () => {
    assert.match(model, /token\.Privileges\.TryGetValue\("SeIncreaseQuotaPrivilege"/);
    assert.match(model, /state=="held-enabled" \|\| state=="held-disabled"/);
    assert.match(program, /catch\(Exception error\) \{RecordFailure\(result,error\);\}/);
    assert.match(program, /result\.Win32Error=Win32Code\(error\)/);
    assert.match(model, /TokenSnapshot\(parent\) != TokenSnapshot\(result\.ParentAfter\)/);
});

function restrictionDiagnosticsContract(nativeSource, programSource) {
    const restricted = nativeSource.slice(
        nativeSource.indexOf('internal static KernelHandle Restricted('),
        nativeSource.indexOf('internal sealed class OwnedJob'),
    );
    assert.match(restricted, /trace\.Input=Token\(original\)/);
    assert.match(restricted, /trace\.BeforeIntegrity=before/);
    assert.ok(
        restricted.indexOf('Policy.RecordRestrictionCandidate(trace,parent,Token(result))') <
            restricted.indexOf('Policy.Require(trace.ValidationFailures.Length==0'),
        'candidate facts must be recorded before rejection',
    );
    assert.ok(restricted.includes('Policy.RecordRestrictionCandidate(trace,parent,Token(result))'));
    assert.match(restricted, /String\.Join\(", ",trace\.ValidationFailures\)/);
    assert.match(
        restricted,
        /catch \{result\.Dispose\(\);trace\.CandidateDisposeCalledOnFailure=true;throw;\}/,
    );
    assert.match(programSource, /result\.Restriction=new RestrictionFacts\(\)/);
    assert.match(
        programSource,
        /Native\.Restricted\(result\.Parent\.Process\.Token,result\.Restriction\)/,
    );
    assert.match(programSource, /finally \{\s+Policy\.AttachRestrictionCandidate\(result\);/);
    assert.match(nativeSource, /"TokenType\(8\)",Number\(token,8\)/);
    assert.match(nativeSource, /value\.IntegritySid=Info\(token,25/);
}

test('restriction diagnostics preserve queried facts and failure details before token disposal', () => {
    restrictionDiagnosticsContract(native, program);
    assert.match(
        model,
        /trace\.ValidationFailures = Child\(parent, candidate, "restricted"\)\.ToArray\(\)/,
    );
    assert.match(model, /trace\.PredicateResults = CandidateChecks\(parent, candidate\)/);
});

test('restriction diagnostics reject regressions that again discard failed candidate facts', () => {
    assert.throws(() =>
        restrictionDiagnosticsContract(
            native.replace('Policy.RecordRestrictionCandidate(trace,parent,Token(result))', ''),
            program,
        ),
    );
    assert.throws(() =>
        restrictionDiagnosticsContract(
            native,
            program.replace('Policy.AttachRestrictionCandidate(result);', ''),
        ),
    );
    assert.throws(() =>
        restrictionDiagnosticsContract(native.replace('trace.BeforeIntegrity=before', ''), program),
    );
    assert.throws(() =>
        restrictionDiagnosticsContract(
            native.replace(
                'result.Dispose();trace.CandidateDisposeCalledOnFailure=true;throw;',
                'throw;',
            ),
            program,
        ),
    );
});

test('helper requests no elevation or UIAccess; profiles are observed, not redirected', () => {
    assert.match(read(base + 'pilot.manifest'), /level="asInvoker" uiAccess="false"/);
    assert.match(native, /Registry\.Users\.OpenSubKey\(sid,false\)/);
    assert.match(native, /Environment\.SpecialFolder\.UserProfile/);
    assert.match(native, /Environment\.SpecialFolder\.ApplicationData/);
    assert.doesNotMatch(
        program + native + prepare,
        /EnvironmentVariables\s*\[|SetEnvironmentVariable|Set-Acl|New-LocalUser|net user|net localgroup|Registry\.(?:CurrentUser|LocalMachine)\.(?:Create|Set)/i,
    );
    assert.match(model, /parent-token-changed-or-missing/);
    assert.match(model, /enabled-group-expansion/);
    assert.match(model, /not-ordinary-medium-primary/);
});

test('installer entry points and old fixture are never invoked by pilot sources', () => {
    assert.doesNotMatch(
        program + native + prepare + workflow,
        /native-wizard-install-physical-fs|staged-artifact-gate|setup-worker|windows-setup\.nsi|Setup\.exe|makensis|\/allusers|--setup-worker/i,
    );
    assert.match(model, /PilotOnly = true, InstallerExecuted = false/);
});
