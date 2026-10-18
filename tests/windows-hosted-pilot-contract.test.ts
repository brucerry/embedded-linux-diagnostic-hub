// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
    pilotLimits,
    validatePilotBinding,
    bindingDigest,
    PilotSpaceLedger,
    requirePilotRuntimeReady,
} from '../scripts/lib/hosted-pilot-contract.mjs';
import { SameJobPilotCustody } from '../scripts/lib/hosted-pilot-custody.mjs';
import { growthCanary } from '../scripts/lib/pilot-growth-canary.mjs';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { RootGuard } from '../scripts/lib/product-collector-files.mjs';
import { closeEntries } from '../scripts/lib/product-collector-evidence.mjs';
import { finiteNativeReadiness } from './fixtures/windows-native-readiness-pilot';
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
async function fixture(options = {}) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-pilot-protocol-')),
        marker = path.join(dir, 'owned.lock'),
        guard = new RootGuard(dir),
        events = new EventEmitter(),
        timers = new Map();
    let now = 0,
        id = 0;
    const rows = [];
    const clock = {
        now: () => now,
        set: (fn, ms) => {
            const v = ++id;
            timers.set(v, { fn, ms });
            return v;
        },
        clear: (v) => timers.delete(v),
    };
    const lease = new ProductLease(marker, { nonce, bindingSHA256: bindingDigest(binding()) });
    let holds = 0;
    const record = (name, value) => {
        rows.push({ name, value });
        if (options.recordFail) throw Error('Injected durable receipt failure');
    };
    const protocol = new SameJobPilotCustody(binding(), {
        lease,
        executionGate: options.defaultGate ? undefined : () => {},
        events,
        clock,
        record,
        verify: options.verify ?? (async (b) => b),
        closeEvidence:
            options.closeEvidence ??
            (async () => {
                const fd = fs.openSync(path.join(dir, 'final.json'), 'wx', 0o600);
                fs.writeFileSync(fd, '{}');
                return closeEntries([{ fd, errors: [], attempted: false }]);
            }),
        hold: (state, persist) => {
            holds++;
            try {
                persist('ownership-held.json', state);
            } catch {}
            return { snapshot: () => ({ attached: true, referencedHandleCreated: true }) };
        },
    });
    return {
        protocol,
        lease,
        marker,
        dir,
        clock,
        events,
        rows,
        timers,
        setNow: (n) => (now = n),
        holds: () => holds,
        cleanup() {
            if (fs.existsSync(marker)) fs.unlinkSync(marker);
            fs.rmSync(dir, { recursive: true });
        },
    };
}
function child() {
    const c = new EventEmitter();
    c.connected = true;
    c.send = (message, cb) => {
        c.lastMessage = message;
        cb?.();
    };
    return c;
}
async function stages(f, token) {
    for (const stage of ['real-os-pty', 'native-electron-store']) {
        const c = child();
        f.protocol.start(stage, token, binding(), () => c);
        c.emit('spawn');
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
        await f.protocol.joinStage(async () => ({
            descendantsClosed: true,
            leafReceiptsClosed: true,
            logsClosed: true,
        }));
    }
}
test('default pilot native admission remains blocked before any workload factory', () => {
    assert.throws(() => requirePilotRuntimeReady(), /Separate native pilot selector/);
});
test('exact same-job token closes real marker only after two actual-event joins and real evidence fd sync/close', async () => {
    const f = await fixture();
    try {
        const token = await f.protocol.acquireAndVerify();
        assert(fs.existsSync(f.marker));
        await stages(f, token);
        await f.protocol.release({
            inputsUnchanged: true,
            rootsCleanupClosed: true,
            resultClosed: true,
        });
        assert(!fs.existsSync(f.marker));
        assert.equal(f.protocol.state, 'released');
        assert.equal(f.timers.size, 0);
    } finally {
        f.cleanup();
    }
});
for (const [name, change] of [
    ['run', (b) => (b.host.run = '2')],
    ['source', (b) => (b.sourceSHA256 = 'b'.repeat(64))],
    ['coverage', (b) => (b.coveragePolicySHA256 = 'b'.repeat(64))],
    ['deps', (b) => (b.dependenciesSHA256 = 'b'.repeat(64))],
    ['runtime', (b) => (b.runtime.electron.sha256 = 'b'.repeat(64))],
    ['root', (b) => (b.roots.privateRoot.ino = '99')],
    ['descriptor', (b) => (b.roots.canonicalTemp.descriptorSHA256 = 'b'.repeat(64))],
    ['nonce', (b) => (b.nonce = 'b'.repeat(36))],
    ['deadline', (b) => b.deadline++],
    ['principal', (b) => (b.principalSID += '1')],
])
    test('stale ' + name + ' binding cannot spawn and retains actual marker', async () => {
        const f = await fixture();
        try {
            const token = await f.protocol.acquireAndVerify(),
                b = binding();
            change(b);
            let calls = 0;
            assert.throws(() =>
                f.protocol.start('real-os-pty', token, b, () => {
                    calls++;
                    return child();
                }),
            );
            assert.equal(calls, 0);
            assert(fs.existsSync(f.marker));
            assert.equal(f.protocol.state, 'held');
            assert(f.holds() > 0);
        } finally {
            f.cleanup();
        }
    });
