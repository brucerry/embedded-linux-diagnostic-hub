// Source data only; no SDK, application, fixture or configuration evaluation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../tests/ui/network-interface-identity.spec.ts');
const config = read('./network-identity-candidate.config.ts');
const workflow = read('./workflows/network-identity-candidate.yml');
const titles = [...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]);
assert.deepEqual(titles, ['LAN selector distinguishes repeated interface names by reported index and keeps selected facts and raw evidence aligned']);
assert.equal((source.match(/^test\(/gm) ?? []).length, 1);
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
    for (const prefix of ['network-interface-identity.spec.ts ', '  network-interface-identity.spec.ts ', ' chromium network-interface-identity.spec.ts ']) { assert.ok(grep.test(prefix + title)); accepted++; }
    for (const value of [title, 'network.spec.ts ' + title, 'network-interface-identity.spec.ts extra ' + title, 'network-interface-identity.spec.ts ' + title + ' extra']) { assert.equal(grep.test(value), false); rejected++; }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 20);
for (const [file, expected] of Object.entries(pins)) {
    assert.ok(file === 'package.json' || /^(tests|shared|src)\/[a-zA-Z0-9_./-]+\.tsx?$/.test(file));
    assert.ok(!file.split('/').includes('..'));
    assert.equal(hash(read('../' + file)), expected);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
for (const fact of ['networkIdentityReport()', "getByLabel('Import diagnostic report', { exact: true })", "['eth0 · ifindex 7', 'eth0 · ifindex 19', 'eth1']", 'select.selectOption({ label: labels[0] })', 'select.selectOption({ label: labels[1] })', 'select.selectOption({ label: labels[2] })', 'toHaveValue(\'["eth0",7]\')', 'toHaveValue(\'["eth0",19]\')', 'toHaveValue(\'["eth1",null]\')', "toHaveText('1500')", "toHaveText('9000')", "toHaveText('1200')", 'interface identity changed during collection; conflicting records kept separate.', "command.locator('pre').nth(1).textContent()).toBe(raw)", 'liveCollectionRequested: false, downloadsRequested: 0']) assert.ok(source.includes(fact), fact);
for (const forbidden of ['screenshot(', 'gatewayFixture', 'installDesktop', 'installSerial', 'page.clock.', 'readFile(', '.saveAs(', '.delete(', '.clear(', '.forget(', "waitForEvent('download')", "name: 'Connect via SSH'", "name: 'Collect snapshot'"]) assert.equal(source.includes(forbidden), false);
assert.equal((source.match(/await info\.attach\(/g) ?? []).length, 1);
const component = read('../src/features/network/NetworkSummary.tsx');
assert.ok(component.includes('key={i.id} value={i.id}'));
assert.ok(component.includes('{interfaceLabel(i)}'));
assert.ok(component.includes('setSelected(e.target.value)'));
const model = read('../shared/diagnostics/network/model.ts');
assert.ok(model.includes("iface.ifindex !== undefined ? ' · ifindex ' + iface.ifindex : ''"));
assert.equal(JSON.parse(read('../package.json')).scripts.test, 'tsx --test tests/*.test.ts');
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1', "trace: 'off'", "screenshot: 'off'", "video: 'off'", 'timeout: 90_000', 'globalTimeout: 180_000']) assert.ok(config.includes(fact));
assert.ok(workflow.includes('branches: [ci/integration216-network-identity]'));
for (const fact of ['timeout-minutes: 15', 'contents: read', 'retention-days: 3', '1048576', 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org', 'socket_bytes > 107']) assert.ok(workflow.includes(fact));
for (const forbidden of ['workflow_dispatch:', 'secrets.', '--no-sandbox']) assert.equal(workflow.includes(forbidden), false);
assert.ok(workflow.includes('scope="$RUNNER_TEMP/ni-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'));
const sdkPins = JSON.parse(workflow.match(/const sdkPins = (\{[^\r\n]+\});/)[1]);
assert.deepEqual(Object.keys(sdkPins), ['node_modules/playwright/lib/runner/index.js', 'node_modules/playwright/lib/worker/workerProcessEntry.js']);
for (const value of Object.values(sdkPins)) assert.match(value, /^[a-f0-9]{64}$/);
const socketBytes = Buffer.byteLength('/home/runner/work/_temp/ni-41676005405-1/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket');
assert.equal(socketBytes, 89);
assert.ok(workflow.indexOf('socket_bytes=${#socket_probe}') < workflow.indexOf('mkdir "$scope"'));
console.log(JSON.stringify({selectedScenarios: 1, definedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected, sourcePins: Object.keys(pins).length, sdkSerializerPins: Object.keys(sdkPins).length, syntheticReportImports: 1, interfaceSelections: 3, liveCollectionRequested: false, downloadsRequested: 0, socketBytes, mountedExecuted: 0}));

// Bind this cohort to the combined source checkpoint, not a historical sibling.
assert.ok(workflow.includes("ref: 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("test \"$(git -C tooling rev-parse HEAD^)\" = 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("825f83b3489382bdf68518f4135e6cd60ebfec79"));
