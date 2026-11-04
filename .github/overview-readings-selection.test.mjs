// Read source data only; never import the SDK, application, configuration or fixtures.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const hash = b => createHash('sha256').update(b).digest('hex');
const config = read('./overview-readings-candidate.config.ts');
const workflow = read('./workflows/overview-readings-candidate.yml');
const file = 'overview-unknown-readings.spec.ts';
const title = 'Overview renders unknown uptime and memory without false zero and recovers genuine values';
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
assert(config.includes("testMatch: ['" + file + "']"));
let accepted = 0, rejected = 0;
for (const prefix of ['', '  ', 'chromium ']) { assert(grep.test(prefix + file + ' ' + title)); accepted++; }
for (const value of [title, file + ' extra ' + title, file + ' ' + title + ' extra',
 'automation.spec.ts ' + title, 'ssh-console-gateway.spec.ts ' + title,
 'stored-serial-results.spec.ts ' + title, 'stored-console-results.spec.ts ' + title]) {
 assert.equal(grep.test(value), false); rejected++;
}
const specs = readdirSync(new URL('../tests/ui/', import.meta.url)).filter(n => n.endsWith('.spec.ts'));
for (const name of specs) {
 for (const m of read('../tests/ui/' + name).matchAll(/\btest\(['"\x60]([^'"\x60\n]+)/g)) {
  const selected = name === file && m[1] === title;
  assert.equal(grep.test(name + ' ' + m[1]), selected);
  if (!selected) rejected++;
 }
 if (name !== file) { assert.equal(grep.test(name + ' ' + title), false); rejected++; }
}
const source = read('../tests/ui/' + file);
assert.deepEqual([...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]), [title]);
assert.equal((source.match(/await refresh\(page,/g) ?? []).length, 6);
assert.equal((source.match(/await readings\(page,/g) ?? []).length, 7);
for (const fact of ["'100.00 0'", "'9'.repeat(400)", "' \\t\\r\\n'", "'1e309 0'", "'MemTotal: 102400 kB\\n'",
 "'0.00 0'", "'3661.50 0'", "'Unavailable'", "'Memory data unavailable'", "'Availability unknown · 100 MiB total'",
 "'0h 0m'", "'100%'", "'0 MiB available of 100 MiB'", "'50 MiB available of 100 MiB'",
 "'Disconnect device'", "connects: 1, disconnects: 1", "collects: 7", "'overview-readings-observation'", 'body.length > 4096'])
 assert(source.includes(fact), fact);
for (const bad of ['page.clock.', 'page.request.', 'screenshot(', '.saveAs(', 'runner.current', 'waitForTimeout(', 'dispatchEvent(']) assert(!source.includes(bad), bad);
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 19);
for (const [p, h] of Object.entries(pins)) {
 assert(!p.split('/').includes('..')); assert.equal(hash(read('../' + p)), h, p);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
assert.equal(hash(read('./overview-log-receipt.mjs')), workflow.match(/if \(createHash\('sha256'\).update\(fs.readFileSync\(helper\)\).digest\('hex'\) !== '([a-f0-9]{64})'/)[1]);
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1',
 'timeout: 90_000', 'globalTimeout: 300_000', "trace: 'off'", "screenshot: 'off'", "video: 'off'",
 'reuseExistingServer: false', '--host 127.0.0.1 --port 5200 --strictPort', 'gracefulShutdown:']) assert(config.includes(fact), fact);
for (const fact of ['branches: [ci/overview-readings-candidate-239-debug1]', 'timeout-minutes: 15', 'contents: read',
 '1048576', 'socket_bytes > 107', 'receipt-only:', 'needs: files', 'timeout-minutes: 2', 'permissions: {}',
 'RECEIPT_BYTES > 32768', 'HUB_OVERVIEW239_V1', 'test "$PRODUCER_RESULT" = success',
 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org',
 'sdk_exit=$?', 'exit "$sdk_exit"', 'SDK_STEP_OUTCOME: ${{ steps.sdk.outcome }}']) assert(workflow.includes(fact), fact);
for (const bad of ['workflow_dispatch:', 'workflow_call:', 'secrets.', '--no-sandbox', 'sudo ', 'rm -',
 'kill ', 'continue-on-error:', 'actions/upload-artifact', 'actions/cache', 'retention-days:']) assert(!workflow.includes(bad), bad);
assert.equal((workflow.match(/node node_modules\/playwright\/cli\.js test/g) ?? []).length, 1);
const sourceSHA = read('./overview-log-receipt.mjs').match(/export const SOURCE = '([a-f0-9]{40})'/)[1];
assert.deepEqual([...workflow.matchAll(/^                  ref: (.+)$/gm)].map(m => m[1]), ['${{ github.sha }}', sourceSHA]);
assert(workflow.includes('test "$(git -C tooling rev-parse HEAD^)" = dd49f9b4d4ab2123c8eb87b6bf4578d85273a352'));
assert(workflow.includes('test "$(git -C application rev-parse HEAD)" = ' + sourceSHA));
console.log(JSON.stringify({ selectedScenarios: 1, positiveFullNames: accepted, negativeControls: rejected,
 unrelatedSpecs: specs.length - 1, sourcePins: Object.keys(pins).length, states: 7, manualRefreshes: 6,
 caseTimeoutMs: 90000, sdkGlobalMs: 300000, workers: 1, retries: 0, sourceDataOnly: true,
 mountedOrSDKDiscoveryExecuted: false }));
