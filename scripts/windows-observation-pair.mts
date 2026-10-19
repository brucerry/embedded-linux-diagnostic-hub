// @ts-nocheck
/** Manual raw observation preparation. Import is inert; no finite pilot selector enables this route. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceFingerprint } from '../tests/fixtures/memory-resource-identity';
import { parseNativeCoverage } from '../tests/fixtures/memory-product-native-contract';
import { productClock } from '../tests/fixtures/memory-product-owner';
import { NativePilotStartup } from '../tests/fixtures/native-pilot-startup';
import { preparePilotStageRuntime } from './lib/pilot-runtime-startup.mjs';
import { preparePilotElectron } from './lib/pilot-electron-preparation.mjs';
import { settledElectronExecutable } from './lib/pilot-dependencies.mjs';
import { lookupPilotTool } from './lib/pilot-tool-lookup.mjs';
import {
    metadataIdentity,
    ancestryIdentity,
    checkAncestry,
    fileIdentity,
    digest,
    refuseMarker,
} from './lib/windows-preflight.mjs';
import { ProductLease } from './lib/product-collector-files.mjs';
import { closeEntries, writeAll } from './lib/product-collector-evidence.mjs';
import { CollectionEntry, createOwnershipHold } from './lib/product-entry-custody.mjs';
import {
    collectProductPreparation,
    limits as finiteLimits,
} from './lib/product-collector-controller.mjs';
import { soakPhysicalLimits } from './lib/soak-physical-budget.mjs';
import { soakEvidenceContractSHA256 } from './lib/soak-evidence.mjs';
import { runOuter, verifyProductManifest, dependencyIdentity } from './memory-product-collect.mts';
import {
    preparationObservationSecurity,
    closedObservationSecurityRefusal,
} from './lib/observation-security.mjs';
import { bindObservationDirectory } from './lib/observation-paths.mjs';
import { ObservationHandoff } from './lib/observation-handoff.mjs';
import { ObservationAccounting, admitObservationShared } from './lib/observation-accounting.mjs';
import { preserveObservationPty } from './lib/observation-pty-receipt.mjs';
import {
    observationPolicy,
    observationDigest,
    pollObservationApproval,
    observationAuthority,
} from './lib/windows-observation-approval.mjs';

export function observationContext(
    env = process.env,
    {
        platform = process.platform,
        arch = process.arch,
        version = process.version,
        tmp = os.tmpdir(),
        realpath = fs.realpathSync,
        identity = metadataIdentity,
        ancestry = ancestryIdentity,
        recheck = checkAncestry,
    } = {},
) {
    assert.equal(platform, 'win32');
    assert.equal(arch, 'x64');
    assert.equal(version, 'v24.22.0');
    for (const [key, value] of Object.entries({
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Windows',
        RUNNER_ARCH: 'X64',
        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_RUN_ATTEMPT: '1',
        HUB_WINDOWS_OBSERVATION_PAIR: '1',
    }))
        assert.equal(env[key], value, key);
    for (const key of Object.keys(env)) {
        if (/^(NODE_|TSX_|ESBUILD_|ELECTRON_)/.test(key))
            assert.fail('Unreviewed runtime override: ' + key);
        if (key.startsWith('HUB_'))
            assert(['HUB_WINDOWS_OBSERVATION_PAIR', 'HUB_OBSERVATION_REQUEST_JSON'].includes(key));
    }
    const profile = realpath(env.USERPROFILE);
    assert(/^C:\\Users\\[^\\]+$/i.test(profile));
    const profileBinding = bindObservationDirectory(env.USERPROFILE, profile, { identity });
    const tempBinding = bindObservationDirectory(
        tmp,
        path.win32.join(profile, 'AppData', 'Local', 'Temp'),
        { identity },
    );
    tmp = realpath(tmp);
    const admittedAncestries = [
        ancestry(tmp),
        ancestry(realpath(path.win32.join(profile, 'AppData', 'Local', 'Temp'))),
    ];
    const preserved = Object.fromEntries(
        ['TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA'].map((k) => [k, env[k]]),
    );
    return {
        tmp,
        check() {
            for (const rows of admittedAncestries) recheck(rows);
            profileBinding.check();
            tempBinding.check();
            for (const [k, v] of Object.entries(preserved)) assert.equal(env[k], v);
        },
    };
}
/** Ordinary refusal cleanup needs positive local resource/evidence/source and marker proofs. */
export async function refuseObservationPreparation(
    error,
    { lease, verifySource, check, record, resourceStates, evidenceComplete },
) {
    const resources = resourceStates();
    assert.deepEqual(Object.keys(resources).sort(), ['electron', 'runtime']);
    assert(
        Object.values(resources).every((v) => ['not-started', 'closed'].includes(v)),
        'Preparation resource closure unproved',
    );
    assert(evidenceComplete(), 'Preparation evidence incomplete');
    assert.equal(await verifySource(), true, 'Preparation source changed');
    check();
    const proof = {
        admissionCertain: true,
        directParentsClosed: true,
        evidenceClosed: true,
        inputsUnchanged: true,
        leafReceiptsClosed: true,
        resultClosed: true,
    };
    record('preparation-refused', {
        error: String(error).slice(0, 4096),
        sourceUnchanged: true,
        resources,
        securityRefusal: closedObservationSecurityRefusal(error),
        releasePending: true,
        proof,
    });
    // ProductLease rechecks the actual marker, owner/ACL, ancestry and exact bytes here.
    lease.release(proof);
    return { released: lease.state().released };
}
export async function observationMain(
    args = process.argv.slice(2),
    env = process.env,
    contextOptions,
) {
    assert.equal(
        observationPolicy.executionEnabled,
        true,
        'Observation route disabled pending independent source/host review and separate activation authorization.',
    );
    const context = observationContext(env, contextOptions),
        root = fs.realpathSync(path.resolve(import.meta.dirname, '..')),
        require = createRequire(import.meta.url),
        started = productClock.now(),
        deadline = started + observationPolicy.preparationMs,
        signal = new AbortController();
    assert.equal(args.length, 1);
    assert(args[0].startsWith('--out='));
    const out = fs.realpathSync(args[0].slice(6));
    assert.equal(path.dirname(out), context.tmp);
    assert.equal(path.basename(out), 'diagnostic-hub-observation-' + env.GITHUB_RUN_ID + '-1');
    assert.deepEqual(fs.readdirSync(out), [], 'Fresh private root; no replacement attempt.');
    const ancestry = ancestryIdentity(out),
        nonce = randomUUID();
    let lease,
        entry,
        unknown,
        stage = 'preparation',
        cohortDeadline = null,
        recordBytes = 0,
        recordRows = 0,
        startup,
        initialSource,
        monitor,
        accounting,
        preparationEvidenceComplete = true;
    const preparationResources = { electron: 'not-started', runtime: 'not-started' };
    const held = (state) => {
        if (unknown) return unknown;
        return createOwnershipHold(
            {
                ...state,
                stage,
                sourceSHA256: initialSource ?? null,
                lease: lease?.state() ?? null,
                resources: { ...preparationResources },
            },
            record,
            {
                onRetained: (hold) => {
                    unknown = hold;
                    clearInterval(monitor);
                    startup?.stopQueryAdmission();
                    signal.abort(Error('Unknown observation custody'));
                },
            },
        );
    };
    const cancel = () => signal.abort(Error('Observation supervisor cancelled'));
    for (const e of ['SIGINT', 'SIGTERM', 'disconnect']) process.on(e, cancel);
    const timer = setTimeout(
        () => signal.abort(Error('Observation preparation deadline')),
        observationPolicy.preparationMs,
    );
    const check = () => {
        assert(!unknown, 'Unknown custody remains held');
        if (stage === 'preparation') signal.signal.throwIfAborted();
        context.check();
        checkAncestry(ancestry);
        assert(
            productClock.now() < (stage.startsWith('preparation') ? deadline : cohortDeadline),
            'Observation absolute deadline',
        );
    };
    const prep = path.join(out, 'preparation');
    fs.mkdirSync(prep);
    const record = (name, value) => {
        try {
            context.check();
            checkAncestry(ancestry);
            const bytes = Buffer.from(
                JSON.stringify({ sequence: recordRows, stage: name, data: value }) + '\n',
            );
            assert(
                recordRows < 2048 && bytes.length <= 65536 && recordBytes + bytes.length <= 1048576,
                'Observation preparation evidence bound',
            );
            if (accounting)
                admitObservationShared(out, accounting.prerequisiteRoots, 'parent', bytes.length);
            const ordinal = recordRows++;
            recordBytes += bytes.length;
            const fd = fs.openSync(
                    path.join(prep, String(ordinal).padStart(6, '0') + '.json'),
                    'wx',
                    0o600,
                ),
                e = { fd, errors: [], attempted: false };
            try {
                writeAll(fd, bytes);
            } finally {
                const closed = closeEntries([e]);
                if (!closed.complete) {
                    held({ phase: 'preparation-evidence-close-unknown', closed });
                    throw Error('Preparation evidence not durable/closed');
                }
            }
        } catch (error) {
            preparationEvidenceComplete = false;
            throw error;
        }
    };
    const freeSpace = () => {
        const s = fs.statfsSync(context.tmp, { bigint: true });
        return Number(s.bavail * s.bsize);
    };
    try {
        assert(
            typeof env.HUB_OBSERVATION_REQUEST_JSON === 'string' &&
                Buffer.byteLength(env.HUB_OBSERVATION_REQUEST_JSON) <= 65536,
        );
        const request = JSON.parse(env.HUB_OBSERVATION_REQUEST_JSON);
        assert.deepEqual(Object.keys(request).sort(), [
            'coverageJSON',
            'coverageSHA256',
            'policySHA256',
            'pty',
            'schema',
            'sourceSHA256',
        ]);
        assert.equal(request.schema, 1);
        assert.equal(request.policySHA256, observationDigest(observationPolicy));
        assert.equal(await sourceFingerprint(root), request.sourceSHA256);
        initialSource = request.sourceSHA256;
        check();
        parseNativeCoverage(
            Buffer.from(request.coverageJSON),
            request.coverageSHA256,
            request.sourceSHA256,
        );
        assert.equal(env.OBSERVATION_PTY_GATE_COMPLETED, '1');
        const ptyRoot = fs.realpathSync(env.OBSERVATION_PTY_ROOT);
        assert.equal(
            ptyRoot,
            path.join(context.tmp, 'diagnostic-hub-observation-pty-' + env.GITHUB_RUN_ID + '-1'),
        );
        const ptyResultPath = path.join(ptyRoot, 'returned-owner-result.json'),
            ptyStat = fs.lstatSync(ptyResultPath);
        assert(
            ptyStat.isFile() &&
                !ptyStat.isSymbolicLink() &&
                ptyStat.nlink === 1 &&
                ptyStat.size <= 8192,
        );
        const ptyBytes = fs.readFileSync(ptyResultPath),
            ptyResult = JSON.parse(ptyBytes.toString().replace(/^\uFEFF/, ''));
        assert.equal(ptyResult.state, 'released');
        assert.equal(ptyResult.passed, true);
        assert.equal(ptyResult.winpsContractPassed, true);
        assert.equal(ptyResult.entryEvidenceClosure.complete, true);
        assert.deepEqual(ptyResult.stages, ['real-os-pty']);
        assert.equal(ptyResult.collectionApproval, false);
        assert(freeSpace() >= 2 * 1024 ** 3, 'Observation free-space admission requires2GiB');
        record('preparation-start', {
            sourceSHA256: request.sourceSHA256,
            policy: observationPolicy,
            availableBytes: freeSpace(),
            universalAllocationQuotaClaim: false,
        });
        let ordinal = 0;
        const where = (name) =>
            lookupPilotTool(name, {
                ordinal: ++ordinal,
                clock: productClock.now,
                workDeadline: deadline - 60000,
                check,
                record,
                onProcessState: (state) => {
                    if (!state.closed) held({ phase: 'tool-query-close-unknown', state });
                },
            });
        const git = await where('git.exe'),
            pwsh = await where('pwsh.exe'),
            winps = path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
            gitRoot = [
                path.resolve(path.dirname(git), '..'),
                path.resolve(path.dirname(git), '../..'),
            ].find((p) => fs.existsSync(path.join(p, 'usr/bin/winpty.dll')));
        assert(gitRoot);
        const bin = path.join(gitRoot, 'usr/bin'),
            tools = {
                winps,
                pwsh,
                git,
                bash: path.join(bin, 'bash.exe'),
                cygpath: path.join(bin, 'cygpath.exe'),
                winptyDll: path.join(bin, 'winpty.dll'),
                winptyAgent: path.join(bin, 'winpty-agent.exe'),
            };
        const {
            initial: securityInitial,
            descriptors,
            ownerCheck,
        } = preparationObservationSecurity(
            root,
            winps,
            [
                { path: context.tmp, kind: 'directory' },
                { path: out, kind: 'directory' },
            ],
            {
                environment: env,
                record,
                check,
                onProcessState: (s) => {
                    if (!s.closed) held({ phase: 'security-query-close-unknown', state: s });
                },
            },
        );
        refuseMarker(context.tmp);
        lease = new ProductLease(
            path.join(context.tmp, 'diagnostic-hub-v060-check.lock'),
            {
                schema: 1,
                kind: observationPolicy.kind,
                nonce,
                run: env.GITHUB_RUN_ID,
                sourceSHA256: request.sourceSHA256,
            },
            { ownerCheck },
        );
        lease.acquire();
        record('same-host-owner', { nonce, lease: lease.state() });
        const ptyExpected = { sourceSHA256: request.sourceSHA256, ...request.pty },
            host = {
                repository: env.GITHUB_REPOSITORY,
                run: env.GITHUB_RUN_ID,
                attempt: '1',
                commit: env.GITHUB_SHA,
            };
        const ptyReceipt = preserveObservationPty(ptyRoot, ptyExpected, {
            sourceRoot: root,
            host,
            canonicalTemp: context.tmp,
            ownerCheck,
            hold: held,
        });
        preparationResources.electron = 'running';
        await preparePilotElectron(root, {
            parent: context.tmp,
            evidenceRoot: prep,
            tools,
            environment: env,
            signal: signal.signal,
            workDeadline: deadline - 60000,
            check,
            record,
            hold: (state) => held({ phase: 'electron-preparation', state }),
        });
        preparationResources.electron = 'closed';
        check();
        preparationResources.runtime = 'running';
        startup = new NativePilotStartup({
            signal: signal.signal,
            deadline: deadline - 60000,
            cleanupDeadline: deadline,
            emit: async (s, d) => record(s, d),
            hold: (e) => held({ phase: 'runtime-preparation', error: String(e) }),
            diagnostics: true,
        });
        const runtimeParent = path.join(out, 'runtime');
        fs.mkdirSync(runtimeParent);
        const runtime = await preparePilotStageRuntime({
            binding: { nonce, deadline },
            bindingSHA256: observationDigest({ nonce, source: request.sourceSHA256 }),
            paths: { runtimeParent },
            startup,
            signal: signal.signal,
            deadline: deadline - 60000,
            emit: async (s, d) => record(s, d),
            cancel: (e) => signal.abort(e),
            hold: (e) => held({ phase: 'runtime-build', error: String(e) }),
            root,
        });
        assert.equal((await startup.join()).complete, true);
        assert.equal(startup.unknown.length, 0);
        preparationResources.runtime = 'closed';
        check();
        const coveragePath = path.join(out, 'native-coverage.json');
        fs.writeFileSync(coveragePath, request.coverageJSON, { flag: 'wx' });
        // Reopen writable to retain Windows fsync semantics, and positively close it.
        const coverageEntry = { fd: fs.openSync(coveragePath, 'r+'), errors: [], attempted: false };
        const coverageClosed = closeEntries([coverageEntry]);
        if (!coverageClosed.complete) {
            held({ phase: 'coverage-evidence-close-unknown', coverageClosed });
            throw Error('Coverage descriptor durability or closure failed');
        }
        const collectionRoot = path.join(out, 'collection');
        fs.mkdirSync(collectionRoot);
        ownerCheck(collectionRoot);
        const identity = (file) =>
            fileIdentity(fs.realpathSync(file), {
                pe: !file.endsWith('.mjs') && !file.endsWith('.js'),
                check,
            });
        const node = identity(process.execPath),
            tsx = identity(require.resolve('tsx')),
            electron = identity(settledElectronExecutable(root, env)),
            powershell = identity(winps),
            dependencies = dependencyIdentity(fs.realpathSync(path.join(root, 'node_modules')));
        node.version = process.version;
        electron.version = '44.5.1';
        const manifest = {
            schema: 1,
            reviewed: true,
            kind: 'windows-first-product-calibration-pair',
            sourceRoot: root,
            sourceSHA256: request.sourceSHA256,
            platform: 'win32',
            arch: 'x64',
            repository: env.GITHUB_REPOSITORY,
            node,
            tsx,
            electron,
            powershell,
            dependencies,
            runtimeVersions: { ...process.versions },
            limits: {
                ...finiteLimits,
                jobBytes: soakPhysicalLimits.job,
                cohortBytes: soakPhysicalLimits.cohort,
            },
            localEvidenceContractSHA256: soakEvidenceContractSHA256,
            jobs: [
                { ordinal: 0, observerMode: 'sampled', gcMode: 'normal', expectedParentCode: 0 },
                { ordinal: 1, observerMode: 'no-sampler', gcMode: 'normal', expectedParentCode: 0 },
            ],
            collectionOnly: true,
            thresholdsSelected: false,
            executionApproval: 'one-serialized-windows-normal-pair-only',
            outputRoot: collectionRoot,
            canonicalTmp: context.tmp,
            principalSID: securityInitial.principal,
            outputRootSDDLSHA256: ownerCheck(collectionRoot).descriptorSHA256,
            canonicalTmpSDDLSHA256: descriptors.get(context.tmp),
            coverage: { path: coveragePath, sha256: request.coverageSHA256 },
            sshProfile: {
                path: runtime.manifestPath,
                sha256: digest(fs.readFileSync(runtime.manifestPath)),
            },
            sshPreload: runtime.preloadPath,
            childPATH: env.PATH,
            collectorSHA256: digest(
                fs.readFileSync(path.join(root, 'scripts/memory-product-collect.mts')),
            ),
        };
        manifest.observationApprovalPath = path.join(out, 'same-host-approval.json');
        manifest.observationPtyRoot = ptyRoot;
        const manifestPath = path.join(out, 'approved-manifest.json');
        const manifestEntry = {
            fd: fs.openSync(manifestPath, 'wx', 0o600),
            errors: [],
            attempted: false,
        };
        try {
            writeAll(manifestEntry.fd, Buffer.from(JSON.stringify(manifest)));
        } finally {
            const closure = closeEntries([manifestEntry]);
            if (!closure.complete) {
                held({ phase: 'manifest-descriptor-unknown', closure });
                throw Error('Manifest not durable/closed');
            }
        }
        accounting = new ObservationAccounting(out, context.tmp, { prerequisiteRoots: [ptyRoot] });
        accounting.admit();
        const binding = {
            schema: 1,
            kind: observationPolicy.kind,
            host: {
                repository: env.GITHUB_REPOSITORY,
                run: env.GITHUB_RUN_ID,
                attempt: '1',
                commit: env.GITHUB_SHA,
                event: 'workflow_dispatch',
                environment: 'github-hosted',
            },
            nonce,
            supervisorPID: process.pid,
            hostname: os.hostname(),
            platform: 'win32',
            arch: 'x64',
            createdUTC: new Date().toISOString(),
            preparationStartedAt: started,
            preparationDeadline: deadline,
            sourceSHA256: request.sourceSHA256,
            policySHA256: request.policySHA256,
            coverageSHA256: request.coverageSHA256,
            manifestSHA256: observationDigest(manifest),
            runtime: { node, tsx, electron, powershell },
            dependencies,
            roots: {
                canonicalTemp: metadataIdentity(context.tmp),
                private: metadataIdentity(out),
                collection: metadataIdentity(collectionRoot),
            },
            marker: {
                path: lease.file,
                identity: metadataIdentity(lease.file),
                bodySHA256: digest(lease.bytes),
            },
            principalSID: securityInitial.principal,
            descriptors: Object.fromEntries(descriptors),
            availableBytes: freeSpace(),
            policy: observationPolicy,
            freshPty: ptyReceipt,
            physicalAdmission: accounting.snapshot(),
        };
        record('host-approval-challenge', {
            binding,
            bindingSHA256: observationDigest(binding),
            manifest,
        });
        console.log(
            JSON.stringify({
                status: 'AWAITING_SAME_HOST_HUMAN_APPROVAL',
                binding,
                approval: {
                    schema: 1,
                    decision: 'approve-one-normal-pair',
                    parentRun: binding.host.run,
                    bindingSHA256: observationDigest(binding),
                    sourceSHA256: binding.sourceSHA256,
                    commit: binding.host.commit,
                },
            }),
        );
        const approval = await pollObservationApproval(binding, env.GITHUB_TOKEN, {
            check: () => {
                check();
                lease.check();
            },
            record,
        });
        check();
        assert.deepEqual(
            preserveObservationPty(ptyRoot, ptyExpected, {
                sourceRoot: root,
                host,
                canonicalTemp: context.tmp,
                ownerCheck,
                hold: held,
            }),
            ptyReceipt,
            'Durable PTY evidence changed during approval wait',
        );
        const approvalBytes = Buffer.from(JSON.stringify({ binding, approval }));
        assert(approvalBytes.length <= 65536);
        admitObservationShared(out, [ptyRoot], 'parent', approvalBytes.length);
        const approvalEntry = {
            fd: fs.openSync(manifest.observationApprovalPath, 'wx', 0o600),
            errors: [],
            attempted: false,
        };
        try {
            writeAll(approvalEntry.fd, approvalBytes);
        } finally {
            const closure = closeEntries([approvalEntry]);
            if (!closure.complete) {
                held({ phase: 'approval-descriptor-unknown', closure });
                throw Error('Approval not durable/closed');
            }
        }
        accounting.admit();
        assert.equal(await sourceFingerprint(root), request.sourceSHA256);
        record('preparation-closed', {
            startup: startup.snapshot(),
            approval,
            recordBytes,
            availableBytes: freeSpace(),
        });
        assert(!unknown);
        clearTimeout(timer);
        stage = 'collection';
        cohortDeadline = productClock.now() + observationPolicy.cohortMs;
        const authority = observationAuthority(binding, manifest, approval, {
            lease,
            ownerCheck,
            check,
            preparationClosed: true,
        });
        const cohort = {
            schema: 1,
            nonce,
            startedAt: cohortDeadline - observationPolicy.cohortMs,
            deadlineMs: cohortDeadline,
        };
        const handoff = new ObservationHandoff(authority, manifest, {
            verify: () => verifyProductManifest(manifest, authority),
            record,
            check,
            admit: () => {
                signal.signal.throwIfAborted();
                check();
                assert.deepEqual(
                    preserveObservationPty(ptyRoot, ptyExpected, {
                        sourceRoot: root,
                        host,
                        canonicalTemp: context.tmp,
                        ownerCheck,
                        hold: held,
                    }),
                    ptyReceipt,
                );
            },
            hold: (e) => held({ phase: 'approval-handoff-unknown', error: String(e) }),
            accounting,
        });
        monitor = setInterval(() => {
            try {
                check();
                accounting.scan();
            } catch (e) {
                signal.abort(e);
                if (handoff.child?.connected)
                    handoff.child.send(
                        { kind: 'cancel-product-collection', nonce, reason: String(e) },
                        () => {},
                    );
            }
        }, 1000);
        let result;
        try {
            result = await runOuter(manifest, observationDigest(manifest), manifestPath, {
                nonce,
                cohort,
                authority,
                handoff,
                sharedAdmission: (bytes) => admitObservationShared(out, [ptyRoot], 'parent', bytes),
                verify: () => verifyProductManifest(manifest, authority),
                principalObserver: () => ownerCheck,
                ownershipHold: (state, record) => held(state),
            });
        } finally {
            clearInterval(monitor);
        }
        assert(result.markerReleased === true && lease.state().released === true);
        return result;
    } catch (error) {
        if (startup)
            try {
                assert.equal((await startup.join()).complete, true);
                preparationResources.runtime = 'closed';
            } catch (e) {
                held({ phase: 'preparation-descendants-unknown', error: String(e) });
            }
        if (unknown) return unknown.outcome;
        if (lease?.state().created && !lease.state().released) {
            if (stage !== 'preparation')
                return held({
                    phase: 'observation-controller-custody-unknown',
                    error: String(error),
                }).outcome;
            try {
                stage = 'preparation-cleanup';
                await refuseObservationPreparation(error, {
                    lease,
                    verifySource: async () => (await sourceFingerprint(root)) === initialSource,
                    check,
                    record,
                    resourceStates: () => ({ ...preparationResources }),
                    evidenceComplete: () => preparationEvidenceComplete,
                });
            } catch (e) {
                return held({ phase: 'preparation-release-unknown', error: String(e) }).outcome;
            }
        }
        throw error;
    } finally {
        clearTimeout(timer);
        if (!unknown) for (const e of ['SIGINT', 'SIGTERM', 'disconnect']) process.off(e, cancel);
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    void observationMain()
        .then((result) => console.log(JSON.stringify(result)))
        .catch((error) => {
            console.error(String(error));
            process.exitCode = 1;
        });
