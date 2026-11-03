// Source-only selection/pin checks; never imports Playwright, the config or fixtures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const source = read('../tests/ui/connection-retries.spec.ts');
const config = read('./ssh-retry-candidate.config.ts');
const workflow = read('./workflows/ssh-retry-candidate.yml');
const titles = [...source.matchAll(/\btest\('([^']+)'/g)].map(m => m[1]);
assert.deepEqual(titles, ["initial diagnostic failure leaves authenticated SSH and terminal available without re-login", "temporary failure displays retry status and Cancel removes the pending attempt timer", "native authentication failure pauses for password correction rather than timer retries", "Cancel during an active handshake rejects its late ready completion", "cleanup acknowledgement starts the exact three-second retry and Cancel fences the second handshake"]);
assert.equal((source.match(/\btest\(/g) ?? []).length, 5);
const literal = config.match(/^    grep: \/(.*)\/,$/m); assert.ok(literal);
const grep = new RegExp(literal[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
 for (const prefix of ['connection-retries.spec.ts ', '  connection-retries.spec.ts ', ' chromium connection-retries.spec.ts ']) {
  assert.ok(grep.test(prefix + title)); accepted++;
 }
 for (const value of [title, 'other.spec.ts ' + title, 'connection-retries.spec.ts extra ' + title, 'connection-retries.spec.ts ' + title + ' extra']) {
  assert.equal(grep.test(value), false); rejected++;
 }
}
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 7);
for (const [file, hash] of Object.entries(pins)) {
 assert.match(file, /^(tests|shared)\/[a-zA-Z0-9_./-]+\.ts$/); assert.ok(!file.split('/').includes('..'));
 assert.equal(createHash('sha256').update(read('../' + file)).digest('hex'), hash);
}
assert.equal(createHash('sha256').update(config).digest('hex'), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
assert.ok(config.includes('chromiumSandbox: true') && config.includes('workers: 1') && config.includes('retries: 0'));
assert.ok(workflow.includes('branches: [ci/ssh-retry-candidate-20261103]'));
assert.ok(workflow.includes('timeout-minutes: 15') && workflow.includes('retention-days: 3'));
assert.ok(!workflow.includes('workflow_dispatch:'));
assert.ok(!source.includes('screenshot(') && !source.includes("waitForEvent('download')"));
// Literal source binding plus byte arithmetic only; never runs the workflow/shell/browser.
const scopeLine = 'scope="$RUNNER_TEMP/sr-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"';
const guard = `export LC_ALL=C
                  socket_probe="$scope/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket"
                  socket_bytes=\${#socket_probe}
                  if (( socket_bytes > 107 )); then
                      printf 'Owned Chromium socket path needs %s bytes; maximum is 107.\\n' "$socket_bytes"
                      exit 1
                  fi`;
assert.ok(workflow.includes(scopeLine) && workflow.includes(guard));
assert.ok(workflow.indexOf(scopeLine) < workflow.indexOf(guard));
assert.ok(workflow.indexOf(guard) < workflow.indexOf('mkdir "$scope"'));
const suffix = '/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket';
const bytes = (root, prefix = 'sr') => Buffer.byteLength(`${root}/${prefix}-41608752526-1${suffix}`);
assert.equal(bytes('/home/runner/work/_temp', 'automation-retirement'), 108);
assert.equal(bytes('/home/runner/work/_temp'), 89);
assert.equal(bytes('/home/runner/work/_temp') <= 107, true);
const rootFor = n => '/' + 'x'.repeat(n - bytes('') - 1);
assert.equal(bytes(rootFor(107)), 107);
assert.equal(bytes(rootFor(108)), 108);
assert.equal(bytes(rootFor(107)) <= 107, true);
assert.equal(bytes(rootFor(108)) <= 107, false);
assert.equal(bytes('/' + 'é'.repeat(40)) <= 107, false);
assert.equal(bytes('/runner temporary'), 83);
console.log(JSON.stringify({selectedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected, sourcePins: Object.keys(pins).length, socketBoundaryControls: 6, oldSocketBytes: 108, newSocketBytes: 89, mountedExecuted: 0}));
