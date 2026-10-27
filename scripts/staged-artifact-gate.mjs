import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { includesWindowsSetup } from './lib/release-assets.mjs';
import { WINDOWS_SETUP_ASSET } from './lib/windows-setup-release.mjs';
import {
    PLATFORM_LANES,
    laneDefinition,
    laneFiles,
    digest,
    hashFile,
    readBoundedJSON,
    validateArtifactRecords,
    validateInstallerReceipt,
    validatePlatformReceipt,
    verifyEvidence,
    producerFiles,
    validateProducerReceipt,
} from './lib/staged-artifact-gate.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repository);
const [mode, laneId] = process.argv.slice(2);
const release = path.resolve('release');
const output = path.resolve(process.env.HUB_PLATFORM_EVIDENCE ?? 'validation/platform');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
function git(...args) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
}
function context() {
    const sourceCommit = git('rev-parse', 'HEAD');
    assert.equal(
        sourceCommit,
        process.env.GITHUB_SHA,
        'Qualify the final checked-out source commit.',
    );
    assert.equal(process.env.GITHUB_REF_NAME, 'v' + version);
    assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/);
    assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/);
    assert.equal(
        git('status', '--porcelain', '--untracked-files=no'),
        '',
        'Tracked source changed since the release commit.',
    );
    return {
        version,
        sourceCommit,
        sourceTree: git('rev-parse', 'HEAD^{tree}'),
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    };
}
async function artifacts(id) {
    const records = await Promise.all(
        laneFiles(version, id).map((name) => hashFile(path.join(release, name), name)),
    );
    for (const asset of records.filter(
        (item) => !item.name.endsWith('.sha256') && !item.name.endsWith('.json'),
    )) {
        assert.equal(
            await readFile(path.join(release, asset.name + '.sha256'), 'utf8'),
            `${asset.sha256}  ${asset.name}\n`,
            'Staged checksum differs before native execution.',
        );
        if (asset.name.startsWith('download-run'))
            assert.equal(
                asset.sha256,
                digest(await readFile(path.join('public', asset.name))),
                'Staged helper differs from final source.',
            );
    }
    return records;
}
async function runCase(id, command, env, directory, evidence, cases) {
    const log = path.join(directory, id + '.log');
    const stream = createWriteStream(log, { flags: 'wx' });
    stream.write(JSON.stringify({ command, startedAt: new Date().toISOString() }) + '\n');
    let error;
    let logBytes = 0;
    stream.on('error', (failure) => {
        error ??= failure;
    });
    const logChunk = (chunk) => {
        logBytes += chunk.length;
        if (logBytes <= 16 * 1024 ** 2) stream.write(chunk);
        else error ??= Error('Native case output exceeded its16MiB evidence bound.');
    };
    const result = await new Promise((resolve) => {
        const child = spawn(command[0], command.slice(1), {
            cwd: repository,
            env: { ...process.env, ...env },
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', logChunk);
        child.stderr.on('data', logChunk);
        child.on('error', (failure) => {
            error = failure;
            stream.write(String(failure) + '\n');
        });
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    await new Promise((resolve, reject) => {
        stream.once('error', reject);
        stream.end(
            JSON.stringify({ ...result, endedAt: new Date().toISOString() }) + '\n',
            resolve,
        );
    });
    const record = await hashFile(log, path.relative(evidence, log).split(path.sep).join('/'));
    cases.push({
        id,
        command,
        status: !error && result.code === 0 && result.signal === null ? 'passed' : 'failed',
        exitCode: result.code,
        signal: result.signal,
        evidence: [{ path: record.name, bytes: record.bytes, sha256: record.sha256 }],
    });
    assert.ok(
        !error && result.code === 0 && result.signal === null,
        'Native artifact case failed: ' + id,
    );
}
async function verifyProducers(selected) {
    for (const scope of ['web', 'gateway']) {
        const receipt = await readBoundedJSON(path.join(output, scope + '.json'));
        const expected = await Promise.all(
            producerFiles(version, scope).map((name) => hashFile(path.join(release, name), name)),
        );
        validateProducerReceipt(receipt, { ...selected, scope, artifacts: expected });
        await verifyEvidence(output, receipt.cases);
    }
}
const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
const node = process.execPath;
if (mode === 'build-setup') {
    assert.equal(process.platform, 'win32');
    if (includesWindowsSetup(version)) {
        // Existing packager writes a source/payload-bound descriptor and exclusive sidecars.
        const code = await new Promise((resolve, reject) => {
            const child = spawn(node, [tsx, 'scripts/package-windows-setup.mts'], {
                cwd: repository,
                env: process.env,
                stdio: 'inherit',
                windowsHide: true,
                shell: false,
            });
            child.once('error', reject);
            child.once('close', (code, signal) => resolve(signal === null ? code : null));
        });
        assert.equal(code, 0, 'Assisted setup build did not exit normally.');
    } else console.log('Historical catalog: no assisted setup asset requested.');
} else if (mode === 'consume') {
    const lane = laneDefinition(laneId);
    assert.equal(
        process.platform,
        lane.platform,
        'A different OS cannot qualify this native lane.',
    );
    assert.equal(process.arch, lane.arch, 'Emulation is not native architecture qualification.');
    const selected = context();
    const directory = path.join(output, lane.id);
    await mkdir(directory, { recursive: true });
    const receipt = {
        schemaVersion: 1,
        kind: 'staged-native-consumer',
        status: 'running',
        ...selected,
        lane: lane.id,
        runtime: {
            platform: process.platform,
            arch: process.arch,
            osRelease: os.release(),
            node: process.versions.node,
            executable: process.execPath,
            executableSHA256: (await hashFile(process.execPath)).sha256,
        },
        artifacts: [],
        applications: [],
        cases: [],
        startedAt: new Date().toISOString(),
    };
    const receiptFile = path.join(output, lane.id + '.json');
    try {
        receipt.artifacts = await artifacts(lane.id);
        const run = (id, command, env = {}) =>
            runCase(id, command, env, directory, output, receipt.cases);
        const identity = async (id, executable, asset, extra = {}) => {
            const destination = path.join(directory, id + '.json');
            await run(id, [node, tsx, 'tests/staged-artifact-native.mts'], {
                HUB_TEST_EXECUTABLE: executable,
                HUB_STAGED_IDENTITY: destination,
                HUB_STAGED_ASSET: asset,
                ...extra,
            });
            receipt.applications.push(await readBoundedJSON(destination, 64 * 1024));
            const h = await hashFile(
                destination,
                path.relative(output, destination).split(path.sep).join('/'),
            );
            receipt.cases.at(-1).evidence.push({ path: h.name, bytes: h.bytes, sha256: h.sha256 });
        };
        const desktop = (id, executable, extra = {}) =>
            run(id, [node, tsx, 'tests/desktop-smoke.ts'], {
                HUB_TEST_EXECUTABLE: executable,
                HUB_TEST_SANDBOX: '1',
                ...extra,
            });
        const windows = (id, executable, extra = {}) =>
            run(id, [node, tsx, 'tests/native-window-smoke.ts'], {
                HUB_TEST_EXECUTABLE: executable,
                HUB_TEST_SANDBOX: '1',
                HUB_NATIVE_CYCLES: '100',
                ...extra,
            });
        if (lane.platform === 'win32') {
            const executable = path.join(release, 'Diagnostic-Hub.exe');
            await identity('portable-runtime-identity', executable, 'Diagnostic-Hub.exe');
            await desktop('portable-desktop', executable);
            await windows('portable-native-windows', executable);
            await run('portable-host', [
                'powershell.exe',
                '-NoProfile',
                '-NonInteractive',
                '-File',
                'tests/windows-host-verification.ps1',
                '-Executable',
                executable,
            ]);
        } else if (lane.platform === 'darwin') {
            const environment = path.join(directory, 'installed-environment.txt');
            await run('bundle-helper-installer', [node, 'tests/macos-installer-smoke.mjs'], {
                GITHUB_ENV: environment,
            });
            const entry = (await readFile(environment, 'utf8'))
                .split(/\r?\n/)
                .find((line) => line.startsWith('HUB_TEST_EXECUTABLE='));
            assert.ok(
                entry,
                'The actual native installer did not report its installed executable.',
            );
            const executable = entry.slice('HUB_TEST_EXECUTABLE='.length);
            await identity(
                'installed-runtime-identity',
                executable,
                `Diagnostic-Hub-macos-${lane.arch}.zip`,
            );
            await desktop('installed-desktop', executable);
            await windows('installed-native-windows', executable);
        } else {
            const executable = path.join(release, 'Diagnostic-Hub-linux-x64.AppImage');
            await runCase(
                'prepare-executable',
                ['chmod', '+x', executable],
                {},
                directory,
                output,
                [],
            );
            await identity(
                'appimage-runtime-identity',
                executable,
                'Diagnostic-Hub-linux-x64.AppImage',
                { HUB_TEST_APPIMAGE: '1' },
            );
            await desktop('appimage-desktop', executable, { HUB_TEST_APPIMAGE: '1' });
            await windows('appimage-native-windows', executable, { HUB_TEST_APPIMAGE: '1' });
            const unpack = await mkdtemp(path.join(os.tmpdir(), 'hub-staged-archive-'));
            // Archive paths/types are checked before extraction; symlinks are not accepted here.
            const listing = execFileSync(
                'tar',
                ['-tvzf', path.join(release, 'Diagnostic-Hub-linux-x64.tar.gz')],
                { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
            );
            for (const line of listing.trim().split('\n'))
                assert.ok(
                    /^[d-]/.test(line),
                    'Archive links/special files require a reviewed native extraction contract.',
                );
            const names = execFileSync(
                'tar',
                ['-tzf', path.join(release, 'Diagnostic-Hub-linux-x64.tar.gz')],
                { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
            )
                .trim()
                .split('\n');
            for (const name of names)
                assert.ok(
                    !name.startsWith('/') &&
                        !name.split('/').includes('..') &&
                        !name.includes('\\'),
                    'Unsafe staged archive entry.',
                );
            execFileSync('tar', [
                '--no-same-owner',
                '--no-same-permissions',
                '-xzf',
                path.join(release, 'Diagnostic-Hub-linux-x64.tar.gz'),
                '-C',
                unpack,
            ]);
            const roots = [
                unpack,
                ...(await readdir(unpack)).map((name) => path.join(unpack, name)),
            ];
            const app = [];
            for (const root of roots) {
                try {
                    await readFile(path.join(root, 'resources/app.asar'));
                    app.push(root);
                } catch {}
            }
            assert.equal(app.length, 1, 'Require one complete staged Linux application.');
            const launcher = path.join(app[0], 'AppRun');
            await identity('archive-runtime-identity', launcher, 'Diagnostic-Hub-linux-x64.tar.gz');
            await desktop('archive-desktop', launcher);
        }
        if (includesWindowsSetup(version)) {
            const input = path.resolve(
                process.env.HUB_INSTALLER_QUALIFICATION ??
                    path.join('validation/installers', lane.id + '.json'),
            );
            const installer = await readBoundedJSON(input);
            validateInstallerReceipt(installer, {
                ...selected,
                lane: lane.id,
                artifacts: receipt.artifacts,
            });
            await verifyEvidence(path.dirname(input), installer.cases);
            const destination = path.join(directory, 'installer');
            await mkdir(destination, { recursive: true });
            for (const item of installer.cases)
                for (const evidence of item.evidence) {
                    const target = path.join(destination, evidence.path);
                    await mkdir(path.dirname(target), { recursive: true });
                    await copyFile(path.join(path.dirname(input), evidence.path), target);
                }
            await copyFile(input, path.join(destination, 'receipt.json'));
            receipt.installer = installer;
            receipt.installerReceiptSHA256 = (await hashFile(input)).sha256;
            const productInput = path.resolve(
                process.env.HUB_PRODUCT_QUALIFICATION ??
                    path.join('validation/products', lane.id + '.json'),
            );
            const product = await readBoundedJSON(productInput);
            validateProducerReceipt(product, {
                ...selected,
                scope: 'desktop-' + lane.id,
                artifacts: receipt.artifacts,
            });
            await verifyEvidence(path.dirname(productInput), product.cases);
            const productDestination = path.join(directory, 'product');
            await mkdir(productDestination, { recursive: true });
            for (const item of product.cases)
                for (const evidence of item.evidence) {
                    const target = path.join(productDestination, evidence.path);
                    await mkdir(path.dirname(target), { recursive: true });
                    await copyFile(path.join(path.dirname(productInput), evidence.path), target);
                }
            await copyFile(productInput, path.join(productDestination, 'receipt.json'));
            receipt.product = product;
            receipt.productReceiptSHA256 = (await hashFile(productInput)).sha256;
        }
        validateArtifactRecords(await artifacts(lane.id), receipt.artifacts);
        receipt.status = 'passed';
        validatePlatformReceipt(receipt, {
            ...selected,
            lane: lane.id,
            artifacts: receipt.artifacts,
        });
    } catch (error) {
        receipt.status = 'blocked';
        receipt.failure = String(error);
        throw error;
    } finally {
        receipt.endedAt = new Date().toISOString();
        await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    }
} else if (mode === 'verify') {
    const selected = context();
    for (const lane of PLATFORM_LANES) {
        const receipt = await readBoundedJSON(path.join(output, lane.id + '.json'));
        validatePlatformReceipt(receipt, {
            ...selected,
            lane: lane.id,
            artifacts: await artifacts(lane.id),
        });
        await verifyEvidence(output, receipt.cases);
        for (const item of receipt.cases.filter((entry) => entry.id.endsWith('runtime-identity'))) {
            const identity = await readBoundedJSON(
                path.join(output, lane.id, item.id + '.json'),
                64 * 1024,
            );
            assert.deepEqual(
                identity,
                receipt.applications.find((app) => app.asset === identity.asset),
                'Native identity summary differs from its actual retained observation.',
            );
        }
        if (includesWindowsSetup(version)) {
            const installerRoot = path.join(output, lane.id, 'installer');
            const bytes = await readFile(path.join(installerRoot, 'receipt.json'));
            assert.equal(digest(bytes), receipt.installerReceiptSHA256);
            assert.deepEqual(JSON.parse(bytes), receipt.installer);
            await verifyEvidence(installerRoot, receipt.installer.cases);
            const productRoot = path.join(output, lane.id, 'product');
            const productBytes = await readFile(path.join(productRoot, 'receipt.json'));
            assert.equal(digest(productBytes), receipt.productReceiptSHA256);
            assert.deepEqual(JSON.parse(productBytes), receipt.product);
            await verifyEvidence(productRoot, receipt.product.cases);
        }
    }
    await verifyProducers(selected);
    console.log(
        'All four native staged-consumer receipts bind these exact final assets and source; no publication performed.',
    );
} else if (mode === 'verify-producers') {
    await verifyProducers(context());
    console.log('Final web and gateway archive producer/runtime/resource receipts verified.');
} else
    throw Error(
        'Usage: staged-artifact-gate.mjs build-setup | consume LANE | verify | verify-producers',
    );
