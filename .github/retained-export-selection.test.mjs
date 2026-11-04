// Source-data checks only; do not evaluate SDK, app, fixtures or CI configuration.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../tests/ui/retained-export-files.spec.ts');
const config = read('./retained-export-candidate.config.ts');
const workflow = read('./workflows/retained-export-candidate.yml');
const expected = ['retained browser results export off-page identities and complete beyond-preview JSON Markdown without deleting captures'];
const titles = [...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]);
assert.deepEqual(titles, expected);
assert.equal((source.match(/^test\(/gm) ?? []).length, 1);
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
    for (const prefix of ['retained-export-files.spec.ts ', '  retained-export-files.spec.ts ', ' chromium retained-export-files.spec.ts ']) { assert.ok(grep.test(prefix + title)); accepted++; }
    for (const value of [title, 'stored-serial-results.spec.ts ' + title, 'retained-export-files.spec.ts extra ' + title, 'retained-export-files.spec.ts ' + title + ' extra']) { assert.equal(grep.test(value), false); rejected++; }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 27);
for (const [file, expected] of Object.entries(pins)) {
    assert.ok(file === 'vite.config.mts' || /^(tests|shared|src)\/[a-zA-Z0-9_./-]+\.tsx?$/.test(file));
    assert.ok(!file.split('/').includes('..'));
    assert.equal(hash(read('../' + file)), expected);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
for (const fact of ['IndexedDbCaptureStore.open()', 'CaptureWriter.begin(store, row.header)', 'await store.record(capture.id, row.outcome)', 'await store.close()', 'expect(ids).toHaveLength(21)', 'ids[0]', 'ids[20]', 'raw.equals(Buffer.from(expectedRaw))', "exportFile(results, 'json', 'selected')", "exportFile(results, 'markdown', 'selected')", "exportFile(results, 'json', 'filtered')", 'report.schemaVersion).toBe(3)', 'retainedAfterReload: 21', 'await page.reload()', 'readOwnedDownload(await pending, FLOW_COHORT_READ_BYTES - readBytes)', "createHash('sha256')", 'expect(evidence).toHaveLength(3)', '{ opens: 0, writes: [] }', "expect(markdown).toContain('~~~~text\\n')", "not.toContainText('EXPORT-BEYOND-PREVIEW')"]) assert.ok(source.includes(fact), fact);
for (const forbidden of ['.delete(', '.deleteDatabase(', '.clear(', '.forget(', 'readFile(', '.saveAs(', 'download.path(', 'screenshot(', 'gatewayFixture', 'page.clock.', 'installDesktop']) assert.equal(source.includes(forbidden), false);
assert.equal((source.match(/await info\.attach\(/g) ?? []).length, 1);
const reader = read('../tests/ui/fixtures/flow-download.ts');
for (const fact of ['FLOW_FILE_READ_BYTES = 8 * 1024 * 1024', 'FLOW_COHORT_READ_BYTES = 32 * 1024 * 1024', 'await download.failure()', 'await download.createReadStream()', 'for await (const chunk of stream)', 'bytes > FLOW_FILE_READ_BYTES || bytes > remainingBytes']) assert.ok(reader.includes(fact));
assert.ok(reader.includes("import type { Download } from '@playwright/test';"));
for (const fact of ['chromiumSandbox: true', "serviceWorkers: 'allow'", 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1', "trace: 'off'", "screenshot: 'off'", "video: 'off'", 'timeout: 90_000', 'globalTimeout: 180_000']) assert.ok(config.includes(fact));
assert.ok(workflow.includes('branches: [ci/integration216-retained-export]'));
for (const fact of ['timeout-minutes: 15', 'contents: read', 'retention-days: 3', '1048576', 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org', 'socket_bytes > 107']) assert.ok(workflow.includes(fact));
for (const forbidden of ['workflow_dispatch:', 'secrets.', '--no-sandbox']) assert.equal(workflow.includes(forbidden), false);
assert.ok(workflow.includes('scope="$RUNNER_TEMP/re-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'));
const sdkPins = JSON.parse(workflow.match(/const sdkPins = (\{[^\r\n]+\});/)[1]);
assert.deepEqual(Object.keys(sdkPins), ['node_modules/playwright/lib/runner/index.js', 'node_modules/playwright/lib/worker/workerProcessEntry.js']);
for (const value of Object.values(sdkPins)) assert.match(value, /^[a-f0-9]{64}$/);
const socketBytes = Buffer.byteLength('/home/runner/work/_temp/re-41676005405-1/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket');
assert.equal(socketBytes, 89);
assert.ok(workflow.indexOf('socket_bytes=${#socket_probe}') < workflow.indexOf('mkdir "$scope"'));
console.log(JSON.stringify({selectedScenarios: 1, definedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected, sourcePins: Object.keys(pins).length, sdkSerializerPins: Object.keys(sdkPins).length, seededCaptures: 21, selectedCaptures: 2, downloads: 3, socketBytes, mountedExecuted: 0}));

// Bind this cohort to the combined source checkpoint, not a historical sibling.
assert.ok(workflow.includes("ref: 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("test \"$(git -C tooling rev-parse HEAD^)\" = 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("825f83b3489382bdf68518f4135e6cd60ebfec79"));
