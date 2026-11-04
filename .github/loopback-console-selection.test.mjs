// Source data only; never import SDK, ssh2, fixture, configuration or app code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const hash = b => createHash('sha256').update(b).digest('hex');
const source = read('../tests/ui/loopback-console.spec.ts');
const fixture = read('../tests/ui/fixtures/loopback-console-gateway.ts');
const config = read('./loopback-console-candidate.config.ts');
const workflow = read('./workflows/loopback-console-candidate.yml');
const dependencies = read('./loopback-console-dependencies.json');
const outcome = read('./loopback-console-outcome.mjs');
const original = read('../tests/ui/console-results.spec.ts');
const title = 'actual authenticated gateway and browser journal keep Script/Enter/Enter/Script in one owned console';
assert.deepEqual([...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]), [title]);
assert.equal((source.match(/^test\(/gm) ?? []).length, 1);
const originalCase = original.slice(original.indexOf("test('actual authenticated gateway"), original.indexOf("test('wrong shell criterion"));
const assertions = originalCase.match(/(?:await\s+)?expect(?:\.poll)?\([\s\S]*?;\n/g) ?? [];
assert.ok(assertions.length >= 20);
for (const assertion of assertions) assert.ok(source.includes(assertion), assertion);
const grep = new RegExp(config.match(/^    grep: \/(.*)\/,$/m)[1]);
let accepted = 0, rejected = 0;
for (const prefix of ['loopback-console.spec.ts ', ' chromium loopback-console.spec.ts ', '  loopback-console.spec.ts ']) { assert.ok(grep.test(prefix + title)); accepted++; }
for (const name of [title, 'console-results.spec.ts ' + title, 'loopback-console.spec.ts extra ' + title, 'loopback-console.spec.ts ' + title + ' extra']) { assert.equal(grep.test(name), false); rejected++; }
const pins = JSON.parse(workflow.match(/const pins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(pins).length, 62);
for (const [p, expected] of Object.entries(pins)) {
    assert.ok(/^(package(?:-lock)?\.json|(?:tests|shared|src|backend|gateway)\/[a-zA-Z0-9_./-]+\.(?:tsx?|json))$/.test(p));
    assert.ok(!p.split('/').includes('..'));
    assert.equal(hash(read('../' + p)), expected);
}
assert.ok(workflow.includes("if (hash(config) !== '" + hash(config) + "')"));
assert.ok(workflow.includes("!== '" + hash(dependencies) + "') throw Error('Changed dependency review')"));
const deps = JSON.parse(dependencies);
assert.equal(Object.keys(deps.installedDependencyFilePins).length, 35);
assert.deepEqual(deps.optionalAddonPathsMustBeAbsent, ['cpu-features/build/Release/cpufeatures.node', 'ssh2/lib/protocol/crypto/build/Release/sshcrypto.node']);
assert.equal(deps.nestedDependencyDirectoriesMustBeAbsent.length, 6);
for (const p of Object.keys(deps.installedDependencyFilePins)) assert.ok(!p.split('/').includes('..') && /^[a-zA-Z0-9_./-]+$/.test(p));
for (const fact of ['server.listen(0, \'127.0.0.1\')', 'if (closeTask) return closeTask;', "closing = true; state.phase = 'closing'", 'await startTask?.catch(() => undefined);', 'await Promise.allSettled(tasks)', 'state.sshCloseAcknowledged = true;', 'state.gatewayCloseAcknowledged = true;', 'clients.size || state.fileHandles || state.failedFileCloses || journalFailed', 'writeFileSync(journal, text, { flag: journalCreated ? \'w\' : \'wx\' })', "state.phase = closing ? 'closing' : 'ready'", "origin.hostname !== '127.0.0.1'", "if (closing) throw Error('Loopback admission frozen before activeGateway acquisition.')"]) assert.ok(fixture.includes(fact), fact);
assert.ok(fixture.indexOf('return { start, close: closeOwned') > fixture.indexOf('function closeOwned'));
for (const fact of ['const owner = allocateLoopbackGateway();', 'currentOwner = owner;', 'test.afterEach(async () => { await currentOwner?.close(); });', 'budget = { remaining: 8 * 1024 * 1024 }', 'Math.min(4 * 1024 * 1024, budget.remaining)', 'constants.O_RDONLY | constants.O_NOFOLLOW', 'owner.fileOpened();', 'closeSync(fd); owner.fileClosed();', 'owner.fileCloseFailed();', 'new AggregateError([primary, error]', 'failures.push(error)', "url.hostname === '127.0.0.1'", "info.attach('loopback-owned-summary'", "format: 'svg'", "format: 'json'"]) assert.ok(source.includes(fact), fact);
assert.equal((source.match(/await readOwnedDownload\(/g) ?? []).length, 2);
assert.ok(source.indexOf('const owner = allocateLoopbackGateway()') < source.indexOf('await owner.start'));
for (const forbidden of ['screenshot(', '.clear(', '.delete(', '.forget(', '.unplug(', 'execFile(', 'spawn(', 'child_process', 'rmSync(', 'unlinkSync(', 'readFile(']) assert.equal(source.includes(forbidden), false, forbidden);
for (const fact of ['chromiumSandbox: true', "downloadsPath: path.join(scope, 'tmp', 'downloads')", 'workers: 1', 'retries: 0', 'repeatEach: 1', 'maxFailures: 1', 'timeout: 90_000', 'globalTimeout: 180_000', "trace: 'off'", "screenshot: 'off'", "video: 'off'", "gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 }"]) assert.ok(config.includes(fact));
for (const fact of ['branches: [ci/loopback-passive-candidate-224]', 'contents: read', 'timeout-minutes: 15', 'retention-days: 3', 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org', 'socket_bytes > 107', 'Unexpected optional native addon', 'Unexpected nested dependency resolution', "read('ownership.json', 8192)", 'messageSha256: digest', "issues.push('retirement-unproved')", 'if (!passed) process.exitCode = 1;', "scope=\"$RUNNER_TEMP/lc-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT\""]) assert.ok(workflow.includes(fact), fact);
for (const forbidden of ['workflow_dispatch:', 'secrets.', '--no-sandbox', '--with-deps', 'sudo ', 'rm -', 'kill ']) assert.equal(workflow.includes(forbidden), false, forbidden);
const sdkPins = JSON.parse(workflow.match(/const sdkPins = (\{[^\r\n]+\});/)[1]);
assert.equal(Object.keys(sdkPins).length, 4);
for (const p of ['node_modules/playwright/lib/index.js', 'node_modules/playwright-core/lib/coreBundle.js']) assert.match(sdkPins[p], /^[a-f0-9]{64}$/);
assert.ok(workflow.includes('mkdir "$scope/tmp/downloads"'));
const socketBytes = Buffer.byteLength('/home/runner/work/_temp/lc-41676005405-1/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket');
assert.equal(socketBytes, 89);
assert.ok(workflow.indexOf('socket_bytes=${#socket_probe}') < workflow.indexOf('mkdir "$scope"'));

assert.ok(workflow.includes('test "$(git -C tooling rev-parse HEAD^)" = a613afc237d8c5172198a3adf4e6c4e2ce54141b'));
for (const fact of ["id: sdk", "SDK_STEP_OUTCOME: ${{ steps.sdk.outcome }}", "sdk_exit=$?", 'exit "$sdk_exit"', "read('sdk-outcome.json', 1024)", 'globalErrors:report && report.errors', 'const {passed} = outcome;', 'issues:outcome.issues', 'globalErrorCount:outcome.globalErrorCount']) assert.ok(workflow.includes(fact), fact);
assert.equal(workflow.includes('((result && result.errors) || report && report.errors || [])'), false);
assert.ok(workflow.includes("import { assessLoopbackOutcome } from './tooling/.github/loopback-console-outcome.mjs'"));
assert.ok(outcome.includes("stepOutcome !== 'success'"));
assert.ok(outcome.includes('command.exitCode !== 0'));
assert.ok(outcome.includes('if (global.length)'));
assert.ok(workflow.indexOf('sdk_exit=$?') > workflow.indexOf('node node_modules/playwright/cli.js test'));

// One exact file/case, including on the combined tree with the six other cohorts.
assert.equal(config.match(/^    testMatch: '([^']+)',$/m)?.[1], 'loopback-console.spec.ts');
let negativeCombinedAndLegacyNames = 0;
for (const file of ['automation-validation.spec.ts', 'stored-serial-results.spec.ts', 'console-results.spec.ts', 'retained-export-files.spec.ts', 'report-import-reliability.spec.ts', 'automation-schedule-fields.spec.ts', 'update-failure-retry.spec.ts', 'network-interface-identity.spec.ts', 'automation-fields.spec.ts']) {
    for (const m of read('../tests/ui/' + file).matchAll(/^test\('([^']+)'/gm)) {
        assert.equal(grep.test(file + ' ' + m[1]), false);
        assert.equal(grep.test(' chromium ' + file + ' ' + m[1]), false);
        negativeCombinedAndLegacyNames += 2;
    }
}
assert.equal(negativeCombinedAndLegacyNames, 32);
assert.deepEqual([...workflow.matchAll(/^                  ref: (.+)$/gm)].map(m => m[1]), ['${{ github.sha }}', "a613afc237d8c5172198a3adf4e6c4e2ce54141b"]);
assert.ok(workflow.includes("test \"$(git -C application rev-parse 'HEAD^{tree}')\" = 3ff168b54e6cc409d8293e66389f820fe28642c0"));
assert.ok(workflow.includes("test \"$(git -C application rev-parse HEAD)\" = a613afc237d8c5172198a3adf4e6c4e2ce54141b"));
assert.equal(hash(read('../shared/diagnostics/network/model.ts')), "0960cb63e750bf6a5da03065b0eca8bfd49cdd4ba785550027047725ae5c5c9d");
assert.equal(hash(read('../src/features/network/NetworkSummary.tsx')), "af532e419359591b5547a597c678f451f8bdad4f3d6f5fd771dd22c60fffd8f6");
console.log(JSON.stringify({selectedCases: 1, negativeCombinedAndLegacyNames, originalAssertionsPreserved: assertions.length, acceptedFullNames: accepted, rejectedFullNames: rejected, criticalSourcePins: Object.keys(pins).length, dependencyFilePins: 35, absentOptionalAddons: 2, readonlyDownloadLimit: 4194304, aggregateReadLimit: 8388608, socketBytes, targetOrDiscoveryExecuted: false}));

assert.ok(source.includes("owner.stage('connect-requested')"));
assert.ok(source.includes("owner.stage('dialog-closed')"));
assert.ok(source.includes("owner.modalState(await modal.isVisible()"));
assert.ok(fixture.includes('diagnostics.cleanupFailure(snapshot()'));
const diagnosticGate = read('./loopback-console-diagnostic.mjs');
assert.ok(diagnosticGate.includes('Buffer.byteLength(JSON.stringify(diagnostic)) > 8192'));
assert.ok(diagnosticGate.includes('input.overflow || value.overflow !== false'));
assert.ok(workflow.includes("import { sanitizeLoopbackDiagnostics } from './application/tests/ui/fixtures/loopback-diagnostics.ts'"));
assert.ok(diagnosticGate.includes("issues.push('diagnostic-evidence-unproved')"));
assert.ok(workflow.includes('issues.push(...diagnosticEvidence.issues)'));
assert.ok(workflow.includes('ownership:owner,diagnostic,exports:files'));

assert.ok(source.includes('passive = installLoopbackPassiveObserver'));
assert.ok(source.includes('passive?.stop()'));
assert.ok(fixture.includes('await clientRetirement.join();'));
assert.ok(diagnosticGate.includes("issues.push('passive-observer-unproved')"));
assert.ok(diagnosticGate.includes("issues.push('passive-observer-not-stopped')"));
