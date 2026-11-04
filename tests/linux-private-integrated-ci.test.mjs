import assert from 'node:assert/strict';
import test from 'node:test';
import { PRIVATE_SOURCE, PACKAGE_REF, PACKAGE_BUILD_ID, validatePackageInput,
    requirePlainEnvironment, gitQueryEnvironment, requireSafeGitQueries, packageEnvironment,
    packageArguments, observePackageChild, retireOwnedHandles, nativeQualificationInputs,
    createCohortReceipt, verifyCohortReadback, completedCommandReceipt, validateCompletedCommand, LINUX_CI_ASSETS, LINUX_CI_METADATA, ciJSON, ciHash }
    from '../scripts/lib/linux-private-integrated-ci.mjs';

const input = () => ({ event: 'push', artifactOnly: true, ref: PACKAGE_REF,
    repository: 'brucerry/embedded-linux-diagnostic-hub', appSHA: PRIVATE_SOURCE.commit,
    workflowSHA: 'b'.repeat(40), workflowFileSHA: 'b'.repeat(40), runId: '12345',
    runAttempt: '1', buildId: PACKAGE_BUILD_ID });
const workspace = '/home/runner/work/hub/hub', root = workspace + '/private-artifacts/' + PACKAGE_BUILD_ID;
const expectedJob = () => ({ workflowSHA: input().workflowSHA, runId: input().runId,
    runAttempt: '1', jobId: '34567', artifactId: '45678' });
const observedJob = () => ({ ...expectedJob(), status: 'completed', conclusion: 'success' });


