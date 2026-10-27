import { APP_VERSION } from '../project';
import { validateInventory, validateResource } from './inventory';
import { validateProfile, validateReadiness, validateTest, matches } from './profile';
import { caseVerdict, summarizeRun } from './runner';
import {
    CASE_BYTES,
    REPORT_BYTES,
    RUN_BYTES,
    type CaseResult,
    type Evidence,
    type TestReport,
    type TestRun,
} from './types';
import {
    bool,
    bounded,
    canonical,
    choice,
    date,
    digest,
    id,
    list,
    number,
    object,
    text,
    unique,
} from './validation';

export function validateRun(input: unknown): TestRun {
    bounded(input, REPORT_BYTES, 'Run');
    const v = object(
        input,
        [
            'id',
            'mode',
            'phase',
            'startedAt',
            'finishedAt',
            'interruption',
            'profile',
            'profileDigest',
            'inventory',
            'sequence',
            'readiness',
            'cases',
            'verdict',
        ],
        'Run',
    );
    const profile = validateProfile(v.profile),
        inventory = validateInventory(v.inventory);
    const readiness = validateReadiness(v.readiness, profile.tests);
    const cases = unique(
        list(v.cases, 'Case results', 64).map((raw): CaseResult => {
            const c = object(
                raw,
                [
                    'test',
                    'adapterVersion',
                    'resource',
                    'status',
                    'verdict',
                    'reason',
                    'startedAt',
                    'finishedAt',
                    'evidence',
                    'feedback',
                ],
                'Case',
            );
            const test = validateTest(c.test);
            if (!profile.tests.some((t) => t.id === test.id && canonical(t) === canonical(test)))
                throw Error('Case test differs from its recorded profile.');
            const resource = c.resource === null ? null : validateResource(c.resource);
            if (
                resource &&
                (!inventory.resources.some(
                    (r) => r.id === resource.id && canonical(r) === canonical(resource),
                ) ||
                    resource.domain !==
                        profile.resources.find((r) => r.id === test.resource)!.domain ||
                    !matches(
                        resource,
                        profile.resources.find((r) => r.id === test.resource)!.selector,
                    ))
            )
                throw Error('Case resource differs from its recorded inventory/mapping.');
            let evidence: Evidence | null = null;
            if (c.evidence !== null) {
                const e = object(
                    c.evidence,
                    [
                        'execution',
                        'reason',
                        'measured',
                        'stdout',
                        'stderr',
                        'exitCode',
                        'durationMs',
                        'truncated',
                        'cleanup',
                        'cleanupDetail',
                        'interrupted',
                    ],
                    'Evidence',
                );
                if (
                    e.measured !== null &&
                    typeof e.measured !== 'number' &&
                    typeof e.measured !== 'string'
                )
                    throw Error('Invalid measurement.');
                const stdout = text(e.stdout, 'Stdout', CASE_BYTES),
                    stderr = text(e.stderr, 'Stderr', CASE_BYTES + 1024);
                if (new TextEncoder().encode(stdout + stderr).length > CASE_BYTES + 1024)
                    throw Error('Case output exceeds limits.');
                evidence = {
                    execution: choice(
                        e.execution,
                        ['ok', 'mismatch', 'blocked', 'interrupted', 'error', 'skipped'],
                        'Execution',
                    ),
                    reason: text(e.reason, 'Evidence reason', 4096),
                    measured:
                        typeof e.measured === 'string'
                            ? text(e.measured, 'Measurement', 32768)
                            : e.measured === null
                              ? null
                              : number(e.measured, 'Measurement', 0, 255),
                    stdout,
                    stderr,
                    exitCode: e.exitCode === null ? null : number(e.exitCode, 'Exit code', -1, 255),
                    durationMs: number(e.durationMs, 'Duration', 0, 70000),
                    truncated: bool(e.truncated, 'Truncated'),
                    cleanup: choice(e.cleanup, ['verified', 'unverified', 'not-needed'], 'Cleanup'),
                    cleanupDetail: text(e.cleanupDetail, 'Cleanup detail', 4096),
                };
            }
            let feedback: CaseResult['feedback'] = null;
            if (c.feedback !== null) {
                const f = object(c.feedback, ['value', 'at'], 'Feedback');
                feedback = {
                    value: choice(f.value, ['yes', 'no', 'unobserved'], 'Observation'),
                    at: date(f.at, 'Observation timestamp'),
                };
                if (test.adapter !== 'led.pattern' || evidence?.execution !== 'ok')
                    throw Error('Feedback does not belong to an observed LED case.');
            }
            const result: CaseResult = {
                test,
                adapterVersion: text(c.adapterVersion, 'Adapter version', 64, false),
                resource,
                status: choice(c.status, ['pending', 'running', 'done'], 'Case status'),
                verdict: choice(
                    c.verdict,
                    ['Pass', 'Fail', 'Blocked', 'Skipped', 'Inconclusive'],
                    'Verdict',
                ),
                reason: text(c.reason, 'Reason', 4096),
                startedAt: date(c.startedAt, 'Case start', true),
                finishedAt: date(c.finishedAt, 'Case finish', true),
                evidence,
                feedback,
            };
            if (
                result.verdict !== caseVerdict(result) ||
                (result.verdict === 'Pass' &&
                    (!resource ||
                        !readiness.reviewed ||
                        !readiness.fixtures[test.id]?.ready ||
                        evidence?.exitCode !== 0 ||
                        (test.adapter !== 'i2c.identity' && evidence.cleanup !== 'verified'))) ||
                (result.status === 'done' && !evidence)
            )
                throw Error('Case verdict is inconsistent with its evidence.');
            return result;
        }),
        (c) => c.test.id,
        'Cases',
    );
    if (
        new TextEncoder().encode(
            cases.map((c) => (c.evidence?.stdout || '') + (c.evidence?.stderr || '')).join(''),
        ).length >
        RUN_BYTES + 65536
    )
        throw Error('Run evidence exceeds limits.');
    const profileDigest = text(v.profileDigest, 'Profile digest', 64, false);
    if (!/^[0-9a-f]{64}$/.test(profileDigest)) throw Error('Invalid profile digest.');
    const run: TestRun = {
        id: id(v.id, 'Run ID'),
        mode: choice(v.mode, ['ssh', 'simulated'], 'Run source'),
        phase: choice(
            v.phase,
            ['preparing', 'running', 'cleaning', 'review', 'complete', 'cancelled'],
            'Run phase',
        ),
        startedAt: date(v.startedAt, 'Run start'),
        finishedAt: date(v.finishedAt, 'Run finish', true),
        interruption: text(v.interruption, 'Interruption', 4096),
        profile,
        profileDigest,
        inventory,
        sequence: text(v.sequence, 'Sequence', 64),
        readiness,
        cases,
        verdict: choice(
            v.verdict,
            ['Pass', 'Fail', 'Blocked', 'Skipped', 'Inconclusive'],
            'Run verdict',
        ),
    };
    if (run.mode !== inventory.mode || run.verdict !== summarizeRun(run))
        throw Error('Run source/verdict is inconsistent.');
    if (
        ['complete', 'cancelled', 'review'].includes(run.phase) &&
        (!run.finishedAt || cases.some((c) => c.status !== 'done'))
    )
        throw Error('Finished run has incomplete case state.');
    return run;
}
export function createTestReport(run: TestRun, imported = false): TestReport {
    return {
        format: 'diagnostic-hub-test-report',
        schemaVersion: 1,
        applicationVersion: APP_VERSION,
        generatedAt: new Date().toISOString(),
        imported,
        run: validateRun(run),
    };
}
export async function validateTestReport(input: unknown): Promise<TestReport> {
    bounded(input, REPORT_BYTES, 'Test report');
    const v = object(
        input,
        ['format', 'schemaVersion', 'applicationVersion', 'generatedAt', 'imported', 'run'],
        'Test report',
    );
    if (v.format !== 'diagnostic-hub-test-report' || v.schemaVersion !== 1)
        throw Error('Unsupported test report. Import a Diagnostic Hub test JSON report, schema 1.');
    const run = validateRun(v.run);
    if (run.profileDigest !== (await digest(run.profile)))
        throw Error('Profile digest does not match the recorded profile.');
    return {
        format: 'diagnostic-hub-test-report',
        schemaVersion: 1,
        applicationVersion: text(v.applicationVersion, 'Application version', 64, false),
        generatedAt: date(v.generatedAt, 'Generated'),
        imported: bool(v.imported, 'Imported'),
        run,
    };
}
export async function parseTestReport(content: string): Promise<TestReport> {
    if (new TextEncoder().encode(content).length > REPORT_BYTES)
        throw Error('Test report exceeds the 16 MiB limit.');
    let input: unknown;
    try {
        input = JSON.parse(content);
    } catch {
        throw Error('The selected test report is not valid JSON.');
    }
    const report = await validateTestReport(input);
    report.imported = true;
    return report;
}
export const escapeText = (value: unknown): string =>
    String(value ?? '').replace(
        /[&<>"']/g,
        (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]!,
    );
export function reportHtml(report: TestReport): string {
    const r = report.run,
        e = escapeText;
    const counts = ['Pass', 'Fail', 'Blocked', 'Skipped', 'Inconclusive']
        .map(
            (v) =>
                `<span class="count"><b>${r.cases.filter((c) => c.verdict === v).length}</b> ${v}</span>`,
        )
        .join('');
    const rows = r.cases
        .map(
            (c) =>
                `<tr><td>${e(c.test.name)}<small>${e(c.test.adapter)} · ${e(c.adapterVersion)}</small></td><td><span class="badge ${c.verdict.toLowerCase()}">${c.verdict}</span></td><td>${e(c.reason)}</td></tr>`,
        )
        .join('');
    const metadata = (key: string, value: unknown) =>
        `<div><dt>${key}</dt><dd>${e(value === null || value === undefined || value === '' ? 'Unknown / not observed' : value)}</dd></div>`;
    const details = r.cases
        .map(
            (c, i) =>
                `<section class="case"><h2>${i + 1}. ${e(c.test.name)} <span class="badge ${c.verdict.toLowerCase()}">${c.verdict}</span></h2><dl>${metadata('Adapter', `${c.test.adapter} · ${c.adapterVersion}`)}${metadata('Resolved resource', c.resource?.path)}${metadata('Device-tree source', c.resource?.ofNode)}${metadata('Expected behavior', c.test.expected)}${metadata('Parameters', JSON.stringify(c.test.parameters))}${metadata('Observed value', c.evidence?.measured === null ? '' : c.evidence?.measured)}${metadata('Fixture requirement', c.test.fixture)}${metadata('Fixture identity / readiness', `${r.readiness.fixtures[c.test.id]?.identity || 'Identity not recorded'} / ${r.readiness.fixtures[c.test.id]?.ready ? 'Declared ready' : 'Not ready'}`)}${metadata('Operator observation', c.feedback ? `${c.feedback.value} · ${c.feedback.at}` : 'Not recorded')}${metadata('Result reason', c.reason)}${metadata('Cleanup', c.evidence ? `${c.evidence.cleanup} · ${c.evidence.cleanupDetail}` : 'Not executed')}${metadata('Started / finished (UTC)', `${c.startedAt || 'Not started'} / ${c.finishedAt || 'Not finished'}`)}${metadata('Duration / exit code', `${c.evidence?.durationMs ?? 0} ms / ${c.evidence?.exitCode ?? 'Unknown'}`)}</dl></section>`,
        )
        .join('');
    const raw = r.cases
        .map(
            (c) =>
                `<section class="raw"><h3>${e(c.test.name)}</h3>${c.evidence?.truncated ? '<p>Evidence truncated; interpretation is limited.</p>' : ''}<h4>Standard output</h4><pre>${e(c.evidence?.stdout || '(No output)')}</pre><h4>Standard error</h4><pre>${e(c.evidence?.stderr || '(No errors recorded)')}</pre></section>`,
        )
        .join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Board test report · ${e(r.profile.name)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#eef2f2;color:#243235;font:14px/1.55 'Segoe UI',Arial,sans-serif}.paper{max-width:960px;margin:32px auto;padding:44px 48px;background:white}header{border-top:5px solid #21836d;padding-top:22px;margin-bottom:28px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:2px;color:#47645d}h1{font-size:30px;line-height:1.2;margin:10px 0}h2{font-size:18px;margin:26px 0 12px}h3{font-size:15px;margin:24px 0 8px}h4{font-size:12px;margin:12px 0 6px}.source{font-weight:700;color:#76551e}.summary{padding:18px 20px;background:#f0f7f4;border:1px solid #d5e6de}.summary strong{font-size:20px}.counts{display:flex;flex-wrap:wrap;gap:18px;margin-top:12px}.count b{font-size:18px}dl{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px;margin:20px 0}dl div{min-width:0}dt{font-size:11px;color:#5c7073;text-transform:uppercase;letter-spacing:.5px}dd{margin:3px 0 0;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;background:#eff4f3}td,th{padding:11px 10px;border-bottom:1px solid #dce5e3;vertical-align:top;overflow-wrap:anywhere}td:first-child{width:32%}td:nth-child(2){width:16%}small{display:block;color:#607574;margin-top:3px}.badge{display:inline-block;padding:3px 8px;border:1px solid #b3c6c0;border-radius:5px;font-size:11px;white-space:nowrap;color:#274d40;background:#f4f8f6}.fail{color:#8a2836;background:#fff1f2;border-color:#e5b8bf}.blocked,.inconclusive{color:#765719;background:#fff9e8;border-color:#dbc895}.skipped{color:#566570;background:#f1f4f7}.case{border-top:1px solid #dde6e3;margin-top:24px}.case h2{break-after:avoid}.raw pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:11px/1.5 Consolas,monospace;background:#f5f7f7;padding:12px;border:1px solid #e0e7e5}.appendix{break-before:page}footer{margin-top:32px;border-top:1px solid #dbe5e2;padding-top:12px;color:#617572;font-size:11px}@page{size:A4;margin:18mm 16mm}@media print{body{background:white;font-size:10pt}.paper{margin:0;padding:0;max-width:none}h1{font-size:24pt}.counts{gap:12px}thead{display:table-header-group}tr,dl div{break-inside:avoid}h2,h3,h4{break-after:avoid}pre{background:white!important;font-size:8pt}.summary,.badge,th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}@media(max-width:600px){.paper{padding:24px;margin:0}dl{grid-template-columns:1fr}h1{font-size:24px}}
</style></head><body><main class="paper"><header><div class="eyebrow">DIAGNOSTIC HUB / BOARD TEST EVIDENCE</div><h1>${e(r.profile.name)}</h1><p class="source">${r.mode === 'simulated' ? 'SIMULATED DATA - NOT PHYSICAL HARDWARE QUALIFICATION' : 'SSH DEVICE EVIDENCE'}${report.imported ? ' · IMPORTED HISTORICAL REPORT' : ''}</p></header><section class="summary"><strong>Overall: ${r.verdict}</strong><div>Run state: ${e(r.phase)}${r.interruption ? ` · ${e(r.interruption)}` : ''}</div><div class="counts">${counts}</div></section><dl>${metadata('Observed board', r.inventory.device.model)}${metadata('Declared board revision', r.profile.boardRevision)}${metadata('Observed serial', r.inventory.device.serial)}${metadata('Kernel', r.inventory.device.kernel)}${metadata('Firmware / OS evidence', r.inventory.device.firmware)}${metadata('Endpoint / SSH user', `${r.inventory.endpoint} / ${r.inventory.username}`)}${metadata('Profile revision', `${r.profile.id} · ${r.profile.revision}`)}${metadata('Profile SHA-256', r.profileDigest)}${metadata('Run ID', r.id)}${metadata('Sequence', r.sequence || 'Selected individual tests')}${metadata('Run started / finished (UTC)', `${r.startedAt} / ${r.finishedAt || 'Still running'}`)}${metadata('Inventory source / completeness', `${r.inventory.mode} · ${r.inventory.capturedAt} · ${r.inventory.complete ? 'Complete' : 'Incomplete'}`)}${metadata('Inventory limitations', r.inventory.issues.join('; ') || 'No discovery errors recorded')}${metadata('Document generated (UTC)', report.generatedAt)}</dl><h2>Test results</h2><table><thead><tr><th>Test</th><th>Verdict</th><th>Evidence / limitation</th></tr></thead><tbody>${rows}</tbody></table>${details}<section class="appendix"><h2>Raw evidence appendix</h2>${raw}</section><footer>Diagnostic Hub ${e(report.applicationVersion)} · Test report schema 1 · Verdicts describe only the selected tests and recorded observations. Unknown metadata and unverified cleanup are not passes.</footer></main></body></html>`;
}
