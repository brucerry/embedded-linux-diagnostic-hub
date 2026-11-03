// Fixed source-data reads only; never evaluate app, fixtures, SDK or CI configuration.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../tests/ui/serial-deselect.spec.ts');
const config = read('./serial-deselect-candidate.config.ts');
const workflow = read('./workflows/serial-deselect-candidate.yml');
const expected = ["Serial selected-only Deselect restores framing controls without opening a port", "Serial connected Deselect retains its selection until close acknowledgement then restores framing"];
const titles = [...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]);
assert.deepEqual(titles, expected);
assert.equal((source.match(/\btest\(/g) ?? []).length, 2);
const imports = [...source.matchAll(/^import .*?from '([^']+)'/gm)].map(m => m[1]);
assert.deepEqual(imports, ['@playwright/test', './fixtures/desktop', './fixtures/serial', './fixtures/serial-custody']);
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
    for (const prefix of ['serial-deselect.spec.ts ', '  serial-deselect.spec.ts ', ' chromium serial-deselect.spec.ts ']) { assert.ok(grep.test(prefix + title)); accepted++; }
    for (const value of [title, 'serial.spec.ts ' + title, 'serial-deselect.spec.ts extra ' + title, 'serial-deselect.spec.ts ' + title + ' extra']) { assert.equal(grep.test(value), false); rejected++; }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 14);
for (const [file, expected] of Object.entries(pins)) {
    assert.match(file, /^(tests|shared|src)\/[a-zA-Z0-9_./-]+\.tsx?$/);
    assert.ok(!file.split('/').includes('..'));
    assert.equal(hash(read('../' + file)), expected);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
const page = read('../src/features/serial/SerialPage.tsx');
for (const fact of ['value={ports.indexOf(session.selectedPort!)}', 'onClick={() => action(() => session.close(true))}', "['opening', 'connected', 'closing', 'selecting'].includes(status.state)", "status.state === 'closing'"])
    assert.ok(page.includes(fact));
const session = read('../src/features/serial/session.ts');
const close = session.slice(session.indexOf('async close(deselect'));
assert.ok(close.indexOf('await port.close();') < close.indexOf('this.selected = undefined;'));
for (const fact of ['this.selected === intent.selected', 'this.status.generation === intent.generation', "this.publish(this.selected ? 'selected' : 'idle')"]) assert.ok(close.includes(fact));
for (const fact of ["const framing = ['57600', '7', 'even', '2', 'hardware'];", 'closeAcks: 0', 'closeAcks: 1', 'acknowledgeClose()', 'readerCancels: 1', 'aborts: 1', 'writes: []', 'if (!assertionFailed) throw error;', "toHaveValue('-1')"])
    assert.ok(source.includes(fact));
for (const forbidden of ['screenshot(', 'setInputFiles(', 'waitForEvent(', '.forget(', 'page.clock.', 'gatewayFixture']) assert.equal(source.includes(forbidden), false);
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1', "trace: 'off'", "screenshot: 'off'", "video: 'off'", 'timeout: 30_000', 'globalTimeout: 120_000']) assert.ok(config.includes(fact));
assert.ok(workflow.includes('branches: [ci/serial-deselect-candidate-20261103]'));
for (const fact of ['timeout-minutes: 15', 'contents: read', 'retention-days: 3', '1048576', 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org', 'socket_bytes > 107']) assert.ok(workflow.includes(fact));
for (const forbidden of ['workflow_dispatch:', 'secrets.', '--no-sandbox']) assert.equal(workflow.includes(forbidden), false);
assert.ok(workflow.includes('scope="$RUNNER_TEMP/sd-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'));
const socketBytes = Buffer.byteLength('/home/runner/work/_temp/sd-41669467090-1/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket');
assert.equal(socketBytes, 89);
assert.ok(workflow.indexOf('socket_bytes=${#socket_probe}') < workflow.indexOf('mkdir "$scope"'));
console.log(JSON.stringify({selectedScenarios: 2, definedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected, sourcePins: Object.keys(pins).length, socketBytes, mountedExecuted: 0}));
