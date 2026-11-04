// Source-data checks only: never import the app, SDK, configuration or fixtures.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const hash = v => createHash('sha256').update(v).digest('hex');
const config = read('./unified-cleanup-log-candidate.config.ts');
const workflow = read('./workflows/unified-cleanup-log-candidate.yml');
const titles = {
 'activity-release-retry.spec.ts': 'cancelled Serial pre-arm release failure stays recoverable until explicit retry acknowledgement',
 'cleanup-retry-outcome.spec.ts': 'explicit console cleanup retry preserves acknowledged evidence failure in Automation status without replay',
};
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
assert.ok(config.includes("testMatch: ['activity-release-retry.spec.ts', 'cleanup-retry-outcome.spec.ts']"));
let accepted = 0, rejected = 0;
for (const [file, title] of Object.entries(titles)) {
 const source = read('../tests/ui/' + file);
 assert.deepEqual([...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]), [title]);
 for (const prefix of ['', '  ', 'chromium ']) { assert.ok(grep.test(prefix + file + ' ' + title)); accepted++; }
 for (const value of [title, file + ' extra ' + title, file + ' ' + title + ' extra',
  'automation.spec.ts ' + title, 'ssh-console-gateway.spec.ts ' + title,
  'stored-serial-results.spec.ts ' + title, 'stored-console-results.spec.ts ' + title]) {
  assert.equal(grep.test(value), false); rejected++;
 }
}
const names = readdirSync(new URL('../tests/ui/', import.meta.url)).filter(n => n.endsWith('.spec.ts'));
for (const name of names) {
 assert.ok(!name.includes('/') && !name.includes('..'));
 for (const match of read('../tests/ui/' + name).matchAll(/\btest\(['"\x60]([^'"\x60\n]+)/g)) {
  const selected = titles[name] === match[1];
  assert.equal(grep.test(name + ' ' + match[1]), selected);
  if (!selected) rejected++;
 }
 if (!(name in titles)) for (const title of Object.values(titles)) { assert.equal(grep.test(name + ' ' + title), false); rejected++; }
}
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 54);
for (const [p, expected] of Object.entries(pins)) {
 assert.ok(['package.json', 'package-lock.json', 'vite.config.mts'].includes(p) || /^(tests|src|shared|electron)\/[A-Za-z0-9_./-]+\.tsx?$/.test(p));
 assert.ok(!p.split('/').includes('..')); assert.equal(hash(read('../' + p)), expected);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
assert.equal(pins['src/features/automation/AutomationPage.tsx'], 'ea978e8dfe36aaedaf763db7102892c82ca0ac298fbd36d9994cc1d72456cab4');
assert.equal(pins['src/features/automation/activity-release.ts'], '5620edfd25a683e3ce82a01ab151896fe69314600f38ea0d88219bd2e66dc68b');
assert.equal(pins['src/features/terminal/TerminalPage.tsx'], 'c67ae2cf6789d84a9dc6f15324faa4616b5585f7b779c323da09f21d2152ff39');
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1',
 'timeout: 90_000', 'globalTimeout: 300_000', "trace: 'off'", "screenshot: 'off'", "video: 'off'",
 'reuseExistingServer: false', '--host 127.0.0.1 --port 5200 --strictPort', 'gracefulShutdown:']) assert.ok(config.includes(fact), fact);
for (const fact of ['branches: [ci/unified-cleanup-log-candidate-232]', 'timeout-minutes: 15', 'contents: read',
 '1048576', 'socket_bytes > 107',
 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org',
 'SDK_STEP_OUTCOME: ${{ steps.sdk.outcome }}', 'sdk_exit=$?', 'exit "$sdk_exit"', 'sdk-outcome.json',
 'sdkStepOutcome: process.env.SDK_STEP_OUTCOME || null', 'scope="$RUNNER_TEMP/lc-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"']) assert.ok(workflow.includes(fact), fact);
for (const bad of ['workflow_dispatch:', 'workflow_call:', 'secrets.', '--no-sandbox', 'sudo ', 'rm -',
 'kill ', 'passed:', 'continue-on-error:']) assert.equal(workflow.includes(bad), false, bad);
assert.equal((workflow.match(/node node_modules\/playwright\/cli\.js test/g) ?? []).length, 1);
assert.deepEqual([...workflow.matchAll(/^                  ref: (.+)$/gm)].map(m => m[1]), ['${{ github.sha }}', 'b1ae35ee059e48b2733b6270b5cbe67b2fbeafd0']);
assert.ok(workflow.includes('test "$(git -C tooling rev-parse HEAD^)" = b1ae35ee059e48b2733b6270b5cbe67b2fbeafd0'));
assert.ok(workflow.includes('test "$(git -C application rev-parse HEAD)" = b1ae35ee059e48b2733b6270b5cbe67b2fbeafd0'));
assert.ok(workflow.includes("test \"$(git -C application rev-parse 'HEAD^{tree}')\" = f5f3db39583fb63a33aab708fc12353fbdc0d311"));
for (const [file, facts] of [
 ['cleanup-retry-outcome.spec.ts', ['await retry.click()', 'ownerReleased: 0', 'activityReleases: 0',
 'leaseHeld: true', 'await expect(start).toBeDisabled()', 'Flow paused; arm explicitly to resume.',
 "commands: ['FAIL_ONCE']", 'ownerReleased: 1', 'activityReleases: 1', 'leaseHeld: false',
 'body.length > 4096', "'cleanup-retry-summary'"]],
 ['activity-release-retry.spec.ts', ['await cancel.click()', 'await retry.click()', 'acknowledgeRetry()',
 'releaseRequests: [a, a, b]', 'acknowledged: [a, b]', 'grantPending: false, retryPending: false',
 'opens: 1, closes: 1, writes: 0', 'Buffer.byteLength(body) > 4096', "'activity-release-retry-observation'"]],
]) {
 const source = read('../tests/ui/' + file);
 for (const fact of facts) assert.ok(source.includes(fact), fact);
 for (const bad of ['page.clock.', 'page.request.', 'screenshot(', '.saveAs(', 'runner.current']) assert.equal(source.includes(bad), false, bad);
}
console.log(JSON.stringify({ selectedScenarios: 2, positiveFullNames: accepted, negativeControls: rejected,
 unrelatedSpecs: names.length - 2, sourcePins: Object.keys(pins).length, caseTimeoutMs: 90000,
 sdkGlobalMs: 300000, workers: 1, retries: 0, sourceDataOnly: true, mountedOrSDKDiscoveryExecuted: false }));

for (const required of ['receipt-only:', 'needs: files', 'timeout-minutes: 2', 'permissions: {}',
 'RECEIPT_BYTES > 32768', 'HUB_CLEANUP232_V1', 'HUB_CLEANUP232_UNAVAILABLE', 'test "$PRODUCER_RESULT" = success'])
 assert.ok(workflow.includes(required), required);
for (const forbidden of ['actions/upload-artifact', 'actions/cache', 'retention-days:', 'declare-artifact', '::artifact'])
 assert.equal(workflow.includes(forbidden), false, forbidden);
