import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
assert.equal(process.platform, 'darwin');
const arch = process.arch;
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'hub-mac-installer-'));
const bin = path.join(root, 'bin');
const fixture = path.join(root, 'fixture');
const directory = path.join(root, 'Applications with spaces');
const target = path.join(directory, 'Diagnostic Hub.app');
await mkdir(bin);
await mkdir(fixture);
await mkdir(directory);
const payload = 'Diagnostic-Hub-macos-' + arch + '.zip';
const original = JSON.parse(await readFile('release/macos-build-info-' + arch + '.json', 'utf8'));
await writeFile(
    path.join(fixture, 'release.json'),
    JSON.stringify({ tag_name: 'v' + version, draft: false, target_commitish: original.commit }),
);
const fixtureScript = path.join(root, 'curl.mjs');
await writeFile(
    fixtureScript,
    [
        "import {copyFile,writeFile} from 'node:fs/promises';",
        "import path from 'node:path';",
        "const args=process.argv.slice(2); const url=args.find(v=>v.startsWith('https://')); const out=args[args.indexOf('-o')+1];",
        "const name=url.includes('api.github.com')?'release.json':decodeURIComponent(url.split('/').at(-1));",
        "if(process.env.HUB_FIXTURE_CASE==='download-failure' && name.endsWith('.zip')) {await writeFile(out,'partial');process.exit(22);}",
        'await copyFile(path.join(process.env.HUB_MAC_FIXTURE,name),out);',
    ].join('\n'),
);
async function shim(name, body) {
    await writeFile(path.join(bin, name), '#!/bin/bash\n' + body + '\n', { mode: 0o700 });
}
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
await shim(
    'curl',
    'exec ' + shellQuote(process.execPath) + ' ' + shellQuote(fixtureScript) + ' "$@"',
);
await shim(
    'uname',
    'if [ "$1" = "-m" ] && [ -n "$HUB_FIXTURE_MACHINE" ]; then printf "%s\\n" "$HUB_FIXTURE_MACHINE"; else exec /usr/bin/uname "$@"; fi',
);
await shim(
    'sysctl',
    'if [ -n "$HUB_FIXTURE_ARM" ]; then printf "%s\\n" "$HUB_FIXTURE_ARM"; else exec /usr/sbin/sysctl "$@"; fi',
);
await shim(
    'open',
    'if [ "$HUB_FIXTURE_CASE" = launch-failure ]; then exit 1; fi\nexec /usr/bin/open "$@"',
);
await shim(
    'mv',
    'if [ "$HUB_FIXTURE_CASE" = interrupted ] && [[ "$1" == */extracted/Diagnostic\\ Hub.app ]]; then kill -TERM "$PPID"; exit 1; fi\nexec /bin/mv "$@"',
);
const env = {
    ...process.env,
    PATH: bin + ':' + process.env.PATH,
    HUB_MAC_FIXTURE: fixture,
    HUB_FIXTURE_CASE: '',
    HUB_FIXTURE_MACHINE: '',
    HUB_FIXTURE_ARM: '',
};
const helper = path.resolve('public/download-run-macos.sh');
function run(extraEnv = {}, args = ['--no-launch']) {
    return spawnSync(
        '/bin/bash',
        [helper, '--version', 'v' + version, '--directory', directory, ...args],
        { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120000 },
    );
}
async function reset(info = original, bytes) {
    if (bytes) await writeFile(path.join(fixture, payload), bytes);
    else await copyFile(path.join('release', payload), path.join(fixture, payload));
    const sha256 = createHash('sha256')
        .update(await readFile(path.join(fixture, payload)))
        .digest('hex');
    await writeFile(path.join(fixture, payload + '.sha256'), sha256 + '  ' + payload + '\n');
    await writeFile(
        path.join(fixture, 'macos-build-info-' + arch + '.json'),
        JSON.stringify({ ...info, sha256 }),
    );
}
await reset();
let result = run();
assert.equal(result.status, 0, result.stderr + result.stdout);
const previous = await readFile(path.join(target, 'Contents/Resources/app.asar'));
const userData = path.join(root, 'user-data');
await mkdir(userData);
await writeFile(path.join(userData, 'preserved.txt'), 'user data');
async function reject(label, extraEnv = {}, args = ['--no-launch']) {
    const result = run(extraEnv, args);
    assert.notEqual(result.status, 0, label + ' must fail: ' + result.stdout);
    assert.deepEqual(
        await readFile(path.join(target, 'Contents/Resources/app.asar')),
        previous,
        label + ' replaced prior app',
    );
    assert.equal(await readFile(path.join(userData, 'preserved.txt'), 'utf8'), 'user data');
    assert.ok(!result.stdout.includes('Installed Diagnostic Hub'), label + ' claimed success');
    console.log('Rejected ' + label + '; prior app and user data preserved.');
    return result;
}
await reject('unsafe tag', {}, ['--version', '../unsafe', '--no-launch']);
await reject('unsupported architecture', { HUB_FIXTURE_MACHINE: 'ppc', HUB_FIXTURE_ARM: '0' });
await reject('interrupted download', { HUB_FIXTURE_CASE: 'download-failure' });
await writeFile(path.join(fixture, payload + '.sha256'), '0'.repeat(64) + '  ' + payload + '\n');
await reject('corrupt checksum');
for (const change of [
    { arch: arch === 'x64' ? 'arm64' : 'x64' },
    { version: '0.0.0' },
    { minimumMacOSVersion: '999.0.0' },
    { signature: 'Developer ID' },
    { asarSHA256: '0'.repeat(64) },
]) {
    await reset({ ...original, ...change });
    await reject('mismatched ' + Object.keys(change)[0]);
}
for (const entry of ['../outside', 'Other.app/file', 'Diagnostic Hub.app/../../outside']) {
    await reset(original, zipSync({ [entry]: strToU8('unsafe') }));
    await reject('unsafe archive ' + entry);
}
await reset(
    original,
    zipSync({
        'Diagnostic Hub.app/escape': [strToU8('/tmp/outside'), { os: 3, attrs: 0xa1ff0000 }],
    }),
);
await reject('escaping archive symlink');
await reset(
    original,
    zipSync({ 'Diagnostic Hub.app/': [strToU8('__MACOSX'), { os: 3, attrs: 0xa1ff0000 }] }),
);
await reject('symlinked app root');
await reset();
const runningEnv = { ...process.env };
delete runningEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(
    path.join(target, 'Contents/MacOS/Diagnostic Hub'),
    ['--user-data-dir=' + path.join(root, 'running-profile')],
    { env: runningEnv, stdio: 'ignore' },
);
try {
    const deadline = Date.now() + 15000;
    while (
        spawnSync('/usr/sbin/lsof', ['-t', path.join(target, 'Contents/MacOS/Diagnostic Hub')])
            .status !== 0
    ) {
        assert.equal(child.exitCode, null, 'Installed app exited before running-app check.');
        if (Date.now() >= deadline) throw Error('Installed app did not start.');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const refused = await reject('running application');
    assert.match(refused.stderr, /Quit Diagnostic Hub/);
} finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([
        exited,
        new Promise((_, reject) =>
            setTimeout(() => reject(Error('Installed app did not quit.')), 5000),
        ),
    ]);
}
await reject('interrupted replacement', { HUB_FIXTURE_CASE: 'interrupted' });
await reject('launch refusal rollback', { HUB_FIXTURE_CASE: 'launch-failure' }, []);
if (arch === 'arm64') {
    result = run({ HUB_FIXTURE_MACHINE: 'x86_64', HUB_FIXTURE_ARM: '1' });
    assert.equal(
        result.status,
        0,
        'Translated terminal must select native Apple Silicon: ' + result.stderr,
    );
}
result = run();
assert.equal(result.status, 0, result.stderr);
execFileSync(process.execPath, ['scripts/verify-macos-package.mjs', target, arch], {
    stdio: 'inherit',
});
if (process.env.GITHUB_ENV)
    await writeFile(
        process.env.GITHUB_ENV,
        'HUB_TEST_EXECUTABLE=' +
            target +
            '/Contents/MacOS/Diagnostic Hub\nHUB_MAC_INSTALLED_APP=' +
            target +
            '\n',
        { flag: 'a' },
    );
await rm(bin, { recursive: true });
await rm(fixture, { recursive: true });
console.log(
    JSON.stringify({
        nativeInstallerPassed: true,
        arch,
        version,
        source: original.commit,
        installedApp: target,
        remaining: 'Physical Mac and browser quarantine acceptance not claimed.',
    }),
);
