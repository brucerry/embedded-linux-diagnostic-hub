// Source-data checks only. Do not import the spec, fixture, SDK, config or application.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const spec = read('../tests/ui/terminal-resize-owner.spec.ts');
const fixture = read('../tests/ui/fixtures/terminal-resize-owner.ts');
const config = read('./terminal-resize-owner-candidate.config.ts');
const workflow = read('./workflows/terminal-resize-owner-candidate.yml');
const title = 'old resize failure cannot replace a reconnected terminal diagnostic';
assert.deepEqual([...spec.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]), [title]);
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const prefix of ['', '  ', 'chromium ']) {
    assert.ok(grep.test(prefix + 'terminal-resize-owner.spec.ts ' + title)); accepted++;
}
const specs = readdirSync(new URL('../tests/ui/', import.meta.url)).filter(n => n.endsWith('.spec.ts'));
for (const name of specs) if (name !== 'terminal-resize-owner.spec.ts') {
    assert.equal(grep.test(name + ' ' + title), false); rejected++;
    for (const match of read('../tests/ui/' + name).matchAll(/\btest\(['"`]([^'"`\n]+)/g)) {
        assert.equal(grep.test(name + ' ' + match[1]), false); rejected++;
    }
}
for (const name of ['automation.spec.ts', 'ssh-console-gateway.spec.ts', 'stored-serial-results.spec.ts',
    'stored-console-results.spec.ts', 'capture-storage-lifecycle.spec.ts', 'terminal.spec.ts']) {
    assert.equal(grep.test(name + ' ' + title), false); rejected++;
}
for (const bad of [title, 'terminal-resize-owner.spec.ts extra ' + title,
    'terminal-resize-owner.spec.ts ' + title + ' extra']) {
    assert.equal(grep.test(bad), false); rejected++;
}
for (const fact of ['await page.setViewportSize({ width: 1100, height: 850 })',
    '(await observation(page)).pending).toBe(true)', 'expect(replacement).not.toBe(before.id)',
    "Clipboard text exceeds the terminal paste limit.", 'window.terminalResizeOwnerTest.rejectHeld()',
    "'CURRENT_RESIZE_SESSION\\r'", 'staleAlertSeen: false', 'inputBytes: 23',
    'opens: 2, closes: 2, disconnects: 2', 'await attach(page, info)', 'throw error;',
    'Buffer.byteLength(body) > 4096']) assert.ok(spec.includes(fact), fact);
assert.ok(spec.indexOf('await page.goto') < spec.indexOf('await installTerminalResizeOwner'));
assert.equal((spec.match(/await connect\(page\)/g) ?? []).length, 2);
assert.equal((spec.match(/await paste\(page\)/g) ?? []).length, 2);
for (const source of [spec, fixture]) for (const bad of ['dispatchEvent(', 'waitForTimeout(', 'page.clock.',
    'runner.current', '_react', 'setTimeout(', 'setInterval(', 'fetch(', 'WebSocket(',
    'node:fs', 'node:net', 'child_process', 'screenshot(', '.saveAs(', '.delete(', '.clear(', '.forget(']) {
    assert.equal(source.includes(bad), false, bad);
}
for (const fact of ['bridge.resizeTerminal = (id, size)', 'return original(id, size)',
    'state.calls.length >= 32', 'state.pending || state.held', 'armedOnce',
    'new Promise<void>', 'state.rejected !== 0', 'Math.min(64, state.observationEvents + 1)',
    'new MutationObserver(observe)', 'observer.disconnect()', "Object.hasOwn(window, 'terminalResizeOwnerTest')"])
    assert.ok(fixture.includes(fact), fact);
const protocol = read('../shared/terminal.ts');
for (const fact of ['/^[A-Za-z0-9_-]{16,64}$/', 'size.cols < 2', 'size.cols > 500',
    'size.rows < 1', 'size.rows > 300', 'Number.isInteger(size.cols)', 'Number.isInteger(size.rows)']) {
    assert.ok(protocol.includes(fact), fact); assert.ok(fixture.includes(fact), fact);
}
const page = read('../src/features/terminal/TerminalPage.tsx');
for (const fact of ['terminalConnection.current === connection', 'terminalEpoch.current !== epoch',
    'connectionEpoch.current !== connection', 'latest.current.transport !== transport'])
    assert.ok(page.includes(fact), fact);
const pasteBegin = page.indexOf('    async function paste() {');
const pasteEnd = page.indexOf('\n    useEffect(', pasteBegin);
assert.ok(pasteBegin > 0 && pasteEnd > pasteBegin);
// Current successful paste does not erase the diagnostic being used as the stale-error oracle.
assert.equal((page.slice(pasteBegin, pasteEnd).match(/setError\(/g) ?? []).length, 1);
assert.ok(page.slice(pasteBegin, pasteEnd).includes('catch (failure)'));
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 28);
for (const [file, expected] of Object.entries(pins)) {
    assert.ok(!file.split('/').includes('..'));
    assert.equal(hash(read('../' + file)), expected, file);
}
assert.equal(hash(config), workflow.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);
for (const fact of ['chromiumSandbox: true', 'workers: 1', 'retries: 0', 'repeatEach: 1',
    'maxFailures: 1', 'timeout: 90_000', 'globalTimeout: 180_000', "trace: 'off'",
    "screenshot: 'off'", "video: 'off'", 'reuseExistingServer: false'])
    assert.ok(config.includes(fact), fact);
for (const fact of ['branches: [ci/terminal-resize-owner-candidate-219]', 'timeout-minutes: 15',
    'contents: read', 'retention-days: 3', '1048576', 'socket_bytes > 107',
    'SDK_STEP_OUTCOME: ${{ steps.sdk.outcome }}', 'sdk_exit=$?', 'exit "$sdk_exit"',
    'sdk-outcome.json', 'sdkStepOutcome: process.env.SDK_STEP_OUTCOME || null',
    'scope="$RUNNER_TEMP/tr-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'])
    assert.ok(workflow.includes(fact), fact);
for (const bad of ['workflow_dispatch:', 'secrets.', '--no-sandbox', 'sudo ', 'rm -', 'kill ', 'passed:'])
    assert.equal(workflow.includes(bad), false, bad);
assert.deepEqual([...workflow.matchAll(/^                  ref: (.+)$/gm)].map(m => m[1]),
    ['${{ github.sha }}', '66b58d85df6f223bfa076054646a35c23e234457']);
assert.ok(workflow.includes('test "$(git -C tooling rev-parse HEAD^)" = 66b58d85df6f223bfa076054646a35c23e234457'));
assert.ok(workflow.includes('test "$(git -C application rev-parse HEAD)" = 66b58d85df6f223bfa076054646a35c23e234457'));
assert.ok(workflow.includes("test \"$(git -C application rev-parse 'HEAD^{tree}')\" = c8a34f18e092a99092f29f278dab47fd390b6f43"));
console.log(JSON.stringify({ selectedScenarios: 1, acceptedFullNames: accepted,
    rejectedFullNames: rejected, unrelatedSpecs: specs.length - 1, sourcePins: Object.keys(pins).length,
    heldResizeLimit: 1, recordedResizeLimit: 32, observerCounterLimit: 64,
    attachmentLimit: 4096, syntheticCurrentInputBytes: 23, downloads: 0,
    sourceDataChecksOnly: true, SDKDiscoveryOrBrowserExecuted: false }));