test('only exact source branch workflow identity and one-shot build identity admit', () => {
    assert.deepEqual(validatePackageInput(input()), input());
    for (const delta of [{ event: 'workflow_dispatch' }, { event: 'pull_request' }, { ref: 'refs/heads/main' },
        { appSHA: 'a'.repeat(40) }, { workflowSHA: PRIVATE_SOURCE.commit }, { workflowFileSHA: 'c'.repeat(40) },
        { runAttempt: '2' }, { buildId: 'c'.repeat(32) }, { repository: 'other/repo' }, { extra: true }])
        assert.throws(() => validatePackageInput({ ...input(), ...delta }), /CI_INPUT/);
});
test('package child keeps HOME unchanged and excludes inherited tokens and arbitrary settings', () => {
    const inherited = { HOME: '/home/runner', PATH: '/untrusted', GITHUB_TOKEN: 'synthetic',
        ACTIONS_RUNTIME_TOKEN: 'synthetic', CSC_LINK: 'synthetic', unrelated: 'value' };
    const before = structuredClone(inherited), env = packageEnvironment(inherited, '/opt/node/bin/node', workspace, root);
    assert.equal(env.HOME, inherited.HOME); assert.deepEqual(inherited, before);
    for (const key of ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'CSC_LINK', 'unrelated']) assert.equal(key in env, false);
    for (const key of ['TMPDIR', 'NPM_CONFIG_CACHE', 'ELECTRON_CACHE', 'ELECTRON_BUILDER_CACHE', 'XDG_CACHE_HOME', 'npm_config_devdir'])
        assert.ok(env[key].startsWith(root + '/'), key);
    assert.equal(env.NPM_CONFIG_USERCONFIG, root + '/npm-user.npmrc');
    assert.equal(env.NPM_CONFIG_GLOBALCONFIG, root + '/npm-global.npmrc');
});
test('inherited proxy CA Node and Git injection is refused rather than silently bypassed', () => {
    for (const key of ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY',
        'SSL_CERT_FILE', 'LD_PRELOAD', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_DIR', 'GIT_REPLACE_REF_BASE'])
        assert.throws(() => requirePlainEnvironment({ HOME: '/home/runner', [key]: 'synthetic' }));
    for (const home of ['', '/', '/home/runner/../other', '/home/runner\n'])
        assert.throws(() => requirePlainEnvironment({ HOME: home }));
});
test('cache and command construction refuses traversal and arbitrary command phases', () => {
    assert.throws(() => packageEnvironment({ HOME: '/home/runner' }, '/node', workspace, root + '/../elsewhere'));
    assert.deepEqual(packageArguments('dependencies', '/opt/node/bin/node').slice(1),
        ['ci', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org']);
    assert.deepEqual(packageArguments('package', '/opt/node/bin/node').slice(1), ['run', 'package:linux']);
    for (const phase of ['cleanup', 'shell', 'install', 'verify']) assert.throws(() => packageArguments(phase, '/opt/node/bin/node'));
});
test('read-only Git environment preserves HOME without disabling global or hook configuration', () => {
    const env = gitQueryEnvironment({ HOME: '/home/runner', GITHUB_TOKEN: 'synthetic' });
    assert.equal(env.HOME, '/home/runner');
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_REPLACE_OBJECTS', 'GITHUB_TOKEN'])
        assert.equal(key in env, false);
});
function gitFixture(change = () => undefined) {
    const calls = [];
    return { calls, query(args) {
        calls.push([...args]); const changed = change(args); if (changed) return changed;
        return { status: args[0] === 'config' ? 1 : 0, stdout: '' };
    } };
}
test('Git safety preflight uses effective configuration reads and never changes hook settings', () => {
    const f = gitFixture(args => args.includes('core.fsmonitor') ? { status: 0, stdout: 'false\n' } : undefined);
    requireSafeGitQueries(f.query);
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls.every(args => !args.includes('-c') && !args.some(a => a.includes('hooksPath') || a.includes('filter.'))));
});
test('external Git fsmonitor helpers partial clone and replacement state fail before source queries', () => {
    for (const response of [{ status: 0, stdout: 'true\n' }, { status: 128, stdout: '' }]) {
        const f = gitFixture(args => args.includes('core.fsmonitor') ? response : undefined);
        assert.throws(() => requireSafeGitQueries(f.query), /CI_GIT_CONFIG/); assert.equal(f.calls.length, 1);
    }
    for (const at of ['^(extensions\\.partialclone|remote\\..*\\.promisor)$', 'refs/replace']) {
        const f = gitFixture(args => args.includes(at) ? { status: 0, stdout: 'present\n' } : undefined);
        assert.throws(() => requireSafeGitQueries(f.query), /CI_GIT_CONFIG/);
        assert.ok(!f.calls.some(args => args.includes('ls-files') || args.includes('rev-parse')));
    }
});
test('every admitted file close is attempted and primary plus close errors survive', async () => {
    const primary = new Error('primary write'), close = new Error('destination close'), calls = [];
    await assert.rejects(retireOwnedHandles({ failed: true, error: primary }, [
        { close: async () => { calls.push('destination'); throw close; } },
        { close: async () => { calls.push('source'); } },
    ]), error => error instanceof AggregateError && error.errors[0] === primary &&
        error.errors[1] === close && error.cause === primary && error.retirementProven === false);
    assert.deepEqual(calls, ['destination', 'source']);
});
test('fully acknowledged close preserves the original failure or ordinary successful completion', async () => {
    const original = new Error('read failure');
    await assert.rejects(retireOwnedHandles({ failed: true, error: original }, [{ close: async () => {} }]), error => error === original);
    await retireOwnedHandles({ failed: false }, [{ close: async () => {} }]);
    await assert.rejects(retireOwnedHandles({ failed: false }, [{ close: async () => { throw Error('close'); } }]), /CI_CLOSE/);
});
test('child error alone is not completion and cannot claim descendant retirement', async () => {
    const callbacks = new Map(), child = { once(name, fn) { callbacks.set(name, fn); } };
    let resolved = false; const task = observePackageChild(child).then(value => { resolved = true; return value; });
    const original = new Error('spawn failed'); callbacks.get('error')(original);
    await Promise.resolve(); await Promise.resolve(); assert.equal(resolved, false);
    callbacks.get('close')(null, null); const value = await task;
    assert.equal(value.error, original); assert.equal(value.childCloseObserved, true);
    assert.equal(value.descendantRetirementQualified, false);
});
function cohort() {
    const files = [{ path: 'diagnostic-hub', bytes: 10, mode: 0o755, sha256: '1'.repeat(64) },
        { path: 'resources/app.asar', bytes: 20, mode: 0o644, sha256: '2'.repeat(64) }];
    const inventory = { files, directories: ['resources'], payloadBytes: 30,
        inventorySHA256: ciHash(Buffer.from(JSON.stringify(files))) };
    const flat = ciJSON(inventory);
    const rows = [...LINUX_CI_ASSETS, ...Object.keys(LINUX_CI_METADATA)]
        .filter(name => name !== 'upload-accounting.json').map(name => ({ name, bytes: 100, sha256: 'd'.repeat(64) }));
    Object.assign(rows.find(f => f.name === 'flat-inventory.json'), { bytes: flat.length, sha256: ciHash(flat) });
    const accountingBytes = ciJSON({ schema: 1, files: rows, accountingFileExcludedFromHashList: true });
    const accounting = { bytes: accountingBytes.length, sha256: ciHash(accountingBytes) };
    rows.push({ name: 'upload-accounting.json', ...accounting });
    return { inventory, flat, rows, accounting };
}
test('native prerequisite identity binds actual executable ASAR source tooling and build ID', () => {
    const f = cohort(), value = nativeQualificationInputs(input(), f.inventory, f.rows.filter(row => LINUX_CI_ASSETS.includes(row.name)));
    assert.equal(value.applicationCommit, PRIVATE_SOURCE.commit); assert.equal(value.applicationTree, PRIVATE_SOURCE.tree);
    assert.equal(value.toolingCommit, input().workflowSHA); assert.equal(value.buildId, PACKAGE_BUILD_ID);
    assert.equal(value.assets.length, 2); assert.equal(value.assets[0].sha256, 'd'.repeat(64));
    assert.equal(value.executable.sha256, '1'.repeat(64)); assert.equal(value.asar.sha256, '2'.repeat(64));
    for (const files of [f.inventory.files.slice(1), [...f.inventory.files, f.inventory.files[0]],
        [{ ...f.inventory.files[0], sha256: undefined }, f.inventory.files[1]]]) {
        const changed = { ...f.inventory, files, inventorySHA256: ciHash(Buffer.from(JSON.stringify(files))) };
        assert.throws(() => nativeQualificationInputs(input(), changed, f.rows.filter(row => LINUX_CI_ASSETS.includes(row.name))), /CI_NATIVE_IDENTITY/);
    }
});
test('cohort readback can only match unqualified bytes with the expected workflow and flat metadata', () => {
    const f = cohort(), receipt = createCohortReceipt(input(), f.rows, f.accounting, f.inventory);
    assert.equal(receipt.handoffAllowed, false); assert.equal(receipt.nativeValidation, 'unperformed');
    assert.equal(verifyCohortReadback(receipt, [...f.rows].reverse(), expectedJob(), observedJob(), f.flat).status,
        'readback-matched-unqualified');
    assert.throws(() => verifyCohortReadback(receipt, f.rows, { ...expectedJob(), workflowSHA: 'c'.repeat(40) }, observedJob(), f.flat));
    for (const delta of [{ status: 'passed' }, { nativeValidation: 'verified' }, { compiledSourceProven: true }, { handoffAllowed: true }, { unknownAuthority: true }])
        assert.throws(() => verifyCohortReadback({ ...receipt, ...delta }, f.rows, expectedJob(), observedJob(), f.flat));
});
test('same-size asset or ASAR drift and metadata substitution cannot pass by filename/version', () => {
    const f = cohort(), receipt = createCohortReceipt(input(), f.rows, f.accounting, f.inventory);
    const rows = structuredClone(f.rows); rows[0].sha256 = 'e'.repeat(64);
    assert.throws(() => verifyCohortReadback(receipt, rows, expectedJob(), observedJob(), f.flat), /CI_CHANGED/);
    const wrong = structuredClone(receipt); wrong.nativeQualificationInputs.asar.sha256 = 'e'.repeat(64);
    assert.throws(() => verifyCohortReadback(wrong, f.rows, expectedJob(), observedJob(), f.flat), /CI_NATIVE_IDENTITY/);
    assert.throws(() => verifyCohortReadback(receipt, f.rows, expectedJob(), observedJob(), Buffer.from('{}')), /CI_CHANGED/);
});

test('phase advancement requires matching owner and actual successful child close acknowledgement', () => {
    const completed = { code: 0, signal: null, error: null, childCloseObserved: true, descendantRetirementQualified: false };
    const receipt = completedCommandReceipt(input(), 'dependencies', completed);
    assert.equal(validateCompletedCommand(receipt, input(), 'dependencies').status, 'command-closed-unqualified');
    assert.throws(() => validateCompletedCommand(receipt, input(), 'package'), /CI_COMMAND/);
    for (const delta of [{ code: 1 }, { signal: 'SIGTERM' }, { childCloseObserved: false }, { error: new Error('spawn') }])
        assert.throws(() => completedCommandReceipt(input(), 'dependencies', { ...completed, ...delta }), /CI_COMMAND/);
    const other = { ...input(), workflowSHA: 'c'.repeat(40), workflowFileSHA: 'c'.repeat(40) };
    assert.throws(() => validateCompletedCommand(receipt, other, 'dependencies'), /CI_COMMAND/);
});

test('readback rejects a receipt from another run even with identical source tooling and assets', () => {
    const f = cohort(), other = { ...input(), runId: '12346' };
    const receipt = createCohortReceipt(other, f.rows, f.accounting, f.inventory);
    assert.throws(() => verifyCohortReadback(receipt, f.rows, expectedJob(), observedJob(), f.flat), /CI_RUN_BINDING/);
    const receiptHere = createCohortReceipt(input(), f.rows, f.accounting, f.inventory);
    const changed = structuredClone(receiptHere); changed.input.runAttempt = '2';
    assert.throws(() => verifyCohortReadback(changed, f.rows, expectedJob(), observedJob(), f.flat));
});
test('readback requires matching independently selected artifact run attempt job and tooling identities', () => {
    const f = cohort(), receipt = createCohortReceipt(input(), f.rows, f.accounting, f.inventory);
    for (const delta of [{ runId: '12346' }, { runAttempt: '2' }, { artifactId: '45679' },
        { jobId: '34568' }, { workflowSHA: 'c'.repeat(40) }, { status: 'in_progress' },
        { conclusion: 'failure' }, { conclusion: 'cancelled' }])
        assert.throws(() => verifyCohortReadback(receipt, f.rows, expectedJob(), { ...observedJob(), ...delta }, f.flat), /CI_RUN_BINDING/);
    const result = verifyCohortReadback(receipt, f.rows, expectedJob(), observedJob(), f.flat);
    for (const key of ['runId', 'runAttempt', 'jobId', 'artifactId']) assert.equal(result[key], expectedJob()[key]);
});
test('readback fails closed for missing malformed or self-asserted execution context', () => {
    const f = cohort(), receipt = createCohortReceipt(input(), f.rows, f.accounting, f.inventory);
    for (const key of Object.keys(expectedJob())) {
        const expected = expectedJob(); delete expected[key];
        assert.throws(() => verifyCohortReadback(receipt, f.rows, expected, observedJob(), f.flat), /CI_RUN_BINDING/);
    }
    for (const key of Object.keys(observedJob())) {
        const observed = observedJob(); delete observed[key];
        assert.throws(() => verifyCohortReadback(receipt, f.rows, expectedJob(), observed, f.flat), /CI_RUN_BINDING/);
    }
    for (const expected of [undefined, null, {}, { ...expectedJob(), artifactId: 45678 },
        { ...expectedJob(), artifactId: '0' }, { ...expectedJob(), runAttempt: '2' }])
        assert.throws(() => verifyCohortReadback(receipt, f.rows, expected, observedJob(), f.flat), /CI_RUN_BINDING/);
    for (const observed of [undefined, null, {}, receipt.input])
        assert.throws(() => verifyCohortReadback(receipt, f.rows, expectedJob(), observed, f.flat), /CI_RUN_BINDING/);
});
