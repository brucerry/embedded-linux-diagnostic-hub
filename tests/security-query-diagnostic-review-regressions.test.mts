// @ts-nocheck
import test from 'node:test';
import {
    fixtureJobEnvironment,
    fixtureRuntime,
    fixtureJobTime,
} from './fixtures/security-query-job-admission.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
    queryOwner,
    writeReceipt,
    cancellationBoundary,
} from '../scripts/lib/security-query-diagnostic-runtime.mjs';
import {
    QueryLifecycle,
    queryPolicy as policy,
    oldQueryInputs,
    querySourceRoot as sourceRoot,
    bindQueryTree,
} from '../scripts/lib/security-query-diagnostic.mjs';
import { readEvidenceProof } from '../scripts/lib/query-durable-evidence.mjs';
import { ownerStdioCapture } from '../scripts/lib/security-query-owner-stdio.mjs';
import { runSecurityCommand } from '../scripts/lib/pilot-security-command.mjs';
import {
    runWinpsSecurityContract,
    winpsContractCases,
} from '../scripts/lib/pilot-winps-contract.mjs';
import { modelReply, identity, exe } from './fixtures/security-query-diagnostic-model.mjs';
import { sourceFingerprint } from './fixtures/memory-resource-identity.ts';
import { digest } from '../scripts/lib/product-collector-evidence.mjs';
const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-query61-review-')));
const mutate = (file, kind) => {
    if (kind === 'append') fs.appendFileSync(file, 'UNOBSERVED-APPEND');
    else if (kind === 'truncate') fs.truncateSync(file, 1);
    else if (kind === 'overwrite') fs.writeFileSync(file, 'BAD');
    else if (kind === 'replace') {
        fs.renameSync(file, file + '.original');
        fs.writeFileSync(file, 'raw');
    }
};
/** Actual owner, actual contract and security adapters, controlled in-memory child.
 * No OS child/provider process and no production referenced hold/timer is used. */
