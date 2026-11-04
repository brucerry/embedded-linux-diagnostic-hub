// Read source as data only; never import the driver, build tools or an app module.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const workflow = read('./workflows/linux-portable.yml');
const driver = read('../scripts/linux-private-integrated-ci.mjs');
const helper = read('../scripts/lib/linux-private-integrated-ci.mjs');
const pkg = JSON.parse(read('../package.json'));
const source = '4745d466139031de2c81e5b3e3b19ea8b24d72bf';
const tree = '825f83b3489382bdf68518f4135e6cd60ebfec79';
assert.match(workflow, /on:\n    push:\n        branches: \[ci\/integration216-linux-package-readback\]/);
const jobs = workflow.slice(workflow.indexOf('\njobs:\n') + 7);
assert.deepEqual([...jobs.matchAll(/^    ([a-z][a-z0-9-]*):$/gm)].map(m => m[1]), ['private-artifacts']);
for (const forbidden of ['workflow_dispatch:', 'workflow_call:', 'pull_request:', 'secrets.', 'contents: write',
    'gnome:', '--cap-add', 'seccomp=unconfined', 'sudo ', '--no-sandbox', 'HOME=', 'env -i',
    'npm run verify', 'test:e2e', 'xvfb-run', 'staged-artifact-native', 'desktop-smoke'])
    assert.equal(workflow.includes(forbidden), false, forbidden);
for (const fact of ['runs-on: ubuntu-22.04', 'timeout-minutes: 30', 'contents: read',
    'cancel-in-progress: false', 'github.run_attempt == 1', 'retention-days: 3', 'compression-level: 0',
    'overwrite: false', 'include-hidden-files: false', 'persist-credentials: false', 'clean: false',
    'set-safe-directory: false', 'submodules: false', 'lfs: false', 'fetch-depth: 2',
    'DH_WORKFLOW_FILE_SHA: ${{ github.workflow_sha }}', 'ref: ' + source]) assert.ok(workflow.includes(fact), fact);
assert.deepEqual([...workflow.matchAll(/^                  ref: (.+)$/gm)].map(m => m[1]), ['${{ github.sha }}', source]);
for (const phase of ['admit', 'dependencies', 'pre-package', 'package', 'finalize'])
    assert.equal(workflow.split('run: node tooling/scripts/linux-private-integrated-ci.mjs ' + phase + '\n').length, 2, phase);
const uploads = [...workflow.matchAll(/^                      \$\{\{ github.workspace \}\}\/private-artifacts\/(.+)$/gm)].map(m => m[1]);
assert.equal(uploads.length, 15); assert.equal(new Set(uploads).size, 15);
assert.ok(uploads.every(p => p.startsWith('${{ env.DH_BUILD_ID }}/')));
assert.equal(uploads.filter(p => p.endsWith('/cohort-receipt.json')).length, 1);
assert.equal(uploads.filter(p => p.includes('/upload/')).length, 14);
assert.ok(uploads.every(p => !p.includes('*') && !p.includes('..') && !p.includes('node_modules')));
assert.ok(helper.includes("commit: '" + source + "'")); assert.ok(helper.includes("tree: '" + tree + "'"));
assert.ok(helper.includes("sha256: '3b1deb2366c3857b199b2f59d7861793a2fa2cd0e69dfd160d1a9239a1fd0cf5'"));
assert.ok(helper.includes('files: 907, bytes: 8860226'));
for (const forbidden of ['core.hooksPath=/dev/null', 'GIT_CONFIG_GLOBAL:', 'GIT_CONFIG_NOSYSTEM:',
    'fs.chmod(', 'fs.chown(', 'process.env.HOME =', 'application.launch('])
    assert.equal(driver.includes(forbidden), false, forbidden);
for (const fact of ['gitQueryEnvironment(process.env)', 'requireSafeGitQueries(args => queryGit(cwd, args))',
    "git(tooling, ['rev-parse', 'HEAD^'])", "git(tooling, ['cat-file', 'blob', 'HEAD:' + n])",
    "tree !== LINUX_CI_SOURCE.tree", "await absent(path.join(app, '.npmrc'))",
    'const environment = packageEnvironment(process.env', 'const completion = await observePackageChild(child)',
    "shell: false, stdio: 'inherit'", 'await retireOwnedHandles(primary, [destination, fd])',
    'createCohortReceipt(input, final.files, expectedAccounting, inventory)', 'compiledSourceProven: false',
    'appLaunched: false', 'handoffAllowed: false', 'retirementProven:', 'await handle.sync()',
    "publishControl(phase + '-attempt.json'", "publishControl(phase + '-completed.json'",
    "await requireCommand('dependencies')", "await requireCommand('package')"])
    assert.ok(driver.includes(fact), fact);
assert.equal(pkg.scripts['package:linux'], 'npm run build && electron-builder --linux AppImage tar.gz --x64 --publish never');
assert.ok(helper.includes("nativeValidation: 'unperformed'"));
assert.ok(helper.includes("['executable', 'diagnostic-hub']"));
assert.ok(helper.includes("['asar', 'resources/app.asar']"));
assert.ok(helper.includes('toolingCommit: admitted.workflowSHA, buildId: admitted.buildId'));
console.log(JSON.stringify({ jobs: 1, trigger: 'one new branch push', phases: 5,
    uploadFiles: uploads.length, retentionDays: 3, appSource: source, appTree: tree,
    homeRedirectRemoved: true, gitConfigurationOverridesRemoved: true, uploadChmodRemoved: true,
    sourceOnly: true, buildInstallNativeExecuted: false }));

assert.ok(driver.indexOf("publishControl(phase + '-attempt.json'") < driver.indexOf('const child = spawn('));
assert.ok(driver.indexOf("publishControl(phase + '-completed.json'") > driver.indexOf('await observePackageChild(child)'));

assert.ok(helper.includes('validateReadbackJob(expectedJob, observedJob)'));
assert.ok(helper.includes('admitted.runId !== selected.runId || admitted.runAttempt !== selected.runAttempt'));
assert.ok(helper.includes("observed.status !== 'completed' || observed.conclusion !== 'success'"));
assert.ok(helper.includes("['workflowSHA', 'runId', 'runAttempt', 'jobId', 'artifactId']"));
