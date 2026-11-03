// Source-only selection/pin checks; never imports Playwright, the config or fixtures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const source = read('../tests/ui/automation-sequence.spec.ts');
const config = read('./automation-sequence-candidate.config.ts');
const workflow = read('./workflows/automation-sequence-candidate.yml');
const titles = [...source.matchAll(/\btest\('([^']+)'/g)].map(m => m[1]);
assert.deepEqual(titles, ["Serial three-step Script Enter Script keeps armed bytes while the next draft changes", "SSH three independent commands retain order and repeated command rows without terminal scraping"]);
assert.equal((source.match(/\btest\(/g) ?? []).length, 2);
const literal = config.match(/^    grep: \/(.*)\/,$/m); assert.ok(literal);
const grep = new RegExp(literal[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
 for (const prefix of ['automation-sequence.spec.ts ', '  automation-sequence.spec.ts ', ' chromium automation-sequence.spec.ts ']) {
  assert.ok(grep.test(prefix + title)); accepted++;
 }
 for (const value of [title, 'other.spec.ts ' + title, 'automation-sequence.spec.ts extra ' + title, 'automation-sequence.spec.ts ' + title + ' extra']) {
  assert.equal(grep.test(value), false); rejected++;
 }
}
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 9);
for (const [file, hash] of Object.entries(pins)) {
 assert.match(file, /^(tests|shared)\/[a-zA-Z0-9_./-]+\.ts$/); assert.ok(!file.split('/').includes('..'));
 assert.equal(createHash('sha256').update(read('../' + file)).digest('hex'), hash);
}
assert.equal(createHash('sha256').update(config).digest('hex'), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
assert.ok(config.includes('chromiumSandbox: true') && config.includes('workers: 1') && config.includes('retries: 0'));
assert.ok(workflow.includes('branches: [ci/automation-sequence-candidate-20261103]'));
assert.ok(workflow.includes('timeout-minutes: 15') && workflow.includes('retention-days: 3'));
assert.ok(!workflow.includes('workflow_dispatch:'));
assert.ok(!source.includes('screenshot(') && !source.includes("waitForEvent('download')"));
console.log(JSON.stringify({selectedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected, sourcePins: Object.keys(pins).length, mountedExecuted: 0}));
