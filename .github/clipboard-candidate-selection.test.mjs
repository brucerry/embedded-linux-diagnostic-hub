// Source-only selection regression: no Playwright/config/fixture imports or test execution.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const config = read('./clipboard-candidate.config.ts');
const workflow = read('./workflows/clipboard-candidate.yml');
const source = read('../tests/ui/terminal.spec.ts');
const literal = config.match(/^    grep: \/(.*)\/,$/m);
assert.ok(literal, 'Expected one unflagged, single-line grep literal.');
assert.equal([...config.matchAll(/^    grep:/gm)].length, 1);
const grep = new RegExp(literal[1]);
const filename = 'clipboard-owner.spec.ts';
assert.ok(config.includes(`testMatch: '${filename}'`));

const start = source.indexOf('async function connectDesktop(page: Page) {');
const end = source.indexOf("test('desktop terminal is embedded", start);
assert.ok(start >= 0 && end > start, 'Expected the actual CI projection boundaries.');
const projection = source.slice(start, end);
const outcomeMatch = projection.match(/for \(const outcome of \[([^\]]+)\] as const\) \{/);
assert.ok(outcomeMatch, 'Expected the bounded outcome loop.');
const outcomes = [...outcomeMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
assert.deepEqual(outcomes, ['text', 'failure', 'oversized']);
const templates = [...projection.matchAll(/\btest\(`([^`]+)`/g)];
assert.equal(templates.length, 1, 'Expected exactly one projected title template.');
assert.equal((projection.match(/\btest\(/g) ?? []).length, 1);
assert.equal(
    templates[0][1],
    'desktop clipboard ${outcome} from an old connection cannot affect its replacement',
);
const titles = outcomes.map((outcome) => templates[0][1].replace('${outcome}', outcome));
// Installed Playwright's _collectGrepTitlePath/_grepTitleWithTags join the root,
// project, relative filename and title with spaces. Empty suite names remain.
const fullName = (title, file = filename, project = '') => ['', project, file, title].join(' ');
for (const title of titles) {
    assert.equal(grep.test(fullName(title)), true, title);
    assert.equal(grep.test(fullName(title, filename, 'chromium')), true, title);
    assert.equal(grep.test(`${filename} ${title}`), true, title);
}

const otherTitles = [...source.matchAll(/\btest\(\s*'((?:\\.|[^'\\])*)'/g)].map((m) => m[1]);
assert.ok(otherTitles.length > 0, 'Expected unrelated terminal scenarios as controls.');
assert.equal((source.match(/\btest\(/g) ?? []).length, otherTitles.length + 1);
const rejected = otherTitles.map((title) => fullName(title));
for (const title of titles) {
    rejected.push(
        title,
        fullName(title, 'terminal.spec.ts'),
        fullName(title, 'other-clipboard-owner.spec.ts'),
        fullName(`unrelated ${title}`),
        fullName(`${title} extra`),
    );
}
rejected.push(fullName('desktop clipboard other from an old connection cannot affect its replacement'));
for (const name of rejected) assert.equal(grep.test(name), false, name);

const configPin = workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/);
assert.ok(configPin, 'Expected the workflow configuration integrity check.');
assert.equal(createHash('sha256').update(config).digest('hex'), configPin[1]);
const sourcePin = workflow.match(/if \(hash\(source\) !== '([a-f0-9]{64})'\)/);
assert.ok(sourcePin, 'Expected the unchanged scenario source pin.');
assert.equal(createHash('sha256').update(source).digest('hex'), sourcePin[1]);
assert.ok(workflow.includes('node tooling/.github/clipboard-candidate-selection.test.mjs'));
assert.ok(workflow.includes(
    'test "$(git -C tooling rev-parse HEAD^)" = 461df227359224c2798048b262a8ab4058992174',
));
assert.ok(workflow.includes(
    'test "$(git -C application rev-parse HEAD)" = 63a9dce4db46495845d572c78da711e3471465fe',
));
console.log(JSON.stringify({
    kind: 'source-only-selection-regression',
    selectedScenarios: titles.length,
    acceptedFullNames: titles.length * 3,
    rejectedFullNames: rejected.length,
    configAndSourcePinsMatch: true,
    mountedScenariosExecuted: 0,
    playwrightDiscoveryExecuted: false,
}));
