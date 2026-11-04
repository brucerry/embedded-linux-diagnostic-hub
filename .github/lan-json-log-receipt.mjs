import { createHash } from 'node:crypto';
export const SOURCE = 'a6ab44e1196a13c8a4d858a6cb026bb06d22b237';
export const MAX_RAW = 1048576, MAX_PROJECTION = 32768, MAX_LOG = 1048576;
export const PREFIX = 'HUB_LAN241_V1';
export const TITLES = Object.freeze({
 'lan-json-syntax.spec.ts': 'LAN rejects malformed numeric-key JSON, retains address fallback and displays exact 64-bit counters',
});
const need = (v, m) => { if (!v) throw Error(m); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const hash = b => createHash('sha256').update(b).digest('hex');
const id = v => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v);
const hex = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
function specsOf(report) {
 need(object(report) && Array.isArray(report.suites), 'REPORT');
 const stack = [...report.suites], specs = [];
 while (stack.length) {
  const s = stack.pop(); need(object(s) && Array.isArray(s.specs ?? []) && Array.isArray(s.suites ?? []), 'SUITE');
  specs.push(...(s.specs ?? [])); stack.push(...(s.suites ?? []));
 }
 return specs;
}
function errorFields(v) {
 need(Array.isArray(v.errors ?? []), 'ERRORS');
 return { errors: structuredClone(v.errors ?? []), ...(v.error === undefined ? {} : { error: structuredClone(v.error) }) };
}
/** Preserve all selected result/error facts; omit SDK config/timing/stdout/stderr/location metadata and explicitly mark the SDK failure-context document as metadata-only.
 * Oversized projections fail; no field, error or attachment is truncated to make it fit. */
