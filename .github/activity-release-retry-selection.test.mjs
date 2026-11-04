// Source-data checks only: never import the spec, SDK, configuration, app or fixture.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const hash = v => createHash('sha256').update(v).digest('hex');
const source = read('../tests/ui/activity-release-retry.spec.ts');
const fixture = read('../tests/ui/fixtures/activity-release-retry.ts');
const config = read('./activity-release-retry-candidate.config.ts');
const workflow = read('./workflows/activity-release-retry-candidate.yml');
const title = 'cancelled Serial pre-arm release failure stays recoverable until explicit retry acknowledgement';
assert.deepEqual([...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]), [title]);
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const prefix of ['', '  ', 'chromium ']) {
    assert.ok(grep.test(prefix + 'activity-release-retry.spec.ts ' + title)); accepted++;
}
const names = readdirSync(new URL('../tests/ui/', import.meta.url)).filter(n => n.endsWith('.spec.ts'));
for (const name of names) if (name !== 'activity-release-retry.spec.ts') {
    assert.equal(grep.test(name + ' ' + title), false); rejected++;
    const text = read('../tests/ui/' + name);
    for (const match of text.matchAll(/\btest\(['"`]([^'"`\n]+)/g)) {
        assert.equal(grep.test(name + ' ' + match[1]), false); rejected++;
    }
}
for (const value of [title, 'activity-release-retry.spec.ts extra ' + title,
    'activity-release-retry.spec.ts ' + title + ' extra',
    'automation.spec.ts ' + title, 'ssh-console-gateway.spec.ts ' + title,
    'stored-serial-results.spec.ts ' + title]) { assert.equal(grep.test(value), false); rejected++; }
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 31);
for (const [p, expected] of Object.entries(pins)) {
    assert.ok(p === 'package.json' || p === 'vite.config.mts' || /^(tests|src|shared|electron)\/[A-Za-z0-9_./-]+\.tsx?$/.test(p));
    assert.ok(!p.split('/').includes('..'));
    assert.equal(hash(read('../' + p)), expected);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
for (const fact of ['await cancel.click()', 'await retry.click()',
    'window.activityReleaseRetryTest.grant()', 'window.activityReleaseRetryTest.acknowledgeRetry()',
    'Wait for the current clock reader admission.', 'Synthetic host release reply lost after effect.',
    'Previous flow: Flow cancelled before arming.', 'await expect(start).toBeDisabled()',
    'await expect(retry).toHaveCount(0)', 'acquireRequests).toBe(2)',
    'releaseRequests: [a, a, b]', 'acknowledged: [a, b]', 'hostEffects: 2',
    'grantPending: false, retryPending: false', 'opens: 1, closes: 1, writes: 0',
    'throw error;', 'Buffer.byteLength(body) > 4096', 'await attachObservation(page, info)']) assert.ok(source.includes(fact), fact);
assert.equal((source.match(/await retry\.click\(\)/g) ?? []).length, 2);
assert.ok(source.indexOf('await page.goto') < source.indexOf('await installActivityReleaseRetry'));
for (const bad of ['page.cancel(', 'runner.current', 'armAttempt', 'activityEpoch', 'dispatchEvent(',
    'page.clock.', 'page.request.', '.delete(', '.clear(', '.forget(', 'screenshot(',
    "waitForEvent('download')", '.saveAs(', 'gatewayFixture']) assert.equal(source.includes(bad), false, bad);
for (const fact of ['state.acquireRequests >= 2', 'state.releaseRequests.length >= 3',
    'state.hostLease = null;', 'state.hostEffects++', 'await new Promise<void>',
    'calls !== 2', 'state.acknowledged.push(id)', 'state.retryPending = true']) assert.ok(fixture.includes(fact), fact);
for (const bad of ['setTimeout(', 'setInterval(', 'fetch(', 'WebSocket', 'indexedDB',
    'navigator.', 'node:fs', 'node:net', 'child_process', 'dispatchEvent(', 'runner.current', 'armAttempt']) assert.equal(fixture.includes(bad), false, bad);
const ids = [...fixture.matchAll(/const [ab] = '([^']+)'/g)].map(m => m[1]);
assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2);
for (const id of ids) { assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/); assert.ok(source.includes(id)); }
const activity = read('../electron/automation-activity.ts');
assert.ok(activity.includes("if (typeof id === 'string' && id === this.lease) this.clear();"));
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1',
    'maxFailures: 1', 'timeout: 90_000', 'globalTimeout: 180_000', "trace: 'off'", "screenshot: 'off'", "video: 'off'", 'reuseExistingServer: false']) assert.ok(config.includes(fact), fact);
for (const fact of ['branches: [ci/activity-release-retry-candidate-217]', 'timeout-minutes: 15',
    'contents: read', 'retention-days: 3', '1048576', 'socket_bytes > 107',
    'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org',
    'SDK_STEP_OUTCOME: ${{ steps.sdk.outcome }}', 'sdk_exit=$?', 'exit "$sdk_exit"',
    'sdk-outcome.json', 'sdkStepOutcome: process.env.SDK_STEP_OUTCOME || null',
    'scope="$RUNNER_TEMP/ar-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"']) assert.ok(workflow.includes(fact), fact);
for (const bad of ['workflow_dispatch:', 'secrets.', '--no-sandbox', 'sudo ', 'rm -', 'kill ', 'passed:']) assert.equal(workflow.includes(bad), false, bad);
assert.deepEqual([...workflow.matchAll(/^                  ref: (.+)$/gm)].map(m => m[1]), ['${{ github.sha }}', '18070743dce5366d1d46992f3392a8453bcfa1c6']);
assert.ok(workflow.includes('test "$(git -C tooling rev-parse HEAD^)" = 18070743dce5366d1d46992f3392a8453bcfa1c6'));
assert.ok(workflow.includes('test "$(git -C application rev-parse HEAD)" = 18070743dce5366d1d46992f3392a8453bcfa1c6'));
assert.ok(workflow.includes("test \"$(git -C application rev-parse 'HEAD^{tree}')\" = 5f93e63a06edb5fc30d2eddaf48a9596996283c2"));
console.log(JSON.stringify({ selectedScenarios: 1, acceptedFullNames: accepted, rejectedFullNames: rejected,
    unrelatedSpecFiles: names.length - 1, sourcePins: Object.keys(pins).length, syntheticAcquireLimit: 2,
    syntheticReleaseLimit: 3, syntheticIdCount: ids.length, observationBytesLimit: 4096,
    expectedPortOpens: 1, expectedPortCloses: 1, commandWrites: 0, downloads: 0,
    sourceDataChecksOnly: true, mountedOrSDKDiscoveryExecuted: false }));
