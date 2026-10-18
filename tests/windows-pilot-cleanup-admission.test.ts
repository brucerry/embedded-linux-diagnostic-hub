// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import { runHostedPilot, joinPilotStage } from '../scripts/lib/hosted-pilot-run.mjs';
import { waitPilotStage } from '../scripts/lib/pilot-runtime-startup.mjs';
import { pilotLimits, bindingDigest } from '../scripts/lib/hosted-pilot-contract.mjs';
const h = 'a'.repeat(64),
    nonce = '9536ac3c-b0ea-44dc-a4b6-9b1feec7975e';
function binding() {
    return {
        schema: 1,
        kind: 'windows-hosted-native-readiness-pilot-v1',
        collectionApproval: false,
        host: {
            repository: 'brucerry/embedded-linux-diagnostic-hub',
            attempt: '1',
            run: '39110250748',
            commit: 'a'.repeat(40),
            environment: 'github-hosted',
        },
        nonce,
        principalSID: 'S-1-5-21-1-2-3-500',
        sourceSHA256: h,
        coveragePolicySHA256: h,
        pilotPolicySHA256: h,
        dependenciesSHA256: h,
        runtime: {
            platform: 'win32',
            arch: 'x64',
            ...Object.fromEntries(
                [
                    'node',
                    'tsx',
                    'electron',
                    'powershell',
                    'git',
                    'bash',
                    'cygpath',
                    'winptyDll',
                    'winptyAgent',
                ].map((k) => [
                    k,
                    {
                        path: 'C:\\runtime\\' + k,
                        sha256: h,
                        ...(k === 'node'
                            ? { version: 'v24.22.0' }
                            : k === 'electron'
                              ? { version: '44.5.1' }
                              : {}),
                    },
                ]),
            ),
        },
        roots: Object.fromEntries(
            ['canonicalTemp', 'privateRoot', 'evidenceRoot'].map((k, i) => [
                k,
                {
                    path:
                        k === 'privateRoot'
                            ? 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\diagnostic-hub-native-pilot-' +
                              nonce
                            : k === 'canonicalTemp'
                              ? 'C:\\Users\\runneradmin\\AppData\\Local\\Temp'
                              : 'D:\\a\\report',
                    dev: '1',
                    ino: String(i + 1),
                    ...(k === 'evidenceRoot' ? { identitySHA256: h } : { descriptorSHA256: h }),
                },
            ]),
        ),
        startedAt: 0,
        deadline: 600000,
        limits: pilotLimits,
    };
}

