import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { NativePilotStartup } from '../../tests/fixtures/native-pilot-startup.ts';
import {
    fileIdentity,
    metadataIdentity,
    checkAncestry,
    ancestryIdentity,
    preflightLimits,
} from './windows-preflight.mjs';
import { boundedRead } from './product-collector-evidence.mjs';
import { createOwnershipHold } from './product-entry-custody.mjs';
import { settledElectronExecutable } from './pilot-dependencies.mjs';
import { pilotLimits } from './hosted-pilot-contract.mjs';
const clock = () => Number(process.hrtime.bigint() / 1000000n);
export const electronPreparation = Object.freeze({
    version: '44.5.1',
    platform: 'win32',
    arch: 'x64',
    totalMs: 180000,
    reserveMs: 30000,
    streamBytes: 65536,
    sampleMs: 1000,
    samples: 192,
    packageSHA256: '686050bd77b967aab170a2dcacdc0254072446f5be1d5fb6e4383d577342fc19',
    installerSHA256: '3b9e0c3c9070edbdb732dc05ed23c6f1c6b7a404bd623033a2f0b71052534e93',
    checksumsSHA256: '5d50092913d34c25993512dad7205c112c935da8ff9dc0296f3090d3e39cb001',
    artifact: 'electron-v44.5.1-win32-x64.zip',
    artifactSHA256: '9b382492dcfee91f8f9e92c91f7972550a1b95d2299cac72279dab33a600d7db',
    artifactURL:
        'https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-win32-x64.zip',
});
export function preparationEnvironment(environment, cache, version = false) {
    const env = { ...environment };
    for (const key of Object.keys(env))
        if (
            /electron|^npm_config_(?:arch|platform)$|^force_no_cache$|^NAPI_RS_|^NODE_(?:OPTIONS|PATH)$|^DEBUG$/i.test(
                key,
            )
        )
            delete env[key];
    Object.assign(env, {
        ELECTRON_INSTALL_PLATFORM: 'win32',
        ELECTRON_INSTALL_ARCH: 'x64',
        electron_config_cache: cache,
        ELECTRON_GET_NO_PROGRESS: '1',
    });
    if (version) env.ELECTRON_RUN_AS_NODE = '1';
    return env;
}
/** Read-only presence/hash audit; no lazy package entry, tool install or service launch. */
export function auditPilotLaunchPrerequisites(
    root,
    tools,
    {
        identity = fileIdentity,
        runtime = {
            platform: process.platform,
            arch: process.arch,
            version: process.version,
            executable: process.execPath,
        },
        resolve = createRequire(path.join(root, 'package.json')).resolve,
        check = () => {},
        environment = process.env,
    } = {},
) {
    check();
    for (const key of Object.keys(environment))
        if (
            environment[key] &&
            /^(?:ESBUILD_BINARY_PATH|NODE_OPTIONS|NODE_PATH|NAPI_RS_.*|ROLLDOWN_BINDING_PATH)$/.test(
                key.toUpperCase(),
            )
        )
            assert.fail('Unreviewed launch prerequisite override: ' + key);
    assert.equal(runtime.platform, 'win32');
    assert.equal(runtime.arch, 'x64');
    assert.equal(runtime.version, 'v24.22.0');
    const pkg = resolve('electron/package.json'),
        dir = path.dirname(pkg),
        installer = path.join(dir, 'install.js'),
        sums = path.join(dir, 'checksums.json');
    const identities = {};
    for (const [name, file, expected] of [
        ['package', pkg, electronPreparation.packageSHA256],
        ['installer', installer, electronPreparation.installerSHA256],
        ['checksums', sums, electronPreparation.checksumsSHA256],
    ]) {
        identities[name] = identity(file, { check });
        assert.equal(identities[name].sha256, expected);
    }
    const lock = JSON.parse(boundedRead(path.join(root, 'package-lock.json'), 2097152));
    const locked = lock.packages['node_modules/electron'];
    assert.equal(locked.version, '44.5.1');
    assert.equal(
        locked.integrity,
        'sha512-lx7AYoFIiyvEvgvpyWO9kOC60xtNPpiPZAth6Fmg9NutzpCAMLwpUlaBY2EXfZyIgUdzEmLMj9KvK0Vrokl1yQ==',
    );
    assert.equal(
        JSON.parse(boundedRead(sums, 65536))[electronPreparation.artifact],
        electronPreparation.artifactSHA256,
    );
    assert(
        !fs.existsSync(path.join(dir, 'dist')) && !fs.existsSync(path.join(dir, 'path.txt')),
        'Fresh npm-restored package required; no overwrite/repair of an existing Electron runtime',
    );
    const qualificationPackages = [];
    for (const name of [
        'ssh2',
        'asn1',
        'safer-buffer',
        'bcrypt-pbkdf',
        'tweetnacl',
        'tsx',
        'esbuild',
    ]) {
        const manifest = resolve(name + '/package.json'),
            installed = JSON.parse(boundedRead(manifest, 65536));
        assert.equal(
            installed.version,
            lock.packages['node_modules/' + name].version,
            'Installed qualification dependency differs from lock: ' + name,
        );
        qualificationPackages.push({
            name,
            version: installed.version,
            identity: identity(manifest, { check }),
        });
    }
    const extractor = resolve('@electron-internal/extract-zip'),
        nativeExtractor = path.join(path.dirname(extractor), 'index.win32-x64-msvc.node');
    const modules = {
        tsx: resolve('tsx'),
        playwright: resolve('playwright'),
        electronGet: resolve('@electron/get'),
        extractor,
        esbuild: resolve('esbuild'),
        vite: resolve('vite'),
        rolldown: resolve('rolldown'),
        lightningcss: resolve('lightningcss'),
    };
    for (const [name, file] of Object.entries(modules))
        identities[name] = identity(fs.realpathSync(file), { check });
    const native = {
        node: runtime.executable,
        extractor: nativeExtractor,
        esbuild: resolve('@esbuild/win32-x64/esbuild.exe'),
        rolldown: resolve('@rolldown/binding-win32-x64-msvc'),
        lightningcss: resolve('lightningcss-win32-x64-msvc'),
        ...tools,
    };
    for (const [name, file] of Object.entries(native)) {
        const id = identity(fs.realpathSync(file), { pe: true, check });
        assert.equal(id.pe.architecture, 'x64');
        identities[name] = id;
    }
    // pwsh supplies Add-Type/Roslyn; WinPS supplies the existing process sampler's CIM cmdlet.
    for (const file of [
        path.join(path.dirname(tools.pwsh), 'Microsoft.CodeAnalysis.dll'),
        path.join(path.dirname(tools.pwsh), 'Microsoft.CodeAnalysis.CSharp.dll'),
        path.join(path.dirname(tools.pwsh), 'System.Management.Automation.dll'),
        path.join(path.dirname(tools.winps), 'Modules/CimCmdlets/CimCmdlets.psd1'),
    ])
        identities[file] = identity(fs.realpathSync(file), { check });
    identities.worker = identity(path.join(root, 'scripts/lib/pilot-electron-install-worker.mjs'), {
        check,
    });
    return {
        dir,
        installer,
        identities,
        qualificationPackages,
        esbuildVersion: lock.packages['node_modules/esbuild'].version,
        worker: path.join(root, 'scripts/lib/pilot-electron-install-worker.mjs'),
        nativeModules:
            'npm-restored win32/x64; no browser installation required for Playwright Electron executablePath',
        sqlite: 'Electron built-in node:sqlite; no external SQLite installer',
    };
}
/** Logical-size observation only, with finite walk admission. Never a native hard quota. */
export function preparationInventory(root, check = () => {}) {
    const counts = { bytes: 0, files: 0, directories: 0, vanishedDuringScan: 0 };
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            if (e.code === 'ENOENT') {
                counts.vanishedDuringScan++;
                return;
            }
            throw e;
        }
        for (const e of entries) {
            check();
            const p = path.join(dir, e.name);
            let s;
            try {
                s = fs.lstatSync(p);
            } catch (e) {
                if (e.code === 'ENOENT') {
                    counts.vanishedDuringScan++;
                    continue;
                }
                throw e;
            }
            assert(!s.isSymbolicLink());
            if (s.isDirectory()) {
                counts.directories++;
                assert(counts.directories <= 30000);
                walk(p);
            } else {
                assert(s.isFile());
                counts.files++;
                counts.bytes += s.size;
                assert(
                    counts.files <= preflightLimits.dependencyFiles &&
                        counts.bytes <= preflightLimits.dependencyBytes,
                );
            }
        }
    };
    if (fs.existsSync(root)) {
        const s = fs.lstatSync(root);
        assert(s.isDirectory() && !s.isSymbolicLink() && fs.realpathSync(root) === root);
        walk(root);
    }
    return { root, ...counts };
}
function eventWithin(child, name, deadline, signal, now) {
    return new Promise((resolve, reject) => {
        const finish = (e, value) => {
            clearTimeout(timer);
            child.off(name, done);
            child.off('close', closed);
            signal.removeEventListener('abort', aborted);
            e ? reject(e) : resolve(value);
        };
        const done = (value) => finish(null, value),
            closed = () => finish(Error('Preparation child closed before readiness')),
            aborted = () => finish(signal.reason);
        const timer = setTimeout(
            () => finish(Error('Preparation command deadline')),
            Math.max(0, deadline - now()),
        );
        child.once(name, done);
        child.once('close', closed);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
    });
}
/** Actual child is adopted before awaiting identity/readiness; holds precede their receipts. */
export async function runOwnedPreparationCommand(
    {
        label,
        executable,
        args,
        environment,
        cwd,
        deadline,
        cleanupDeadline,
        signal,
        check,
        record,
        hold,
    },
    { spawnPort = spawn, startupFactory = (o) => new NativePilotStartup(o), now = clock } = {},
) {
    const controller = new AbortController(),
        abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let failure, child, timer;
    const stop = (e) => {
        failure ??= e;
        controller.abort(e);
    };
    const streams = {
        stdout: { bytes: 0, retained: 0, chunks: [], hash: createHash('sha256') },
        stderr: { bytes: 0, retained: 0, chunks: [], hash: createHash('sha256') },
    };
    const startup = startupFactory({
        signal: controller.signal,
        deadline,
        cleanupDeadline,
        emit: async (s, d) => record(s, d),
        hold,
    });
    try {
        check();
        assert(now() < deadline);
        record('electron-preparation-launch', {
            label,
            executable,
            args,
            deadline,
            cleanupDeadline,
            maxPerStreamBytes: electronPreparation.streamBytes,
            environment: {
                ELECTRON_INSTALL_PLATFORM: environment.ELECTRON_INSTALL_PLATFORM,
                ELECTRON_INSTALL_ARCH: environment.ELECTRON_INSTALL_ARCH,
                electron_config_cache: environment.electron_config_cache,
                ELECTRON_RUN_AS_NODE: environment.ELECTRON_RUN_AS_NODE ?? null,
                childElectronOverridesIsolated: true,
                TEMP_TMPChanged: false,
            },
            cwd,
        });
        child = startup.spawn(
            label,
            () =>
                spawnPort(executable, args, {
                    cwd,
                    env: environment,
                    shell: false,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                }),
            (p) => {
                if (!p.kill()) throw Error('Preparation stop request unavailable');
            },
        );
        for (const name of ['stdout', 'stderr'])
            child[name].on('data', (b) => {
                const s = streams[name];
                s.bytes += b.length;
                s.hash.update(b);
                const keep = b.subarray(
                    0,
                    Math.max(0, electronPreparation.streamBytes - s.retained),
                );
                if (keep.length) {
                    s.chunks.push(keep);
                    try {
                        for (let i = 0; i < keep.length; i += 4096)
                            record('electron-preparation-output', {
                                label,
                                stream: name,
                                offset: s.retained + i,
                                base64: keep.subarray(i, i + 4096).toString('base64'),
                            });
                    } catch (e) {
                        stop(e);
                    }
                    s.retained += keep.length;
                }
                if (s.bytes > electronPreparation.streamBytes)
                    stop(Error('Preparation output threshold'));
            });
        timer = setTimeout(
            () => stop(Error('Preparation immutable command deadline')),
            Math.max(0, deadline - now()),
        );
        const ready = eventWithin(child, 'message', deadline, controller.signal, now);
        const [, message] = await Promise.all([startup.children.get(child).identityTask, ready]);
        assert.equal(message.kind, 'electron-preparation-ready');
        assert.equal(message.pid, child.pid);
        controller.signal.throwIfAborted();
        check();
        const closed = eventWithin(child, 'close', deadline, controller.signal, now);
        void closed.catch(() => {});
        await new Promise((resolve, reject) =>
            child.send({ kind: 'admit-electron-preparation' }, (e) => (e ? reject(e) : resolve())),
        );
        await closed;
        clearTimeout(timer);
        const receipt = await startup.join();
        record('electron-preparation-child-closed', {
            label,
            ...receipt,
            streams: Object.fromEntries(
                Object.entries(streams).map(([k, s]) => [
                    k,
                    { bytes: s.bytes, retained: s.retained, sha256: s.hash.digest('hex') },
                ]),
            ),
        });
        if (failure) throw failure;
        controller.signal.throwIfAborted();
        check();
        assert.equal(receipt.children[0].code, 0);
        assert.equal(receipt.children[0].signal, null);
        return { receipt, stdout: Buffer.concat(streams.stdout.chunks).toString('utf8') };
    } catch (e) {
        stop(e);
        try {
            await startup.join();
        } catch (closure) {
            hold({ kind: 'electron-preparation-closure-unknown', label, error: String(closure) });
        }
        throw e;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
    }
}
/** One explicit official install and one Run-as-Node version probe, both before identity freeze. */
export async function preparePilotElectron(
    root,
    {
        parent,
        evidenceRoot,
        tools,
        environment = process.env,
        signal,
        workDeadline,
        check = () => {},
        record,
        hold = createOwnershipHold,
    },
    {
        now = clock,
        audit = auditPilotLaunchPrerequisites,
        command = runOwnedPreparationCommand,
        inventory = preparationInventory,
        identity = fileIdentity,
        settled = settledElectronExecutable,
    } = {},
) {
    const startedAt = now(),
        deadline = Math.min(startedAt + electronPreparation.totalMs, workDeadline),
        commandDeadline = deadline - electronPreparation.reserveMs;
    assert(commandDeadline > startedAt);
    const controller = new AbortController(),
        cancel = () => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    let unknown = false,
        held,
        fixture,
        fixtureBinding,
        timer,
        failure,
        samples = 0,
        previousAt = null,
        peak = 0;
    const holdNow = (reason) => {
        unknown = true;
        held ??= hold(
            { kind: 'electron-preparation-custody-unknown', reason, fixture, deadline },
            record,
        );
        controller.abort(Error('Electron preparation custody unknown'));
        return held;
    };
    const baseline = new Set(fs.readdirSync(parent)),
        ancestors = ancestryIdentity(parent);
    const tempRoots = () =>
        fs
            .readdirSync(parent)
            .filter((n) => n.startsWith('electron-download-') && !baseline.has(n))
            .map((n) => path.join(parent, n));
    const checkFixture = () => {
        if (fixtureBinding) {
            const current = metadataIdentity(fixture);
            for (const key of ['dev', 'ino', 'realpath', 'directory', 'nlink'])
                assert.equal(current[key], fixtureBinding[key]);
        }
    };
    const admit = () => {
        check();
        checkAncestry(ancestors);
        checkFixture();
        controller.signal.throwIfAborted();
        assert(now() < commandDeadline);
    };
    const snapshot = (stage) => {
        checkAncestry(ancestors);
        checkFixture();
        const start = now(),
            dependencies = inventory(path.join(root, 'node_modules'), () => {
                assert(now() < deadline);
            }),
            evidence = inventory(evidenceRoot),
            scratch = [fixture, ...tempRoots()].filter(Boolean).map((p) => inventory(p));
        const bytes = scratch.reduce((n, v) => n + v.bytes, 0),
            files = scratch.reduce((n, v) => n + v.files, 0),
            atMs = now();
        assert(++samples <= electronPreparation.samples);
        const row = {
            stage,
            atMs,
            scanMs: atMs - start,
            gapMs: previousAt === null ? null : atMs - previousAt,
            dependencies,
            evidence,
            scratch,
            jobBytes: bytes + evidence.bytes,
            measuredPeakLowerBound: (peak = Math.max(peak, bytes + evidence.bytes)),
            hardNativeDiskCap: false,
            transientPeakKnown: false,
            externalWritesNotIntercepted: true,
        };
        previousAt = atMs;
        record('electron-preparation-inventory', row);
        assert(
            bytes <= pilotLimits.treeBytes &&
                files <= pilotLimits.treeFiles &&
                evidence.bytes <= pilotLimits.evidenceBytes &&
                bytes + evidence.bytes <= pilotLimits.jobBytes &&
                bytes + evidence.bytes <= pilotLimits.cohortBytes,
            'Preparation observed scratch/evidence threshold',
        );
        return row;
    };
    try {
        admit();
        record('electron-preparation-start', {
            startedAt,
            deadline,
            commandDeadline,
            outerWorkDeadline: workDeadline,
            limits: electronPreparation,
            dependencyBytes: preflightLimits.dependencyBytes,
            dependencyFiles: preflightLimits.dependencyFiles,
            scratchBytes: pilotLimits.treeBytes,
            scratchFiles: pilotLimits.treeFiles,
            jobBytes: pilotLimits.jobBytes,
            cohortBytes: pilotLimits.cohortBytes,
            evidenceBytes: pilotLimits.evidenceBytes,
            defaultTempParent: parent,
            baselineDownloadRoots: [...baseline].filter((n) => n.startsWith('electron-download-')),
            hardNativeDiskCap: false,
            transientPeakKnown: false,
            capacityQualifiedForFullPair: false,
        });
        for (const key of [
            'ELECTRON_OVERRIDE_DIST_PATH',
            'ELECTRON_INSTALL_PLATFORM',
            'ELECTRON_INSTALL_ARCH',
        ])
            assert(!environment[key], 'Unreviewed Electron override: ' + key);
        const facts = audit(root, tools, { check: admit, environment });
        record('pilot-launch-prerequisites', facts);
        fixture = path.join(parent, 'diagnostic-hub-electron-preparation-' + randomUUID());
        fs.mkdirSync(fixture);
        const fixtureIdentity = fs.realpathSync(fixture);
        assert.equal(fixtureIdentity, fixture);
        const cache = path.join(fixture, 'cache');
        fs.mkdirSync(cache);
        fixtureBinding = metadataIdentity(fixture);
        const childEnvironment = preparationEnvironment(environment, cache);
        snapshot('before-install');
        timer = setInterval(() => {
            try {
                admit();
                snapshot('periodic');
            } catch (e) {
                failure ??= e;
                controller.abort(e);
            }
        }, electronPreparation.sampleMs);
        const common = {
            cwd: root,
            deadline: commandDeadline,
            cleanupDeadline: deadline,
            signal: controller.signal,
            check: admit,
            record,
            hold: holdNow,
        };
        const installed = await command({
            ...common,
            label: 'pinned-official-electron-installer',
            executable: process.execPath,
            args: [facts.worker, 'install', facts.installer, electronPreparation.installerSHA256],
            environment: childEnvironment,
        });
        const moduleProbe = installed.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .find((row) => row?.kind === 'pilot-launch-modules-loaded');
        assert(
            moduleProbe &&
                moduleProbe.nativeExtractor &&
                moduleProbe.playwrightElectron &&
                moduleProbe.vite &&
                moduleProbe.rolldown &&
                moduleProbe.lightningcss,
        );
        assert.equal(moduleProbe.esbuild, facts.esbuildVersion);
        record('pilot-launch-modules-loaded', moduleProbe);
        admit();
        assert(!tempRoots().length, 'Official downloader temporary roots remain; retain custody');
        snapshot('installer-closed');
        const archives = [];
        const find = (p) => {
            for (const e of fs.readdirSync(p, { withFileTypes: true })) {
                const file = path.join(p, e.name);
                if (e.isDirectory()) find(file);
                else archives.push(file);
            }
        };
        find(cache);
        assert.equal(archives.length, 1);
        assert.equal(path.basename(archives[0]), electronPreparation.artifact);
        const archive = identity(archives[0], { check: admit });
        assert.equal(archive.sha256, electronPreparation.artifactSHA256);
        assert(Number(archive.size) <= pilotLimits.treeBytes);
        record('electron-preparation-artifact-verified', {
            url: electronPreparation.artifactURL,
            archive,
            pinnedChecksum: electronPreparation.artifactSHA256,
            officialInstaller: facts.identities.installer,
            defaultTempParent: parent,
            extraction: path.join(facts.dir, 'dist'),
        });
        const electron = settled(root, environment),
            executable = identity(electron, { pe: true, check: admit });
        assert.equal(executable.pe.architecture, 'x64');
        const version = await command({
            ...common,
            label: 'settled-electron-version',
            executable: electron,
            args: [facts.worker, 'version'],
            environment: preparationEnvironment(environment, cache, true),
        });
        const actual = JSON.parse(version.stdout);
        assert.deepEqual(actual, {
            kind: 'settled-electron-version',
            version: '44.5.1',
            platform: 'win32',
            arch: 'x64',
            sqlite: true,
        });
        assert.deepEqual(identity(electron, { pe: true, check: admit }), executable);
        for (const [name, file] of [
            ['package', path.join(facts.dir, 'package.json')],
            ['installer', facts.installer],
            ['checksums', path.join(facts.dir, 'checksums.json')],
        ])
            assert.deepEqual(identity(file, { check: admit }), facts.identities[name]);
        record('electron-preparation-settled', {
            executable,
            actual,
            pathTXT: 'electron.exe',
            distVersion: '44.5.1',
            dependencyFreezeStillPending: true,
        });
    } catch (e) {
        failure ??= e;
        controller.abort(e);
        try {
            record('electron-preparation-failed', {
                error: String(e).slice(0, 2048),
                unknown,
                fixture,
                elapsedMs: now() - startedAt,
                dependencyFreezeAdmitted: false,
            });
        } catch (persistence) {
            holdNow({ error: String(persistence), phase: 'failed preparation evidence' });
        }
    } finally {
        clearInterval(timer);
        signal.removeEventListener('abort', cancel);
    }
    // The command adapter never returns before joined closure. Residual opaque scratch is held.
    try {
        const residuals = tempRoots();
        if (residuals.length)
            holdNow({ error: 'Unremoved official-download temporary roots', roots: residuals });
    } catch (e) {
        if (fixture) holdNow({ error: String(e), phase: 'temporary-root closure inventory' });
        else failure ??= e;
    }
    if (!unknown && fixture) {
        try {
            assert(now() < deadline);
            checkAncestry(ancestors);
            snapshot('final-before-cleanup');
            fs.rmSync(fixture, { recursive: true });
            assert(!fs.existsSync(fixture));
            record('electron-preparation-cleanup', {
                fixture,
                removed: true,
                elapsedMs: now() - startedAt,
                samples,
                measuredPeakLowerBound: peak,
                hardNativeDiskCap: false,
                transientPeakKnown: false,
            });
        } catch (e) {
            holdNow({ error: String(e), phase: 'preparation fixture/evidence cleanup' });
        }
    }
    if (unknown) {
        await held.outcome;
        throw Error('Electron preparation unknown custody retained');
    }
    if (failure) throw failure;
    check();
    assert(now() < deadline);
    return {
        completed: true,
        elapsedMs: now() - startedAt,
        limits: electronPreparation,
        dependencyFreezeStillPending: true,
    };
}
