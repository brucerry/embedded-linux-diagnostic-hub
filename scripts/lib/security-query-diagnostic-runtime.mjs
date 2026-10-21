import assert from 'node:assert/strict';
import {
    requirePreinstalledQueryRuntime,
    admitQueryJobTime,
    requireQueryJobAdmission,
    queryJobLimits,
} from './security-query-job-admission.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {
    acquiredEvidenceIdentity,
    readEvidenceProof,
    requireEvidenceProof,
    sealEvidenceProof,
} from './query-durable-evidence.mjs';
import { currentOwnerStdio } from './security-query-owner-stdio.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
    queryPolicy as policy,
    querySourceRoot,
    parseQueryRequest,
    decodeQueryInputTransport,
    queryHostedContext,
    QueryLifecycle,
    QueryAccounting,
    bindQueryTree,
    verifyQueryInputs,
} from './security-query-diagnostic.mjs';
import { observationInventory } from './observation-accounting.mjs';
import { projectCollectorEnvironment } from './product-collector-environment.mjs';
import { requireLeafEnvironment } from './security-query-leaf-refusal.mjs';
import {
    normalizeQueryOwnerEnvironment,
    assertQueryOwnerEnvironmentAbsent,
} from './security-query-owner-environment.mjs';
import {
    ancestryIdentity,
    checkAncestry,
    fileIdentity,
    metadataIdentity,
    digest,
    refuseMarker,
} from './windows-preflight.mjs';
import { sourceFingerprint } from '../../tests/fixtures/memory-resource-identity.ts';
import { createOwnershipHold, prepareProductLogs } from './product-entry-custody.mjs';
import { ProductLease, RootGuard } from './product-collector-files.mjs';
import { writeAll, closeEntries, boundedRead } from './product-collector-evidence.mjs';
import {
    preparationObservationSecurity,
    collectorObservationSecurity,
} from './observation-security.mjs';
import { runSecurityCommand, firstCollectorSecurityQuery } from './pilot-security-command.mjs';
import { PreparationEvidence } from './observation-preparation-evidence.mjs';
import { PilotEvidence } from './pilot-evidence.mjs';
import { runWinpsSecurityContract } from './pilot-winps-contract.mjs';
const tick = () => Number(process.hrtime.bigint() / 1000000n);
const present = (env) =>
    Object.fromEntries(
        [
            'SystemRoot',
            'WINDIR',
            'TEMP',
            'TMP',
            'USERPROFILE',
            'LOCALAPPDATA',
            'COMSPEC',
            'PSModulePath',
            'PATH',
            'ProgramFiles',
            'ProgramData',
            'PUBLIC',
        ].map((k) => [k, Object.keys(env).some((n) => n.toUpperCase() === k.toUpperCase())]),
    );