async function ownerCase({ mutation, when = 'before-close', cleanupCutoff = false } = {}) {
    const tmp = temp(),
        request = {
            schema: 1,
            kind: policy.kind,
            repository: 'brucerry/embedded-linux-diagnostic-hub',
            ref: 'refs/heads/validation/windows-metadata-3577982-20261018',
            commit: 'a'.repeat(40),
            sourceSHA256: await sourceFingerprint(sourceRoot),
            policySHA256: digest(
                fs.readFileSync(
                    path.join(sourceRoot, 'scripts/lib/security-query-diagnostic-policy.json'),
                ),
            ),
            workflowSHA256: digest(
                fs.readFileSync(path.join(sourceRoot, '.github/workflows/windows-portable.yml')),
            ),
            lockfileSHA256: digest(fs.readFileSync(path.join(sourceRoot, 'package-lock.json'))),
            diagnostic: true,
        };
    const raw = JSON.stringify(request),
        environment = {
            ...fixtureJobEnvironment,
            GITHUB_SHA: request.commit,
            GITHUB_REF: request.ref,
            GITHUB_REPOSITORY: request.repository,
            GITHUB_RUN_ID: '123456',
            GITHUB_RUN_ATTEMPT: '1',
            SystemRoot: 'C:\\Windows',
            TEMP: tmp,
            TMP: tmp,
            SECURITY_QUERY_REQUEST_JSON: raw,
            SECURITY_QUERY_INPUTS_JSON: JSON.stringify({
                ...oldQueryInputs,
                windows_security_query_only: true,
                security_query_request_json: raw,
            }),
        };
    const owned = path.join(tmp, 'diagnostic-hub-security-query-123456-1'),
        file = path.join(owned, 'outer', 'leaf.stdout.log');
    let inContract = false,
        index = 0,
        held = false,
        parentCalls = 0,
        grants = 0,
        now = 100;
    const callbacks = [],
        cases = winpsContractCases(['a', 'b'], 'f', 'm');
    try {
        const running = queryOwner(
            { startedAt: 100, environment, sourceRoot },
            {
                now: () => now,
                ownerStdio: ownerStdioCapture(),
                runtime: fixtureRuntime,
                jobTime: fixtureJobTime,
                argv: ['node', 'entry'],
                execArgv: policy.runtimeArgs,
                version: policy.node,
                cancellation: {
                    events: new EventEmitter(),
                    set(fn) {
                        callbacks.push(fn);
                        return fn;
                    },
                    clear() {},
                },
                accounting: { free: () => 3 * 1024 ** 3 },
                identity,
                resolvePowerShell: () => exe,
                context: () => ({
                    parent: tmp,
                    host: {
                        run: '123456',
                        commit: request.commit,
                        repository: request.repository,
                        attempt: '1',
                        actor: 'brucerry',
                    },
                    check() {},
                }),
                command(source, powershell, raw, opts) {
                    const expected = inContract ? cases[index++].expected : 'green';
                    if (!inContract) {
                        parentCalls++;
                        if (cleanupCutoff && parentCalls === 11) {
                            now = 100 + policy.ownerMs - policy.cleanupMs + 1;
                            callbacks[0]();
                        }
                        if (mutation && when === 'release-query' && parentCalls === 14)
                            mutate(file, mutation);
                    }
                    return runSecurityCommand(source, powershell, raw, {
                        ...opts,
                        identity,
                        spawn() {
                            return {
                                pid: 321,
                                status: expected === 'green' ? 0 : 1,
                                signal: null,
                                stdout: JSON.stringify(
                                    modelReply({ plans: JSON.parse(raw), expected }),
                                ),
                                stderr: '',
                            };
                        },
                    });
                },
                async contract(opts, ports) {
                    inContract = true;
                    try {
                        return await runWinpsSecurityContract(opts, {
                            ...ports,
                            resolvePowerShell: () => exe,
                        });
                    } finally {
                        inContract = false;
                    }
                },
                spawn(_executable, args) {
                    const binding = JSON.parse(fs.readFileSync(args.at(-2), 'utf8'));
                    const c = Object.assign(new EventEmitter(), {
                        pid: 123456,
                        connected: true,
                        stdout: new PassThrough(),
                        stderr: new PassThrough(),
                        send(message, cb) {
                            cb?.();
                            if (message.kind !== 'query-grant') return;
                            grants++;
                            queueMicrotask(() => {
                                const receipt = writeReceipt(
                                    path.join(owned, 'leaf-result.json'),
                                    {
                                        schema: 1,
                                        kind: policy.kind,
                                        nonce: binding.nonce,
                                        requestSHA256: binding.requestSHA256,
                                        passed: true,
                                        targetQueries: 1,
                                        providerProcessClosedByExistingRule: true,
                                        actualWinpsExitOrPipeCloseObserved: false,
                                        evidenceClosed: true,
                                    },
                                    {
                                        check() {},
                                        admit() {},
                                        hold() {
                                            assert.fail('receipt unexpected hold');
                                        },
                                    },
                                );
                                c.stdout.write('raw');
                                if (mutation && when === 'before-close') mutate(file, mutation);
                                c.emit('message', {
                                    kind: 'query-receipt',
                                    nonce: binding.nonce,
                                    receipt,
                                });
                                c.emit('exit', 0, null);
                                c.stdout.end();
                                c.stderr.end();
                                c.emit('close', 0, null);
                                if (mutation && when === 'after-close') mutate(file, mutation);
                            });
                        },
                    });
                    setImmediate(() =>
                        c.emit('message', { kind: 'query-ready', nonce: binding.nonce }),
                    );
                    return c;
                },
                hold(state, record, { onRetained }) {
                    held = true;
                    const h = { outcome: Promise.resolve() };
                    onRetained(h);
                    try {
                        record('ownership-held.json', state);
                    } catch {}
                    return h;
                },
            },
        );
        if (mutation) {
            await assert.rejects(running);
            assert(held, 'Mutated evidence must retain custody');
            assert(fs.existsSync(path.join(tmp, 'diagnostic-hub-v060-check.lock')));
            assert.equal(grants, 1);
            assert(parentCalls <= 14);
            assert(!fs.existsSync(path.join(owned, 'collection', 'collector')));
        } else {
            const result = await running;
            assert.equal(result.state, 'released');
            assert.equal(held, false);
            assert.equal(parentCalls, 14);
            assert.equal(index, 30);
            assert.equal(grants, 1);
            assert(!fs.existsSync(path.join(tmp, 'diagnostic-hub-v060-check.lock')));
        }
    } finally {
        // All child/timer/holds in this fixture are models; no production disposal or release inferred.
        fs.rmSync(tmp, { recursive: true });
    }
}
for (const mutation of ['append', 'truncate', 'overwrite', 'replace'])
    for (const when of ['before-close', 'after-close', 'release-query'])
        test('F1 actual owner retains ' + mutation + ' ' + when, () =>
            ownerCase({ mutation, when }),
        );
