// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { collectProductPreparation, limits } from './lib/product-collector-controller.mjs';
import { observeCollector } from './lib/product-collector-observer.mjs';
import {
    boundedRead,
    digest,
    readDurableArtifacts,
    closeEntries,
    streamCollector,
} from './lib/product-collector-evidence.mjs';
import {
    RootGuard,
    ProductLease,
    ProductJournal,
    canonicalMarker,
    windowsPrincipalObserver,
} from './lib/product-collector-files.mjs';
import { inspectProductRaw } from './lib/product-collector-inspection.mjs';
import { sourceFingerprint } from '../tests/fixtures/memory-resource-identity';
import { parseNativeCoverage } from '../tests/fixtures/memory-product-native-contract';
import {
    CollectionEntry,
    createOwnershipHold,
    prepareProductSpawn,
    prepareProductLogs,
} from './lib/product-entry-custody.mjs';
import { productClock } from '../tests/fixtures/memory-product-owner';

const sourceRoot = fs.realpathSync(path.resolve(import.meta.dirname, '..')),
    require = createRequire(import.meta.url);
const hashFile = (file) => digest(fs.readFileSync(file));
const argumentsOf = (argv) =>
    new Map(
        argv.map((arg) => {
            const i = arg.indexOf('=');
            assert(arg.startsWith('--') && i > 2);
            return [arg.slice(2, i), arg.slice(i + 1)];
        }),
    );
