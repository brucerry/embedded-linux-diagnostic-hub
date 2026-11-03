// Source-data only; no Playwright, app, fixture or configuration module evaluation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../tests/ui/terminal-recovery.spec.ts');
const original = read('../tests/ui/terminal.spec.ts');
const config = read('./terminal-recovery-candidate.config.ts');
const workflow = read('./workflows/terminal-recovery-candidate.yml');
const expected = ["shell recovery preserves history, discards pending input, resets modes and ignores stale events", "recovery pauses behind a modal, does not steal hidden-tab focus and cancels on disconnect", "shell recovery stops on refusal, stream errors and repeated rapid closure"];
const titles = [...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]);
assert.deepEqual(titles, expected);
assert.equal((source.match(/\btest\(/g) ?? []).length, 3);
const begin = original.indexOf("test('shell recovery preserves history");
const end = original.indexOf("test('terminal starts on connection", begin);
assert.ok(begin > 0 && end > begin);
assert.ok(source.endsWith(original.slice(begin, end).trimEnd() + '\n'));
const imports = [...source.matchAll(/^import .*?from '([^']+)'/gm)].map(m => m[1]);
assert.deepEqual(imports, ['@playwright/test', './fixtures/desktop']);
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const title of titles) {
    for (const prefix of ['terminal-recovery.spec.ts ', '  terminal-recovery.spec.ts ', ' chromium terminal-recovery.spec.ts ']) {
        assert.ok(grep.test(prefix + title)); accepted++;
    }
    for (const value of [title, 'terminal.spec.ts ' + title, 'terminal-recovery.spec.ts extra ' + title, 'terminal-recovery.spec.ts ' + title + ' extra']) {
        assert.equal(grep.test(value), false); rejected++;
    }
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
const page = read('../src/features/terminal/TerminalPage.tsx');
for (const fact of ['if (event.id !== id.current) return;', 'input.current?.close();', 'restartAttempts.current.length < 3', 'now - attempt < 10_000', 'latest.current.blocked', 'latest.current.visible', "setState('restarting')", "term?.write('\\r\\n\\x1b[2KShell restarted.\\r\\n'"])
    assert.ok(page.includes(fact));
for (const fact of ['HISTORY_BEFORE_EXIT', 'QUEUED_ONLY', "terminal!.end('closed', id)", "terminal!.refuseNextOpen = true", "terminal!.end('error')", "not.toBeFocused()", "window.desktopTest.closeConnection!()", "toBe(7)"])
    assert.ok(source.includes(fact));
const contract = read('../shared/terminal.ts');
const idPattern = new RegExp(contract.match(/!\/(.*?)\/\.test\(value\)/)[1]);
const fixtureCheck = read('../tests/terminal-recovery-fixture-memory.test.ts');
const owners = [...fixtureCheck.matchAll(/terminalId\('([^']+)'\)/g)].map(m => m[1]);
assert.equal(owners.length, 4); for (const id of owners) assert.ok(idPattern.test(id));
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1', "trace: 'off'", "screenshot: 'off'", "video: 'off'", "timeout: 30_000", 'globalTimeout: 120_000']) assert.ok(config.includes(fact));
assert.ok(workflow.includes('branches: [ci/terminal-recovery-candidate-20261103]'));
for (const fact of ['timeout-minutes: 15', 'contents: read', 'retention-days: 3', '1048576', 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org', 'socket_bytes > 107']) assert.ok(workflow.includes(fact));
for (const forbidden of ['workflow_dispatch:', 'secrets.', '--no-sandbox']) assert.equal(workflow.includes(forbidden), false);
assert.ok(workflow.includes('scope="$RUNNER_TEMP/tr-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'));
const socketBytes = Buffer.byteLength('/home/runner/work/_temp/tr-41666257491-1/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket');
assert.equal(socketBytes, 89);
assert.ok(workflow.indexOf('socket_bytes=${#socket_probe}') < workflow.indexOf('mkdir "$scope"'));
console.log(JSON.stringify({selectedScenarios: 3, definedScenarios: titles.length, acceptedFullNames: accepted, rejectedFullNames: rejected, sourcePins: Object.keys(pins).length, fixtureOwnerControls: owners.length, socketBytes, mountedExecuted: 0}));