test('F3 actual owner completes positive cleanup after scheduled work cutoff without deadline extension', () =>
    ownerCase({ cleanupCutoff: true }));

for (const phase of ['write', 'sync', 'close'])
    for (const change of ['replacement', 'same-length-overwrite'])
        test(
            'F2 receipt ' +
                change +
                ' during ' +
                phase +
                ' retains the exact writer identity/durability',
            () => {
                const dir = temp(),
                    file = path.join(dir, 'receipt.json'),
                    check = bindQueryTree(dir);
                let held = 0,
                    writerFD,
                    writerCloses = 0,
                    writerOpen = false,
                    changed = false;
                const alter = () => {
                    if (changed) return;
                    changed = true;
                    if (change === 'replacement') {
                        fs.renameSync(file, file + '.original');
                        fs.writeFileSync(file, '{"value":1}\n');
                    } else fs.writeFileSync(file, '{"value":2}\n');
                };
                const io = {
                    ...fs,
                    openSync(...args) {
                        const fd = fs.openSync(...args);
                        if (args[1] === 'wx') {
                            writerFD = fd;
                            writerOpen = true;
                        }
                        return fd;
                    },
                    writeSync(...args) {
                        const n = fs.writeSync(...args);
                        if (phase === 'write' && args[0] === writerFD) alter();
                        return n;
                    },
                    fsyncSync(fd) {
                        fs.fsyncSync(fd);
                        if (phase === 'sync' && fd === writerFD) alter();
                    },
                    closeSync(fd) {
                        fs.closeSync(fd);
                        if (fd === writerFD && writerOpen) {
                            writerOpen = false;
                            writerCloses++;
                            if (phase === 'close') alter();
                        }
                    },
                };
                try {
                    assert.throws(() =>
                        writeReceipt(
                            file,
                            { value: 1 },
                            {
                                io,
                                check,
                                admit() {},
                                hold() {
                                    held++;
                                },
                            },
                        ),
                    );
                    assert(held > 0);
                    assert.equal(writerCloses, 1);
                } finally {
                    fs.rmSync(dir, { recursive: true });
                }
            },
        );