export function treeInventory(root, { maxBytes = limits.jobBytes, maxFiles = 8192 } = {}) {
    let bytes = 0,
        count = 0;
    const files = {};
    const walk = (directory) => {
        for (const item of fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            const file = path.join(directory, item.name),
                s = fs.lstatSync(file);
            assert(!s.isSymbolicLink(), 'Tree aliases require separate review.');
            if (s.isDirectory()) walk(file);
            else {
                assert(s.isFile() && s.nlink === 1);
                bytes += s.size;
                assert(bytes <= maxBytes && count++ < maxFiles, 'Private tree budget exceeded.');
                files[path.relative(root, file).replaceAll('\\', '/')] = s.size;
            }
        }
    };
    walk(root);
    return { bytes, files };
}
export function dependencyIdentity(root) {
    const tree = treeInventory(root, { maxBytes: 2 * 1024 ** 3, maxFiles: 30000 });
    const hash = createHash('sha256');
    for (const name of Object.keys(tree.files)) {
        hash.update(name + '\0' + hashFile(path.join(root, name)) + '\n');
    }
    return { sha256: hash.digest('hex'), files: Object.keys(tree.files).length };
}
export function loadProductManifest(argv) {
    const args = argumentsOf(argv);
    assert(
        args.has('manifest') && /^[a-f0-9]{64}$/.test(args.get('manifest-sha256') ?? ''),
        'Provide independent reviewed manifest digest.',
    );
    const bytes = boundedRead(path.resolve(args.get('manifest')), 262144);
    assert.equal(digest(bytes), args.get('manifest-sha256'));
    const m = JSON.parse(bytes.toString());
    assert.equal(m.schema, 1);
    assert.equal(m.reviewed, true, 'Preparation manifest is not approved.');
    assert.equal(m.kind, 'windows-first-product-calibration-pair');
    assert.equal(m.sourceRoot, sourceRoot);
    assert.equal(m.platform, 'win32');
    assert.equal(m.arch, 'x64');
    assert.equal(m.electron.version, '44.5.1');
    assert.equal(m.node.version, 'v24.22.0');
    assert.deepEqual(m.limits, limits);
    assert.deepEqual(m.jobs, [
        { ordinal: 0, observerMode: 'sampled', gcMode: 'normal', expectedParentCode: 0 },
        { ordinal: 1, observerMode: 'no-sampler', gcMode: 'normal', expectedParentCode: 0 },
    ]);
    assert.equal(m.collectionOnly, true);
    assert.equal(m.thresholdsSelected, false);
    assert.equal(m.executionApproval, 'one-serialized-windows-normal-pair-only');
    assert(path.isAbsolute(m.outputRoot) && fs.realpathSync(m.outputRoot) === m.outputRoot);
    assert(
        !m.outputRoot.startsWith(sourceRoot + path.sep),
        'Evidence must be outside fingerprinted source.',
    );
    assert.equal(m.canonicalTmp, fs.realpathSync(os.tmpdir()));
    assert.match(m.principalSID, /^S-1-5-/);
    for (const key of ['outputRootSDDLSHA256', 'canonicalTmpSDDLSHA256'])
        assert.match(m[key], /^[a-f0-9]{64}$/);
    return {
        m,
        manifestSHA256: digest(bytes),
        manifestPath: path.resolve(args.get('manifest')),
        args,
    };
}
function environment(m) {
    for (const key of Object.keys(process.env))
        if (/^(NODE_|TSX_|ESBUILD_|ELECTRON_)/.test(key))
            throw Error('Unreviewed runtime environment: ' + key);
    for (const key of Object.keys(process.env))
        if (key.startsWith('HUB_')) throw Error('Unreviewed Hub override: ' + key);
    const allowed = [
        'GITHUB_RUN_ATTEMPT',
        'GITHUB_REPOSITORY',
        'GITHUB_SHA',
        'GITHUB_RUN_ID',
        'SystemRoot',
        'SYSTEMROOT',
        'WINDIR',
        'TEMP',
        'TMP',
        'USERPROFILE',
        'HOMEDRIVE',
        'HOMEPATH',
        'APPDATA',
        'LOCALAPPDATA',
        'COMSPEC',
        'ComSpec',
        'PATHEXT',
        'PSModulePath',
        'NUMBER_OF_PROCESSORS',
        'PROCESSOR_ARCHITECTURE',
        'ProgramFiles',
        'ProgramFiles(x86)',
        'ProgramData',
        'PUBLIC',
    ];
    const env = Object.fromEntries(
        allowed
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]]),
    );
    return { ...env, PATH: m.childPATH, HUB_MEMORY_SSH_PROFILE: m.sshProfile.path };
}
export async function verifyProductManifest(m) {
    throw Error(
        'Collection disabled pending independent same-host approval/custody protocol review. Metadata from a previous hosted job cannot approve this host.',
    );
    assert.equal(process.platform, 'win32', 'Native Windows producer required.');
    assert.equal(process.arch, 'x64');
    assert.equal(
        process.env.GITHUB_RUN_ATTEMPT,
        '1',
        'Only the first explicitly approved hosted attempt.',
    );
    assert.equal(process.env.GITHUB_REPOSITORY, m.repository);
    assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
    assert.match(process.env.GITHUB_RUN_ID ?? '', /^[0-9]+$/);
    assert.equal(process.version, m.node.version);
    assert.equal(fs.realpathSync(process.execPath), m.node.path);
    assert.deepEqual(process.execArgv, ['--import', pathToFileURL(m.tsx.path).href]);
    environment(m);
    assert.equal(await sourceFingerprint(sourceRoot), m.sourceSHA256);
    assert.equal(hashFile(m.node.path), m.node.sha256);
    assert.equal(hashFile(m.tsx.path), m.tsx.sha256);
    assert.equal(fs.realpathSync(require('electron')), m.electron.path);
    assert.equal(hashFile(m.electron.path), m.electron.sha256);
    assert.equal(hashFile(m.powershell.path), m.powershell.sha256);
    assert.deepEqual(
        dependencyIdentity(fs.realpathSync(path.join(sourceRoot, 'node_modules'))),
        m.dependencies,
    );
    assert.equal(hashFile(m.sshProfile.path), m.sshProfile.sha256);
    const ssh = JSON.parse(boundedRead(m.sshProfile.path, 65536));
    const { id, ...core } = ssh;
    assert.equal(digest(JSON.stringify(core)), id);
    assert.deepEqual(Object.keys(ssh.files).sort(), ['preload.cjs', 'ssh2.cjs']);
    for (const [name, hash] of Object.entries(ssh.files))
        assert.equal(hashFile(path.join(path.dirname(m.sshProfile.path), name)), hash);
    assert.equal(m.sshPreload, path.join(path.dirname(m.sshProfile.path), 'preload.cjs'));
    parseNativeCoverage(boundedRead(m.coverage.path, 16384), m.coverage.sha256, m.sourceSHA256);
    const principal = windowsPrincipalObserver(m);
    principal(m.outputRoot);
    principal(m.canonicalTmp);
    assert.equal(m.runtimeVersions.node, process.versions.node);
    assert.deepEqual(m.runtimeVersions, process.versions);
    return {
        sourceSHA256: m.sourceSHA256,
        dependencies: m.dependencies,
        nativeCoverageSHA256: m.coverage.sha256,
        principalSID: m.principalSID,
    };
}
function entries(guard, names, io = fs) {
    return prepareProductLogs(guard, names, io);
}
function recordPort(guard) {
    let complete = true,
        total = 0;
    const record = (name, value) => {
        try {
            const bytes = Buffer.from(JSON.stringify(value) + '\n');
            assert(bytes.length <= 262144 && total + bytes.length <= 4 * 1024 ** 2);
            total += bytes.length;
            guard.write(name, bytes);
        } catch (error) {
            complete = false;
            throw error;
        }
    };
    return { record, complete: () => complete };
}
function prepareCollectorPorts(m, manifestSHA256, nonce, entry) {
    let journal;
    try {
        entry.assertAdmissible();
        const ownerCheck = windowsPrincipalObserver(m);
        const rootGuard = new RootGuard(m.outputRoot, { ownerCheck });
        entry.assertAdmissible();
        const directory = rootGuard.mkdir('collector');
        entry.assertAdmissible();
        const guard = new RootGuard(directory, { ownerCheck });
        entry.assertAdmissible();
        const owner = {
            schema: 1,
            nonce,
            sourceSHA256: m.sourceSHA256,
            manifestSHA256,
            pid: process.pid,
            outputRoot: m.outputRoot,
            kind: m.kind,
            hostedRun: {
                repository: process.env.GITHUB_REPOSITORY,
                sha: process.env.GITHUB_SHA,
                run: process.env.GITHUB_RUN_ID,
                attempt: process.env.GITHUB_RUN_ATTEMPT,
            },
        };
        const lease = new ProductLease(canonicalMarker(), owner, { ownerCheck });
        entry.assertAdmissible();
        journal = new ProductJournal(guard, path.join(directory, 'journal.jsonl'));
        const records = recordPort(guard);
        const collectorSHA256 = hashFile(fileURLToPath(import.meta.url));
        m = { ...m, collectorSHA256 };
        const ports = {
            owner,
            manifestSHA256,
            lease,
            journal,
            verify: () => verifyProductManifest(m),
            record: records.record,
            evidenceComplete: records.complete,
            async prepare(spec, admit, onFailure, finalAdmission) {
                const prepared = prepareProductSpawn(spec, admit, finalAdmission, {
                    deferSpawn: true,
                    directory: (spec) => guard.mkdir('job-' + spec.ordinal),
                    logs: (spec) =>
                        entries(guard, [
                            'parent-' + spec.ordinal + '.stdout.log',
                            'parent-' + spec.ordinal + '.stderr.log',
                        ]),
                    command(_spec, job, jobDirectory) {
                        return [
                            '--require',
                            m.sshPreload,
                            '--import',
                            pathToFileURL(m.tsx.path).href,
                            path.join(sourceRoot, 'tests/fixtures/memory-resource-soak.ts'),
                            '--child=1',
                            '--product-job=' + JSON.stringify(job),
                            '--calibration=1',
                            '--lane=desktop',
                            '--gc=normal',
                            '--viewer=1',
                            '--driver=' +
                                path.join(sourceRoot, 'tests/fixtures/memory-product-aggregate.ts'),
                            '--source-sha256=' + m.sourceSHA256,
                            '--coverage-contract=' + m.coverage.path,
                            '--coverage-contract-sha256=' + m.coverage.sha256,
                            '--out=' + jobDirectory,
                            ...(spec.observerMode === 'no-sampler' ? ['--no-sampler=1'] : []),
                        ];
                    },
                    options: () => ({
                        cwd: sourceRoot,
                        windowsHide: true,
                        env: environment(m),
                        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                    }),
                    spawn: (argv, options) => spawn(m.node.path, argv, options),
                });
                // Deliver queued IPC/signals from blocking Windows preparation before final admission.
                try {
                    await new Promise((resolve) => setImmediate(resolve));
                } catch (error) {
                    error.noChildStarted = true;
                    error.preparedLogs = prepared.logs;
                    error.fdClosure = closeEntries(prepared.logs);
                    throw error;
                }
                return prepared;
            },
            begin(_spec, _allocate, onFailure, _finalAdmission, prepared) {
                const launch = prepared.commit();
                const { child, job, directory: jobDirectory, logs, command: argv } = launch;
                const streams = logs.map((e) => streamCollector(e.fd, { onFailure }));
                let monitor;
                return {
                    child,
                    job,
                    argv,
                    cwd: sourceRoot,
                    cancel(reason) {
                        if (!child.connected) throw Error('Actual child IPC unavailable.');
                        child.send({ kind: 'cancel-product-job', nonce: job.nonce, reason });
                    },
                    setup() {
                        for (const [name, i] of [
                            ['stdout', 0],
                            ['stderr', 1],
                        ]) {
                            child[name].on('data', (bytes) => streams[i].write(bytes));
                            child[name].on('error', onFailure);
                        }
                        monitor = setInterval(() => {
                            try {
                                guard.check(jobDirectory);
                                treeInventory(jobDirectory, {
                                    maxBytes: limits.jobBytes - 10 * 1024 ** 2,
                                });
                            } catch (error) {
                                onFailure(error);
                            }
                        }, 1000);
                        child.once('close', () => clearInterval(monitor));
                    },
                    closeLogs() {
                        clearInterval(monitor);
                        const closure = closeEntries(logs);
                        return {
                            ...closure,
                            streams: streams.map((s) => s.snapshot()),
                            complete:
                                closure.complete && streams.every((s) => !s.snapshot().truncated),
                        };
                    },
                    inspect(parentLifecycle) {
                        assert.equal(parentLifecycle.closeObserved, true);
                        const tree = treeInventory(jobDirectory, {
                                maxBytes: limits.jobBytes - 10 * 1024 ** 2,
                            }),
                            directories = fs.readdirSync(jobDirectory);
                        assert.equal(directories.length, 1);
                        const run = path.join(jobDirectory, directories[0]);
                        const relativeTimeline = path
                                .relative(jobDirectory, path.join(run, 'timeline.jsonl'))
                                .replaceAll('\\', '/'),
                            relativeExit = path
                                .relative(jobDirectory, path.join(run, 'native-will-quit.json'))
                                .replaceAll('\\', '/');
                        assert(
                            Object.hasOwn(tree.files, relativeTimeline) &&
                                Object.hasOwn(tree.files, relativeExit),
                        );
                        const specs = Object.entries(tree.files).map(([relative, size]) => ({
                            name:
                                relative === relativeTimeline
                                    ? 'timeline'
                                    : relative === relativeExit
                                      ? 'nativeExit'
                                      : relative,
                            path: path.join(jobDirectory, relative),
                            max: Math.max(1, size),
                        }));
                        for (let i = 0; i < specs.length; i += 32)
                            ownerCheck.many(specs.slice(i, i + 32).map((s) => s.path));
                        const durable = readDurableArtifacts(specs, {
                            check: (file) => guard.check(file),
                        });
                        for (let i = 0; i < specs.length; i += 32)
                            ownerCheck.many(specs.slice(i, i + 32).map((s) => s.path));
                        const result = inspectProductRaw(durable.raw, {
                            sourceSHA256: m.sourceSHA256,
                            adapterSHA256: hashFile(
                                path.join(sourceRoot, 'tests/fixtures/memory-product-aggregate.ts'),
                            ),
                            contractSHA256: m.coverage.sha256,
                            job,
                            parentLifecycle,
                            noSampler: spec.observerMode === 'no-sampler',
                        });
                        return {
                            ...result,
                            valid: result.valid && durable.durability.complete,
                            ownershipComplete:
                                result.ownershipComplete && durable.durability.complete,
                            rawDurability: durable.durability,
                            inventory: durable.inventory,
                            privateTree: tree,
                        };
                    },
                };
            },
            summary(rows) {
                records.record('pair-summary.json', {
                    collectionOnly: true,
                    policyQualified: false,
                    thresholdsSelected: false,
                    rows: rows.map((r) => ({
                        ordinal: r.ordinal,
                        observerMode: r.observerMode,
                        receipt: r.inspection.receipt,
                        rawTimelineSHA256: r.inspection.rawTimelineSHA256,
                    })),
                });
            },
            holdUnknown(state) {
                return createOwnershipHold(state, records.record).outcome;
            },
        };
        return ports;
    } catch (error) {
        if (journal)
            try {
                journal.close();
                assert(journal.proof());
            } catch (cleanup) {
                error.ownershipHold = createOwnershipHold(
                    {
                        phase: 'collector-prepare-close-unknown',
                        error: String(error),
                        cleanup: String(cleanup),
                    },
                    () => {},
                );
            }
        throw error;
    }
}
export async function runCollector(
    m,
    manifestSHA256,
    nonce,
    cohort,
    {
        events = process,
        clock = productClock,
        verify = verifyProductManifest,
        prepare = prepareCollectorPorts,
    } = {},
) {
    const entry = new CollectionEntry({
        nonce,
        cohort,
        events,
        clock,
        requireIPC: true,
        requireCohort: true,
    });
    let ports,
        controllerStarted = false;
    try {
        await entry.verify(() => verify(m));
        ports = prepare(m, manifestSHA256, nonce, entry);
        entry.assertAdmissible();
        controllerStarted = true;
        const result = await collectProductPreparation(m, ports, {
            supervisorNonce: nonce,
            entry,
            clock,
            events,
            startedAt: entry.cohort.startedAt,
        });
        assert(!result.leaseRetained && !result.leaseOwnershipUnverified);
        entry.dispose({ closed: true });
        if (!result.completionDurable || result.status !== 'COLLECTED_UNREVIEWED_WINDOWS_PAIR')
            events.exitCode = 1;
        if (events.connected) events.disconnect();
        return result;
    } catch (error) {
        if (error.ownershipHold) return error.ownershipHold.outcome;
        if (controllerStarted)
            return createOwnershipHold(
                { phase: 'collector-entry-or-controller-failed', error: String(error) },
                ports?.record ?? (() => {}),
            ).outcome;
        if (ports) {
            try {
                ports.journal.close();
                assert(ports.journal.proof());
            } catch (cleanup) {
                return createOwnershipHold(
                    {
                        phase: 'entry-journal-close-unknown',
                        error: String(error),
                        cleanup: String(cleanup),
                    },
                    ports.record,
                ).outcome;
            }
        }
        entry.dispose({ closed: true });
        throw error;
    }
}
export async function runOuter(
    m,
    manifestSHA256,
    manifestPath,
    {
        events = process,
        clock = productClock,
        verify = verifyProductManifest,
        logIO = fs,
        principalObserver = windowsPrincipalObserver,
        ownershipHold = createOwnershipHold,
        spawnChild = spawn,
    } = {},
) {
    const entry = new CollectionEntry({ events, clock });
    let logs = [],
        child,
        records,
        actualClosed = false;
    try {
        const startedAt = entry.cohort.startedAt;
        await entry.verify(() => verify(m));
        entry.assertAdmissible();
        assert.deepEqual(
            fs.readdirSync(m.outputRoot),
            [],
            'One fresh reviewed empty evidence root, no retries.',
        );
        const ownerCheck = principalObserver(m);
        const rootGuard = new RootGuard(m.outputRoot, { ownerCheck });
        entry.assertAdmissible();
        const directory = rootGuard.mkdir('outer');
        entry.assertAdmissible();
        const guard = new RootGuard(directory, { ownerCheck });
        entry.assertAdmissible();
        records = recordPort(guard);
        logs = entries(guard, ['collector.stdout.log', 'collector.stderr.log'], logIO);
        const nonce = entry.nonce;
        const streams = logs.map((e) =>
            streamCollector(e.fd, {
                onFailure: (error) => {
                    if (child?.connected)
                        child.send({
                            kind: 'cancel-product-collection',
                            nonce,
                            reason: String(error),
                        });
                },
            }),
        );
        const collectorEnv = environmentForCollector();
        await new Promise((resolve) => setImmediate(resolve));
        try {
            entry.assertAdmissible();
            child = spawnChild(
                m.node.path,
                [
                    '--import',
                    pathToFileURL(m.tsx.path).href,
                    fileURLToPath(import.meta.url),
                    '--collector=1',
                    '--nonce=' + nonce,
                    '--cohort=' + JSON.stringify(entry.cohort),
                    '--manifest=' + manifestPath,
                    '--manifest-sha256=' + manifestSHA256,
                ],
                {
                    cwd: sourceRoot,
                    env: collectorEnv,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                },
            );
        } catch (error) {
            const closure = closeEntries(logs, logIO);
            if (!closure.complete)
                return ownershipHold(
                    { phase: 'outer-pre-spawn-close-unknown', error: String(error) },
                    records.record,
                ).outcome;
            entry.dispose({ closed: true });
            throw error;
        }
        child.once('close', () => {
            actualClosed = true;
        });
        const observed = await observeCollector(child, {
            nonce,
            startedAt,
            record: records.record,
            streams,
            clock,
            events,
            entry,
        });
        const closure = closeEntries(logs, logIO);
        if (!closure.complete)
            return ownershipHold({ phase: 'outer-log-close-unknown', closure }, records.record)
                .outcome;
        const result = {
            ...observed,
            logClosure: closure,
            outerEvidenceDurable: records.complete(),
            nativeWindowsQualified: false,
            policyQualified: false,
        };
        records.record('outer-completion.json', result);
        if (
            !closure.complete ||
            !records.complete() ||
            observed.errors.length ||
            observed.timedOut ||
            !observed.spawnObserved ||
            !observed.exitObserved ||
            !observed.closeObserved ||
            observed.code !== 0 ||
            observed.closeCode !== 0 ||
            observed.signal !== null ||
            observed.closeSignal !== null ||
            streams.some((s) => s.snapshot().truncated)
        )
            process.exitCode = 1;
        entry.dispose({ closed: true });
        return result;
    } catch (error) {
        // Assignment never completes when a later log open fails. Preserve the helper's
        // acquired entries and failed/unknown proof; an empty local list proves nothing.
        logs = [...new Set([...logs, ...(error.preparedLogs ?? [])])];
        const closure = closeEntries(logs, logIO),
            carriedClosureComplete =
                !Object.hasOwn(error, 'fdClosure') || error.fdClosure?.complete === true;
        if ((child && !actualClosed) || !closure.complete || !carriedClosureComplete)
            return ownershipHold(
                {
                    phase: 'outer-custody-unknown',
                    error: String(error),
                    closure,
                    preparedLogClosure: error.fdClosure ?? null,
                    handles: logs.map((entry) => ({
                        name: entry.name,
                        syncObserved: entry.synced === true,
                        closeObserved: entry.closed === true,
                        closeAttempted: entry.attempted === true,
                        errors: [...entry.errors],
                    })),
                },
                records?.record ?? (() => {}),
            ).outcome;
        entry.dispose({ closed: true });
        throw error;
    }
    function environmentForCollector() {
        const env = environment(m);
        delete env.HUB_MEMORY_SSH_PROFILE;
        return env;
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    console.error(
        'Collection disabled: first use the separately reviewed preflight-only workflow. Same-host approval/custody remains unresolved.',
    );
    process.exitCode = 1;
}