test('serialized/replayed token cannot become a live continuation', async () => {
    const f = await fixture();
    try {
        await f.protocol.acquireAndVerify();
        assert.throws(() => f.protocol.start('real-os-pty', {}, binding(), () => child()));
        assert.equal(f.protocol.state, 'held');
        assert(fs.existsSync(f.marker));
    } finally {
        f.cleanup();
    }
});
test('cancellation during verification refuses a late approval and leaves marker owned', async () => {
    let done;
    const f = await fixture({ verify: () => new Promise((r) => (done = r)) });
    try {
        const pending = f.protocol.acquireAndVerify();
        f.events.emit('SIGINT');
        done(binding());
        await assert.rejects(pending);
        assert(fs.existsSync(f.marker));
        assert.equal(f.protocol.state, 'approved');
        assert.equal(f.protocol.pending, 0);
    } finally {
        f.cleanup();
    }
});
test('unknown synchronous spawn failure retains marker before any async escape', async () => {
    const f = await fixture();
    try {
        const t = await f.protocol.acquireAndVerify();
        assert.throws(() =>
            f.protocol.start('real-os-pty', t, binding(), () => {
                throw Error('ambiguous spawn');
            }),
        );
        assert.equal(f.protocol.state, 'held');
        assert(fs.existsSync(f.marker));
    } finally {
        f.cleanup();
    }
});
test('exit without inherited pipe close cannot release ownership', async () => {
    const f = await fixture();
    try {
        const t = await f.protocol.acquireAndVerify(),
            c = child();
        f.protocol.start('real-os-pty', t, binding(), () => c);
        c.emit('spawn');
        c.emit('exit', 0, null);
        await assert.rejects(
            f.protocol.joinStage(async () => ({
                descendantsClosed: true,
                leafReceiptsClosed: true,
                logsClosed: true,
            })),
        );
        assert.equal(f.protocol.state, 'held');
        assert(fs.existsSync(f.marker));
    } finally {
        f.cleanup();
    }
});
test('unknown descendant or log closure cannot release ownership', async () => {
    const f = await fixture();
    try {
        const t = await f.protocol.acquireAndVerify(),
            c = child();
        f.protocol.start('real-os-pty', t, binding(), () => c);
        c.emit('spawn');
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
        await assert.rejects(
            f.protocol.joinStage(async () => ({
                descendantsClosed: false,
                leafReceiptsClosed: true,
                logsClosed: true,
            })),
        );
        assert(fs.existsSync(f.marker));
    } finally {
        f.cleanup();
    }
});
test('real evidence descriptor close failure retains marker until actual closure', async () => {
    let fd;
    const f = await fixture({
        closeEvidence: async () => {
            fd = fs.openSync(path.join(f.dir, 'unclosed'), 'wx');
            return closeEntries([{ fd, errors: [], attempted: false }], {
                ...fs,
                closeSync() {
                    throw Error('injected close');
                },
            });
        },
    });
    try {
        const t = await f.protocol.acquireAndVerify();
        await stages(f, t);
        await assert.rejects(
            f.protocol.release({
                inputsUnchanged: true,
                rootsCleanupClosed: true,
                resultClosed: true,
            }),
        );
        assert(fs.fstatSync(fd).isFile());
        assert(fs.existsSync(f.marker));
        assert.equal(f.protocol.state, 'held');
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        f.cleanup();
    }
});
test('failed hold receipt does not remove the actual marker', async () => {
    const f = await fixture({ recordFail: true });
    try {
        await assert.rejects(f.protocol.acquireAndVerify());
        assert(fs.existsSync(f.marker));
        assert.equal(f.protocol.state, 'held');
        assert(f.holds() > 0);
    } finally {
        f.cleanup();
    }
});
test('finite window cannot be extended or restarted', () => {
    const b = binding();
    assert.throws(() => validatePilotBinding({ ...b, deadline: 600001 }, 0));
    assert.throws(() => validatePilotBinding(b, 540000));
});
test('disk pre-write reservations retain deleted-file high water and refuse unknown writers', () => {
    const l = new PilotSpaceLedger();
    assert.throws(() =>
        l.reserve({
            writer: 'unbounded-Electron',
            bytes: 1,
            files: 1,
            reviewedPrewriteBound: false,
        }),
    );
    l.reserve({
        writer: 'known',
        bytes: pilotLimits.treeBytes,
        files: 8192,
        reviewedPrewriteBound: true,
    });
    l.observe({ bytes: 0, files: 0, scanMs: 100, gapMs: 10000 });
    assert.equal(l.snapshot().reservedTreeBytes, pilotLimits.treeBytes);
    assert.throws(() =>
        l.reserve({ writer: 'more', bytes: 1, files: 0, reviewedPrewriteBound: true }),
    );
    l.reserveEvidence(10 * 1024 ** 2);
    assert.equal(l.snapshot().jobCharge, pilotLimits.jobBytes);
    assert.throws(() => l.reserveEvidence(1));
});
test('real finite growth canary stays within reservation and closes/unlinks actual files', () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-growth-')),
        l = new PilotSpaceLedger(),
        rows = [];
    try {
        const r = growthCanary(dir, l, { check: () => {}, observe: (v) => rows.push(v) });
        assert.equal(r.failure, null);
        assert.equal(r.written, 16 * 1024 ** 2);
        assert.equal(r.peak, r.written);
        assert(r.allClosed && r.cleaned && r.closure.complete);
        assert.equal(rows.length, 64);
        assert(r.conservativePeakPlusBurstBytes <= pilotLimits.treeBytes);
        assert.equal(r.nativeWriterOvershootQualified, false);
        assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
test('finite native adapter cannot substitute compile/presence metadata for actual startup', async () => {
    let starts = 0;
    await assert.rejects(
        finiteNativeReadiness({
            privateRoot: path.resolve('/tmp'),
            nativeCoverage: {},
            signal: new AbortController().signal,
            workDeadlineMs: 100000,
            emit: async () => {},
            holdUnknown: () => {},
            createDriver: async () => {
                starts++;
                throw Error('not reached');
            },
        }),
        /Separate native pilot selector/,
    );
    assert.equal(starts, 0);
});
test('finite native readiness requires generation/reopen and actual held Save cancel/read-failure cases', async () => {
    const driver = {
        cycle: async () => ({
            coverage: [
                'native-renderer-generation-reset-reopen',
                'clear-reopen',
                'export-cancel',
                'export-failure',
            ],
        }),
        teardown: async () => {},
        assertDescendantsExited: async () => {},
    };
    const r = await finiteNativeReadiness({
        privateRoot: path.resolve('/tmp'),
        nativeCoverage: {},
        signal: new AbortController().signal,
        workDeadlineMs: 100000,
        emit: async () => {},
        holdUnknown: () => assert.fail(),
        gate: () => {},
        createDriver: async () => driver,
    });
    assert.equal(r.cycles, 1);
    assert.equal(r.fullCollection, false);
});
test('native factory rejection is uncertain custody even without a returned driver', async () => {
    let held = 0;
    await assert.rejects(
        finiteNativeReadiness({
            privateRoot: path.resolve('/tmp'),
            nativeCoverage: {},
            signal: new AbortController().signal,
            workDeadlineMs: 100000,
            emit: async () => {},
            holdUnknown: () => held++,
            gate: () => {},
            createDriver: async () => {
                throw Error('startup may own children');
            },
        }),
    );
    assert.equal(held, 1);
});

test('growth observer overhead/gap are measured rather than fabricated as zero', () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-growth-clock-')),
        rows = [];
    let ticks = 0;
    try {
        const r = growthCanary(dir, new PilotSpaceLedger(), {
            check: () => {},
            observe: (v) => rows.push(v),
            clock: () => ++ticks,
        });
        assert(r.observerMs > 0 && r.maxGapMs > 0);
        assert(rows.every((row) => row.scanMs > 0 && row.gapMs > 0));
        assert(r.cleaned);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('native startup cannot precede required real OS PTY stage', async () => {
    const f = await fixture();
    try {
        const token = await f.protocol.acquireAndVerify();
        let starts = 0;
        assert.throws(() =>
            f.protocol.start('native-electron-store', token, binding(), () => {
                starts++;
                return child();
            }),
        );
        assert.equal(starts, 0);
        assert.equal(f.protocol.state, 'held');
        assert(fs.existsSync(f.marker));
    } finally {
        f.cleanup();
    }
});
test('hold forwards nonce/binding-bound IPC without killing the owning child', async () => {
    const f = await fixture();
    try {
        const t = await f.protocol.acquireAndVerify(),
            c = child();
        f.protocol.start('real-os-pty', t, binding(), () => c);
        f.events.emit('SIGTERM');
        assert.equal(c.lastMessage.kind, 'cancel-hosted-pilot-stage');
        assert.equal(c.lastMessage.nonce, nonce);
        assert.equal(c.lastMessage.bindingSHA256, bindingDigest(binding()));
        assert.equal(f.protocol.state, 'running');
        assert(fs.existsSync(f.marker));
    } finally {
        f.cleanup();
    }
});

test('default producer gate prevents actual spawn even after protocol enrollment', async () => {
    const f = await fixture({ defaultGate: true });
    try {
        const t = await f.protocol.acquireAndVerify();
        let starts = 0;
        assert.throws(
            () =>
                f.protocol.start('real-os-pty', t, binding(), () => {
                    starts++;
                    return child();
                }),
            /Separate native pilot selector/,
        );
        assert.equal(starts, 0);
        assert(fs.existsSync(f.marker));
    } finally {
        f.cleanup();
    }
});
