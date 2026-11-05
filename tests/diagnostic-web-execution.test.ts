import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiagnosticWebExecution, validateDiagnosticWebContext, DIAGNOSTIC_WEB_BRANCH, DIAGNOSTIC_WEB_POLICY } from '../scripts/lib/diagnostic-web-execution.mjs';
import { inspectDiagnosticWebBuild } from '../scripts/lib/diagnostic-web-inspection.mjs';
import { readbackFixture } from './fixtures/archive-readback-memory';

const context = () => ({ repository: 'brucerry/embedded-linux-diagnostic-hub', private: false,
    ref: 'refs/heads/' + DIAGNOSTIC_WEB_BRANCH, event: 'push', attempt: '1', runner: 'github-hosted',
    system: 'Linux', arch: 'X64', sha: 'a'.repeat(40), run: '12345', policy: DIAGNOSTIC_WEB_POLICY });
const selection = () => ({ context: context(), root: '/project', gitPath: '/usr/bin/git', gitSHA256: 'b'.repeat(64),
    nodePath: '/tools/node', vitePath: '/project/node_modules/vite/bin/vite.js',
    environment: { PATH: '/tools:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' } });
function ports() {
    const calls: any[] = [], forbidden = () => { assert.fail('No native IO may run in this fixture'); };
    return { calls, filesystem: Object.fromEntries(['realpath', 'lstat', 'open', 'opendir', 'mkdir'].map((k) => [k, forbidden])),
        launch: (...args: any[]) => { calls.push(args); return 'fake direct child, not executed'; },
        setTimer: forbidden, clearTimer: forbidden, now: forbidden };
}
const buildArgs = ['/project/node_modules/vite/bin/vite.js', 'build', '--config', '/project/vite.config.mts', '--mode', 'web', '--outDir', '/project/validation/web-source/site'];
const buildOptions = () => ({ cwd: '/project', env: { ...selection().environment, NODE_ENV: 'production', WEB_BASE_PATH: './' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
const gitPrefix = ['--no-replace-objects', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];

test('diagnostic grant is explicit, construction has no effects and creates no group/qualification proof', () => {
    const p = ports(), selected = selection(), r = createDiagnosticWebExecution(selected, p);
    assert.equal(p.calls.length, 0); assert.equal(r.capability.snapshot().processGroupRetirement, null);
    assert.equal(r.policy.gracefulWholeGroupRetirement, null); assert.equal(r.policy.releaseAcceptance, false);
    assert.equal(r.policy.timeoutCancellation, 'may-use-runner-teardown');
    selected.root = '/replaced'; p.launch = () => { assert.fail('Changed port cannot redirect'); };
    assert.equal(r.capability.launch('/tools/node', buildArgs, buildOptions()), 'fake direct child, not executed');
    assert.equal(p.calls.length, 1);
    assert.throws(() => r.capability.launch('/tools/node', buildArgs, buildOptions()), /replay/);
});
for (const [key, value] of [['private', true], ['ref', 'refs/heads/main'], ['attempt', '2'], ['runner', 'self-hosted'],
    ['system', 'Darwin'], ['arch', 'ARM64'], ['event', 'workflow_dispatch'], ['policy', 'graceful-group-proved']] as const)
    test('context rejects unsupported ' + key + ' before IO', () => {
        const c: any = context(); c[key] = value; const p = ports();
        assert.throws(() => validateDiagnosticWebContext(c));
        assert.throws(() => createDiagnosticWebExecution({ ...selection(), context: c }, p)); assert.equal(p.calls.length, 0);
    });

test('only exact fixed Vite command reaches the supplied launcher', () => {
    const p = ports(), r = createDiagnosticWebExecution(selection(), p);
    for (const args of [[...buildArgs.slice(0, -1), '/outside'], [...buildArgs, '--host'], ['-e', 'launch something']])
        assert.throws(() => r.capability.launch('/tools/node', args, buildOptions()));
    assert.throws(() => r.capability.launch('/bin/sh', buildArgs, buildOptions()));
    for (const change of [{ shell: true }, { detached: true }, { signal: null }, { timeout: 1000 }, { cwd: '/outside' },
        { env: { ...buildOptions().env, SECRET: 'not inherited' } }])
        assert.throws(() => r.capability.launch('/tools/node', buildArgs, { ...buildOptions(), ...change }));
    assert.equal(p.calls.length, 0);
});

test('Git family remains read-only and cannot add hook overrides or arbitrary commands', () => {
    const p = ports(), r = createDiagnosticWebExecution(selection(), p);
    const opts = { cwd: '/project', env: r.capability.gitEnvironment, shell: false, stdio: ['ignore', 'pipe', 'pipe'] };
    r.capability.launch('/usr/bin/git', [...gitPrefix, 'rev-parse', '--verify', 'HEAD'], opts);
    assert.equal(p.calls.length, 1);
    for (const args of [[...gitPrefix, 'push'], [...gitPrefix, '-c', 'core.hooksPath=/dev/null', 'rev-parse', '--verify', 'HEAD']])
        assert.throws(() => r.capability.launch('/usr/bin/git', args, opts));
    assert.equal(p.calls.length, 1);
});

test('receipt records approved runner-teardown limitation and rejects unknown policy', async () => {
    const f = await readbackFixture('web'), record = f.files.get('web-build.json')!, v = JSON.parse(record.toString());
    const args = [record, f.files.get(v.archive.name)!, f.files.get(v.checksum.name)!, v.context,
        { completed: true, exitCode: 0, signal: null, timedOut: false }] as const;
    const { receipt } = inspectDiagnosticWebBuild(...args, DIAGNOSTIC_WEB_POLICY);
    assert.equal(receipt.executionPolicy, DIAGNOSTIC_WEB_POLICY);
    assert.equal(receipt.timeoutCancellation, 'may-use-runner-teardown-no-graceful-group-proof');
    assert.equal(receipt.wholeGroupRetirement, null); assert.equal(receipt.releaseAcceptance, false);
    assert.throws(() => inspectDiagnosticWebBuild(...args, 'retirement-proved'));
});

test('native entry and active workflow retain exact scope and no hidden launch/cleanup surface', () => {
    const entry = readFileSync(new URL('../.github/diagnostic-web-entry.mjs', import.meta.url), 'utf8');
    const workflow = readFileSync(new URL('../.github/workflows/diagnostic-web-build.yml', import.meta.url), 'utf8');
    const guard = entry.indexOf('validateDiagnosticWebContext({'), io = entry.indexOf('createOwnedWebFiles(fs)');
    assert.ok(guard >= 0 && io > guard);
    assert.ok(entry.includes('shell:') === false); // spawn receives only the validated source-owned options.
    assert.ok(!/\b(?:kill|chmod|unlink|rmdir|rm|exec|execSync)\s*\(/.test(entry));
    assert.ok(workflow.includes('branches: [' + DIAGNOSTIC_WEB_BRANCH + ']'));
    assert.ok(workflow.includes('timeout-minutes: 20') && workflow.includes('contents: read'));
    assert.ok(workflow.includes('cancel-in-progress: false'));
    assert.ok(!/actions\/(?:upload|cache)|secrets\.|id-token:|contents: write/.test(workflow));
    assert.ok(workflow.includes('actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803'));
    assert.ok(workflow.includes('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'));
    const first = workflow.indexOf('test "$GITHUB_RUN_ATTEMPT" = 1'), setup = workflow.indexOf('uses: actions/checkout');
    assert.ok(first >= 0 && setup > first);
    function sourceBeforeSetup(value: string) {
        const guard = value.indexOf('test "$(git rev-parse HEAD^)" = 7670d8b096794bbc699e4ca3a8535960a7759784');
        const setup = value.indexOf('uses: actions/setup-node@');
        assert.ok(guard >= 0 && setup > guard);
    }
    sourceBeforeSetup(workflow);
    assert.throws(() => sourceBeforeSetup(workflow.replace('test "$(git rev-parse HEAD^)" = 7670d8b096794bbc699e4ca3a8535960a7759784', '')));
    assert.ok(workflow.includes('node .github/diagnostic-web-entry.mjs'));
});

test('actual main routes package reads through admitted filesystem and preserves a rejected read/close', async () => {
    const url = new URL('../scripts/produce-web-archive.mjs', import.meta.url);
    const source = readFileSync(url, 'utf8'), begin = source.indexOf('export async function main('), end = source.indexOf('\nif (process.argv[1]', begin);
    assert.ok(begin >= 0 && end > begin);
    const body = source.slice(begin, end).replace('export async function', 'async function').replaceAll('import.meta.url', JSON.stringify(url.href));
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const run = new AsyncFunction('assert', 'requireOwnedWebCapabilities', 'process', 'path', 'fileURLToPath', 'localSourceProvider',
        'createRequire', 'produceWebArchive', 'readStableSourceFile', 'createHash', 'raw', body + ';return main(raw,{});');
    const primary = new Error('authored owned package close failure'); let reads = 0;
    const owned = {
        realpath: async (p: string) => p === path.resolve(path.dirname(fileURLToPath(url)), '..') ? '/project' : p,
        lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    };
    const native = { filesystem: owned, executeGit: () => assert.fail('No Git dispatch in this route fixture'), gitEnvironment: {} };
    const sha = 'a'.repeat(40), tree = 'b'.repeat(40), raw = ['--scope=web', '--version=0.6.0', '--source-commit=' + sha,
        '--source-tree=' + tree, '--run-id=12345', '--run-attempt=1', '--job-key=web_archive', '--output=validation/web-source'];
    await assert.rejects(run(assert, () => native, { env: { GITHUB_SHA: sha, GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'web_archive', GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub' }, platform: 'linux' }, path, fileURLToPath,
        async () => ({}), () => ({ resolve: () => '/project/node_modules/vite/package.json' }),
        async (_a: unknown, _b: unknown, io: any) => io.packageJSON(),
        async (root: string, name: string, maximum: unknown, filesystem: unknown) => {
            reads++; assert.equal(root, '/project'); assert.equal(name, 'package.json'); assert.equal(maximum, undefined);
            assert.equal(filesystem, owned, 'Native default filesystem must not bypass the owner'); throw primary;
        }, () => assert.fail('No runtime hashing in this route fixture'), raw), (error: unknown) => error === primary);
    assert.equal(reads, 1);
});
