// Fixed source data only: no SDK, browser, fixture, config or app evaluation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = read('../tests/ui/automation-fields.spec.ts');
const original = read('../tests/ui/automation-validation.spec.ts');
const config = read('./automation-fields-candidate.config.ts');
const workflow = read('./workflows/automation-fields-candidate.yml');
const titles = [...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]);
assert.deepEqual(titles, [
    'Next validates commands and numeric fields with associated errors, stable geometry and first-invalid focus',
    'Serial required prompt and optional prefix correct accessibly; Review opens advanced field and Enter-only needs framing',
]);
assert.equal((source.match(/^test\(/gm) ?? []).length, 2);
let derived = original.slice(0, original.indexOf("test('schedule missing"))
    .replace("import { mkdir } from 'node:fs/promises';\n", '')
    .replace("import path from 'node:path';\n", '');
const helperStart = derived.indexOf('async function screen(');
const helperEnd = derived.indexOf('async function open(', helperStart);
assert.ok(helperStart > 0 && helperEnd > helperStart);
derived = derived.slice(0, helperStart) + derived.slice(helperEnd);
derived = derived.replace("    await screen(page, 'automation-command-validation.png');\n", '');
assert.equal(source, derived.trimEnd() + '\n', 'Preserve both original behavioral cases exactly.');
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
    for (const prefix of ['automation-fields.spec.ts ', '  automation-fields.spec.ts ', ' chromium automation-fields.spec.ts ']) {
        assert.ok(grep.test(prefix + title)); accepted++;
    }
    for (const name of [title, 'automation-validation.spec.ts ' + title, 'automation-fields.spec.ts extra ' + title, 'automation-fields.spec.ts ' + title + ' extra']) {
        assert.equal(grep.test(name), false); rejected++;
    }
}
assert.equal(grep.test('automation-fields.spec.ts schedule missing date/time, DST fold and missing device sample point to their actual fields'), false);
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 17);
for (const [file, expected] of Object.entries(pins)) {
    assert.ok(file === 'package.json' || /^(tests|shared|src)\/[a-zA-Z0-9_./-]+\.(tsx?|css)$/.test(file));
    assert.ok(!file.split('/').includes('..'));
    assert.equal(hash(read('../' + file)), expected);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
for (const fact of [
    "toContainText('Enter a command')", "expect(command).toBeFocused()", 'toBe(beforePageTop)',
    "timeout.fill('301')", "delay.fill('Infinity')", "expect(timeout).toBeFocused()",
    "expect(delay).toBeFocused()", "delay.fill('0.0000001')", "repeat.fill('0')",
    "expect(repeat).toBeFocused()", "enabled.uncheck()", "toContainText('Enable at least one')",
    "prefix.fill('x'.repeat(129))", "toContainText('128')", "expect(prefix).toBeFocused()",
    "getByRole('button', { name: 'Start flow', exact: true })).toBeDisabled()",
    "getByLabel('Command 1 send Enter only').check()", "selectOption('none')", "toContainText('CR')",
]) assert.ok(source.includes(fact), fact);
assert.equal((source.match(/window\.serialTest\.writes\.length/g) ?? []).length, 2);
assert.equal((source.match(/window\.serialTest\.opens/g) ?? []).length, 2);
for (const forbidden of ['node:', 'screen(', 'screenshot(', 'gatewayFixture', 'installDesktop', 'page.clock.', '.saveAs(', '.forget(', '.unplug(', '.recoverBreak(', "waitForEvent('download')", "name: 'Connect',", "name: 'Connect via SSH'"]) assert.equal(source.includes(forbidden), false);
const fixture = read('../tests/ui/fixtures/serial.ts');
assert.ok(fixture.startsWith("import type { Page } from '@playwright/test';"));
assert.equal((fixture.match(/^import /gm) ?? []).length, 1);
assert.ok(fixture.includes('Object.defineProperty(navigator, \'serial\''));
const component = read('../src/features/automation/AutomationPage.tsx');
for (const fact of ['const fieldIssues = draftIssues({', 'const nextStage = () => {', 'if (invalid) focusIssue(invalid);', 'field.focus({ preventScroll: true });', 'ancestor.open = true;', 'fieldIssues.length > 0 ||']) assert.ok(component.includes(fact));
const validation = read('../src/features/automation/draft-validation.ts');
for (const fact of ["add('ending', 0, 'Enter-only needs CR, LF or CRLF.')", "add('prefix', 0, 'Use up to 128 printable characters, or leave blank.')", "'Enable at least one command.'"]) assert.ok(validation.includes(fact));
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1', "trace: 'off'", "screenshot: 'off'", "video: 'off'", 'timeout: 60_000', 'globalTimeout: 180_000']) assert.ok(config.includes(fact));
for (const fact of ['branches: [ci/integration216-automation-fields]', 'timeout-minutes: 15', 'contents: read', 'retention-days: 3', '1048576', 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org', 'socket_bytes > 107']) assert.ok(workflow.includes(fact));
for (const forbidden of ['workflow_dispatch:', 'secrets.', '--no-sandbox']) assert.equal(workflow.includes(forbidden), false);
assert.ok(workflow.includes('scope="$RUNNER_TEMP/af-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'));
const sdkPins = JSON.parse(workflow.match(/const sdkPins = (\{[^\r\n]+\});/)[1]);
assert.deepEqual(Object.keys(sdkPins), ['node_modules/playwright/lib/runner/index.js', 'node_modules/playwright/lib/worker/workerProcessEntry.js']);
for (const value of Object.values(sdkPins)) assert.match(value, /^[a-f0-9]{64}$/);
const socketBytes = Buffer.byteLength('/home/runner/work/_temp/af-41676005405-1/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket');
assert.equal(socketBytes, 89);
assert.ok(workflow.indexOf('socket_bytes=${#socket_probe}') < workflow.indexOf('mkdir "$scope"'));
console.log(JSON.stringify({selectedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected + 1, criticalSourcePins: Object.keys(pins).length, originalAssertionsPreserved: true, expectedFakePortOpens: 0, expectedFakePortWrites: 0, socketBytes, sdkSerializerPins: Object.keys(sdkPins).length, mountedExecuted: 0}));

// Bind this cohort to the combined source checkpoint, not a historical sibling.
assert.ok(workflow.includes("ref: 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("test \"$(git -C tooling rev-parse HEAD^)\" = 4745d466139031de2c81e5b3e3b19ea8b24d72bf"));
assert.ok(workflow.includes("825f83b3489382bdf68518f4135e6cd60ebfec79"));