test('F2 later receipt consumer refuses identical replacement inode and same-inode identical unsynced rewrite', () => {
    for (const change of ['replacement', 'identical-rewrite']) {
        const d = temp(),
            file = path.join(d, 'receipt.json');
        try {
            const proof = writeReceipt(
                file,
                { value: 1 },
                {
                    check: bindQueryTree(d),
                    admit() {},
                    hold() {
                        assert.fail('unexpected');
                    },
                },
            );
            if (change === 'replacement') {
                fs.renameSync(file, file + '.old');
                fs.writeFileSync(file, '{"value":1}\n');
            } else fs.writeFileSync(file, '{"value":1}\n');
            assert.throws(() =>
                readEvidenceProof(proof, { maximum: 65536, check: bindQueryTree(d) }),
            );
        } finally {
            fs.rmSync(d, { recursive: true });
        }
    }
});
function closedLife() {
    let now = 100;
    const callbacks = [],
        sent = [],
        holds = [];
    const life = new QueryLifecycle(now, { now: () => now, hold: (r) => holds.push(r) });
    life.contractClosed = true;
    life.targetAdmitted = true;
    life.leafExited = true;
    life.leafClosed = true;
    const events = new EventEmitter(),
        boundary = cancellationBoundary(life, {
            events,
            child: () => ({ connected: true, send: (m) => sent.push(m) }),
            set: (fn) => {
                callbacks.push(fn);
                return fn;
            },
            clear() {},
        });
    return { life, callbacks, sent, holds, events, boundary, set: (n) => (now = n) };
}
test('F3 scheduled work closure preserves only cleanup helpers; hard deadline and exact10s headroom remain', () => {
    const f = closedLife();
    f.set(f.life.workDeadline + 1);
    f.callbacks[0]();
    assert.equal(f.life.cancelled, null);
    assert(f.life.workClosed);
    assert.equal(f.sent.length, 0);
    assert.doesNotThrow(() => f.life.admit('parent', { cleanup: true }));
    for (const kind of ['parent', 'contract', 'node', 'target'])
        assert.throws(() => f.life.admit(kind));
    for (const kind of ['contract', 'node', 'target'])
        assert.throws(() => f.life.admit(kind, { cleanup: true }));
    f.set(f.life.deadline - policy.queryMs);
    assert.throws(() => f.life.admit('parent', { cleanup: true }));
    f.set(f.life.deadline);
    assert.throws(() =>
        f.life.proof({
            logsClosed: true,
            receiptClosed: true,
            inputsUnchanged: true,
            evidenceClosed: true,
        }),
    );
    f.callbacks[1]();
    assert(f.life.held);
    assert.equal(f.holds.length, 1);
});
for (const reason of ['SIGTERM', 'SIGINT'])
    test('F3 external ' + reason + ' still forbids cleanup and release', () => {
        const f = closedLife();
        f.set(f.life.workDeadline + 1);
        f.callbacks[0]();
        f.events.emit(reason);
        assert.equal(f.life.cancelled, reason);
        assert.throws(() => f.life.admit('parent', { cleanup: true }));
        assert.throws(() =>
            f.life.proof({
                logsClosed: true,
                receiptClosed: true,
                inputsUnchanged: true,
                evidenceClosed: true,
            }),
        );
        assert.equal(f.sent.length, 1);
    });
test('F3 work cutoff with unclosed leaf cancels by IPC, permits no cleanup helper, and never kills', () => {
    const f = closedLife();
    f.life.leafClosed = false;
    f.set(f.life.workDeadline);
    f.callbacks[0]();
    assert.equal(f.sent.length, 1);
    assert.equal(f.life.cancelled, null);
    assert.throws(() => f.life.admit('parent', { cleanup: true }));
    f.life.retain({ phase: 'unknown' });
    assert.throws(() => f.life.check({ cleanup: true }));
});
test('F2 read-handle close uncertainty retains before reporting and never retries an acquisition', () => {
    const dir = temp(),
        file = path.join(dir, 'receipt.json');
    const open = new Map(),
        closed = [];
    let ordinal = 0,
        holds = 0;
    const io = {
        ...fs,
        openSync(...args) {
            const fd = fs.openSync(...args);
            open.set(fd, { ordinal: ++ordinal, writer: args[1] === 'wx' });
            return fd;
        },
        closeSync(fd) {
            const entry = open.get(fd);
            assert(entry);
            open.delete(fd);
            fs.closeSync(fd);
            closed.push(entry.ordinal);
            if (!entry.writer)
                throw Error('controlled read-close outcome unknown after actual local closure');
        },
    };
    try {
        assert.throws(() =>
            writeReceipt(
                file,
                { value: 1 },
                {
                    io,
                    check: bindQueryTree(dir),
                    admit() {},
                    hold() {
                        holds++;
                    },
                },
            ),
        );
        assert(holds > 0);
        assert.equal(open.size, 0);
        assert.equal(new Set(closed).size, closed.length);
        assert.equal(closed.length, 2);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
