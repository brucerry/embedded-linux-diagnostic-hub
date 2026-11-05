// Explicit held producer entry. Import is inert; normal package commands and workflows are unchanged.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireOwnedWebCapabilities } from './lib/owned-web-capabilities.mjs';
import { startOwnedWebBuild, runHeldWebProducer } from './lib/owned-web-build.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
    produceWebArchive,
    WEB_ARCHIVE_LIMITS,
    readStableArtifactFile,
} from './lib/web-archive-producer.mjs';
import { localSourceProvider, readStableSourceFile } from './lib/committed-source-provider.mjs';

export async function main(raw, capability) {
    // No serialized manifest, ambient environment or inactive workflow can grant native execution.
    const native = requireOwnedWebCapabilities(capability),
        fs = native.filesystem;
    const args = new Map();
    for (const value of raw) {
        const match =
            /^--(scope|version|source-commit|source-tree|run-id|run-attempt|job-key|output)=(.+)$/.exec(
                value,
            );
        assert.ok(match && !args.has(match[1]), 'Unknown, duplicate or empty producer argument.');
        args.set(match[1], match[2]);
    }
    assert.equal(args.size, 8);
    assert.equal(
        args.get('scope'),
        'web',
        'Gateway archive producer is unsupported; no build is admitted.',
    );
    for (const [argument, variable] of [
        ['source-commit', 'GITHUB_SHA'],
        ['run-id', 'GITHUB_RUN_ID'],
        ['run-attempt', 'GITHUB_RUN_ATTEMPT'],
        ['job-key', 'GITHUB_JOB'],
    ])
        assert.equal(
            process.env[variable],
            args.get(argument),
            'Producer invocation differs from job environment: ' + variable,
        );
    assert.equal(process.env.GITHUB_REPOSITORY, 'brucerry/embedded-linux-diagnostic-hub');
    assert.ok(
        !Object.keys(process.env).some((key) => key.startsWith('VITE_')),
        'Ambient VITE_ build inputs are unsupported.',
    );
    for (const key of ['NODE_OPTIONS', 'NODE_PATH'])
        assert.ok(process.env[key] === undefined, 'Ambient runtime injection is unsupported.');
    const root = await fs.realpath(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    );
    const relative = args.get('output');
    assert.ok(
        /^validation\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(relative),
        'Use one NEW directory immediately under validation/.',
    );
    const validation = path.join(root, 'validation');
    // Existing ancestors must be canonical directories. No recursive creation or cleanup.
    const parent = await fs.lstat(validation);
    assert.ok(parent.isDirectory() && !parent.isSymbolicLink());
    assert.equal(await fs.realpath(validation), validation);
    const directory = path.join(root, relative),
        site = path.join(directory, 'site');
    const dependencies = path.join(root, 'node_modules');
    const installed = await fs.lstat(dependencies);
    assert.ok(
        installed.isDirectory() && !installed.isSymbolicLink(),
        'Use an isolated local installed toolchain, not a shared dependency symlink.',
    );
    assert.equal(await fs.realpath(dependencies), dependencies);
    const provider = await localSourceProvider(root, {
        filesystem: fs,
        execute: native.executeGit,
        asynchronous: true,
        platform: process.platform,
        environment: native.gitEnvironment,
    });
    const require = createRequire(import.meta.url),
        vite = await fs.realpath(
            path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
        );
    assert.ok(
        vite.startsWith(dependencies + path.sep),
        'Build tool must come from the local installed dependency tree.',
    );
    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
    async function runtime() {
        const executablePath = await fs.realpath(process.execPath);
        const bytes = (
            await readStableArtifactFile(
                path.dirname(executablePath),
                path.basename(executablePath),
                WEB_ARCHIVE_LIMITS.archive,
                fs,
            )
        ).bytes;
        return {
            executablePath,
            executableSHA256: digest(bytes),
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            versions: { ...process.versions },
            execArgv: [...process.execArgv],
            nodeOptions: process.env.NODE_OPTIONS ?? null,
        };
    }
    async function output() {
        assert.equal(await fs.realpath(site), site);
        const files = new Map();
        let total = 0,
            entries = 0;
        async function visit(relative = '') {
            const at = path.join(site, relative),
                names = await fs.readdir(at, { withFileTypes: true });
            for (const item of names) {
                assert.ok(++entries <= WEB_ARCHIVE_LIMITS.entries);
                const p = relative ? relative + '/' + item.name : item.name;
                assert.ok(!item.isSymbolicLink());
                if (item.isDirectory()) {
                    assert.equal(await fs.realpath(path.join(site, p)), path.join(site, p));
                    await visit(p);
                } else {
                    assert.ok(item.isFile());
                    const b = await readStableArtifactFile(site, p, WEB_ARCHIVE_LIMITS.member, fs);
                    total += b.bytes.length;
                    assert.ok(total <= WEB_ARCHIVE_LIMITS.expanded);
                    files.set(p, b.bytes);
                }
            }
        }
        await visit();
        return files;
    }
    const selected = {
        scope: args.get('scope'),
        version: args.get('version'),
        sourceCommit: args.get('source-commit'),
        sourceTree: args.get('source-tree'),
        runId: args.get('run-id'),
        runAttempt: args.get('run-attempt'),
        jobKey: args.get('job-key'),
    };
    const result = await produceWebArchive(selected, provider, {
        packageJSON: async () => (await readStableSourceFile(root, 'package.json')).bytes,
        builder: async () => ({
            runtime: await runtime(),
            viteEntryPath: vite,
            viteEntrySHA256: digest(
                (await readStableArtifactFile(path.dirname(vite), 'vite.js', 16 * 1024 ** 2, fs))
                    .bytes,
            ),
        }),
        async build() {
            await fs.mkdir(directory); // EEXIST refuses dirty/prior work, even after earlier input verification.
            await fs.mkdir(site);
            const command = [
                await fs.realpath(process.execPath),
                vite,
                'build',
                '--config',
                path.join(root, 'vite.config.mts'),
                '--mode',
                'web',
                '--outDir',
                site,
            ];
            const environment = { NODE_ENV: 'production', WEB_BASE_PATH: './' };
            const owner = startOwnedWebBuild(
                { command, cwd: root, environment, env: native.buildEnvironment },
                {
                    launch: (command, options) =>
                        native.launch(command[0], command.slice(1), options),
                    setTimer: native.setTimer,
                    clearTimer: native.clearTimer,
                    now: native.now,
                },
            );
            // Rejection retains the owner through the error and never reaches archive publication.
            // The CLI does not force exit, signal the child, destroy streams, retry or clean work.
            return await owner.result;
        },
        output,
        async writeArchive(name, bytes) {
            const file = path.join(directory, name);
            await fs.writeFile(file, bytes, { flag: 'wx' });
            // Source stable reader's per-file scope is deliberately narrower than archive admission.
            const measured = (
                await readStableArtifactFile(directory, name, WEB_ARCHIVE_LIMITS.archive, fs)
            ).bytes;
            return { name, bytes: measured.length, sha256: digest(measured) };
        },
        async writeChecksum(name, bytes) {
            await fs.writeFile(path.join(directory, name), bytes, { flag: 'wx' });
            const measured = (await readStableArtifactFile(directory, name, 1024, fs)).bytes;
            return { name, bytes: measured.length, sha256: digest(measured) };
        },
        async writeRecord(_record, bytes) {
            await fs.writeFile(path.join(directory, 'web-build.json'), bytes, { flag: 'wx' });
            const measured = (
                await readStableArtifactFile(directory, 'web-build.json', 16 * 1024 ** 2, fs)
            ).bytes;
            return { name: 'web-build.json', bytes: measured.length, sha256: digest(measured) };
        },
    });
    native.assertSettled();
    console.log(
        JSON.stringify({
            status: result.status,
            archive: result.archive,
            completeChildEnvironmentSHA256: native.profile.sha256,
            releaseAcceptance: false,
            blocked: [
                'native-executor-group-and-profile-admission',
                'independent-service-build-provenance',
                'installed-toolchain-provenance',
                'product-runtime',
                'loader',
                'per-GC-policies-and-measurements',
                'normal-retirement',
            ],
        }),
    );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await runHeldWebProducer(() => main(process.argv.slice(2)), {
        setExitCode: (code) => {
            process.exitCode = code;
        },
        report: (message) => console.error(message),
    });
