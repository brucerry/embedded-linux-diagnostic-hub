// Source data only. Do not evaluate SDK, app, fixture, configuration or a browser.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const hash = b => createHash('sha256').update(b).digest('hex');
const source = read('../tests/ui/cleanup-retry-outcome.spec.ts');
const fixture = read('../tests/ui/fixtures/cleanup-retry.ts');
const config = read('./cleanup-retry-candidate.config.ts');
const workflow = read('./workflows/cleanup-retry-candidate.yml');
const title = 'explicit console cleanup retry preserves acknowledged evidence failure in Automation status without replay';
assert.deepEqual([...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]), [title]);
assert.equal((source.match(/^test\(/gm) ?? []).length, 1);
assert.equal(config.match(/^    testMatch: '([^']+)',$/m)?.[1], 'cleanup-retry-outcome.spec.ts');
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const prefix of ['', ' chromium ', '  ']) {
    assert.ok(grep.test(prefix + 'cleanup-retry-outcome.spec.ts ' + title)); accepted++;
}
for (const name of [title, 'cleanup-retry-outcome.spec.ts extra ' + title,
    'cleanup-retry-outcome.spec.ts ' + title + ' extra']) {
    assert.equal(grep.test(name), false); rejected++;
}
const files = readdirSync(new URL('../tests/ui/', import.meta.url))
    .filter(name => /^[A-Za-z0-9_-]+\.spec\.ts$/.test(name) && name !== 'cleanup-retry-outcome.spec.ts');
for (const file of files) {
    for (const match of read('../tests/ui/' + file).matchAll(/^test\('([^']+)'/gm)) {
        for (const prefix of ['', ' chromium ']) {
            assert.equal(grep.test(prefix + file + ' ' + match[1]), false); rejected++;
        }
    }
}
for (const file of ['automation-validation.spec.ts', 'stored-serial-results.spec.ts',
    'console-results.spec.ts', 'loopback-console.spec.ts', 'automation-fields.spec.ts'])
    assert.ok(files.includes(file));
assert.ok(read('../tests/ui/automation-validation.spec.ts').includes('await screen('));
assert.ok(/deletion|clears only explicitly/.test(read('../tests/ui/stored-serial-results.spec.ts')));
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 32);
for (const [p, expected] of Object.entries(pins)) {
    assert.ok(p === 'package.json' || p === 'vite.config.mts' || /^(tests|src|shared)\/[A-Za-z0-9_./-]+\.tsx?$/.test(p));
    assert.ok(!p.split('/').includes('..'));
    assert.equal(hash(read('../' + p)), expected);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
for (const fact of ["selectOption('console')", "fill('FAIL_ONCE')", "fill('NEVER_SEND')",
    "name: 'Retry cleanup'", 'await retry.click()', 'retryPending).toBe(true)',
    'ownerReleased: 0', 'activityReleases: 0', 'leaseHeld: true',
    'await expect(start).toBeDisabled()', 'window.cleanupRetryTest.acknowledgeRetry()',
    'Synthetic retained console evidence could not be acknowledged.',
    'Flow paused; arm explicitly to resume.', 'await expect(start).toBeEnabled()',
    "not.toContainText('Flow finished')", 'ownerReleased: 1', 'activityReleases: 1',
    'leaseHeld: false', "commands: ['FAIL_ONCE']", 'body.length > 4096']) assert.ok(source.includes(fact), fact);
assert.ok(source.indexOf('await page.goto') < source.indexOf('await page.evaluate'));
assert.equal((source.match(/await info\.attach\(/g) ?? []).length, 1);
for (const forbidden of ['screenshot(', 'gatewayFixture', "waitForEvent('download')",
    '.saveAs(', '.delete(', '.clear(', '.forget(', 'page.clock.', 'page.request.'])
    assert.equal(source.includes(forbidden), false);
for (const fact of ['consoleRpcRequest(input)', 'consoleArchiveRequest(input)',
    'state.calls <= 16', 'state.catalogLists <= 16', 'state.reads <= 2',
    'state.commands.length === 0', 'state.finishes <= 2',
    "receiveTimeSource: 'local-client'", "journal: 'native-v2', heartbeat: null",
    'await retry;', 'readClosed();', 'state.retryAcknowledged', 'state.ownerReleased === 1'])
    assert.ok(fixture.includes(fact), fact);
for (const bad of ['setTimeout(', 'setInterval(', 'fetch(', 'WebSocket', 'indexedDB',
    'navigator.', 'node:fs', 'node:net', 'child_process']) assert.equal(fixture.includes(bad), false);
const runner = read('../src/features/automation/runner.ts');
assert.ok(runner.includes('const outcome = await pending.retry();'));
assert.ok(runner.includes('outcome?.failure'));
const backend = read('../src/features/automation/capture/console-backend.ts');
assert.ok(backend.includes('if (!client?.resourceSnapshot.localCleanupClosed) throw error;'));
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1',
    'maxFailures: 1', 'timeout: 90_000', 'globalTimeout: 180_000', "trace: 'off'",
    "screenshot: 'off'", "video: 'off'"]) assert.ok(config.includes(fact));
for (const fact of ['branches: [ci/cleanup-retry-candidate-213]', 'timeout-minutes: 15',
    'contents: read', 'retention-days: 3', '1048576', 'socket_bytes > 107',
    'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org',
    'SDK_STEP_OUTCOME: ${{ steps.sdk.outcome }}', 'sdk_exit=$?', 'exit "$sdk_exit"',
    'sdk-outcome.json', 'sdkStepOutcome: process.env.SDK_STEP_OUTCOME || null',
    "scope=\"$RUNNER_TEMP/cr-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT\""])
    assert.ok(workflow.includes(fact), fact);
for (const forbidden of ['workflow_dispatch:', 'secrets.', '--no-sandbox', 'sudo ', 'rm -', 'kill '])
    assert.equal(workflow.includes(forbidden), false);
assert.equal(workflow.includes('passed:'), false);
console.log(JSON.stringify({ selectedScenarios: 1, acceptedFullNames: accepted,
    rejectedFullNames: rejected, negativeSpecFiles: files.length, sourcePins: 32,
    mockHostCallsLimit: 16, mockCatalogListsLimit: 16, mockCommandsLimit: 1,
    fixtureSummaryBytes: 4096, downloads: 0, mountedExecuted: false }));

assert.deepEqual([...workflow.matchAll(/^                  ref: (.+)$/gm)].map(m => m[1]), ['${{ github.sha }}', "bbb088274b7e13027721c35c6c8ad5a3f8284f33"]);
assert.ok(workflow.includes("test \"$(git -C tooling rev-parse HEAD^)\" = bbb088274b7e13027721c35c6c8ad5a3f8284f33"));
assert.ok(workflow.includes("test \"$(git -C application rev-parse HEAD)\" = bbb088274b7e13027721c35c6c8ad5a3f8284f33"));
assert.ok(workflow.includes("test \"$(git -C application rev-parse 'HEAD^{tree}')\" = 3f1424ffcb3312f971138ede420befa4ef45622b"));
