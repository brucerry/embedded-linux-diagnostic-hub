// Source-data checks only; do not import app, test SDK, fixtures or configuration.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../tests/ui/flow-export-files.spec.ts');
const original = read('../tests/ui/automation-flow-export.spec.ts');
const config = read('./flow-files-candidate.config.ts');
const workflow = read('./workflows/flow-files-candidate.yml');
const expected = ["Flow export files preserve measured wide Unicode and XML-invalid content across SVG PNG PDF"];
const titles = [...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]);
assert.deepEqual(titles, expected);
assert.equal((source.match(/^test\(/gm) ?? []).length, 1);
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
    for (const prefix of ['flow-export-files.spec.ts ', '  flow-export-files.spec.ts ', ' chromium flow-export-files.spec.ts ']) { assert.ok(grep.test(prefix + title)); accepted++; }
    for (const value of [title, 'automation-flow-export.spec.ts ' + title, 'flow-export-files.spec.ts extra ' + title, 'flow-export-files.spec.ts ' + title + ' extra']) { assert.equal(grep.test(value), false); rejected++; }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 22);
for (const [file, expected] of Object.entries(pins)) {
    assert.match(file, /^(tests|shared|src)\/[a-zA-Z0-9_./-]+\.tsx?$/);
    assert.ok(!file.split('/').includes('..'));
    assert.equal(hash(read('../' + file)), expected);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
const block = text => text.slice(text.indexOf('        const rendered = await page.evaluate('), text.indexOf('        evidence.push({ case: entry.name, ...rendered });') + '        evidence.push({ case: entry.name, ...rendered });'.length);
assert.ok(block(source).length > 1000); assert.equal(block(source), block(original));
const corpus = text => text.slice(text.indexOf('    const cases = ['), text.indexOf('    const evidence = [];'));
assert.equal(corpus(source), corpus(original));
for (const fact of ["['SVG', 'PNG', 'PDF']", 'nextDownloadAt = receivedAt + 150', 'readFlowDownload(download, FLOW_COHORT_READ_BYTES - downloadedBytes)', "createHash('sha256')", 'expect(fileEvidence).toHaveLength(12)', 'window.desktopTest.connects', 'window.desktopTest.terminal!.opens', 'window.desktopTest.terminal!.inputs']) assert.ok(source.includes(fact));
for (const forbidden of ['readFile(', '.saveAs(', 'download.path(', 'screenshot(', 'gatewayFixture', 'page.clock.']) assert.equal(source.includes(forbidden), false);
assert.equal((source.match(/await info\.attach\(/g) ?? []).length, 3);
const reader = read('../tests/ui/fixtures/flow-download.ts');
for (const fact of ['FLOW_FILE_READ_BYTES = 8 * 1024 * 1024', 'FLOW_COHORT_READ_BYTES = 32 * 1024 * 1024', 'await download.failure()', 'await download.createReadStream()', 'for await (const chunk of stream)', 'bytes > FLOW_FILE_READ_BYTES || bytes > remainingBytes']) assert.ok(reader.includes(fact));
assert.ok(reader.includes("import type { Download } from '@playwright/test';"));
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1', "trace: 'off'", "screenshot: 'off'", "video: 'off'", 'timeout: 90_000', 'globalTimeout: 180_000']) assert.ok(config.includes(fact));
assert.ok(workflow.includes('branches: [ci/flow-files-candidate-20261103]'));
for (const fact of ['timeout-minutes: 15', 'contents: read', 'retention-days: 3', '1048576', 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org', 'socket_bytes > 107']) assert.ok(workflow.includes(fact));
for (const forbidden of ['workflow_dispatch:', 'secrets.', '--no-sandbox']) assert.equal(workflow.includes(forbidden), false);
assert.ok(workflow.includes('scope="$RUNNER_TEMP/ff-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'));
const sdkPins = JSON.parse(workflow.match(/const sdkPins = (\{[^\r\n]+\});/)[1]);
assert.deepEqual(Object.keys(sdkPins), ['node_modules/playwright/lib/runner/index.js', 'node_modules/playwright/lib/worker/workerProcessEntry.js']);
for (const value of Object.values(sdkPins)) assert.match(value, /^[a-f0-9]{64}$/);
const socketBytes = Buffer.byteLength('/home/runner/work/_temp/ff-41672070156-1/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket');
assert.equal(socketBytes, 89);
assert.ok(workflow.indexOf('socket_bytes=${#socket_probe}') < workflow.indexOf('mkdir "$scope"'));
console.log(JSON.stringify({selectedScenarios: 1, definedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected, sourcePins: Object.keys(pins).length, sdkSerializerPins: Object.keys(sdkPins).length, corpusCases: 4, formats: 3, downloads: 12, socketBytes, mountedExecuted: 0}));
