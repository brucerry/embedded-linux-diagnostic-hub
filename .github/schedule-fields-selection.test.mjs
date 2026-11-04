// Source-data checks only; do not evaluate SDK, app, fixtures or configuration.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../tests/ui/automation-schedule-fields.spec.ts');
const corpus = read('../tests/ui/fixtures/schedule-fields-data.ts');
const config = read('./schedule-fields-candidate.config.ts');
const workflow = read('./workflows/schedule-fields-candidate.yml');
const titles = [...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]);
assert.deepEqual(titles, ['Automation schedule fields reject missing gap and unsupported clock inputs and preview both explicit fold instants without arming']);
assert.equal((source.match(/^test\(/gm) ?? []).length, 1);
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
    for (const prefix of ['automation-schedule-fields.spec.ts ', '  automation-schedule-fields.spec.ts ', ' chromium automation-schedule-fields.spec.ts ']) { assert.ok(grep.test(prefix + title)); accepted++; }
    for (const value of [title, 'automation-validation.spec.ts ' + title, 'automation-schedule-fields.spec.ts extra ' + title, 'automation-schedule-fields.spec.ts ' + title + ' extra']) { assert.equal(grep.test(value), false); rejected++; }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 20);
for (const [file, expected] of Object.entries(pins)) {
    assert.match(file, /^(tests|shared|src)\/[a-zA-Z0-9_./-]+\.tsx?$/);
    assert.ok(!file.split('/').includes('..'));
    assert.equal(hash(read('../' + file)), expected);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
for (const fact of ["page.clock.install({ time: new Date(data.anchor) })", 'await page.clock.runFor(2100)', 'await expect(date).toBeFocused()', 'await expect(occurrence).toBeFocused()', 'await expect(clock).toBeFocused()', 'Choose a start date.', 'Choose a start time.', 'This local time does not exist', 'Choose local time for Serial scheduling.', 'data.earlier.utc', 'data.later.utc', 'UTC-04:00', 'UTC-05:00', "name: 'Fix required fields'", 'not.toHaveText(reference)', 'opens: 0, closes: 0, readers: 0, writes: []', 'runnerArmingRequested: false', 'downloadsRequested: 0']) assert.ok(source.includes(fact), fact);
assert.ok(source.indexOf('page.clock.install') < source.indexOf("page.goto('/')"));
for (const forbidden of ['page.clock.pauseAt', 'page.clock.fastForward', 'screenshot(', 'gatewayFixture', 'installDesktop', 'readFile(', '.saveAs(', '.delete(', '.clear(', '.forget(', "waitForEvent('download')", "name: 'Start flow', exact: true }).click()", "name: 'Run once at scheduled time', exact: true }).click()"]) assert.equal(source.includes(forbidden), false);
assert.equal((source.match(/await info\.attach\(/g) ?? []).length, 1);
for (const fact of ['2028-03-12', '2028-11-05', '2028-11-05T05:30:00.000Z', '2028-11-05T06:30:00.000Z', 'America/New_York']) assert.ok(corpus.includes(fact));
const legacy = read('../tests/ui/automation-validation.spec.ts');
assert.ok(legacy.includes("await expect(await errorText(page, flow.getByLabel('Start clock'))).toContainText('Choose local time for Serial scheduling.');"));
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1', "trace: 'off'", "screenshot: 'off'", "video: 'off'", 'timeout: 90_000', 'globalTimeout: 180_000']) assert.ok(config.includes(fact));
assert.ok(workflow.includes('branches: [ci/integration216-schedule-fields]'));
for (const fact of ['timeout-minutes: 15', 'contents: read', 'retention-days: 3', '1048576', 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org', 'socket_bytes > 107']) assert.ok(workflow.includes(fact));
for (const forbidden of ['workflow_dispatch:', 'secrets.', '--no-sandbox']) assert.equal(workflow.includes(forbidden), false);
assert.ok(workflow.includes('scope="$RUNNER_TEMP/sf-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'));
const sdkPins = JSON.parse(workflow.match(/const sdkPins = (\{[^\r\n]+\});/)[1]);
assert.deepEqual(Object.keys(sdkPins), ['node_modules/playwright/lib/runner/index.js', 'node_modules/playwright/lib/worker/workerProcessEntry.js']);
for (const value of Object.values(sdkPins)) assert.match(value, /^[a-f0-9]{64}$/);
const socketBytes = Buffer.byteLength('/home/runner/work/_temp/sf-41676005405-1/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket');
assert.equal(socketBytes, 89);
assert.ok(workflow.indexOf('socket_bytes=${#socket_probe}') < workflow.indexOf('mkdir "$scope"'));
console.log(JSON.stringify({selectedScenarios: 1, definedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected, sourcePins: Object.keys(pins).length, sdkSerializerPins: Object.keys(sdkPins).length, explicitFoldInstants: 2, clockAdvanceMs: 2100, runnerArmingRequested: false, downloadsRequested: 0, socketBytes, mountedExecuted: 0}));

// Bind this cohort to the combined source checkpoint, not a historical sibling.
assert.ok(workflow.includes("ref: 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("test \"$(git -C tooling rev-parse HEAD^)\" = 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("825f83b3489382bdf68518f4135e6cd60ebfec79"));