const now = () => Number(process.hrtime.bigint() / 1000000n);
function receipt(fault, stage) {
    if (fault === 'missing-final') return null;
    const value = {
        stage,
        passed: false,
        startup: { complete: true },
        descendantsClosed: true,
        leafReceiptsClosed: true,
    };
    if (fault === 'missing-startup') delete value.startup;
    if (fault === 'incomplete-startup') value.startup.complete = false;
    if (fault === 'missing-descendant') delete value.descendantsClosed;
    if (fault === 'incomplete-descendant') value.descendantsClosed = false;
    if (fault === 'missing-leaf') delete value.leafReceiptsClosed;
    if (fault === 'incomplete-leaf') value.leafReceiptsClosed = false;
    if (fault === 'wrong-stage') value.stage = 'native-electron-store';
    if (fault === 'passed-final' || fault === 'before-second') value.passed = true;
    return value;
}
async function composed({ fault = 'missing-final', exit = 'watchdog' } = {}) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-pilot-cleanup-')),
        privateRoot = path.join(dir, 'private'),
        report = path.join(dir, 'evidence');
    fs.mkdirSync(privateRoot);
    fs.mkdirSync(report);
    const ownedFile = path.join(privateRoot, 'owned-leaf-file');
    fs.writeFileSync(ownedFile, 'must survive unproven leaf closure');
    const b = binding(),
        lease = new ProductLease(path.join(dir, 'marker.lock'), {
            nonce,
            bindingSHA256: bindingDigest(b),
        }),
        journal = new PilotEvidence(report),
        events = new EventEmitter(),
        timers = new Map(),
        controller = new AbortController(),
        states = new Map(),
        children = [],
        logs = [],
        order = [],
        observations = [];
    let owner,
        held,
        timerId = 0,
        cleanupCalls = 0,
        recheckCalls = 0,
        joinStageCalls = 0,
        stopCount = 0;
    const startup = new NativePilotStartup({
        signal: controller.signal,
        deadline: now() + 3000,
        cleanupDeadline: now() + 4000,
        emit: async (s, d) => journal.append(s, d),
        hold: (e) => owner.hold(e),
        identity: (child) =>
            new Promise((resolve) =>
                child.once('message', () =>
                    resolve({
                        pid: child.pid,
                        created: 'controlled creation identity of actual harmless Node child',
                    }),
                ),
            ),
        proveDescendants: async () => {
            if (fault === 'descendant-query') throw Error('Descendant proof unavailable');
        },
    });
    const ports = {
        lease,
        events,
        clock: {
            now: () => 0,
            set: (fn, ms) => {
                timers.set(++timerId, { fn, ms });
                return timerId;
            },
            clear: (id) => timers.delete(id),
        },
        executionGate: () => {},
        cancelChild: (child, message, callback) => {
            stopCount++;
            child.send(message, callback);
        },
        onOwner: (o) => (owner = o),
        verify: async (value) => {
            if (fault === 'verification-error') throw Error('Verification did not settle');
            return value;
        },
        record: (s, d) => {
            if (fault === 'receipt-persistence' && s === 'pilot-real-os-pty-closed.json')
                throw Error('Final receipt persistence failed');
            journal.append(s, d);
        },
        closeEvidence: async () => journal.close(),
        hold: (state, record) => {
            startup.stopQueryAdmission();
            if (!held) {
                let referenced = false;
                const actual = createOwnershipHold(
                    state,
                    (...args) => {
                        assert(referenced);
                        record(...args);
                    },
                    {
                        interval: () => ({
                            ref() {
                                referenced = true;
                            },
                        }),
                    },
                );
                held = { actual, referenced };
            }
            controller.abort(Error('controlled custody hold'));
            return held.actual;
        },
        beforeStage: async (stage) => {
            if (
                exit === 'before-first' ||
                (fault === 'before-second' && stage === 'native-electron-store')
            ) {
                observations.push('before-stage-failure');
                throw Error('Sibling beforeStage exceptional exit');
            }
        },
        spawnStage: (stage) => {
            order.push(stage);
            const state = { stage, final: null, logs: [] };
            for (const stream of ['stdout', 'stderr']) {
                const entry = {
                    fd: fs.openSync(path.join(report, stage + '-' + stream + '.log'), 'wx', 0o600),
                    errors: [],
                    attempted: false,
                    synced: false,
                    closed: false,
                };
                if (fault === 'log-sync' && stream === 'stdout')
                    entry.beforeSync = () => {
                        throw Error('Actual required log sync check failed');
                    };
                if (fault === 'log-close' && stream === 'stdout') {
                    entry.attempted = true;
                    entry.synced = true;
                }
                state.logs.push(entry);
                logs.push(entry);
            }
            const final = receipt(fault, stage);
            const child = startup.spawn(
                stage,
                () =>
                    spawn(
                        process.execPath,
                        [
                            '-e',
                            `process.on('message',()=>{process.send({kind:'controlled-final',final:${JSON.stringify(final)}});process.exitCode=${exit === 'normal-failed' ? 1 : 0};process.disconnect();});process.send({kind:'controlled-ready'});`,
                        ],
                        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
                    ),
                (p) => {
                    if (p.connected) {
                        stopCount++;
                        p.send({ kind: 'stop' });
                    }
                },
            );
            children.push(child);
            states.set(child, state);
            child.on('message', (m) => {
                if (m.kind === 'controlled-final') state.final = m.final;
            });
            for (const [i, name] of ['stdout', 'stderr'].entries())
                child[name].on('data', (bytes) => {
                    fs.writeSync(state.logs[i].fd, bytes);
                    fs.fsyncSync(state.logs[i].fd);
                });
            return child;
        },
        waitStage: async (child, o) => {
            await startup.children.get(child).identityTask;
            if (
                exit === 'normal-failed' ||
                fault === 'before-second' ||
                exit === 'wait-exception'
            ) {
                child.send({ kind: 'stop' });
                await startup.children.get(child).closed;
                if (exit === 'wait-exception')
                    throw Error('Sibling wait failure after direct closure');
                return;
            }
            return waitPilotStage({
                child,
                startup,
                state: {
                    stage: states.get(child).stage,
                    runtimeReady: false,
                    runtimeDeadline: now() + 25,
                    stageDeadline: now() + 60,
                    cleanupDeadline: startup.cleanupDeadline,
                },
                signal: new AbortController().signal,
                cancel: (e) => o.cancel(e),
                hold: (e) => o.hold(e),
                emit: async (s, d) => journal.append(s, d),
            });
        },
        joinStage: async (child) => {
            joinStageCalls++;
            observations.push('joinStage');
            return joinPilotStage(child, {
                state: states.get(child),
                startup,
                cancel: (reason) => owner.cancel(reason),
                observe: () => observations.push('post-close'),
            });
        },
        recheckInputs: async () => {
            recheckCalls++;
            observations.push('recheck');
            if (fault === 'recheck-error') throw Error('Sibling input recheck failure');
            return fault !== 'recheck-false';
        },
        cleanupRoots: async () => {
            cleanupCalls++;
            observations.push('cleanup');
            assert.equal(owner.active, null);
            assert.equal(owner.pending, 0);
            assert.equal(owner.state, 'approved');
            await startup.join();
            fs.rmSync(privateRoot, { recursive: true });
            return true;
        },
    };
    let result, error;
    try {
        result = await runHostedPilot(b, ports);
    } catch (e) {
        error = e;
    }
    return {
        dir,
        privateRoot,
        ownedFile,
        lease,
        journal,
        owner,
        held,
        startup,
        children,
        order,
        observations,
        result,
        error,
        cleanupCalls,
        recheckCalls,
        joinStageCalls,
        stopCount,
        logs,
        async dispose() {
            for (const child of children)
                if (!startup.children.get(child).close) {
                    child.kill('SIGKILL');
                    await startup.children.get(child).closed;
                }
            for (const entry of logs) if (!entry.closed) fs.closeSync(entry.fd);
            journal.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
const missing = [
    'missing-final',
    'missing-startup',
    'incomplete-startup',
    'missing-descendant',
    'incomplete-descendant',
    'missing-leaf',
    'incomplete-leaf',
    'wrong-stage',
    'log-sync',
    'log-close',
];
for (const fault of missing)
    test(
        'production owner/watchdog cleanup gate retains private roots before deletion: ' + fault,
        async (t) => {
            const f = await composed({ fault });
            try {
                assert(f.error);
                assert.equal(f.owner.state, 'held');
                assert(f.held.referenced);
                assert.equal(f.joinStageCalls, 1);
                assert.equal(f.cleanupCalls, 0);
                assert.equal(f.recheckCalls, 0);
                assert(
                    fs.existsSync(f.privateRoot) &&
                        fs.existsSync(f.ownedFile) &&
                        fs.existsSync(f.lease.file),
                );
                assert(!f.journal.entry.attempted && fs.fstatSync(f.journal.entry.fd).isFile());
                assert.deepEqual(f.order, ['real-os-pty']);
                assert.equal(f.stopCount, 1);
                const row = f.startup.children.get(f.children[0]);
                assert(row.exit && row.close && row.joined);
                if (fault === 'log-close')
                    assert(fs.fstatSync(f.logs[0].fd).isFile() && !f.logs[0].closed);
                if (fault === 'missing-final')
                    t.diagnostic(
                        JSON.stringify({
                            productionOwner: true,
                            productionWatchdog: true,
                            productionFinalValidator: true,
                            cleanupCalls: f.cleanupCalls,
                            joinStageCalls: f.joinStageCalls,
                            recheckCalls: f.recheckCalls,
                            ownerState: f.owner.state,
                            referenced: f.held.referenced,
                            privateFileRetained: true,
                            markerRetained: true,
                            evidenceCloseAttempted: f.journal.entry.attempted,
                            outerExit: row.exit,
                            outerPipeClose: row.close,
                            outerJoined: row.joined,
                            leafReceiptSupplied: false,
                        }),
                    );
            } finally {
                await f.dispose();
            }
        },
    );
for (const [fault, exit] of [
    ['verified-failed', 'watchdog'],
    ['passed-final', 'watchdog'],
    ['verified-failed', 'wait-exception'],
    ['verified-failed', 'normal-failed'],
])
    test(
        'production cleanup joins verified stage and releases failed verdict without next admission: ' +
            fault +
            '/' +
            exit,
        async (t) => {
            const f = await composed({ fault, exit });
            try {
                assert.ifError(f.error);
                assert.equal(f.result.passed, false);
                assert.equal(f.result.state, 'released');
                assert.equal(f.cleanupCalls, 1);
                assert.equal(f.joinStageCalls, 1);
                assert.equal(f.recheckCalls, 1);
                assert(!f.held);
                assert.deepEqual(f.order, ['real-os-pty']);
                assert(!fs.existsSync(f.privateRoot) && !fs.existsSync(f.lease.file));
                assert(f.journal.entry.closed);
                assert(
                    f.observations.indexOf('joinStage') < f.observations.indexOf('recheck') &&
                        f.observations.indexOf('post-close') < f.observations.indexOf('cleanup'),
                );
                assert(f.owner.cancelled);
                if (fault === 'verified-failed' && exit === 'watchdog')
                    t.diagnostic(
                        JSON.stringify({
                            productionOwner: true,
                            productionWatchdog: true,
                            productionFinalValidator: true,
                            verifiedFailedFinal: true,
                            joinStageCalls: f.joinStageCalls,
                            recheckCalls: f.recheckCalls,
                            cleanupCalls: f.cleanupCalls,
                            order: f.observations,
                            result: f.result,
                            markerReleased: !fs.existsSync(f.lease.file),
                            privateRootRemoved: !fs.existsSync(f.privateRoot),
                            evidenceClosed: f.journal.entry.closed,
                            nextStageAdmitted: false,
                            originalWatchdogFailureRetained: Boolean(f.owner.cancelled),
                        }),
                    );
            } finally {
                await f.dispose();
            }
        },
    );
for (const fault of [
    'recheck-false',
    'recheck-error',
    'receipt-persistence',
    'descendant-query',
    'verification-error',
])
    test('shared cleanup entry fences sibling exceptional exit: ' + fault, async () => {
        const f = await composed({ fault });
        try {
            assert(f.error);
            assert.equal(f.cleanupCalls, 0);
            assert.equal(f.owner.state, 'held');
            assert(f.held.referenced);
            assert(fs.existsSync(f.ownedFile) && fs.existsSync(f.lease.file));
            assert(!f.journal.entry.attempted);
            assert(f.order.length <= 1);
        } finally {
            await f.dispose();
        }
    });
for (const [fault, exit] of [
    ['verified-failed', 'before-first'],
    ['before-second', 'before-second'],
])
    test('verified sibling failure remains eligible for failed cleanup: ' + exit, async () => {
        const f = await composed({ fault, exit });
        try {
            assert.ifError(f.error);
            assert.equal(f.result.passed, false);
            assert.equal(f.result.state, 'released');
            assert.equal(f.cleanupCalls, 1);
            assert(!f.held);
            assert(f.order.length <= 1);
            assert(f.observations.includes('before-stage-failure'));
            assert.match(f.owner.cancelled, /Sibling beforeStage/);
            assert(!fs.existsSync(f.privateRoot) && !fs.existsSync(f.lease.file));
        } finally {
            await f.dispose();
        }
    });
