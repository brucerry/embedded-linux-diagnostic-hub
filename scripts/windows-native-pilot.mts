// @ts-nocheck
/** Separately fenced finite pilot. No product collector is imported or dispatched. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sourceFingerprint } from '../tests/fixtures/memory-resource-identity';
import { parseNativeCoverage } from '../tests/fixtures/memory-product-native-contract';
import { NativePilotStartup } from '../tests/fixtures/native-pilot-startup';
import { pilotPathMap } from '../tests/fixtures/native-pilot-paths';
import { productClock } from '../tests/fixtures/memory-product-owner';
import {
    requirePilotRuntimeReady,
    pilotLimits,
    bindingDigest,
} from './lib/hosted-pilot-contract.mjs';
import { pilotHostedContext, parsePilotSecurity } from './lib/hosted-pilot-security.mjs';
import { runHostedPilot, joinPilotStage } from './lib/hosted-pilot-run.mjs';
import { ProductLease } from './lib/product-collector-files.mjs';
import { createOwnershipHold } from './lib/product-entry-custody.mjs';
import { writeAll } from './lib/product-collector-evidence.mjs';
import {
    fileIdentity,
    dependencyFacts,
    digest,
    metadataIdentity,
    ancestryIdentity,
    checkAncestry,
    refuseMarker,
} from './lib/windows-preflight.mjs';
import { PilotEvidence } from './lib/pilot-evidence.mjs';
import { pilotEvidenceReceiver } from './lib/pilot-evidence-channel.mjs';
import { PilotDiskObserver } from './lib/pilot-disk-observer.mjs';
import { runWinpsSecurityContract } from './lib/pilot-winps-contract.mjs';
import { runSecurityCommand, requireSecurityProcess } from './lib/pilot-security-command.mjs';
import { prepareAndFreezePilotDependencies } from './lib/pilot-dependencies.mjs';
import { preparePilotElectron } from './lib/pilot-electron-preparation.mjs';
import {
    pilotStageDeadlines,
    waitPilotStage,
    stopHeldPilotActivity,
} from './lib/pilot-runtime-startup.mjs';
import { lookupPilotTool, prerequisiteFailure } from './lib/pilot-tool-lookup.mjs';
export { runHostedPilot };
export async function nativePilotMain(args = process.argv.slice(2), environment = process.env) {
    requirePilotRuntimeReady(environment);
    const startedAt = productClock.now(),
        early = new AbortController();
    const earlyCancel = () => early.abort(Error('Pilot entry cancelled before enrollment'));
    for (const e of ['SIGTERM', 'SIGINT', 'disconnect']) process.on(e, earlyCancel);
    let owner,
        held,
        evidence,
        timer,
        privateRoot,
        paths,
        signal,
        entryEvidence,
        entryRecord,
        reserveShared,
        entryClosure,
        startup;
    const stages = new Map(),
        cancellationRequests = new WeakSet();
    let entryCharge = 0;
    const hold = (state, record) => {
        stopHeldPilotActivity(startup, () => clearInterval(timer));
        held ??= createOwnershipHold({ ...state, startup: startup?.snapshot() }, record);
        signal?.abort(Error('Pilot owner holds unknown custody'));
        startup?.cancel();
        return held;
    };
    let prerequisite = 'entry-inputs-and-host-context';
    try {
        const expectedKeys = ['out', 'expected-source', 'expected-policy', 'coverage-sha256'];
        const options = Object.fromEntries(
            args.map((a) => {
                assert(/^--[^=]+=.+$/.test(a));
                return a.slice(2).split(/=(.*)/s).slice(0, 2);
            }),
        );
        assert.equal(args.length, expectedKeys.length);
        assert.deepEqual(Object.keys(options).sort(), expectedKeys.sort());
        for (const k of ['expected-source', 'expected-policy', 'coverage-sha256'])
            assert(/^[a-f0-9]{64}$/.test(options[k]));
        const root = path.resolve(import.meta.dirname, '..'),
            require = createRequire(import.meta.url),
            context = pilotHostedContext(environment);
        const admitEarly = () => {
            early.signal.throwIfAborted();
            context.check();
            assert(productClock.now() < startedAt + pilotLimits.totalMs - pilotLimits.reserveMs);
        };
        admitEarly();
        prerequisite = 'source-policy-coverage-and-evidence-root';
        assert.equal(await sourceFingerprint(root), options['expected-source']);
        admitEarly();
        const policyFile = path.join(root, 'scripts/lib/hosted-pilot-policy.json'),
            policyBytes = fs.readFileSync(policyFile);
        assert.equal(digest(policyBytes), options['expected-policy']);
        const coverageJSON = environment.HUB_NATIVE_PILOT_COVERAGE_JSON;
        assert(typeof coverageJSON === 'string' && Buffer.byteLength(coverageJSON) <= 8192);
        parseNativeCoverage(
            Buffer.from(coverageJSON),
            options['coverage-sha256'],
            options['expected-source'],
        );
        const out = options.out;
        assert(path.isAbsolute(out) && fs.realpathSync(out) === out);
        assert.deepEqual(fs.readdirSync(out), [], 'Fresh nonsecret evidence directory required');
        const evidenceAncestors = ancestryIdentity(out),
            evidenceId = metadataIdentity(out);
        assert(evidenceId.directory);
        const entryRoot = path.join(out, 'entry-evidence');
        fs.mkdirSync(entryRoot);
        entryEvidence = new PilotEvidence(entryRoot, {
            check: () => {
                context.check();
                checkAncestry(evidenceAncestors);
            },
        });
        entryRecord = (stage, data) => {
            const bytes = Buffer.byteLength(JSON.stringify({ stage, data })) + 256;
            assert(entryCharge + bytes <= 524288, 'Early evidence pre-write budget');
            reserveShared?.(bytes);
            entryEvidence.append(stage, data);
            entryCharge += bytes;
        };
        entryRecord('entry-start', {
            sourceSHA256: options['expected-source'],
            startedAt,
            deadline: startedAt + pilotLimits.totalMs,
        });
        prerequisite = 'fresh-winps-contract';
        const contractRoot = path.join(out, 'winps-contract');
        fs.mkdirSync(contractRoot);
        const contract = await runWinpsSecurityContract({
            sourceRoot: root,
            outputRoot: contractRoot,
            expectedSourceSHA256: options['expected-source'],
            environment,
            mode: 'pilot',
            signal: early.signal,
            outerDeadline: startedAt + pilotLimits.totalMs - pilotLimits.reserveMs,
        });
        entryRecord('winps-contract-prerequisite', {
            passed: contract.passed,
            casesPassed: contract.casesPassed,
            casesRequired: contract.casesRequired,
            interpreter: contract.interpreter,
            interpreterReport: contract.interpreterReport,
            evidenceClosure: contract.evidenceClosure,
            evidenceBytes: contract.evidenceBytes,
        });
        assert.equal(
            contract.passed,
            true,
            'Real WinPS production provider contract must pass before Electron/dependency enrollment.',
        );
        admitEarly();
        let lookupOrdinal = 0;
        const where = (name) => {
            prerequisite = 'tool-lookup:' + name;
            return lookupPilotTool(name, {
                ordinal: ++lookupOrdinal,
                clock: productClock.now,
                workDeadline: startedAt + pilotLimits.totalMs - pilotLimits.reserveMs,
                check: admitEarly,
                record: entryRecord,
                onProcessState: (state) => {
                    if (!state.closed)
                        hold(
                            { kind: 'pilot-prerequisite-query-unknown', processState: state },
                            entryRecord,
                        );
                },
            });
        };
        const git = await where('git.exe'),
            powershell = contract.interpreter.path,
            pwsh = await where('pwsh.exe');
        prerequisite = 'git-root-and-winpty-paths';
        let gitRoot = [
            path.resolve(path.dirname(git), '..'),
            path.resolve(path.dirname(git), '../..'),
        ].find((p) => fs.existsSync(path.join(p, 'usr/bin/winpty.dll')));
        assert(gitRoot, 'Git root containing usr/bin/winpty.dll unavailable');
        const bin = path.join(gitRoot, 'usr/bin');
        prerequisite = 'owned-electron-preparation';
        await preparePilotElectron(root, {
            parent: context.parent,
            evidenceRoot: out,
            tools: {
                winps: powershell,
                pwsh,
                git,
                bash: path.join(bin, 'bash.exe'),
                cygpath: path.join(bin, 'cygpath.exe'),
                winptyDll: path.join(bin, 'winpty.dll'),
                winptyAgent: path.join(bin, 'winpty-agent.exe'),
            },
            environment,
            signal: early.signal,
            workDeadline: startedAt + pilotLimits.totalMs - pilotLimits.reserveMs,
            check: admitEarly,
            record: entryRecord,
            hold,
        });
        prerequisite = 'dependency-runtime-freeze';
        const prepared = prepareAndFreezePilotDependencies(root, {
            environment,
            check: admitEarly,
            record: entryRecord,
        });
        const deps = prepared.dependencies,
            runtime = { platform: process.platform, arch: process.arch };
        prerequisite = 'runtime-version-and-architecture';
        assert.equal(process.version, 'v24.22.0');
        assert.equal(process.arch, 'x64');
        const runtimePaths = {
            node: process.execPath,
            tsx: require.resolve('tsx'),
            electron: prepared.electron,
            powershell: pwsh,
            git,
            bash: path.join(bin, 'bash.exe'),
            cygpath: path.join(bin, 'cygpath.exe'),
            winptyDll: path.join(bin, 'winpty.dll'),
            winptyAgent: path.join(bin, 'winpty-agent.exe'),
        };
        for (const [name, p] of Object.entries(runtimePaths)) {
            prerequisite = 'runtime-identity:' + name;
            const id = fileIdentity(fs.realpathSync(p), {
                pe: !['tsx'].includes(name),
                check: admitEarly,
            });
            if (id.pe) assert.equal(id.pe.architecture, 'x64');
            runtime[name] = {
                path: id.path,
                sha256: id.sha256,
                ...(name === 'node'
                    ? { version: process.version }
                    : name === 'electron'
                      ? { version: require('electron/package.json').version }
                      : {}),
            };
        }
        prerequisite = 'security-provider-identities';
        const psIdentity = fileIdentity(powershell, { pe: true, check: admitEarly }),
            securityScript = path.join(root, 'scripts/lib/hosted-pilot-security.ps1'),
            scriptIdentity = fileIdentity(securityScript);
        const security = (plans, principal) => {
            const reply = runSecurityCommand(root, powershell, JSON.stringify(plans), {
                environment,
                record: entryRecord,
                onProcessState: (state) => {
                    if (!state.closed) {
                        if (owner)
                            owner.hold(
                                'PowerShell query close unconfirmed: ' + JSON.stringify(state),
                            );
                        else
                            hold(
                                {
                                    kind: 'pilot-security-query-unknown',
                                    processState: state,
                                    privateRoot,
                                },
                                entryRecord,
                            );
                    }
                },
                check: () => {
                    context.check();
                    checkAncestry(evidenceAncestors);
                    assert(productClock.now() < startedAt + pilotLimits.totalMs);
                },
            });
            requireSecurityProcess(reply.result);
            assert.deepEqual(fileIdentity(securityScript), scriptIdentity);
            assert.deepEqual(fileIdentity(powershell, { pe: true }), psIdentity);
            return parsePilotSecurity(reply.stdout, plans, principal);
        };
        prerequisite = 'canonical-marker-absence-and-private-paths';
        refuseMarker(context.parent);
        const nonce = randomUUID();
        privateRoot = path.join(context.parent, 'diagnostic-hub-native-pilot-' + nonce);
        fs.mkdirSync(privateRoot);
        paths = pilotPathMap(privateRoot, nonce, true);
        const plans = [
                { path: context.parent, kind: 'directory' },
                { path: privateRoot, kind: 'directory' },
            ],
            initial = security(plans);
        prerequisite = 'host-binding-and-root-identities';
        const binding = {
            schema: 1,
            kind: 'windows-hosted-native-readiness-pilot-v1',
            collectionApproval: false,
            host: context.host,
            nonce,
            principalSID: initial.principal,
            sourceSHA256: options['expected-source'],
            coveragePolicySHA256: options['coverage-sha256'],
            pilotPolicySHA256: options['expected-policy'],
            dependenciesSHA256: deps.sha256,
            runtime,
            roots: Object.fromEntries(
                [
                    ['canonicalTemp', context.parent, initial.rows[0].descriptorSHA256],
                    ['privateRoot', privateRoot, initial.rows[1].descriptorSHA256],
                    ['evidenceRoot', out, digest(JSON.stringify(evidenceId))],
                ].map(([k, p, descriptorSHA256]) => {
                    const id = metadataIdentity(p);
                    return [k, { path: p, dev: id.dev, ino: id.ino, descriptorSHA256 }];
                }),
            ),
            startedAt,
            deadline: startedAt + pilotLimits.totalMs,
            limits: pilotLimits,
        };
        // evidenceRoot's digest is a nonsecret physical-identity binding, explicitly not ACL admission.
        binding.roots.evidenceRoot.identitySHA256 = binding.roots.evidenceRoot.descriptorSHA256;
        delete binding.roots.evidenceRoot.descriptorSHA256;
        prerequisite = 'lease-construction';
        const lease = new ProductLease(
            path.join(context.parent, 'diagnostic-hub-v060-check.lock'),
            {
                kind: 'finite-native-pilot-owner',
                nonce,
                bindingSHA256: bindingDigest(binding),
                run: context.host.run,
                attempt: '1',
            },
        );
        let charged = entryCharge + contract.evidenceBytes;
        const reserve = (n) => {
            assert(charged + n <= pilotLimits.evidenceBytes);
            charged += n;
        };
        reserveShared = reserve;
        evidence = new PilotEvidence(out, {
            check: () => {
                context.check();
                checkAncestry(evidenceAncestors);
            },
        });
        const record = (stage, data) => {
            reserve(Buffer.byteLength(JSON.stringify({ stage, data })) + 256);
            evidence.append(stage, data);
        };
        signal = new AbortController();
        startup = new NativePilotStartup({
            signal: signal.signal,
            deadline: binding.deadline - pilotLimits.reserveMs,
            cleanupDeadline: binding.deadline,
            emit: async (s, d) => record(s, d),
            hold: (e) => owner?.hold(e),
            diagnostics: true,
        });
        let markerProof;
        const observer = new PilotDiskObserver(
            [
                { path: privateRoot, kind: 'private' },
                { path: out, kind: 'evidence' },
                { path: path.join(context.parent, 'tsx-0'), kind: 'tool', optional: true },
            ],
            {
                check: () => {
                    paths.check();
                    context.check();
                    checkAncestry(evidenceAncestors);
                },
                emit: (r) => {
                    try {
                        record('disk-observation', r);
                    } catch (e) {
                        owner?.hold(e);
                        throw e;
                    }
                },
                stop: (e) => owner?.cancel(e),
            },
        );
        const observe = (stage) => {
            try {
                return observer.scan(stage);
            } catch (e) {
                if (e.observedThresholdExceeded) {
                    owner?.cancel(e);
                    return e.observation;
                }
                throw e;
            }
        };
        const recheck = async () => {
            if (markerProof) {
                lease.check();
                assert.deepEqual(
                    security([...plans, { path: lease.file, kind: 'file' }], binding.principalSID)
                        .rows[2],
                    markerProof,
                );
            }
            context.check();
            paths.check();
            checkAncestry(evidenceAncestors);
            assert.equal(await sourceFingerprint(root), binding.sourceSHA256);
            assert.equal(
                dependencyFacts(path.join(root, 'node_modules'), () => context.check()).sha256,
                binding.dependenciesSHA256,
            );
            for (const [name, p] of Object.entries(runtimePaths))
                assert.equal(fileIdentity(fs.realpathSync(p)).sha256, runtime[name].sha256);
            assert.equal(digest(fs.readFileSync(policyFile)), binding.pilotPolicySHA256);
            assert.deepEqual(
                security(plans, binding.principalSID).rows.map((r) => r.descriptorSHA256),
                initial.rows.map((r) => r.descriptorSHA256),
            );
            return true;
        };
        const sendStageCancel = (child, message, callback = () => {}) => {
            if (cancellationRequests.has(child)) return;
            cancellationRequests.add(child);
            try {
                record('stage-cancel-request', {
                    pid: child.pid,
                    kind: message.kind,
                    reason: message.reason,
                    deadline: binding.deadline,
                });
            } catch (e) {
                owner?.hold(e);
            }
            if (!child.connected) {
                record('stage-cancel-transport', { pid: child.pid, connected: false, sent: false });
                callback(Error('Stage cancellation IPC unavailable'));
                return;
            }
            child.send(message, (e) => {
                try {
                    record('stage-cancel-transport', {
                        pid: child.pid,
                        sent: !e,
                        error: e ? String(e).slice(0, 1024) : null,
                    });
                } catch (persistence) {
                    owner?.hold(persistence);
                }
                callback(e);
            });
        };
        admitEarly();
        prerequisite = 'hosted-pilot-owner-admission';
        const result = await runHostedPilot(binding, {
            lease,
            events: process,
            clock: productClock,
            record,
            hold,
            cancelChild: sendStageCancel,
            executionGate: () => requirePilotRuntimeReady(environment),
            onOwner: (o) => {
                owner = o;
                timer = setInterval(() => {
                    try {
                        observe('periodic');
                    } catch (e) {
                        o.cancel(e);
                    }
                }, 1000);
                if (early.signal.aborted) o.cancel(early.signal.reason);
            },
            verify: async (b) => {
                const marker = security(
                    [...plans, { path: lease.file, kind: 'file' }],
                    b.principalSID,
                );
                markerProof = marker.rows[2];
                record('marker-FileSecurity-readback', {
                    bindingSHA256: bindingDigest(b),
                    marker: marker.rows[2],
                    identity: metadataIdentity(lease.file),
                    bytesSHA256: digest(lease.bytes),
                });
                await recheck();
                early.signal.throwIfAborted();
                return b;
            },
            closeEvidence: async () => {
                const main = evidence.close();
                entryClosure = entryEvidence.close();
                return {
                    complete: main.complete && entryClosure.complete,
                    main,
                    entry: entryClosure,
                };
            },
            beforeStage: async (stage) => {
                observe('before-' + stage);
            },
            spawnStage: (stage, o) => {
                const deadlines = pilotStageDeadlines(binding, stage, productClock.now());
                record('stage-spawn-deadlines', { stage, ...deadlines });
                const child = startup.spawn(
                    'stage-' + stage,
                    () =>
                        spawn(
                            process.execPath,
                            [
                                '--import',
                                pathToFileURL(runtime.tsx.path).href,
                                path.join(root, 'scripts/windows-native-pilot-stage.mts'),
                                JSON.stringify({ binding, stage, coverageJSON, ...deadlines }),
                            ],
                            {
                                cwd: root,
                                windowsHide: true,
                                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                                env: { ...environment, HUB_NATIVE_PILOT_STAGE: '1' },
                            },
                        ),
                    (c) =>
                        sendStageCancel(c, {
                            kind: 'cancel-hosted-pilot-stage',
                            nonce,
                            bindingSHA256: o.hash,
                            reason: 'Outer startup cancellation',
                        }),
                );
                const state = {
                    stage,
                    ...deadlines,
                    runtimeReady: false,
                    sequence: 0,
                    final: null,
                    logs: [],
                    streams: { stdout: 0, stderr: 0 },
                };
                stages.set(child, state);
                // Register writable descriptors before opening the next one.
                try {
                    for (const name of ['stdout', 'stderr']) {
                        const entry = {
                            fd: fs.openSync(
                                path.join(out, stage + '-' + name + '.log'),
                                'wx',
                                0o600,
                            ),
                            errors: [],
                            attempted: false,
                            synced: false,
                            closed: false,
                        };
                        state.logs.push(entry);
                        child[name].on('data', (b) => {
                            try {
                                assert(state.streams[name] + b.length <= pilotLimits.streamBytes);
                                reserve(b.length);
                                writeAll(entry.fd, b);
                                fs.fsyncSync(entry.fd);
                                state.streams[name] += b.length;
                            } catch (e) {
                                o.hold(e);
                            }
                        });
                    }
                } catch (e) {
                    o.hold(e);
                    throw e;
                }
                const receiver = pilotEvidenceReceiver({
                    nonce,
                    bindingSHA256: o.hash,
                    stage,
                    state,
                    record,
                    reserve,
                    recordReserved: (s, d) => evidence.append(s, d),
                    send: (m, callback) => child.send(m, callback),
                    hold: (e) => o.hold(e),
                    clock: () => productClock.now(),
                    acceptQueryClosures: (batch) =>
                        startup.acceptQueryClosures(child, batch, binding.runtime.platform),
                });
                child.on('message', receiver.receive);

                return child;
            },
            waitStage: async (child, o) =>
                waitPilotStage({
                    child,
                    startup,
                    state: stages.get(child),
                    signal: early.signal,
                    cancel: (e) => o.cancel(e),
                    hold: (e) => o.hold(e),
                    emit: async (stage, data) => record(stage, data),
                }),
            joinStage: async (child) =>
                joinPilotStage(child, {
                    state: stages.get(child),
                    startup,
                    cancel: (reason) => owner.cancel(reason),
                    observe,
                }),
            recheckInputs: recheck,
            cleanupRoots: async () => {
                clearInterval(timer);
                await startup.join();
                observe('final-before-cleanup');
                paths.check();
                fs.rmSync(privateRoot, { recursive: true });
                return !fs.existsSync(privateRoot);
            },
        });
        return {
            ...result,
            observations: observer.snapshot(),
            winpsContractPassed: contract.passed,
            entryEvidenceClosure: entryClosure,
        };
    } catch (e) {
        if (
            owner &&
            owner.ports.lease.state().created &&
            owner.state !== 'released' &&
            owner.state !== 'held'
        )
            owner.hold(e);
        if (!held && (!owner || !owner.ports.lease.state().created)) {
            if (entryEvidence && !entryEvidence.entry.attempted)
                try {
                    entryRecord('entry-failed', {
                        ...prerequisiteFailure(e, prerequisite),
                        nativeLaunches: 0,
                    });
                } catch (persistence) {
                    hold(
                        { kind: 'pilot-early-evidence-unknown', reason: String(persistence) },
                        () => {},
                    );
                }
            const main = evidence?.close(),
                entry = entryEvidence?.close();
            console.error(
                JSON.stringify({
                    kind: 'pilot-entry-failure',
                    ...prerequisiteFailure(e, prerequisite),
                    mainEvidenceClosure: main ?? null,
                    entryEvidenceClosure: entry ?? null,
                }),
            );
            if ((main && !main.complete) || (entry && !entry.complete))
                hold(
                    { kind: 'pilot-pre-enrollment-evidence-unknown', reason: String(e) },
                    () => {},
                );
        }
        if (held) await held.outcome;
        throw e;
    } finally {
        clearInterval(timer);
        for (const e of ['SIGTERM', 'SIGINT', 'disconnect']) process.off(e, earlyCancel);
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    nativePilotMain()
        .then((r) => {
            console.log(JSON.stringify(r));
            if (!r.passed) process.exitCode = 1;
        })
        .catch((e) => {
            console.error(
                JSON.stringify({
                    kind: 'pilot-top-level-failure',
                    ...prerequisiteFailure(e, 'pre-entry-runtime-gate-or-unhandled'),
                }),
            );
            process.exitCode = 1;
        });
