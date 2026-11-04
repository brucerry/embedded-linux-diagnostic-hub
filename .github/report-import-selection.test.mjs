// Source data only. Never evaluate SDK, app, fixtures or configuration.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../tests/ui/report-import-reliability.spec.ts');
const corpus = read('../tests/ui/fixtures/report-import-data.ts');
const config = read('./report-import-candidate.config.ts');
const workflow = read('./workflows/report-import-candidate.yml');
const titles = [...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]);
assert.deepEqual(titles, ['historical report import rejects malformed replacements preserves current evidence and admits a later valid report']);
assert.equal((source.match(/^test\(/gm) ?? []).length, 1);
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
    for (const prefix of ['report-import-reliability.spec.ts ', '  report-import-reliability.spec.ts ', ' chromium report-import-reliability.spec.ts ']) { assert.ok(grep.test(prefix + title)); accepted++; }
    for (const value of [title, 'workspace.spec.ts ' + title, 'report-import-reliability.spec.ts extra ' + title, 'report-import-reliability.spec.ts ' + title + ' extra']) { assert.equal(grep.test(value), false); rejected++; }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 29);
for (const [file, expected] of Object.entries(pins)) {
    assert.ok(['vite.config.mts', 'package.json', 'package-lock.json'].includes(file) || /^(tests|shared|src)\/[a-zA-Z0-9_./-]+\.tsx?$/.test(file));
    assert.ok(!file.split('/').includes('..'));
    assert.equal(hash(read('../' + file)), expected);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
for (const fact of ["name: 'replacement.json'", "await expect(input).toHaveValue('')", 'JSON.stringify(REPORT_IMPORT_A)', 'JSON.stringify(REPORT_IMPORT_B)', 'for (const invalid of invalidReportImports())', "page.locator('.error-banner[role=alert]')", "name: 'Search diagnostics'", "name: 'Collect snapshot'", 'toBeDisabled()', 'toBeEnabled()', 'textContent()).toBe(REPORT_IMPORT_A.results[0].stdout)', 'textContent()).toBe(REPORT_IMPORT_A.results[0].stderr)', 'textContent()).toBe(REPORT_IMPORT_A.results[0].command)', 'textContent()).toBe(REPORT_IMPORT_B.results[0].stdout)', 'textContent()).toBe(REPORT_IMPORT_B.results[0].command)', 'Output was truncated. This report contains only the retained output.', 'Historical SSH evidence opened locally. No device connection or upload.', "typeof window.diagnosticHub", 'acceptedReports: 2', 'deviceConnectionActionsRequested: 0, nativeBridgeAbsent: true, downloadsRequested: 0']) assert.ok(source.includes(fact), fact);
for (const fact of ['1969-12-31T23:59:59.000Z', '2028-02-29T12:34:56.123456+05:30', 'JSON syntax', 'duplicate diagnostic identity', 'invalid historical calendar date']) assert.ok(corpus.includes(fact), fact);
for (const forbidden of ['.delete(', '.deleteDatabase(', '.clear(', '.forget(', 'readFile(', '.saveAs(', 'screenshot(', 'gatewayFixture', 'page.clock.', "waitForEvent('download')", 'installDesktop', 'startUpdate']) assert.equal(source.includes(forbidden), false);
assert.equal((source.match(/await info\.attach\(/g) ?? []).length, 1);
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1', "trace: 'off'", "screenshot: 'off'", "video: 'off'", 'timeout: 90_000', 'globalTimeout: 180_000']) assert.ok(config.includes(fact));
assert.ok(workflow.includes('branches: [ci/integration216-report-import]'));
for (const fact of ['timeout-minutes: 15', 'contents: read', 'retention-days: 3', '1048576', 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org', 'socket_bytes > 107']) assert.ok(workflow.includes(fact));
for (const forbidden of ['workflow_dispatch:', 'secrets.', '--no-sandbox']) assert.equal(workflow.includes(forbidden), false);
assert.ok(workflow.includes('scope="$RUNNER_TEMP/ri-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'));
const sdkPins = JSON.parse(workflow.match(/const sdkPins = (\{[^\r\n]+\});/)[1]);
assert.deepEqual(Object.keys(sdkPins), ['node_modules/playwright/lib/runner/index.js', 'node_modules/playwright/lib/worker/workerProcessEntry.js']);
for (const value of Object.values(sdkPins)) assert.match(value, /^[a-f0-9]{64}$/);
const socketBytes = Buffer.byteLength('/home/runner/work/_temp/ri-41676005405-1/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket');
assert.equal(socketBytes, 89);
assert.ok(workflow.indexOf('socket_bytes=${#socket_probe}') < workflow.indexOf('mkdir "$scope"'));
console.log(JSON.stringify({selectedScenarios: 1, definedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected, sourcePins: Object.keys(pins).length, sdkSerializerPins: Object.keys(sdkPins).length, validReports: 2, invalidReports: 3, fixtureBytesLimitEach: 4096, downloads: 0, socketBytes, mountedExecuted: 0}));

// Bind this cohort to the combined source checkpoint, not a historical sibling.
assert.ok(workflow.includes("ref: 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("test \"$(git -C tooling rev-parse HEAD^)\" = 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("825f83b3489382bdf68518f4135e6cd60ebfec79"));
