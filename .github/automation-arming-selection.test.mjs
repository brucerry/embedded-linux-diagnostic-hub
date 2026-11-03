// Source-only admission/selection checks; no Playwright, config or fixture imports.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const config = read('./automation-arming-candidate.config.ts');
const workflow = read('./workflows/automation-arming-candidate.yml');
const source = read('../tests/ui/automation-arming.spec.ts');
const literal = config.match(/^    grep: \/(.*)\/,$/m);
assert.ok(literal);
assert.equal([...config.matchAll(/^    grep:/gm)].length, 1);
const grep = new RegExp(literal[1]);
const filename = 'automation-arming.spec.ts';
assert.ok(config.includes(`testMatch: '${filename}'`));
assert.ok(config.includes("testDir: path.join(application, 'tests/ui')"));
assert.ok(config.includes('chromiumSandbox: true'));
assert.ok(config.includes('workers: 1'));
assert.ok(config.includes('retries: 0'));
assert.ok(config.includes('globalTimeout: 180_000'));

assert.ok(source.includes("for (const transport of ['ssh', 'serial'] as const) {"));
assert.ok(source.includes('for (const scheduled of [false, true]) {'));
assert.ok(source.includes("for (const outcome of ['grant', 'reject'] as const) {"));
const templates = [...source.matchAll(/\btest\(`([^`]+)`/g)].map((m) => m[1]);
assert.deepEqual(templates, [
    '${transport} cancelled lease release fences repeated Starts until acknowledged',
    "${transport} Cancel during pending lease prevents ${scheduled ? 'scheduled' : 'immediate'} sends and repetition",
    '${transport} cancelled lease ${outcome} fences rearming and preserves later pending admission',
    '${transport} cancelled lease ${outcome} preserves later active flow after acknowledged retirement',
]);
assert.equal((source.match(/\btest\(/g) ?? []).length, 4);
assert.equal((source.match(/await expectClockAdmissionBlocked\(page, flow\)/g) ?? []).length, 4);
assert.equal((source.match(/await rearmAfterSettlement\(page, flow, transport, reads/g) ?? []).length, 3);
assert.ok(!source.includes('expectHeaderResumed'));
const helper = source.slice(source.indexOf('async function rearmAfterSettlement('),
    source.indexOf("for (const transport of ['ssh', 'serial'] as const) {"));
const branches = helper.split("if (transport === 'ssh') {")[1]?.split('} else {');
assert.ok(branches && branches.length === 2);
assert.ok(branches[0].includes('.toBeGreaterThan(previousReads)'));
const serialPrecondition = branches[1].split('\n    }')[0];
assert.ok(!serialPrecondition.includes('expect.poll'));
assert.ok(serialPrecondition.includes('expect(previousReads).toBe(0)'));
assert.ok(serialPrecondition.includes('window.desktopTest.connects'));
assert.ok(helper.includes('window.armingTest.pending.length)).toBe(2)'));
assert.ok(helper.includes('window.serialTest.writes.length'));
assert.ok(helper.includes('window.desktopTest.clock.calls)).toBe(0)'));
assert.ok(helper.includes('if (retiredError) await expect(flow).not.toContainText(retiredError)'));
assert.ok(source.includes('Wait for the current clock reader admission.'));

const titles = [];
for (const transport of ['ssh', 'serial']) {
    titles.push(templates[0].replace('${transport}', transport));
    for (const scheduled of [false, true])
        titles.push(templates[1].replace('${transport}', transport).replace(
            "${scheduled ? 'scheduled' : 'immediate'}", scheduled ? 'scheduled' : 'immediate',
        ));
    for (const outcome of ['grant', 'reject'])
        for (const template of templates.slice(2))
            titles.push(template.replace('${transport}', transport).replace('${outcome}', outcome));
}
const suffixes = [
    'cancelled lease release fences repeated Starts until acknowledged',
    'Cancel during pending lease prevents immediate sends and repetition',
    'Cancel during pending lease prevents scheduled sends and repetition',
    'cancelled lease grant fences rearming and preserves later pending admission',
    'cancelled lease reject fences rearming and preserves later pending admission',
    'cancelled lease grant preserves later active flow after acknowledged retirement',
    'cancelled lease reject preserves later active flow after acknowledged retirement',
];
const expected = ['ssh', 'serial'].flatMap((transport) => suffixes.map((s) => `${transport} ${s}`));
assert.deepEqual([...titles].sort(), [...expected].sort());
assert.equal(new Set(titles).size, 14);
const fullName = (title, file = filename, project = '') => ['', project, file, title].join(' ');
for (const title of titles) {
    assert.equal(grep.test(fullName(title)), true, title);
    assert.equal(grep.test(fullName(title, filename, 'chromium')), true, title);
    assert.equal(grep.test(`${filename} ${title}`), true, title);
}
const rejected = titles.flatMap((title) => [
    title,
    fullName(title, 'automation.spec.ts'),
    fullName(title, 'other-automation-arming.spec.ts'),
    fullName(`unrelated ${title}`),
    fullName(`${title} extra`),
]);
rejected.push(
    fullName('other Cancel during pending lease prevents scheduled sends and repetition'),
    fullName('ssh cancelled lease other fences rearming and preserves later pending admission'),
    fullName('desktop clipboard text from an old connection cannot affect its replacement'),
);
for (const title of rejected) assert.equal(grep.test(title), false, title);

const configPin = workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/);
assert.ok(configPin);
assert.equal(createHash('sha256').update(config).digest('hex'), configPin[1]);
const sourcePins = workflow.match(/const pins = (\{[^\r\n]+\});/);
assert.ok(sourcePins);
const pins = JSON.parse(sourcePins[1]);
assert.equal(Object.keys(pins).length, 9);
for (const [file, pin] of Object.entries(pins)) {
    assert.match(file, /^(?:tests|shared)\/[a-zA-Z0-9_./-]+\.ts$/);
    assert.ok(!file.split('/').includes('..'));
    assert.equal(createHash('sha256').update(read('../' + file)).digest('hex'), pin);
}
assert.ok(workflow.includes('node tooling/.github/automation-arming-selection.test.mjs'));
assert.ok(workflow.includes('branches: [ci/automation-arming-63a9dce-20261103]'));
assert.ok(!workflow.includes('workflow_dispatch:'));
assert.ok(workflow.includes('timeout-minutes: 15'));
assert.ok(workflow.includes('retention-days: 3'));
assert.ok(workflow.includes('contents: read'));
assert.ok(workflow.includes(
    'test "$(git -C tooling rev-parse HEAD^)" = c5ffe5d146f28ce54bfb9db2a79f1e35ffe97185',
));
assert.ok(workflow.includes(
    'test "$(git -C application rev-parse HEAD)" = c5ffe5d146f28ce54bfb9db2a79f1e35ffe97185',
));
console.log(JSON.stringify({
    kind: 'source-only-automation-arming-selection',
    selectedScenarios: titles.length,
    acceptedFullNames: titles.length * 3,
    rejectedFullNames: rejected.length,
    sourcePinsChecked: Object.keys(pins).length,
    mountedScenariosExecuted: 0,
    playwrightDiscoveryExecuted: false,
}));
