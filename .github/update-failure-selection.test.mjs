// Source-data checks only; no SDK, fixture, app or native module evaluation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../tests/ui/update-failure-retry.spec.ts');
const config = read('./update-failure-candidate.config.ts');
const workflow = read('./workflows/update-failure-candidate.yml');
const titles = [...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]);
assert.deepEqual(titles, ['Update dialog keeps completed downloads unverified and preserves retired failures through explicit retry']);
assert.equal((source.match(/^test\(/gm) ?? []).length, 1);
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
    for (const prefix of ['update-failure-retry.spec.ts ', '  update-failure-retry.spec.ts ', ' chromium update-failure-retry.spec.ts ']) { assert.ok(grep.test(prefix + title)); accepted++; }
    for (const value of [title, 'updates.spec.ts ' + title, 'update-failure-retry.spec.ts extra ' + title, 'update-failure-retry.spec.ts ' + title + ' extra']) { assert.equal(grep.test(value), false); rejected++; }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 24);
for (const [file, expected] of Object.entries(pins)) {
    assert.match(file, /^(tests|shared|src|electron)\/[a-zA-Z0-9_./-]+\.tsx?$/);
    assert.ok(!file.split('/').includes('..'));
    assert.equal(hash(read('../' + file)), expected);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
for (const fact of ["bridge.checkUpdates = async include", "bridge.startUpdate = request", "state.starts.length >= 2", "state.emittedStages.length >= 12", "if (!pending || message.length > 512)", "state.emit({ stage: 'failed', message })", 'rejectRetiredFailure', 'fully acknowledged failure only', "Verification follows.", "toHaveAttribute('value', '4')", "toHaveAttribute('max', '8')", "not.toHaveAttribute('value')", "getByText('Verified launchable app:')", "page.keyboard.press('Escape')", 'toHaveText(firstFailure)', 'toHaveText(secondFailure)', 'not.toContainText(firstFailure)', "await check.click()", "await cancel.click()", 'window.updateFailureTest.listenerCount', 'observed.subscriptions).toBe(observed.unsubscriptions)', "fixtureMode: 'in-memory bridge only'", 'nativeIOCovered: false']) assert.ok(source.includes(fact), fact);
assert.equal((source.match(/await start\.click\(\)/g) ?? []).length, 2);
assert.equal((source.match(/await info\.attach\(/g) ?? []).length, 1);
assert.equal((source.match(/\.delete\(/g) ?? []).length, 1);
assert.ok(source.includes('listeners.delete(callback)')); // Set unsubscribe only, no file/store deletion.
for (const forbidden of ['screenshot(', 'gatewayFixture', 'page.clock.', 'readFile(', '.saveAs(', '.clear(', '.forget(', "waitForEvent('download')", '.openReleases(', '.openUpdateFolder(', '.copyUpdatePath(', 'window.close(']) assert.equal(source.includes(forbidden), false);
const updater = read('../electron/updates.ts');
for (const fact of ['Release checksum verification failed. No update was installed.', 'The release is not a compatible portable executable.']) assert.ok(source.includes(fact) && updater.includes(fact));
const coordinator = read('../electron/update-coordinator.ts');
assert.ok(coordinator.includes("stage: 'failed'"));
const main = read('../electron/main.ts');
assert.ok(main.includes('return await updateOwnership.start(() => update.start(request));'));
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1', "trace: 'off'", "screenshot: 'off'", "video: 'off'", 'timeout: 90_000', 'globalTimeout: 180_000']) assert.ok(config.includes(fact));
assert.ok(workflow.includes('branches: [ci/integration216-update-failure]'));
for (const fact of ['timeout-minutes: 15', 'contents: read', 'retention-days: 3', '1048576', 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org', 'socket_bytes > 107']) assert.ok(workflow.includes(fact));
for (const forbidden of ['workflow_dispatch:', 'secrets.', '--no-sandbox']) assert.equal(workflow.includes(forbidden), false);
assert.ok(workflow.includes('scope="$RUNNER_TEMP/uf-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'));
const sdkPins = JSON.parse(workflow.match(/const sdkPins = (\{[^\r\n]+\});/)[1]);
assert.deepEqual(Object.keys(sdkPins), ['node_modules/playwright/lib/runner/index.js', 'node_modules/playwright/lib/worker/workerProcessEntry.js']);
for (const value of Object.values(sdkPins)) assert.match(value, /^[a-f0-9]{64}$/);
const socketBytes = Buffer.byteLength('/home/runner/work/_temp/uf-41676005405-1/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket');
assert.equal(socketBytes, 89);
assert.ok(workflow.indexOf('socket_bytes=${#socket_probe}') < workflow.indexOf('mkdir "$scope"'));
console.log(JSON.stringify({selectedScenarios: 1, definedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected, sourcePins: Object.keys(pins).length, sdkSerializerPins: Object.keys(sdkPins).length, mockedAttempts: 2, retirementModel: 'acknowledged failures only', nativeIOCovered: false, downloadsRequested: 0, socketBytes, mountedExecuted: 0}));

// Bind this cohort to the combined source checkpoint, not a historical sibling.
assert.ok(workflow.includes("ref: 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("test \"$(git -C tooling rev-parse HEAD^)\" = 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("825f83b3489382bdf68518f4135e6cd60ebfec79"));
