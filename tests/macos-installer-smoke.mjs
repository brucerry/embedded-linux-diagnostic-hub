import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    mkdtemp,
    mkdir,
    readFile,
    writeFile,
    copyFile,
    rm,
    realpath,
    open,
} from 'node:fs/promises';
import { tmpdir, release as osRelease } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
    digest,
    hashFile,
    laneFiles,
} from '../scripts/lib/staged-artifact-gate.mjs';
import {
    createMacInstallerObservation,
    publishMacInstallerObservation,
    assertMacInstallerHelperReturn,
    allocateMacInstallerFixture,
    macInstallerPublishRoot,
    macInstallerAllocationDiagnostic,
} from '../scripts/lib/macos-installer-observation.mjs';
import path from 'node:path';
import http from 'node:http';
import { chromium, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
// Retained publication handles belong to this one invocation; failures do not delete files.
const publicationHandles = [];
const fixtureAllocations = [];
export async function runMacInstallerSmoke() {
    assert.equal(process.platform, 'darwin');
    const arch = process.arch;
    const { version } = JSON.parse(await readFile('package.json', 'utf8'));
    const original = JSON.parse(
        await readFile('release/macos-build-info-' + arch + '.json', 'utf8'),
    );
    // Actual immutable source/runtime/artifact bindings are required before fixture effects.
    const git = (...args) =>
        execFileSync('git', args, { encoding: 'utf8' }).trim();
    const sourceCommit = git('rev-parse', 'HEAD');
    const sourceTree = git('rev-parse', 'HEAD^{tree}');
    assert.equal(
        git('status', '--porcelain', '--untracked-files=no'),
        '',
        'Commit the reviewed successor before native execution.',
    );
    assert.equal(original.commit, sourceCommit);
    assert.equal(original.version, version);
    if (process.env.GITHUB_SHA)
        assert.equal(process.env.GITHUB_SHA, sourceCommit);
    const context = { version, sourceCommit, sourceTree };
    const runtime = {
        platform: process.platform,
        arch,
        osRelease: osRelease(),
        node: process.versions.node,
        executable: process.execPath,
        executableSHA256: (await hashFile(process.execPath)).sha256,
    };
    const artifacts = await Promise.all(
        laneFiles(version, 'darwin-' + arch).map((name) =>
            hashFile(path.join('release', name), name),
        ),
    );
    assert.equal(original.arch, arch);
    const artifact = (name) => artifacts.find((item) => item.name === name);
    assert.equal(
        original.sha256,
        artifact('Diagnostic-Hub-macos-' + arch + '.zip').sha256,
    );
    for (const item of artifacts.filter(
        (item) => item.name.endsWith('.zip') || item.name.endsWith('.sh'),
    ))
        assert.equal(
            await readFile(path.join('release', item.name + '.sha256'), 'utf8'),
            `${item.sha256}  ${item.name}\n`,
        );
    assert.equal(
        artifact('download-run-macos.sh').sha256,
        digest(await readFile('public/download-run-macos.sh')),
        'Execute the exact helper bound into the staged artifact catalog.',
    );
    const observation = createMacInstallerObservation({
        context,
        runtime,
        artifacts,
        command: [
            process.execPath,
            ...process.execArgv,
            fileURLToPath(import.meta.url),
        ],
        startedAt: new Date().toISOString(),
    });
    let root;
    const allocation = {
        allocation: 'unexecuted',
        allocatedPath: null,
        canonicalReturnedPath: null,
        canonicalRoot: null,
        canonicalization: 'unexecuted',
        failure: null,
    };
    fixtureAllocations.push(allocation);
    let failure;
    const start = (id) => observation.start(id, new Date().toISOString());
    const verified = () => observation.verify(new Date().toISOString());
    try {
        // The helper resolves its installation directory with pwd -P. Match that native contract.
        root = await allocateMacInstallerFixture(
            path.join(tmpdir(), 'hub-mac-installer-'),
            allocation,
            { mkdtemp, realpath },
        );
        const bin = path.join(root, 'bin');
        const fixture = path.join(root, 'fixture');
        const directory = path.join(root, 'Applications with spaces');
        const target = path.join(directory, 'Diagnostic Hub.app');
        await mkdir(bin);
        await mkdir(fixture);
        await mkdir(directory);
        const payload = 'Diagnostic-Hub-macos-' + arch + '.zip';

        await writeFile(
            path.join(fixture, 'release.json'),
            JSON.stringify({
                tag_name: 'v' + version,
                draft: false,
                target_commitish: original.commit,
            }),
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
            await writeFile(
                path.join(bin, name),
                '#!/bin/bash\n' + body + '\n',
                { mode: 0o700 },
            );
        }
        const shellQuote = (value) =>
            "'" + value.replaceAll("'", "'\\''") + "'";
        await shim(
            'curl',
            'exec ' +
                shellQuote(process.execPath) +
                ' ' +
                shellQuote(fixtureScript) +
                ' "$@"',
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
        // Dialog responses below are explicit fixture consent, not native GUI acceptance.
        await shim(
            'osascript',
            'cat >/dev/null\nif [ "$HUB_FIXTURE_REVIEW" = cancel ]; then printf "cancel\\n"; elif [ "$4" = 1 ]; then printf "open\\n"; else printf "install\\n"; fi',
        );
        const env = {
            ...process.env,
            PATH: bin + ':' + process.env.PATH,
            HUB_MAC_FIXTURE: fixture,
            HUB_FIXTURE_CASE: '',
            HUB_FIXTURE_REVIEW: '',
            HUB_FIXTURE_MACHINE: '',
            HUB_FIXTURE_ARM: '',
        };
        const helper = path.resolve('public/download-run-macos.sh');
        function run(
            extraEnv = {},
            args = ['--no-launch'],
            expectedReturn = 'success',
        ) {
            const result = spawnSync(
                '/bin/bash',
                [
                    helper,
                    '--version',
                    'v' + version,
                    '--directory',
                    directory,
                    ...args,
                ],
                {
                    env: { ...env, ...extraEnv },
                    encoding: 'utf8',
                    timeout: 120000,
                },
            );
            const fact = observation.helperReturn({
                command: [
                    '/bin/bash',
                    helper,
                    '--version',
                    'v' + version,
                    '--directory',
                    directory,
                    ...args,
                ],
                exitCode: result.status,
                signal: result.signal,
                error: result.error
                    ? result.error.code === 'ETIMEDOUT'
                        ? 'timeout'
                        : 'spawn-error'
                    : 'none',
                stdout: result.stdout ?? '',
                stderr: result.stderr ?? '',
                expectedReturn,
            });
            assertMacInstallerHelperReturn(fact);
            return result;
        }
        async function reset(info = original, bytes) {
            if (bytes) await writeFile(path.join(fixture, payload), bytes);
            else
                await copyFile(
                    path.join('release', payload),
                    path.join(fixture, payload),
                );
            const sha256 = createHash('sha256')
                .update(await readFile(path.join(fixture, payload)))
                .digest('hex');
            await writeFile(
                path.join(fixture, payload + '.sha256'),
                sha256 + '  ' + payload + '\n',
            );
            await writeFile(
                path.join(fixture, 'macos-build-info-' + arch + '.json'),
                JSON.stringify({ ...info, sha256 }),
            );
        }
        start('package-shape');
        await reset();
        const actualEntries = execFileSync(
            '/usr/bin/zipinfo',
            ['-1', path.join(fixture, payload)],
            {
                encoding: 'utf8',
            },
        )
            .trim()
            .split('\n');
        const bundleDirectories = actualEntries.filter(
            (entry) =>
                entry.startsWith('Diagnostic Hub.app/') && entry.endsWith('/'),
        );
        assert.ok(
            bundleDirectories.length > 0,
            'Real ditto bundle must exercise normal directory markers.',
        );
        console.log(
            'Actual native ZIP directory regression entries:',
            JSON.stringify(bundleDirectories.slice(0, 12)),
        );
        const actualLinks = execFileSync(
            '/usr/bin/zipinfo',
            ['-l', path.join(fixture, payload)],
            {
                encoding: 'utf8',
            },
        )
            .split('\n')
            .filter((line) => line.startsWith('l'));
        console.log(
            'Actual native ZIP link entries:',
            JSON.stringify(actualLinks.slice(0, 8)),
        );
        verified();
        start('cancelled-review');
        let result = run({ HUB_FIXTURE_REVIEW: 'cancel' });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.match(result.stdout, /Setup cancelled/);
        assert.ok(!result.stdout.includes('Installed Diagnostic Hub'));
        await assert.rejects(
            readFile(path.join(target, 'Contents/Resources/app.asar')),
        );
        verified();
        start('initial-install');
        result = run();
        assert.equal(result.status, 0, result.stderr + result.stdout);
        const previous = await readFile(
            path.join(target, 'Contents/Resources/app.asar'),
        );
        const userData = path.join(root, 'user-data');
        await mkdir(userData);
        await writeFile(path.join(userData, 'preserved.txt'), 'user data');
        async function reject(label, extraEnv = {}, args = ['--no-launch']) {
            const result = run(
                extraEnv,
                args,
                extraEnv.HUB_FIXTURE_CASE === 'interrupted'
                    ? 'term-trap'
                    : 'refusal',
            );
            assert.notEqual(
                result.status,
                0,
                label + ' must fail: ' + result.stdout,
            );
            assert.deepEqual(
                await readFile(
                    path.join(target, 'Contents/Resources/app.asar'),
                ),
                previous,
                label + ' replaced prior app',
            );
            assert.equal(
                await readFile(path.join(userData, 'preserved.txt'), 'utf8'),
                'user data',
            );
            assert.ok(
                !result.stdout.includes('Installed Diagnostic Hub'),
                label + ' claimed success',
            );
            console.log(
                'Rejected ' + label + '; prior app and user data preserved.',
            );
            return result;
        }
        verified();
        start('input-refusals');
        await reject('unsafe tag', {}, [
            '--version',
            '../unsafe',
            '--no-launch',
        ]);
        await reject('unsupported architecture', {
            HUB_FIXTURE_MACHINE: 'ppc',
            HUB_FIXTURE_ARM: '0',
        });
        await reject('interrupted download', {
            HUB_FIXTURE_CASE: 'download-failure',
        });
        await writeFile(
            path.join(fixture, payload + '.sha256'),
            '0'.repeat(64) + '  ' + payload + '\n',
        );
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
        for (const entry of [
            '../outside',
            'Other.app/file',
            'Diagnostic Hub.app/../../outside',
            'Diagnostic Hub.app//outside',
            'Diagnostic Hub.app/./outside',
        ]) {
            await reset(original, zipSync({ [entry]: strToU8('unsafe') }));
            await reject('unsafe archive ' + entry);
        }
        await reset(
            original,
            zipSync({
                'Diagnostic Hub.app/escape': [
                    strToU8('/tmp/outside'),
                    { os: 3, attrs: 0xa1ff0000 },
                ],
            }),
        );
        await reject('escaping archive symlink');
        await reset(
            original,
            zipSync({
                'Diagnostic Hub.app/': [
                    strToU8('__MACOSX'),
                    { os: 3, attrs: 0xa1ff0000 },
                ],
            }),
        );
        await reject('symlinked app root');
        await reset();
        verified();
        start('busy-refusal');
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
                spawnSync('/usr/sbin/lsof', [
                    '-t',
                    path.join(target, 'Contents/MacOS/Diagnostic Hub'),
                ]).status !== 0
            ) {
                assert.equal(
                    child.exitCode,
                    null,
                    'Installed app exited before running-app check.',
                );
                if (Date.now() >= deadline)
                    throw Error('Installed app did not start.');
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            const refused = await reject('running application');
            assert.match(refused.stderr, /Quit Diagnostic Hub/);
        } finally {
            const exited = new Promise((resolve) =>
                child.once('exit', resolve),
            );
            child.kill('SIGTERM');
            await Promise.race([
                exited,
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(Error('Installed app did not quit.')),
                        5000,
                    ),
                ),
            ]);
        }
        verified();
        start('interrupted-replacement');
        await reject('interrupted replacement', {
            HUB_FIXTURE_CASE: 'interrupted',
        });
        verified();
        start('launch-refusal-rollback');
        await reject(
            'launch refusal rollback',
            { HUB_FIXTURE_CASE: 'launch-failure' },
            [],
        );
        verified();
        start('same-version-repair');
        if (arch === 'arm64') {
            result = run({
                HUB_FIXTURE_MACHINE: 'x86_64',
                HUB_FIXTURE_ARM: '1',
            });
            assert.equal(
                result.status,
                0,
                'Translated terminal must select native Apple Silicon: ' +
                    result.stderr,
            );
        }
        result = run();
        assert.equal(result.status, 0, result.stderr);
        verified();
        start('installed-package-integrity');
        execFileSync(
            process.execPath,
            ['scripts/verify-macos-package.mjs', target, arch],
            {
                stdio: 'inherit',
            },
        );
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
        verified();
        start('manual-helper-launch');
        // Exercise the real helper's normal LaunchServices request and independently observe the app.
        const reserve = http.createServer();
        await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
        const debugPort = reserve.address().port;
        await new Promise((resolve) => reserve.close(() => resolve()));
        const launchProfile = path.join(root, 'manual-launch-profile');
        result = run({}, [
            '--',
            '--user-data-dir=' + launchProfile,
            '--remote-debugging-port=' + debugPort,
        ]);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes('Launch requested; confirm'));
        assert.ok(result.stdout.includes(target));
        let receiver;
        try {
            await expect
                .poll(
                    async () => {
                        try {
                            return (
                                await fetch(
                                    'http://127.0.0.1:' +
                                        debugPort +
                                        '/json/version',
                                )
                            ).ok;
                        } catch {
                            return false;
                        }
                    },
                    { timeout: 30000 },
                )
                .toBe(true);
            receiver = await chromium.connectOverCDP(
                'http://127.0.0.1:' + debugPort,
            );
            const page = receiver.contexts()[0].pages()[0];
            await page.waitForURL('app://bundle/index.html');
            await expect(
                page.getByRole('heading', { name: 'Device overview' }),
            ).toBeVisible();
            const info = await page.evaluate(() =>
                window.diagnosticHub.readUpdateInfo(),
            );
            assert.equal(info.currentVersion, version);
            assert.equal(info.currentPath, target);
            assert.equal(info.receipt, null);
            assert.equal(info.handoffConfirmed, false);
            console.log(
                JSON.stringify({
                    manualHelperLaunchObserved: true,
                    arch,
                    version,
                    installedBundle: info.currentPath,
                    automaticHandoffClaimed: false,
                    normalLaunchServices: true,
                }),
            );
            await page.evaluate(() => window.close()).catch(() => {});
        } finally {
            await receiver?.close().catch(() => {});
        }
        verified();
        start('fixture-teardown');
        await rm(bin, { recursive: true });
        await rm(fixture, { recursive: true });
        console.log(
            JSON.stringify({
                nativeFixtureAssertionsCompleted: true,
                nativeInstallerQualification: 'blocked',
                arch,
                version,
                source: original.commit,
                installedApp: target,
                remaining:
                    'Physical Mac and browser quarantine acceptance not claimed.',
            }),
        );

        verified();
        observation.complete(new Date().toISOString());
    } catch (error) {
        failure = error;
        observation.fail(new Date().toISOString());
    }
    if (macInstallerPublishRoot(allocation) !== null) {
        const evidenceDirectory = path.join(root, 'qualification');
        try {
            await mkdir(evidenceDirectory);
            const published = await publishMacInstallerObservation(
                observation,
                evidenceDirectory,
                { open, readFile, handles: publicationHandles },
            );
            console.log(
                JSON.stringify({
                    installerObservation: published,
                    nativeInstallerQualification: 'blocked',
                    processExitObserved: false,
                    fixtureDirectory: root,
                }),
            );
        } catch (publicationError) {
            process.stderr.write(
                macInstallerAllocationDiagnostic(
                    allocation,
                    'QUALIFICATION_PUBLICATION_FAILED',
                    true,
                ),
            );
            if (failure)
                throw new AggregateError(
                    [failure, publicationError],
                    'Fixture and evidence publication failed; retain partial artifacts.',
                );
            throw publicationError;
        }
    } else {
        process.stderr.write(
            macInstallerAllocationDiagnostic(
                allocation,
                allocation.failure ?? 'FIXTURE_CANONICALIZATION_FAILED',
                false,
            ),
        );
    }
    if (failure) throw failure;
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    await runMacInstallerSmoke();