function publicSummary(state) {
    try {
        process.stdout.write(
            JSON.stringify({ kind: 'windows-security-query-only', ...state }) + '\n',
        );
    } catch {
        /* Custody is already latched. */
    }
}
function writeReceipt(file, value, { check, admit, hold, io = fs }) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    assert(bytes.length <= 65536);
    check();
    admit(bytes.length);
    let entry, error, proof, syncedProof;
    try {
        entry = { fd: io.openSync(file, 'wx', 0o600), errors: [], attempted: false };
        // Register identity before writes; readers must receive this exact object identity.
        proof = {
            path: file,
            bytes: bytes.length,
            sha256: digest(bytes),
            identity: acquiredEvidenceIdentity(entry.fd, io),
        };
        const options = { maximum: 65536, io, check, writerFD: entry.fd };
        entry.beforeSync = () => {
            syncedProof = sealEvidenceProof(proof, options);
        };
        entry.afterSync = () => {
            readEvidenceProof(syncedProof, options);
        };
        writeAll(entry.fd, bytes, io);
    } catch (e) {
        error = e;
    }
    const closure = closeEntries(entry ? [entry] : [], io);
    try {
        if (error || !closure.complete) throw error ?? Error('Receipt sync/close unknown');
        return sealEvidenceProof(syncedProof, { maximum: 65536, io, check });
    } catch (e) {
        hold({ phase: 'receipt-durability-unknown', closure });
        throw e;
    }
}
function sameTool(file, expected, identity = fileIdentity) {
    assert.deepEqual(identity(file, { pe: expected.pe !== undefined }), expected);
}
/** Install handlers before acquiring descriptors. Never kill/detach a middle owner. */
export function cancellationBoundary(
    life,
    { events = process, child = () => null, set = setTimeout, clear = clearTimeout } = {},
) {
    let notified = false;
    const notify = () => {
        const c = child();
        if (c?.connected && !notified) {
            notified = true;
            try {
                c.send({ kind: 'cancel-query-only' }, (error) => {
                    if (error) life.retain({ phase: 'cancel-delivery-unknown' });
                });
            } catch {
                life.retain({ phase: 'cancel-delivery-unknown' });
            }
        }
    };
    const cancel = (reason) => {
        life.cancel(reason);
        notify();
    };
    const handlers = [
        ['SIGTERM', () => cancel('SIGTERM')],
        ['SIGINT', () => cancel('SIGINT')],
    ];
    for (const [event, fn] of handlers) events.on(event, fn);
    const work = set(
        () => {
            life.closeWork();
            if (!life.leafExited || !life.leafClosed) notify();
        },
        Math.max(0, life.workDeadline - life.tick()),
    );
    const end = set(
        () => life.retain({ phase: 'owner-deadline-unknown' }),
        Math.max(0, life.deadline - life.tick()),
    );
    return {
        cancel,
        dispose() {
            assert(!life.held && life.leafClosed, 'Actual leaf close before watchdog retirement');
            clear(work);
            clear(end);
            for (const [event, fn] of handlers) events.off(event, fn);
        },
    };
}
/** Node exit AND close plus a bound durable receipt are separate obligations. */
export function observeQueryLeaf(
    child,
    { life, logs, record, admit, hold, grant, nonce, check = () => {}, io = fs },
) {
    return new Promise((resolve, reject) => {
        let receipt = null,
            exit = null,
            closed = false,
            error = null,
            request = false;
        const bytes = [0, 0],
            attempted = [0, 0],
            hashes = [createHash('sha256'), createHash('sha256')];
        const syncedRawProofs = [];
        const rawIdentities = logs.map((log) => acquiredEvidenceIdentity(log.fd, io));
        const rawProofs = () =>
            logs.map((log, i) => ({
                path: log.path,
                bytes: bytes[i],
                sha256: hashes[i].copy().digest('hex'),
                identity: rawIdentities[i],
            }));
        const fail = (phase, e) => {
            error ??= e ?? Error(phase);
            life.retain({ phase });
            hold({ phase });
        };
        for (const [index, log] of logs.entries()) {
            const before = log.beforeSync,
                after = log.afterSync;
            const options = { maximum: policy.streamBytes, io, check, writerFD: log.fd };
            log.beforeSync = () => {
                before?.();
                syncedRawProofs[index] = sealEvidenceProof(rawProofs()[index], options);
            };
            log.afterSync = () => {
                after?.();
                readEvidenceProof(syncedRawProofs[index], options);
            };
        }
        for (const [index, stream] of [child.stdout, child.stderr].entries()) {
            if (!stream) {
                fail('leaf-pipe-missing');
                continue;
            }
            stream.on('error', (e) => fail('leaf-pipe-error', e));
            stream.on('data', (data) => {
                try {
                    const b = Buffer.from(data);
                    attempted[index] += b.length;
                    hashes[index].update(b);
                    if (error) return;
                    assert(bytes[index] + b.length <= policy.streamBytes, 'Raw leaf stream cap');
                    check();
                    admit(b.length);
                    writeAll(logs[index].fd, b, io);
                    bytes[index] += b.length;
                } catch (e) {
                    fail('leaf-log-write-unknown', e);
                }
            });
        }
        child.on('message', (m) => {
            try {
                assert(m && m.nonce === nonce, 'Leaf IPC binding');
                if (m.kind === 'query-ready') {
                    assert(!request && !receipt);
                    request = true;
                    life.check({ headroom: policy.queryMs + policy.grantMs });
                    life.admit('target');
                    grant();
                    child.send({ kind: 'query-grant', nonce }, (e) => {
                        if (e) fail('query-grant-delivery-unknown', e);
                    });
                } else if (m.kind === 'query-receipt') {
                    assert(request && !receipt);
                    assert.deepEqual(Object.keys(m).sort(), ['kind', 'nonce', 'receipt'].sort());
                    assert(
                        m.receipt &&
                            Number.isSafeInteger(m.receipt.bytes) &&
                            m.receipt.bytes > 0 &&
                            m.receipt.bytes <= 65536 &&
                            /^[a-f0-9]{64}$/.test(m.receipt.sha256),
                    );
                    requireEvidenceProof(m.receipt, 65536);
                    receipt = m.receipt;
                } else if (m.kind === 'query-held') {
                    fail('leaf-reported-held');
                } else throw Error('Unexpected query IPC');
            } catch (e) {
                fail('leaf-protocol-unknown', e);
            }
        });
        child.on('error', (e) => fail('leaf-process-error', e));
        child.on('exit', (code, signal) => {
            exit = { code, signal };
            life.leafExited = true;
            if (code !== 0 || signal) fail('leaf-exit-refused');
        });
        child.on('close', (code, signal) => {
            closed = true;
            life.leafClosed = true;
            // Attempt each owned descriptor once, even when an earlier stream failed.
            const closure = closeEntries(logs, io);
            let closedRawProofs;
            if (!closure.complete) fail('leaf-log-closure-unknown');
            try {
                closedRawProofs = syncedRawProofs.map((proof) =>
                    sealEvidenceProof(proof, { maximum: policy.streamBytes, io, check }),
                );
                assert(
                    exit &&
                        exit.code === 0 &&
                        !exit.signal &&
                        code === 0 &&
                        !signal &&
                        receipt &&
                        !error &&
                        !life.held,
                    'Leaf exit/pipe/result closure unproved',
                );
                record('leaf-closed', {
                    pid: child.pid,
                    exit,
                    close: { code, signal },
                    rawProofs: closedRawProofs,
                    rawBytes: bytes,
                    rawAttemptedBytes: attempted,
                    rawSHA256: hashes.map((h) => h.copy().digest('hex')),
                    closure,
                    receipt,
                });
                resolve({
                    receipt,
                    closure,
                    rawProofs: closedRawProofs,
                    rawBytes: bytes,
                    exit,
                    closed,
                });
            } catch (e) {
                fail('leaf-result-unproved', e);
                reject(e);
            }
        });
        child.on('disconnect', () => {
            if (!receipt && !closed) fail('leaf-IPC-disconnected-before-receipt');
        });
    });
}
export async function queryOwner(
    { startedAt, environment = process.env, sourceRoot = querySourceRoot } = {},
    ports = {},
) {
    assert.equal((ports.argv ?? process.argv).length, 2, 'Owner accepts no command overrides');
    assert.deepEqual(ports.execArgv ?? process.execArgv, policy.runtimeArgs);
    assert.equal(ports.version ?? process.version, policy.node);
    const request = parseQueryRequest(environment.SECURITY_QUERY_REQUEST_JSON, environment);
    const transportInputs = JSON.parse(environment.SECURITY_QUERY_INPUTS_JSON);
    const canonicalInputs = decodeQueryInputTransport(
        transportInputs,
        environment.SECURITY_QUERY_REQUEST_JSON,
    );
    const context = (ports.context ?? queryHostedContext)(environment);
    const runtimeAdmission = (ports.runtime ?? requirePreinstalledQueryRuntime)(environment);
    const jobTime = await (ports.jobTime ?? admitQueryJobTime)(environment, {
        ownerStartedAt: startedAt,
        now: ports.now ?? tick,
    });
    requireQueryJobAdmission(jobTime.admission, environment, {
        ownerStartedAt: startedAt,
        now: ports.now ?? tick,
    });
    assert.equal(policy.ownerMs, queryJobLimits.ownerMs);
    assert.equal(policy.jobMinutes * 60000, queryJobLimits.outerMs);
    const ownerStdio = ports.ownerStdio ?? currentOwnerStdio();
    assert(ownerStdio, 'Bounded owner capture required');
    let evidence,
        accounting,
        child,
        holdOwner,
        root,
        lease,
        logs = [],
        handlers,
        scanTimer,
        checkTree = () => {},
        cleanup = false,
        finalEvidenceProofs = null;
    const retain = (state, _record, { onRetained = () => {} } = {}) => {
        if (holdOwner) {
            onRetained(holdOwner);
            return holdOwner;
        }
        return (ports.hold ?? createOwnershipHold)(
            {
                kind: 'query-only-custody-held',
                state,
                root,
                marker: lease
                    ? { file: lease.file, created: lease.created, released: lease.released }
                    : null,
                historicalReleaseInferred: false,
            },
            (stage, data) => evidence?.record(stage, data),
            {
                onRetained: (h) => {
                    holdOwner = h;
                    onRetained(h);
                    life.held = true;
                    life.cancel('Custody held');
                    if (scanTimer) clearInterval(scanTimer);
                    publicSummary({
                        state: 'held',
                        phase: String(state.phase ?? 'unknown').slice(0, 128),
                        historicalReleaseInferred: false,
                    });
                },
            },
        );
    };
    const life = new QueryLifecycle(startedAt, { now: ports.now ?? tick, hold: retain });
    const check = () => {
        context.check();
        checkTree();
        requireQueryJobAdmission(jobTime.admission, environment, {
            ownerStartedAt: startedAt,
            now: () => life.tick(),
        });
        life.check({ cleanup });
        accounting?.scan();
    };
    handlers = cancellationBoundary(life, { ...ports.cancellation, child: () => child });
    let final;
    try {
        check();
        verifyQueryInputs(sourceRoot, request);
        assert.equal(
            await (ports.fingerprint ?? sourceFingerprint)(sourceRoot),
            request.sourceSHA256,
        );
        check();
        const powershell = (ports.resolvePowerShell ?? fs.realpathSync)(
            path.win32.join(
                environment.SystemRoot,
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe',
            ),
        );
        assert.equal(
            powershell.toLowerCase(),
            'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe',
        );
        const identity = ports.identity ?? fileIdentity;
        const node = identity(process.execPath),
            ps = identity(powershell, { pe: true }),
            provider = identity(path.join(sourceRoot, 'scripts/lib/hosted-pilot-security.ps1'));
        assert.equal(ps.pe.architecture, 'x64');
        refuseMarker(context.parent);
        root = path.join(
            context.parent,
            'diagnostic-hub-security-query-' + context.host.run + '-1',
        );
        fs.mkdirSync(root, { mode: 0o700 });
        checkTree = bindQueryTree(root);
        for (const name of ['preparation', 'collection', 'contract', 'work', 'outer'])
            fs.mkdirSync(path.join(root, name), { mode: 0o700 });
        accounting = new QueryAccounting(root, context.parent, ports.accounting);
        accounting.reserve();
        const ownerRawGuard = new RootGuard(path.join(root, 'outer'));
        ownerStdio.attach(path.join(root, 'outer'), {
            admit: (n) => accounting.scan(n),
            hold: retain,
            check: () => ownerRawGuard.check(),
        });
        evidence = new PreparationEvidence(path.join(root, 'preparation'), {
            check: () => {
                context.check();
                checkTree();
            },
            admit: (n) => accounting.scan(n),
            hold: retain,
        });
        const record = (stage, data) => evidence.record(stage, data);
        record('query-input-transport', {
            observedKeys: Object.keys(transportInputs).sort(),
            filledEmptyKeys: Object.keys(canonicalInputs)
                .filter((key) => !Object.hasOwn(transportInputs, key))
                .sort(),
            canonicalKeys: Object.keys(canonicalInputs).sort(),
            rawBytes: Buffer.byteLength(environment.SECURITY_QUERY_INPUTS_JSON),
            rawSHA256: digest(environment.SECURITY_QUERY_INPUTS_JSON),
            authority:
                'Actual owner environment projection; not an attestation of submitted event inputs',
        });
        record('job-time-admission', { ...jobTime.admission, runtimeAdmission });
        for (let offset = 0; offset < jobTime.raw.length; offset += 24576)
            record('job-time-metadata', {
                offset,
                bytes: Math.min(24576, jobTime.raw.length - offset),
                base64: jobTime.raw.subarray(offset, offset + 24576).toString('base64'),
            });
        // Only the admitted dedicated owner may change its native process environment.
        // A detached options.env object cannot suppress libuv's native-parent completion.
        const nativeOwnerEnvironment = ports.nativeOwnerEnvironment ?? process.env;
        const ownerEnvironment = normalizeQueryOwnerEnvironment(
            environment,
            nativeOwnerEnvironment,
        );
        context.acceptOwnerEnvironmentNormalization(ownerEnvironment);
        check();
        record('query-only-start', {
            request,
            requestSHA256: digest(environment.SECURITY_QUERY_REQUEST_JSON),
            host: context.host,
            startedAt,
            workDeadline: life.workDeadline,
            deadline: life.deadline,
            policy,
            node,
            ps,
            provider,
            runtimeProfile:
                'Node builtin transform, no npm/tsx/esbuild; differs from original collector loader',
            environmentPresence: present(environment),
            environmentNormalization: ownerEnvironment.flags,
            inventory: { Node: 2, WinPS: 45, parent: 14, contract: 30, target: 1 },
            accounting: accounting.snapshot(),
        });
        const parentQuery = evidence.securityQuery((source, exe, raw, options) => {
            life.admit('parent', { cleanup });
            return (ports.command ?? runSecurityCommand)(source, exe, raw, {
                ...options,
                identity,
                environment,
                spawn: (...args) =>
                    ownerEnvironment.beforeSpawn(
                        () => life.check({ cleanup, headroom: policy.queryMs }),
                        spawnSync,
                        ...args,
                    ),
                onProcessState: (s) => {
                    if (!s.closed) retain({ phase: 'parent-query-unknown', state: s });
                    options.onProcessState?.(s);
                },
            });
        });
        const security = preparationObservationSecurity(
            sourceRoot,
            powershell,
            [context.parent, root, path.join(root, 'collection')].map((p) => ({
                path: p,
                kind: 'directory',
            })),
            { environment, record, check, query: parentQuery },
        );
        const ownerCheck = security.ownerCheck;
        ownerCheck.many(
            ['preparation', 'contract', 'work', 'outer'].map((p) => path.join(root, p)),
        );
        lease = new ProductLease(
            path.join(context.parent, 'diagnostic-hub-v060-check.lock'),
            {
                kind: policy.kind,
                nonce: randomUUID(),
                pid: process.pid,
                root,
                run: context.host.run,
            },
            {
                ownerCheck: (file) => {
                    const value = ownerCheck(file);
                    if (finalEvidenceProofs)
                        for (const proof of finalEvidenceProofs)
                            readEvidenceProof(proof, { maximum: policy.streamBytes, check });
                    return value;
                },
            },
        );
        lease.acquire();
        const contractWorkDeadline = Math.min(life.tick() + 180000, life.workDeadline) - 30000;
        const contract = await (ports.contract ?? runWinpsSecurityContract)(
            {
                sourceRoot,
                outputRoot: path.join(root, 'contract'),
                expectedSourceSHA256: request.sourceSHA256,
                environment,
                outerDeadline: life.workDeadline,
            },
            {
                now: ports.now ?? tick,
                context: { parent: path.join(root, 'work'), host: context.host, check },
                identity,
                fingerprint: ports.fingerprint ?? sourceFingerprint,
                hold: retain,
                command: (...args) => {
                    life.admit('contract');
                    const opts = args[3];
                    return (ports.command ?? runSecurityCommand)(...args.slice(0, 3), {
                        ...opts,
                        identity,
                        spawn: (...values) =>
                            ownerEnvironment.beforeSpawn(
                                () => {
                                    life.check({ headroom: policy.queryMs });
                                    opts.check();
                                    assert(
                                        life.tick() + policy.queryMs < contractWorkDeadline,
                                        'Original contract work and cleanup reserve',
                                    );
                                },
                                spawnSync,
                                ...values,
                            ),
                        onProcessState: (s) => {
                            if (!s.closed) retain({ phase: 'contract-query-unknown' });
                            opts.onProcessState?.(s);
                        },
                    });
                },
                evidenceFactory: (directory) => {
                    let e;
                    try {
                        e = new PilotEvidence(directory, { check });
                    } catch (error) {
                        retain({ phase: 'contract-open-unknown' });
                        throw error;
                    }
                    return {
                        append(stage, data) {
                            try {
                                accounting.scan(
                                    Buffer.byteLength(
                                        JSON.stringify({ sequence: e.rows, stage, data }),
                                    ) + 1,
                                );
                                e.append(stage, data);
                                accounting.scan();
                            } catch (error) {
                                retain({ phase: 'contract-persistence-unknown' });
                                throw error;
                            }
                        },
                        close() {
                            return e.close();
                        },
                    };
                },
            },
        );
        life.contract(contract);
        check();
        record('fresh-contract-closed', {
            passed: contract.passed,
            casesPassed: contract.casesPassed,
            casesRequired: contract.casesRequired,
            cleanup: contract.cleanup,
            evidenceClosure: contract.evidenceClosure,
        });
        const guard = new RootGuard(path.join(root, 'outer'), { ownerCheck });
        logs = prepareProductLogs(guard, ['leaf.stdout.log', 'leaf.stderr.log']);
        for (const log of logs) {
            const file = (log.path = path.join(guard.root, log.name)),
                opened = fs.fstatSync(log.fd);
            const verify = () => {
                guard.check(file);
                const current = fs.lstatSync(file),
                    descriptor = fs.fstatSync(log.fd);
                assert(current.isFile() && !current.isSymbolicLink() && current.nlink === 1);
                for (const k of ['dev', 'ino', 'uid'])
                    assert(
                        current[k] === opened[k] && descriptor[k] === opened[k],
                        'Leaf raw file rebound',
                    );
                assert.equal(current.size, descriptor.size);
            };
            log.beforeSync = verify;
            log.afterSync = verify;
        }

        ownerCheck.many([
            ...logs.map((l) => path.join(root, 'outer', l.name)),
            ...ownerStdio.names().map((n) => path.join(root, 'outer', n)),
        ]);
        ownerCheck(path.join(root, 'collection'));
        lease.check();
        assert.equal(
            await (ports.fingerprint ?? sourceFingerprint)(sourceRoot),
            request.sourceSHA256,
        );
        verifyQueryInputs(sourceRoot, request);
        sameTool(process.execPath, node, identity);
        sameTool(powershell, ps, identity);
        sameTool(provider.path, provider, identity);
        check();
        // The normal collector whitelist, without profile/token/full-pair capabilities.
        const childPATH = path.dirname(node.path) + ';' + path.dirname(ps.path);
        const childEnvironment = projectCollectorEnvironment(environment, childPATH);
        const nonce = randomUUID();
        const binding = {
            schema: 1,
            kind: policy.kind,
            nonce,
            ownerPID: process.pid,
            host: context.host,
            request,
            requestSHA256: digest(environment.SECURITY_QUERY_REQUEST_JSON),
            sourceRoot,
            outputRoot: path.join(root, 'collection'),
            canonicalTmp: context.parent,
            rootIdentity: metadataIdentity(root),
            outputIdentity: metadataIdentity(path.join(root, 'collection')),
            tempIdentity: metadataIdentity(context.parent),
            node,
            ps,
            provider,
            principalSID: security.initial.principal,
            outputRootSDDLSHA256: security.descriptors.get(path.join(root, 'collection')),
            canonicalTmpSDDLSHA256: security.descriptors.get(context.parent),
            contractSHA256: digest(
                boundedRead(
                    path.join(root, 'contract', 'pilot.jsonl'),
                    policy.contractEvidenceBytes,
                ),
            ),
            ownerStartedAt: startedAt,
            ownerWorkDeadline: life.workDeadline,
            ownerDeadline: life.deadline,
            childPATH,
        };
        const bindingReceipt = writeReceipt(path.join(root, 'binding.json'), binding, {
            check,
            admit: (n) => accounting.scan(n),
            hold: retain,
        });
        record('leaf-binding', {
            ...bindingReceipt,
            nonce,
            childEnvironmentPresence: present(childEnvironment),
            credentialForwarded: false,
            loader: '--experimental-transform-types',
            cwd: sourceRoot,
        });
        accounting.reserve();
        life.admit('node');
        child = ownerEnvironment.beforeSpawn(
            check,
            ports.spawn ?? spawn,
            process.execPath,
            [
                ...policy.runtimeArgs,
                path.join(sourceRoot, 'scripts/windows-security-query-diagnostic.mjs'),
                '--leaf',
                bindingReceipt.path,
                JSON.stringify(bindingReceipt),
            ],
            {
                cwd: sourceRoot,
                env: childEnvironment,
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            },
        );
        // Observe before any post-spawn persistence can throw and lose pipe/exit custody.
        const observing = observeQueryLeaf(child, {
            life,
            logs,
            record,
            admit: (n) => accounting.scan(n),
            hold: retain,
            nonce,
            check: () => {
                context.check();
                checkTree();
                guard.check();
                accounting.scan();
            },
            grant: () => {
                check();
                record('target-grant', {
                    atMs: life.tick(),
                    workDeadline: life.workDeadline,
                    grantMs: policy.grantMs,
                    queryMs: policy.queryMs,
                });
            },
        });
        observing.catch(() => {});
        record('leaf-spawned', { pid: child.pid ?? null, ownerPID: process.pid });
        scanTimer = setInterval(() => {
            if (life.held) return;
            try {
                context.check();
                checkTree();
                accounting.scan();
            } catch (error) {
                life.retain({ phase: 'accounting-or-custody-poll-failed' });
                if (child?.connected)
                    try {
                        child.send({ kind: 'cancel-query-only' }, () => {});
                    } catch {}
            }
        }, 100);
        const observed = await observing;
        clearInterval(scanTimer);
        cleanup = true;
        check();
        ownerCheck.many([root, path.join(root, 'collection'), path.join(root, 'outer')]);
        ownerCheck.many([
            ...logs.map((l) => path.join(root, 'outer', l.name)),
            ...ownerStdio.names().map((n) => path.join(root, 'outer', n)),
        ]);
        const resultFile = path.join(root, 'leaf-result.json'),
            raw = readEvidenceProof(observed.receipt, { maximum: 65536, check });
        assert.equal(observed.receipt.path, resultFile);
        assert.equal(observed.receipt.bytes, raw.length);
        assert.equal(observed.receipt.sha256, digest(raw));
        const result = JSON.parse(raw);
        assert.equal(result.kind, policy.kind);
        assert.equal(result.nonce, nonce);
        assert.equal(result.requestSHA256, binding.requestSHA256);
        assert.equal(result.passed, true);
        assert.equal(result.targetQueries, 1);
        assert.equal(result.providerProcessClosedByExistingRule, true);
        assert.equal(result.actualWinpsExitOrPipeCloseObserved, false);
        assert.equal(result.evidenceClosed, true);
        assert.equal(
            await (ports.fingerprint ?? sourceFingerprint)(sourceRoot),
            request.sourceSHA256,
        );
        verifyQueryInputs(sourceRoot, request);
        sameTool(process.execPath, node, identity);
        sameTool(ps.path, ps, identity);
        sameTool(provider.path, provider, identity);
        ownerStdio.check();
        const ownerRawClosure = ownerStdio.close(closeEntries);
        finalEvidenceProofs = [
            ...observed.rawProofs,
            ...ownerStdio.proofs(),
            observed.receipt,
            bindingReceipt,
        ];
        for (const proof of finalEvidenceProofs)
            readEvidenceProof(proof, { maximum: policy.streamBytes, check });
        record('query-only-complete', {
            ownerRawClosure,
            ownerRaw: ownerStdio.snapshot(),
            result,
            counts: life.counts,
            accounting: accounting.snapshot(),
            historicalReleaseInferred: false,
        });
        assert(evidence.complete());
        const proof = life.proof({
            logsClosed: observed.closure.complete && ownerRawClosure.complete,
            receiptClosed: true,
            inputsUnchanged: true,
            evidenceClosed: true,
        });
        lease.release(proof);
        assert.equal(life.counts.parent, policy.parentQueries);
        assert(!fs.existsSync(lease.file));
        final = {
            kind: policy.kind,
            state: 'released',
            passed: true,
            counts: life.counts,
            historicalReleaseInferred: false,
        };
        // All required durable evidence precedes lease release. Stdout is the post-release receipt.
        handlers.dispose();
        ownerStdio.restore?.();
        publicSummary(final);
        return final;
    } catch (error) {
        logs = error.preparedLogs ?? logs;
        const closure = closeEntries([...logs, ...ownerStdio.entries()]);
        retain({ phase: 'query-owner-failed', error: String(error).slice(0, 1024), closure });
        if (child?.connected)
            try {
                child.send({ kind: 'cancel-query-only' }, () => {});
            } catch {
                /* Hold already latched. */
            }
        await holdOwner.outcome;
        throw error;
    }
}
/** Inherited environment is the exact shared projection. No production entry/controller is run. */
export async function queryLeaf(args, ports = {}) {
    assert.deepEqual(process.execArgv, policy.runtimeArgs);
    assert.equal(process.version, policy.node);
    assert.equal(ports.platform ?? process.platform, 'win32');
    assert.equal(ports.arch ?? process.arch, 'x64');
    assert.equal(args.length, 2);
    const [file, receiptJSON] = args;
    assert(Buffer.byteLength(receiptJSON) <= 4096);
    const bindingProof = requireEvidenceProof(JSON.parse(receiptJSON), 65536);
    assert.equal(bindingProof.path, file);
    const bytes = readEvidenceProof(bindingProof, { maximum: 65536 });
    const b = JSON.parse(bytes),
        root = path.dirname(file);
    assert.equal(file, path.join(root, 'binding.json'));
    assert.equal(b.kind, policy.kind);
    assert.equal(b.schema, 1);
    assert.equal(b.ownerPID, process.ppid);
    assert.equal(process.connected, true);
    assert.equal(process.cwd(), b.sourceRoot);
    assert.equal(b.sourceRoot, querySourceRoot);
    assert.equal(b.outputRoot, path.join(root, 'collection'));
    assert.equal(
        root,
        path.join(
            b.canonicalTmp,
            'diagnostic-hub-security-query-' + process.env.GITHUB_RUN_ID + '-1',
        ),
    );
    assert.equal(b.host.commit, process.env.GITHUB_SHA);
    assert.equal(b.host.repository, process.env.GITHUB_REPOSITORY);
    assert.equal(b.host.attempt, process.env.GITHUB_RUN_ATTEMPT);
    assert.equal(b.host.attempt, '1');
    assert.equal(b.host.run, process.env.GITHUB_RUN_ID);
    requireLeafEnvironment(process.env, b.childPATH, (row) => process.stderr.write(row));
    assert(process.env.PATH === b.childPATH, 'Leaf PATH binding');
    let held,
        cancelled = false,
        queried = 0;
    const ancestors = ancestryIdentity(root);
    const retain = (state, record = () => {}, { onRetained = () => {} } = {}) => {
        if (held) {
            onRetained(held);
            return held;
        }
        return (ports.hold ?? createOwnershipHold)(
            { kind: 'query-only-leaf-held', state },
            (stage, data) => {
                record(stage, data);
                writeReceipt(
                    path.join(root, 'leaf-held.json'),
                    { kind: policy.kind, stage, data },
                    {
                        check: () => checkAncestry(ancestors),
                        admit: (n) => {
                            assert(observationInventory(root).bytes + n <= policy.evidenceBytes);
                        },
                        hold: () => {},
                    },
                );
            },
            {
                onRetained: (h) => {
                    held = h;
                    onRetained(h);
                    try {
                        process.send({ kind: 'query-held', nonce: b.nonce }, () => {});
                    } catch {}
                    publicSummary({
                        state: 'held',
                        phase: String(state.phase ?? 'unknown').slice(0, 128),
                    });
                },
            },
        );
    };
    const check = () => {
        assert(!held && !cancelled && process.connected, 'Leaf custody/cancellation');
        checkAncestry(ancestors);
        for (const [p, old] of [
            [root, b.rootIdentity],
            [b.outputRoot, b.outputIdentity],
            [b.canonicalTmp, b.tempIdentity],
        ]) {
            const current = metadataIdentity(p);
            for (const k of ['path', 'realpath', 'directory', 'file', 'dev', 'ino'])
                assert.equal(current[k], old[k]);
        }
        readEvidenceProof(bindingProof, { maximum: 65536, check: () => checkAncestry(ancestors) });
    };
    const cancel = () => {
        cancelled = true;
    };
    const disconnected = () => {
        cancelled = true;
        retain({ phase: 'leaf-disconnected' });
    };
    process.on('SIGTERM', cancel);
    process.on('SIGINT', cancel);
    process.on('disconnect', disconnected);
    const admit = (n) => {
        const census = observationInventory(root);
        assert(
            census.bytes + n <= policy.evidenceBytes &&
                census.bytes + n <= policy.treeBytes &&
                census.files.size <= policy.files,
            'Leaf aggregate evidence',
        );
        const s = fs.statfsSync(b.canonicalTmp, { bigint: true });
        assert(Number(s.bavail * s.bsize) >= policy.stopFreeBytes);
    };
    try {
        check();
        verifyQueryInputs(b.sourceRoot, b.request);
        assert.equal(
            await (ports.fingerprint ?? sourceFingerprint)(b.sourceRoot),
            b.request.sourceSHA256,
        );
        check();
        sameTool(process.execPath, b.node, ports.identity);
        sameTool(b.ps.path, b.ps, ports.identity);
        sameTool(b.provider.path, b.provider, ports.identity);
        assert.equal(
            digest(
                boundedRead(
                    path.join(root, 'contract', 'pilot.jsonl'),
                    policy.contractEvidenceBytes,
                ),
            ),
            b.contractSHA256,
        );
        // These reads confirm same-parent lease custody; they do not run ACL helpers.
        const marker = JSON.parse(
            boundedRead(path.join(b.canonicalTmp, 'diagnostic-hub-v060-check.lock'), 4096),
        );
        assert.equal(marker.pid, b.ownerPID);
        assert.equal(marker.root, root);
        assert.equal(marker.kind, policy.kind);
        const asked = tick();
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                process.off('message', message);
                reject(Error('Query grant deadline'));
            }, policy.grantMs);
            function message(m) {
                if (m?.kind === 'cancel-query-only') {
                    cancelled = true;
                    return;
                }
                clearTimeout(timeout);
                process.off('message', message);
                try {
                    assert.deepEqual(m, { kind: 'query-grant', nonce: b.nonce });
                    assert(tick() - asked < policy.grantMs);
                    check();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }
            process.on('message', message);
            process.send({ kind: 'query-ready', nonce: b.nonce }, (e) => {
                if (e) {
                    clearTimeout(timeout);
                    process.off('message', message);
                    reject(e);
                }
            });
        });
        process.on('message', (m) => {
            if (m?.kind === 'cancel-query-only') cancelled = true;
            else {
                cancelled = true;
                retain({ phase: 'leaf-unexpected-IPC' });
            }
        });
        const factory = firstCollectorSecurityQuery({ outputRoot: b.outputRoot, diagnostic: true });
        const query = (...values) => {
            assert.equal(queried, 0);
            check();
            admit(policy.queryBytes + policy.terminalBytes + policy.holdBytes);
            assert(tick() - asked < policy.grantMs, 'Grant delivery plus local admission window');
            queried++;
            return factory(...values.slice(0, 3), {
                ...values[3],
                ...ports.queryOptions,
                environment: process.env,
                timeout: policy.queryMs,
                spawn: (...launch) => {
                    assertQueryOwnerEnvironmentAbsent(process.env);
                    assert(process.env.PATH === b.childPATH, 'Leaf PATH binding');
                    check();
                    assert(
                        tick() - asked < policy.grantMs,
                        'Grant expired before actual provider spawn',
                    );
                    return (ports.queryOptions?.spawn ?? spawnSync)(...launch);
                },
            });
        };
        const ownerCheck = collectorObservationSecurity({ ...b, powershell: b.ps }, b.sourceRoot, {
            query,
            retainOwnership: retain,
            prerequisiteRoots: [],
            admit,
            check,
        });
        ownerCheck(b.outputRoot);
        check();
        assert.equal(queried, 1);
        const result = {
            schema: 1,
            kind: policy.kind,
            nonce: b.nonce,
            requestSHA256: b.requestSHA256,
            passed: true,
            targetQueries: queried,
            providerProcessClosedByExistingRule: true,
            actualWinpsExitOrPipeCloseObserved: false,
            evidenceClosed: true,
            clock: { leafAskedAtMs: asked, leafReturnedAtMs: tick(), ownerClockIsSeparate: true },
            normalGC: true,
        };
        const receipt = writeReceipt(path.join(root, 'leaf-result.json'), result, {
            check,
            admit,
            hold: retain,
        });
        await new Promise((resolve, reject) =>
            process.send({ kind: 'query-receipt', nonce: b.nonce, receipt }, (e) =>
                e ? reject(e) : resolve(),
            ),
        );
        process.off('SIGTERM', cancel);
        process.off('SIGINT', cancel);
        // IPC close permits normal Node exit only after durable result and closed query records.
        process.off('disconnect', disconnected);
        process.disconnect();
    } catch (error) {
        retain({ phase: 'leaf-query-failed', error: String(error).slice(0, 1024) });
        await held.outcome;
        throw error;
    }
}
export { writeReceipt };