export function project(raw) {
 need(object(raw) && Buffer.byteLength(JSON.stringify(raw)) <= MAX_RAW, 'RAW_CAP');
 need(raw.source === SOURCE && hex(raw.tooling) && id(raw.run) && raw.attempt === '1', 'IDENTITY');
 const specs = specsOf(raw.report).map(s => {
  need(object(s) && Array.isArray(s.tests), 'SPEC');
  return { file: s.file, title: s.title, ok: s.ok, tests: s.tests.map(t => {
   need(object(t) && Array.isArray(t.results), 'TEST');
   return { expectedStatus: t.expectedStatus, status: t.status, results: t.results.map(v => {
    need(object(v) && Array.isArray(v.attachments ?? []), 'RESULT');
    const attachments = (v.attachments ?? []).map(a => {
     need(object(a), 'ATTACHMENT');
     // Playwright can attach error-context.md even with trace/screenshot/video off.
     // Preserve failure facts without reading or emitting that separate document,
     // its path, or its body. This explicit metadata marker cannot qualify success.
     if (a.name === 'error-context') {
      need(a.contentType === 'text/markdown' &&
       ((typeof a.path === 'string' && a.path.length > 0 && a.path.length <= 4096) ||
        typeof a.body === 'string'), 'SDK_CONTEXT');
      return { name: 'error-context', contentType: 'text/markdown',
       bodyOmitted: true, pathOmitted: true, policy: 'sdk-failure-context-metadata-only' };
     }
     need(['lan-json-observation'].includes(a.name) &&
      a.contentType === 'application/json' && typeof a.body === 'string' && a.body.length <= 5464, 'ATTACHMENT');
     const b = Buffer.from(a.body, 'base64'); need(b.length <= 4096 && b.toString('base64') === a.body, 'ATTACHMENT_CAP');
     return structuredClone(a);
    });
    return { status: v.status, retry: v.retry, ...errorFields(v), attachments };
   }) };
  }) };
 });
 const value = { schema: 1, transport: 'receipt-only-job-log-v1', source: raw.source, tooling: raw.tooling,
  run: raw.run, attempt: raw.attempt, producer: 'files', command: structuredClone(raw.command),
  sdkStepOutcome: raw.sdkStepOutcome, report: { ...errorFields(raw.report), stats: structuredClone(raw.report.stats), suites: [{ specs }] } };
 const body = Buffer.from(JSON.stringify(value)); need(body.length <= MAX_PROJECTION, 'PROJECTION_CAP');
 return value;
}
export function encode(raw) {
 const value = project(raw), body = Buffer.from(JSON.stringify(value));
 return { payload: body.toString('base64'), bytes: body.length, digest: hash(body), value };
}
export function frame(encoded) {
 need(object(encoded) && Number.isInteger(encoded.bytes) && encoded.bytes > 0 && encoded.bytes <= MAX_PROJECTION &&
  typeof encoded.digest === 'string' && /^[a-f0-9]{64}$/.test(encoded.digest) &&
  typeof encoded.payload === 'string' && encoded.payload.length <= 43692 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded.payload), 'FRAME');
 return PREFIX + ' ' + encoded.bytes + ' ' + encoded.digest + ' ' + encoded.payload;
}
/** Post-read cap only: the supported reader cannot enforce a pre-download HTTP limit. */
export function parseLog(text) {
 need(typeof text === 'string' && Buffer.byteLength(text) <= MAX_LOG, 'LOG_CAP');
 const lines = text.split(/\r?\n/).map(l => l.replace(/^\d{4}-\d\d-\d\dT[0-9:.]+Z /, ''));
 const candidates = lines.filter(l => l.startsWith(PREFIX + ' ')); need(candidates.length === 1, 'FRAME_COUNT');
 const m = candidates[0].match(/^HUB_LAN241_V1 ([1-9][0-9]{0,4}) ([a-f0-9]{64}) ([A-Za-z0-9+/]+={0,2})$/);
 need(m && Number(m[1]) <= MAX_PROJECTION && m[3].length <= 43692, 'FRAME_FORMAT');
 const body = Buffer.from(m[3], 'base64');
 need(body.toString('base64') === m[3] && body.length === Number(m[1]) && hash(body) === m[2], 'FRAME_INTEGRITY');
 return { receipt: JSON.parse(body.toString()), receiptSHA256: m[2], receiptBytes: body.length, logSHA256: hash(Buffer.from(text)) };
}
/** Independently selected service run/two-job metadata is a required caller input. */
export function validateSuccess(v, expected, service) {
 need(object(expected) && object(service) && expected.source === SOURCE && hex(expected.tooling) &&
  id(expected.run) && expected.attempt === '1' && id(expected.producerJobId) && id(expected.receiptJobId) &&
  expected.producerJobId !== expected.receiptJobId, 'EXPECTED');
 for (const key of ['source', 'tooling', 'run', 'attempt', 'producerJobId', 'receiptJobId'])
  need(service[key] === expected[key], 'SERVICE_ID');
 for (const key of ['workflowStatus', 'producerStatus', 'receiptStatus', 'sdkStatus']) need(service[key] === 'completed', 'SERVICE_PENDING');
 for (const key of ['workflowConclusion', 'producerConclusion', 'receiptConclusion', 'sdkConclusion']) need(service[key] === 'success', 'SERVICE_FAILURE');
 need(object(v) && v.schema === 1 && v.transport === 'receipt-only-job-log-v1' && v.producer === 'files', 'PROJECTION');
 for (const key of ['source', 'tooling', 'run', 'attempt']) need(v[key] === expected[key], 'RECEIPT_ID');
 need(object(v.command) && v.command.schema === 1 && Number.isInteger(v.command.exitCode) && v.command.exitCode === 0 &&
  v.sdkStepOutcome === 'success', 'SDK');
 need(Array.isArray(v.report.errors) && v.report.errors.length === 0 && !v.report.error, 'GLOBAL_ERROR');
 for (const [key, value] of Object.entries({ expected: 1, unexpected: 0, skipped: 0, flaky: 0 })) need(v.report.stats?.[key] === value, 'STATS');
 const specs = specsOf(v.report); need(specs.length === 1, 'SPEC_COUNT'); const seen = new Set();
 for (const s of specs) {
  need(s.file in TITLES && !seen.has(s.file) && s.title === TITLES[s.file] && s.ok === true && s.tests?.length === 1, 'SELECTED');
  seen.add(s.file); const t = s.tests[0]; need(t.expectedStatus === 'passed' && t.status === 'expected' && t.results?.length === 1, 'TEST_RESULT');
  const x = t.results[0]; need(x.status === 'passed' && x.retry === 0 && Array.isArray(x.errors) && !x.errors.length && !x.error, 'CASE_FAILURE');
  need(x.attachments?.length === 1 && x.attachments[0].name === 'lan-json-observation', 'OBSERVATION');
  const o = JSON.parse(Buffer.from(x.attachments[0].body, 'base64').toString());
  const want = {
   schema:1,boundary:'synthetic-imported-lan',phases:[
    {phase:'malformed-link',interfaces:[],warnings:1,rawExact:true},
    {phase:'address-fallback',interfaces:['eth0 · ifindex 7'],warnings:1,rawExact:true},
    {phase:'exact-counter',interfaces:['eth0 · ifindex 7'],warnings:0,rawExact:true},
   ],primaryRawExact:true,maximumCounter:'18446744073709551615',dialogsClosed:true,
   bridge:{connects:0,disconnects:0,collects:0,terminalOpens:0,terminalCloses:0,terminalInputs:0,terminalOwnerEmpty:true,captureExports:0,updateRequests:0},
  };
  need(object(o) && JSON.stringify(Object.keys(o).sort()) === JSON.stringify(Object.keys(want).sort()), 'OBSERVATION_SHAPE');
  for (const [key, val] of Object.entries(want)) need(JSON.stringify(o[key]) === JSON.stringify(val), 'OBSERVATION_MISMATCH');
 }
 return { status: 'passed-exact-lan-json-one-case-log-receipt', source: v.source, tooling: v.tooling, run: v.run,
  producerJobId: expected.producerJobId, receiptJobId: expected.receiptJobId, passed: 1, failed: 0, retries: 0 };
}
