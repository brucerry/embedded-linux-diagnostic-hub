// Pure protocol checks: no SDK/config/application import, IO, timers or subprocess.
import assert from 'node:assert/strict';
import { SOURCE, TITLES, encode, frame, parseLog, validateSuccess, project } from './overview-log-receipt.mjs';
const observation = {
 schema: 1, boundary: 'mock-desktop-overview', connects: 1, disconnects: 1,
 collects: 7, terminalOpens: 0, terminalCloses: 0, terminalInputs: 0,
 captureExports: 0, updateRequests: 0, clockHeld: false, collectionHeld: false,
 phases: ['valid', 'overflow', 'missing-availability', 'malformed-contradictory', 'empty', 'genuine-zero', 'recovered'],
};
const expected = { source: SOURCE, tooling: 'a'.repeat(40), run: '100', attempt: '1', producerJobId: '101', receiptJobId: '102' };
const service = { ...expected,
 workflowStatus: 'completed', producerStatus: 'completed', receiptStatus: 'completed', sdkStatus: 'completed',
 workflowConclusion: 'success', producerConclusion: 'success', receiptConclusion: 'success', sdkConclusion: 'success',
};
function raw() {
 const [file, title] = Object.entries(TITLES)[0];
 return { source: SOURCE, tooling: expected.tooling, run: expected.run, attempt: '1',
  command: { schema: 1, exitCode: 0 }, sdkStepOutcome: 'success', report: {
   errors: [], stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
   suites: [{ specs: [{ file, title, ok: true, tests: [{ expectedStatus: 'passed', status: 'expected', results: [{
    status: 'passed', retry: 0, errors: [], attachments: [{ name: 'overview-readings-observation', contentType: 'application/json', body: Buffer.from(JSON.stringify(observation)).toString('base64') }],
   }] }] }] }],
  } };
}
const result = r => r.report.suites[0].specs[0].tests[0].results[0];
let checks = 0;
function check(name, callback) { callback(); checks++; console.log('ok ' + checks + ' - ' + name); }
check('successful single case and exact observation roundtrip', () => {
 const receipt = parseLog(frame(encode(raw()))).receipt;
 assert.equal(validateSuccess(receipt, expected, service).passed, 1);
});
check('passed case plus global teardown error fails', () => {
 const r = raw(); r.report.errors.push({ message: 'synthetic teardown failure' });
 assert.throws(() => validateSuccess(project(r), expected, service), /GLOBAL_ERROR/);
});
check('passed case plus nonzero command exit fails', () => {
 const r = raw(); r.command.exitCode = 1;
 assert.throws(() => validateSuccess(project(r), expected, service), /SDK/);
});
check('missing or cancelled SDK outcome fails', () => {
 for (const value of [undefined, 'cancelled']) {
  const r = raw(); r.sdkStepOutcome = value;
  assert.throws(() => validateSuccess(project(r), expected, service), /SDK/);
 }
});
check('failed or retried selected case fails', () => {
 for (const patch of [{ status: 'failed' }, { retry: 1 }, { errors: [{ message: 'synthetic case error' }] }]) {
  const r = raw(); Object.assign(result(r), patch);
  assert.throws(() => validateSuccess(project(r), expected, service), /CASE_FAILURE/);
 }
});
check('missing observation fails', () => {
 const r = raw(); result(r).attachments = [];
 assert.throws(() => validateSuccess(project(r), expected, service), /OBSERVATION/);
});
check('wrong phase list or unretired fake connection fails', () => {
 for (const patch of [{ phases: observation.phases.slice(0, 6) }, { disconnects: 0 }, { clockHeld: true }]) {
  const r = raw(); result(r).attachments[0].body = Buffer.from(JSON.stringify({ ...observation, ...patch })).toString('base64');
  assert.throws(() => validateSuccess(project(r), expected, service), /OBSERVATION_MISMATCH/);
 }
});
check('extra case or bad stats cannot pass', () => {
 const r = raw(); r.report.suites[0].specs.push(structuredClone(r.report.suites[0].specs[0]));
 assert.throws(() => validateSuccess(project(r), expected, service), /SPEC_COUNT/);
 r.report.suites[0].specs.pop(); r.report.stats.skipped = 1;
 assert.throws(() => validateSuccess(project(r), expected, service), /STATS/);
});
check('service run job and outcome must match independently', () => {
 for (const patch of [{ run: '200' }, { producerJobId: '201' }, { receiptJobId: '202' }, { producerConclusion: 'cancelled' }])
  assert.throws(() => validateSuccess(project(raw()), expected, { ...service, ...patch }), /SERVICE_/);
});
check('different source and missing identity fail', () => {
 const r = raw(); r.source = 'b'.repeat(40);
 assert.throws(() => project(r), /IDENTITY/);
 assert.throws(() => validateSuccess(project(raw()), { ...expected, receiptJobId: undefined }, service), /EXPECTED/);
});
check('raw projection and observation bounds fail closed', () => {
 const r = raw(); r.padding = 'x'.repeat(1048576);
 assert.throws(() => project(r), /RAW_CAP/);
 const a = raw(); result(a).attachments[0].body = Buffer.alloc(4097).toString('base64');
 assert.throws(() => project(a), /ATTACHMENT_CAP/);
 const b = raw(); b.report.errors = [{ message: 'x'.repeat(32769) }];
 assert.throws(() => project(b), /PROJECTION_CAP/);
});
check('bad duplicate oversized or absent log frame fails', () => {
 const f = frame(encode(raw()));
 assert.throws(() => parseLog(f + '\n' + f), /FRAME_COUNT/);
 assert.throws(() => parseLog('x'.repeat(1048577)), /LOG_CAP/);
 assert.throws(() => parseLog('no receipt'), /FRAME_COUNT/);
 assert.throws(() => parseLog(f.replace(/ [a-f0-9]{64} /, ' ' + 'f'.repeat(64) + ' ')), /FRAME_INTEGRITY/);
});
check('SDK error-context metadata no longer suppresses original failure facts', () => {
 for (const keepObservation of [false, true]) {
  const r = raw(); r.command.exitCode = 1; r.sdkStepOutcome = 'failure';
  r.report.stats.expected = 0; r.report.stats.unexpected = 1;
  const spec = r.report.suites[0].specs[0]; spec.ok = false;
  spec.tests[0].status = 'unexpected'; const x = result(r); x.status = 'failed';
  x.error = { message: 'synthetic primary assertion failure' };
  x.errors = [{ message: 'synthetic primary assertion failure' }];
  if (!keepObservation) x.attachments = [];
  x.attachments.push({ name: 'error-context', contentType: 'text/markdown',
   path: '/owned/synthetic/context-file.md', body: Buffer.from('synthetic context document').toString('base64') });
  const before = JSON.stringify(r), v = project(r), projected = v.report.suites[0].specs[0].tests[0].results[0];
  assert.deepEqual(projected.errors, x.errors); assert.deepEqual(projected.error, x.error);
  assert.deepEqual(v.command, r.command); assert.equal(v.sdkStepOutcome, 'failure');
  assert.deepEqual(projected.attachments.at(-1), { name: 'error-context', contentType: 'text/markdown',
   bodyOmitted: true, pathOmitted: true, policy: 'sdk-failure-context-metadata-only' });
  assert.equal(JSON.stringify(v).includes('/owned/synthetic/context-file.md'), false);
  assert.equal(JSON.stringify(v).includes(Buffer.from('synthetic context document').toString('base64')), false);
  assert.equal(JSON.stringify(r), before);
  assert.throws(() => validateSuccess(v, expected, service), /SDK/);
  assert.deepEqual(parseLog(frame(encode(r))).receipt, v);
 }
});
check('SDK context marker cannot qualify a supposedly passed receipt', () => {
 const r = raw(); result(r).attachments.push({ name: 'error-context', contentType: 'text/markdown', path: '/owned/context.md' });
 assert.throws(() => validateSuccess(project(r), expected, service), /OBSERVATION/);
});
check('unrecognized attachments and malformed SDK context still fail closed', () => {
 for (const attachment of [
  { name: 'unknown', contentType: 'text/markdown', path: '/owned/context.md' },
  { name: 'error-context', contentType: 'text/html', path: '/owned/context.md' },
  { name: 'error-context', contentType: 'text/markdown' },
  { name: 'error-context', contentType: 'text/markdown', path: 'x'.repeat(4097) },
 ]) {
  const r = raw(); result(r).attachments.push(attachment);
  assert.throws(() => project(r), /ATTACHMENT|SDK_CONTEXT/);
 }
});
console.log(JSON.stringify({ pureChecks: checks, sdkOrBrowserExecuted: false }));
