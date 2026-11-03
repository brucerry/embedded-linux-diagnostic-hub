// Source-data checks only; never imports Playwright, app modules or fixtures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const source = read('../tests/ui/automation-reorder.spec.ts');
const config = read('./automation-reorder-candidate.config.ts');
const workflow = read('./workflows/automation-reorder-candidate.yml');
const expected = ["Automation drag cancellation restores identities and command editing cannot start a row drag", "Automation drag and keyboard reorder preserve disabled row identity through Review and execution"];
const titles = [...source.matchAll(/\btest\('([^']+)'/g)].map(m => m[1]);
assert.deepEqual(titles, expected);
assert.equal((source.match(/\btest\(/g) ?? []).length, 2);
const literal = config.match(/^    grep: \/(.*)\/,$/m); assert.ok(literal);
const grep = new RegExp(literal[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
 for (const prefix of ['automation-reorder.spec.ts ', '  automation-reorder.spec.ts ', ' chromium automation-reorder.spec.ts ']) {
  assert.ok(grep.test(prefix + title)); accepted++;
 }
 for (const value of [title, 'other.spec.ts ' + title, 'automation-reorder.spec.ts extra ' + title, 'automation-reorder.spec.ts ' + title + ' extra']) {
  assert.equal(grep.test(value), false); rejected++;
 }
}
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 12);
for (const [file, hash] of Object.entries(pins)) {
 assert.match(file, /^(tests|shared|src)\/[a-zA-Z0-9_./-]+\.tsx?$/);
 assert.ok(!file.split('/').includes('..'));
 assert.equal(createHash('sha256').update(read('../' + file)).digest('hex'), hash);
}
assert.equal(createHash('sha256').update(config).digest('hex'), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
const validator = read('../shared/automation.ts');
const pattern = validator.match(/!\/(.*?)\/\.test\(v\.connection\)/); assert.ok(pattern);
const owner = source.match(/connection: '([^']+)'/); assert.ok(owner);
assert.ok(new RegExp(pattern[1]).test(owner[1]));
assert.equal(new RegExp(pattern[1]).test('header-owner'), false);
const page = read('../src/features/automation/AutomationPage.tsx');
for (const text of ['data-step-id={s.id}', 'onPointerDownCapture=', 'onDragStart=', 'onDragEnd={() => finishDrag(false)}', 'previewDrag(s.id);', 'finishDrag(true);', 'if (!commit && dragOriginal.current) setSteps(dragOriginal.current);', '.filter((s) => s.enabled)']) assert.ok(page.includes(text));
assert.ok(source.includes("await expect(flow.getByRole('navigation', { name: 'Automation setup steps' })).toBeVisible();"));
assert.ok(source.includes(".dragTo(rows(flow).last())"));
assert.ok(source.includes("name: 'Move command 2 up'"));
assert.ok(source.includes("await page.keyboard.press('Escape')"));
assert.ok(source.includes("await transfer.dispose()"));
assert.ok(!source.includes('page.clock.') && !source.includes('screenshot(') && !source.includes("waitForEvent('download')"));
assert.ok(config.includes('chromiumSandbox: true') && config.includes('workers: 1') && config.includes('retries: 0'));
assert.ok(workflow.includes('branches: [ci/automation-reorder-candidate-20261103]'));
assert.ok(workflow.includes('timeout-minutes: 15') && workflow.includes('retention-days: 3'));
assert.ok(!workflow.includes('workflow_dispatch:') && !workflow.includes('secrets.'));
const scopeLine = 'scope="$RUNNER_TEMP/ar-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"';
assert.ok(workflow.includes(scopeLine));
assert.ok(workflow.indexOf('socket_bytes=${#socket_probe}') < workflow.indexOf('mkdir "$scope"'));
const socketBytes = Buffer.byteLength('/home/runner/work/_temp/ar-41630095589-1/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket');
assert.equal(socketBytes, 89);
assert.ok(workflow.includes('if (( socket_bytes > 107 )); then'));
console.log(JSON.stringify({selectedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected, sourcePins: Object.keys(pins).length, fixtureOwnerControls: 2, socketBytes, mountedExecuted: 0}));
