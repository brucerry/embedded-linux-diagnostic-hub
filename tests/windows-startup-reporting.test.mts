// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { runtimeDiagnostics } from '../scripts/lib/pilot-runtime-startup.mjs';
import { pilotEvidenceReceiver } from '../scripts/lib/pilot-evidence-channel.mjs';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import * as identity from '../scripts/lib/startup-identity-report.mjs';
import * as cleanup from '../scripts/lib/pilot-cleanup-diagnostics.mjs';
const root = path.resolve(import.meta.dirname, '..'),
    req = createRequire(import.meta.url),
    ts = req('typescript');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const synthetic = (exports, context) =>
    new vm.SyntheticModule(
        Object.keys(exports),
        function () {
            for (const [k, v] of Object.entries(exports)) this.setExport(k, v);
        },
        { context },
    );
async function load(
    file,
    imports,
    context = vm.createContext({
        process: { platform: 'win32', arch: 'x64', env: {}, hrtime: process.hrtime },
        Buffer,
        console,
        setTimeout,
        clearTimeout,
        performance,
    }),
) {
    const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const module = new vm.SourceTextModule(code, {
        context,
        identifier: file,
        initializeImportMeta(meta) {
            meta.dirname = path.dirname(path.join(root, file));
        },
    });
    await module.link((spec) => {
        assert(spec in imports, 'Uncontrolled import ' + spec);
        return synthetic(imports[spec], context);
    });
    await module.evaluate();
    return module.namespace;
}
const nonce = 'a'.repeat(36),
    binding = 'b'.repeat(64);
async function transport({ holdReceiptFailure = false, totalSeed = 0 } = {}) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-report-wire-')),
        journal = new PilotEvidence(dir),
        wire = [],
        records = [],
        acks = [],
        holds = [];
    const lease = new ProductLease(path.join(dir, 'fixture-marker.lock'), {
        nonce,
        bindingSHA256: binding,
    });
    lease.acquire();
    let charged = totalSeed,
        held;
    const reserve = (n) => {
        assert(charged + n <= 10485760, 'Shared total evidence budget');
        charged += n;
    };
    const record = (stage, data) => {
        reserve(Buffer.byteLength(JSON.stringify({ stage, data })) + 256);
        journal.append(stage, data);
        records.push({ stage, data });
    };
    const hold = (error) => {
        holds.push(String(error));
        if (!held) {
            let referenced = false;
            const actual = createOwnershipHold(
                { reason: String(error).slice(0, 1024) },
                (s, d) => {
                    assert(referenced);
                    if (holdReceiptFailure) throw Error('Controlled failed hold persistence');
                    journal.append(s, d);
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
    };
    const fake = new EventEmitter();
    Object.assign(fake, { connected: true, hrtime: process.hrtime });
    const state = { sequence: 0, runtimeReady: false, runtimeDeadline: Infinity, final: null };
    const receiver = pilotEvidenceReceiver({
        nonce,
        bindingSHA256: binding,
        stage: 'native-electron-store',
        state,
        record,
        reserve,
        recordReserved: (stage, data) => {
            journal.append(stage, data);
            records.push({ stage, data });
        },
        send: (m, cb) => {
            acks.push(m);
            fake.emit('message', m);
            cb?.(null);
        },
        hold,
        clock: () => 0,
    });
    fake.send = (message, callback) => {
        const m = JSON.parse(JSON.stringify(message));
        wire.push(m);
        const valid = receiver.receive(m);
        callback(valid ? null : Error('Controlled evidence owner refused frame'));
    };
    const channel = await load(
        'tests/fixtures/pilot-stage-channel.ts',
        {
            'node:assert/strict': { default: assert },
            '../../scripts/lib/startup-identity-report.mjs': identity,
        },
        vm.createContext({ process: fake, Buffer, setTimeout, clearTimeout }),
    );
    const send = channel.stageChannel(nonce, binding, new AbortController().signal),
        diagnostics = runtimeDiagnostics(send, hold);
    const replay = () => {
        const decoder = identity.startupIdentityDecoder(),
            logical = [];
        for (const r of records) {
            const stage = r.stage.slice('native-electron-store:'.length);
            if (stage === identity.identityManifestStage || stage === identity.identityPartStage) {
                const result = decoder.accept(stage, r.data);
                if (result) logical.push(result);
            } else decoder.assertComplete();
        }
        decoder.assertComplete();
        return logical;
    };
    return {
        dir,
        journal,
        wire,
        records,
        acks,
        holds,
        lease,
        state,
        receiver,
        diagnostics,
        send,
        replay,
        get charged() {
            return charged;
        },
        get held() {
            return held;
        },
        dispose() {
            journal.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
async function fixture({
    browser = false,
    unicode = false,
    commandLine,
    duplicateRole = false,
    report = identity.reportStartupIdentity,
} = {}) {
    let queries = 0,
        payloadCalls = 0,
        closed = 0;
    const executable = Buffer.from('controlled executable identity fixture'),
        sourceSHA = 'd'.repeat(64);
    const roles = [
        'qualification-harness',
        browser ? 'browser-main' : 'electron-main',
        browser ? 'browser-renderer' : 'electron-renderer',
        browser ? 'browser-GPU' : 'electron-GPU',
        browser ? 'browser-Utility' : 'electron-Utility',
        'owned-descendant',
        'gateway-node',
        'ssh-fixture-node',
    ];
    if (duplicateRole) roles.splice(5, 0, roles[4]);
    const samples = roles.map((role, i) => ({
        pid: 1000 + i,
        created: 'controlled-creation-' + i,
        role,
        state: 'running',
        rssBytes: 100,
        heapUsedBytes: 10,
        externalBytes: 1,
        arrayBuffersBytes: 1,
        unsupported: [],
    }));
    const artifacts = Array.from({ length: 64 }, (_, i) => ({
        path:
            'dist/assets/' +
            ('asset-' + i + '-').padEnd(unicode ? 250 : 90, unicode ? '界' : 'x') +
            '.js',
        bytes: 50000 + i,
        sha256: sha('artifact' + i),
    }));
    const nodeIdentity = {
        executablePath: 'C:\\node\\node.exe',
        executableSHA256: sha('node'),
        node: 'v24.22.0',
        platform: 'win32',
        arch: 'x64',
        versions: { node: '24.22.0' },
        execArgv: ['--import', 'file:///fixture/tsx/loader.mjs'],
        nodeOptions: null,
    };
    const gatewayRuntime = Object.fromEntries(
        ['gateway-node', 'ssh-fixture-node'].map((role) => [
            role,
            {
                ...nodeIdentity,
                launch: {
                    argv: ['C:\\node\\node.exe', 'C:\\fixture\\' + role + '.ts'],
                    execArgv: nodeIdentity.execArgv,
                    sshProfile: 'C:\\fixture\\manifest.json',
                    gcMode: 'normal',
                    timerStacks: false,
                },
            },
        ]),
    );
    const scope = await load('tests/fixtures/memory-product-aggregate-scope.ts', {
        'node:assert/strict': { default: assert },
        'node:path': { default: path.win32 },
        'node:crypto': { createHash },
        'node:fs/promises': {
            default: { realpath: async (p) => p, readFile: async () => executable },
        },
        'node:child_process': {
            execFile: (cmd, args, opts, cb) => {
                assert.equal(cmd, 'powershell.exe');
                queries++;
                cb(
                    null,
                    JSON.stringify(
                        samples.map((r, i) => ({
                            ProcessId: r.pid,
                            Created: r.created,
                            ExecutablePath:
                                (unicode ? 'C:\\程序 Files\\' : 'C:\\fixture\\') + r.role + '.exe',
                            CommandLine:
                                i === 3 && commandLine ? commandLine : 'controlled ' + r.role,
                        })),
                    ),
                    '',
                );
            },
        },
        './memory-resource-processes': {
            readProcessTable: async () => {
                throw Error('No actual process query');
            },
        },
    });
    const noop = () => {},
        never = () => {
            payloadCalls++;
            throw Error('Payload call forbidden');
        };
    const protocol = { on() {}, send: async () => ({}), detach: async () => {} },
        page = {
            isClosed: () => false,
            locator: () => ({ count: async () => 1 }),
            context: () => ({ newCDPSession: async () => protocol }),
            evaluate: async () => ({ controlledBaseline: true }),
        };
    const child = new EventEmitter();
    Object.assign(child, { pid: 999, exitCode: null, signalCode: null });
    const workers = { dispose: noop };
    const host = {
        page,
        root: 'C:\\fixture\\native-app',
        origin: 'http://fixture.invalid',
        version: '0.6.0',
        proxyGateway: noop,
        pageForCleanup: () => page,
        sample: async () =>
            samples.filter(
                (r) =>
                    !['qualification-harness', 'gateway-node', 'ssh-fixture-node'].includes(r.role),
            ),
        releaseQualificationHolds: async () => {},
        close: async () => {
            closed++;
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
        },
        assertExited: async () => {},
    };
    const gateway = {
        runtimeIdentity: gatewayRuntime,
        descriptor: { url: 'http://fixture.invalid' },
        sample: async () =>
            samples.filter((r) => ['gateway-node', 'ssh-fixture-node'].includes(r.role)),
        close: async () => {},
        assertExited: async () => {},
    };
    const common = {
        '../../scripts/lib/startup-identity-report.mjs': { reportStartupIdentity: report },
        'node:assert/strict': { default: assert },
        'node:path': { default: path.win32 },
        './memory-product-startup': { productStartup: () => noop },
        './memory-product-shutdown': { shutdownHistory: never, rememberProcessRoles: noop },
        './memory-product-gateway': { createProductGateway: async () => gateway },
        './memory-product-ui': { exerciseProductSerial: never },
        './memory-product-serial-lifecycle': { exerciseProductSerialLifecycle: never },
        './memory-product-results-ui': { exerciseProductResults: never },
        './memory-resource-identity': {
            sourceFingerprint: async () => sourceSHA,
            nodeRuntimeIdentity: async () => nodeIdentity,
        },
        './memory-resource-core': {
            ownerKinds: [],
            viewerOwnerKinds: [],
            soakCoverage: [],
            viewerCoverage: [],
        },
        './memory-product-aggregate-scope': {
            bindAggregateScope: scope.bindAggregateScope,
            inventoryProductArtifacts: async () => artifacts,
            sampleAggregateHarness: async () => samples[0],
        },
        './memory-product-aggregate-contract': Object.fromEntries(
            [
                'aggregatePending',
                'aggregateSupported',
                'aggregateCaptureAccounting',
                'aggregateNativeResourceCounts',
                'assertDistinctAggregateScopes',
                'serialExpectation',
                'serialLifecycleCoverage',
                'scheduledCatalog',
                'assertCoverageReceipt',
            ].map((k) => [
                k,
                k === 'aggregateSupported' ? () => [] : k === 'aggregatePending' ? {} : never,
            ]),
        ),
        './memory-product-aggregate-workloads': {
            createAggregateViewerWitness: async () => ({ workers }),
            exerciseAggregateHeldViewer: never,
            produceAggregateCrossPage: never,
        },
    };
    let mod;
    if (!browser)
        mod = await load('tests/fixtures/memory-product-aggregate-native.ts', {
            ...common,
            '../../scripts/lib/pilot-cleanup-diagnostics.mjs': cleanup,
            'node:fs/promises': { default: {} },
            './memory-product-native-contract': {
                nativeGenerationCase: 'native-renderer-generation-reset-reopen',
            },
            './memory-product-native-save-ui': { exerciseNativeSaveCases: never },
            './memory-product-native-host': { createProductNative: async () => host },
            './memory-product-native-ssh-ui': { exerciseProductNativeSsh: never },
        });
    else {
        class Inspection {
            async initialize() {}
            viewerWorkers() {
                return workers;
            }
            viewerArtifact() {
                return sha('viewer');
            }
            async use(label, work) {
                return work();
            }
            async close() {
                await host.close();
            }
        }
        mod = await load('tests/fixtures/memory-product-aggregate.ts', {
            ...common,
            '../../scripts/lib/pilot-cleanup-diagnostics.mjs': cleanup,
            'node:fs/promises': {
                default: {
                    realpath: async (p) => p,
                    readdir: async () =>
                        artifacts.map((a) => ({
                            name: path.win32.basename(a.path),
                            isSymbolicLink: () => false,
                            isDirectory: () => false,
                        })),
                    stat: async () => ({ size: 50000 }),
                },
            },
            'node:fs': {
                createReadStream: () => Readable.from([executable]),
                appendFileSync: never,
            },
            'node:crypto': { createHash },
            '@playwright/test': {
                chromium: { executablePath: () => nodeIdentity.executablePath },
                firefox: {},
                webkit: {},
            },
            './memory-product-browser-host': {
                createProductBrowser: async (options) => {
                    await options.observeRoot(child);
                    return host;
                },
            },
            './memory-product-ssh-ui': { exerciseProductSsh: never },
            './memory-product-inspection-controller': { ProductInspectionController: Inspection },
            './memory-product-inspection-realm': { requireInspectionRealmDestruction: never },
            './memory-product-aggregate-native': { createNativeAggregateDriver: never },
            './memory-product-aggregate-diagnostics': {
                AggregateCallTracker: class {
                    assertJoined() {}
                },
                recordAggregateFailure: never,
            },
        });
    }
    const make = (emit) =>
        (browser ? mod.createQualificationDriver : mod.createNativeAggregateDriver)({
            lane: browser ? 'browser' : 'desktop',
            gcMode: 'normal',
            profile: 'C:\\fixture\\native-profile',
            viewer: false,
            component: false,
            nativeCoverage: {
                contract: {
                    sourceSHA256: sourceSHA,
                    cases: { versionchange: { reason: 'controlled applicability' } },
                },
            },
            emit,
        });
    return {
        make,
        get queries() {
            return queries;
        },
        get payloadCalls() {
            return payloadCalls;
        },
        get closed() {
            return closed;
        },
    };
}

test('actual native factory reproduces the former 137333-byte identity refusal before any payload', async (t) => {
    let attempted;
    const accepted = [];
    const diag = runtimeDiagnostics(
        async (s, d) => accepted.push({ stage: s, data: d }),
        (e) => {
            throw e;
        },
    );
    const f = await fixture({
        report: (emit, stage, data) => {
            attempted = { stage, data };
            return emit(stage, data);
        },
    });
    await assert.rejects(f.make(diag.emit), (error) => {
        assert.equal(error.reportingFailure.counter, 'frameBytes');
        assert.equal(error.reportingFailure.stage, 'aggregate-native-input-identity');
        assert.equal(error.reportingFailure.encodedBytes, 137333);
        return true;
    });
    assert.equal(Buffer.byteLength(JSON.stringify(attempted)), 137333);
    assert.equal(f.payloadCalls, 0);
    assert.equal(f.closed, 1);
    t.diagnostic(
        JSON.stringify({
            controlledFixtureBytes: 137333,
            originalWindowsRejectedBytesRetained: false,
            actualProductionFactoryAndScopeBuilder: true,
            payloadCalls: 0,
            queries: f.queries,
        }),
    );
});
for (const browser of [false, true])
    test(
        'actual ' +
            (browser ? 'browser' : 'native') +
            ' startup reporters reconstruct complete identity through production wire/parser/journal',
        async (t) => {
            const h = await transport(),
                originals = [];
            try {
                const f = await fixture({
                    browser,
                    unicode: true,
                    commandLine: 'C:\\程序 Files\\app.exe ' + '命'.repeat(65536),
                    duplicateRole: true,
                    report: (emit, stage, data) => {
                        originals.push(JSON.stringify({ stage, data }));
                        return identity.reportStartupIdentity(emit, stage, data);
                    },
                });
                const driver = await f.make(h.diagnostics.emit);
                assert(driver);
                assert.equal(f.payloadCalls, 0);
                await driver.teardown();
                if (!browser) await driver.assertDescendantsExited();
                await h.diagnostics.drain();
                h.receiver.assertComplete();
                const restored = h.replay();
                assert.equal(restored.length, browser ? 2 : 1);
                assert.deepEqual(
                    restored.map(({ stage, data }) => JSON.stringify({ stage, data })),
                    originals,
                );
                assert(h.wire.every((m) => Buffer.byteLength(JSON.stringify(m)) <= 65536));
                assert.equal(h.acks.length, h.wire.length);
                assert.equal(h.holds.length, 0);
                assert(f.queries >= 1);
                assert(
                    h.wire.findIndex((m) => m.stage.endsWith('cold-baseline')) >
                        h.wire.map((m) => m.stage).lastIndexOf(identity.identityPartStage),
                );
                t.diagnostic(
                    JSON.stringify({
                        mode: browser ? 'browser' : 'native',
                        logicalBytes: restored.map((x) => x.bytes),
                        parts: restored.map((x) => x.parts),
                        wireFrames: h.wire.length,
                        maxFullWireBytes: Math.max(
                            ...h.wire.map((x) => Buffer.byteLength(JSON.stringify(x))),
                        ),
                        exactReconstruction: true,
                        payloadCalls: f.payloadCalls,
                        controlledQueries: f.queries,
                        holds: 0,
                    }),
                );
            } finally {
                h.dispose();
            }
        },
    );

test('all four startup identity stages retain Unicode, long raw facts and inventory growth losslessly', async () => {
    const h = await transport();
    try {
        const originals = [];
        for (const stage of identity.startupIdentityStages) {
            const data = {
                path: 'C:\\程序\\資料\\🙂'.repeat(5000),
                launch: { commandLine: 'x'.repeat(65536) },
                inventory: Array.from({ length: 256 }, (_, i) => ({
                    path: 'x'.repeat(256) + i,
                    sha256: sha(String(i)),
                    bytes: i,
                })),
                roles: [
                    { role: 'same', pid: 1 },
                    { role: 'same', pid: 2 },
                ],
            };
            originals.push(JSON.stringify({ stage, data }));
            await identity.reportStartupIdentity(h.diagnostics.emit, stage, data);
        }
        await h.diagnostics.drain();
        assert.deepEqual(
            h.replay().map(({ stage, data }) => JSON.stringify({ stage, data })),
            originals,
        );
        assert.equal(h.acks.length, h.wire.length);
    } finally {
        h.dispose();
    }
});
const logical = 'aggregate-native-input-identity';
const valid = () =>
    [...identity.planStartupIdentity(logical, { value: 'x'.repeat(70000) }).frames()].map((v) =>
        JSON.parse(JSON.stringify(v)),
    );
const rawFrames = (bytes, stage = logical) => {
    const b = Buffer.from(bytes),
        sha256 = sha(b),
        parts = Math.ceil(b.length / 32768);
    return [
        {
            stage: identity.identityManifestStage,
            data: { schema: 1, stage, bytes: b.length, parts, sha256 },
        },
        ...Array.from({ length: parts }, (_, index) => ({
            stage: identity.identityPartStage,
            data: {
                schema: 1,
                stage,
                sha256,
                index,
                base64: b.subarray(index * 32768, (index + 1) * 32768).toString('base64'),
            },
        })),
    ];
};
const malformed = {
    'missing final part': (a) => a.slice(0, -1),
    'duplicate part': (a) => [a[0], a[1], a[1], ...a.slice(2)],
    'out of order': (a) => [a[0], a[2], a[1], ...a.slice(3)],
    'missing manifest': (a) => a.slice(1),
    'manifest extra field': (a) => {
        a[0].data.extra = true;
        return a;
    },
    'manifest schema type': (a) => {
        a[0].data.schema = '1';
        return a;
    },
    'manifest unknown stage': (a) => {
        a[0].data.stage = 'stage-final';
        return a;
    },
    'manifest zero bytes': (a) => {
        a[0].data.bytes = 0;
        return a;
    },
    'manifest excessive bytes': (a) => {
        a[0].data.bytes = 4194305;
        return a;
    },
    'manifest count mismatch': (a) => {
        a[0].data.parts++;
        return a;
    },
    'manifest malformed hash': (a) => {
        a[0].data.sha256 = 'F'.repeat(64);
        return a;
    },
    'part stage mismatch': (a) => {
        a[1].data.stage = 'aggregate-input-identity';
        return a;
    },
    'part hash mismatch': (a) => {
        a[1].data.sha256 = 'c'.repeat(64);
        return a;
    },
    'part index type': (a) => {
        a[1].data.index = '0';
        return a;
    },
    'part extra field': (a) => {
        a[1].data.extra = true;
        return a;
    },
    'part malformed base64': (a) => {
        a[1].data.base64 = '!' + a[1].data.base64.slice(1);
        return a;
    },
    'part decoded size mismatch': (a) => {
        a[1].data.base64 = Buffer.alloc(32767).toString('base64');
        return a;
    },
    'corrupt data matching length': (a) => {
        a[1].data.base64 = Buffer.alloc(32768, 65).toString('base64');
        return a;
    },
    'UTF8 BOM before canonical JSON': () =>
        rawFrames(
            Buffer.concat([
                Buffer.from([0xef, 0xbb, 0xbf]),
                Buffer.from(JSON.stringify({ stage: logical, data: {} })),
            ]),
        ),
    'invalid UTF8': () => rawFrames(Buffer.from([255, 254, 253])),
    'invalid JSON': () => rawFrames('{no json}'),
    'original stage mismatch': () =>
        rawFrames(JSON.stringify({ stage: 'aggregate-input-identity', data: {} })),
    'duplicate original JSON key': () =>
        rawFrames('{"stage":"other","stage":"' + logical + '","data":{}}'),
    'incomplete UTF8 character': () => rawFrames(Buffer.from([0xe2, 0x82])),
    'noncanonical base64 padding bits': () => {
        const a = rawFrames('x');
        a[1].data.base64 = 'eB==';
        return a;
    },
};
for (const [name, change] of Object.entries(malformed))
    test('real production receiver holds and refuses malformed multipart: ' + name, async () => {
        const h = await transport({ holdReceiptFailure: true });
        try {
            const frames = change(valid());
            let sequence = 0,
                ok = true;
            for (const frame of frames) {
                ok = h.receiver.receive({
                    kind: 'pilot-evidence',
                    nonce,
                    bindingSHA256: binding,
                    sequence: sequence++,
                    stage: frame.stage,
                    data: frame.data,
                });
                if (!ok) break;
            }
            if (ok)
                ok = h.receiver.receive({
                    kind: 'pilot-evidence',
                    nonce,
                    bindingSHA256: binding,
                    sequence: sequence++,
                    stage: 'stage-final',
                    data: { passed: true },
                });
            assert.equal(ok, false);
            assert(h.held.referenced);
            assert(fs.existsSync(h.lease.file));
            assert(!h.lease.state().released);
            assert(!h.journal.entry.attempted);
            assert(h.held.actual.snapshot().recordErrors.length);
            assert.equal(
                h.receiver.receive({
                    kind: 'pilot-evidence',
                    nonce,
                    bindingSHA256: binding,
                    sequence: h.state.sequence,
                    stage: 'stage-final',
                    data: { passed: true },
                }),
                false,
            );
        } finally {
            h.dispose();
        }
    });
for (const bad of ['nonce', 'bindingSHA256', 'sequence'])
    test('full channel envelope rejects unbound ' + bad, async () => {
        const h = await transport();
        try {
            const f = valid()[0],
                m = {
                    kind: 'pilot-evidence',
                    nonce,
                    bindingSHA256: binding,
                    sequence: 0,
                    stage: f.stage,
                    data: f.data,
                };
            m[bad] = bad === 'sequence' ? 1 : 'wrong';
            assert.equal(h.receiver.receive(m), false);
            assert(h.held.referenced);
            assert.equal(h.acks.length, 0);
            assert.equal(h.records.length, 0);
        } finally {
            h.dispose();
        }
    });
test('missing/duplicate manifests and interleaved advancement cannot revive identity admission', async () => {
    for (const scenario of [
        'duplicate manifest',
        'new manifest while active',
        'interleaved cold',
    ]) {
        const h = await transport();
        try {
            const frames = valid();
            let seq = 0;
            assert(
                h.receiver.receive({
                    kind: 'pilot-evidence',
                    nonce,
                    bindingSHA256: binding,
                    sequence: seq++,
                    ...frames[0],
                }),
            );
            if (scenario === 'duplicate manifest') {
                for (const f of frames.slice(1))
                    assert(
                        h.receiver.receive({
                            kind: 'pilot-evidence',
                            nonce,
                            bindingSHA256: binding,
                            sequence: seq++,
                            ...f,
                        }),
                    );
            }
            const f =
                scenario === 'interleaved cold'
                    ? { stage: 'aggregate-native-cold-baseline', data: {} }
                    : frames[0];
            assert.equal(
                h.receiver.receive({
                    kind: 'pilot-evidence',
                    nonce,
                    bindingSHA256: binding,
                    sequence: seq++,
                    ...f,
                }),
                false,
            );
            assert(h.held.referenced);
        } finally {
            h.dispose();
        }
    }
});
test('identity publication awaits durable ACKs atomically before later diagnostic or cold admission', async () => {
    let allow;
    const gate = new Promise((r) => (allow = r)),
        sent = [],
        diag = runtimeDiagnostics(
            async (s, d) => {
                sent.push(s);
                if (sent.length === 1) await gate;
            },
            () => {},
        );
    let done = false;
    const report = identity
        .reportStartupIdentity(diag.emit, logical, { v: 'x'.repeat(140000) })
        .then(() => (done = true));
    const later = diag.emit('later-diagnostic', {});
    await new Promise((r) => setImmediate(r));
    assert.equal(done, false);
    assert.deepEqual(sent, [identity.identityManifestStage]);
    allow();
    await report;
    await later;
    await diag.drain();
    assert.equal(sent.at(-1), 'later-diagnostic');
});
test('preflight refuses logical/row/total/pending limits with bounded stage and counter metadata before any identity frame', async () => {
    assert.throws(
        () => identity.planStartupIdentity(logical, { v: 'x'.repeat(4194304) }),
        (e) => e.reportingFailure.counter === 'logicalBytes',
    );
    for (const counter of ['rows', 'totalBytes', 'pendingBytes']) {
        const sent = [];
        let release;
        const gate = new Promise((r) => (release = r));
        const diag = runtimeDiagnostics(
            async (s, d) => {
                sent.push(s);
                if (counter === 'pendingBytes') await gate;
            },
            () => {},
        );
        const tasks = [];
        if (counter === 'rows') for (let i = 0; i < 1023; i++) await diag.emit('seed', {});
        if (counter === 'totalBytes')
            for (let i = 0; i < 140; i++) await diag.emit('seed', { v: 'x'.repeat(60000) });
        if (counter === 'pendingBytes')
            for (let i = 0; i < 4; i++) tasks.push(diag.emit('seed', { v: 'x'.repeat(60000) }));
        await assert.rejects(
            identity.reportStartupIdentity(diag.emit, logical, {
                v: 'x'.repeat(counter === 'totalBytes' ? 1000000 : 70000),
            }),
            (e) => {
                assert.equal(e.reportingFailure.counter, counter);
                assert.equal(e.reportingFailure.stage, logical);
                assert(Number.isFinite(e.reportingFailure.encodedBytes));
                return true;
            },
        );
        assert(!sent.includes(identity.identityManifestStage));
        release();
        await Promise.all(tasks);
        await diag.drain();
    }
});
test('parent reserves original logical and all journal wire bytes before accepting a manifest', async () => {
    const h = await transport({ totalSeed: 10485750 });
    try {
        await assert.rejects(
            identity.reportStartupIdentity(h.diagnostics.emit, logical, { v: 'x'.repeat(70000) }),
        );
        assert.equal(h.records.length, 0);
        assert.equal(h.acks.length, 0);
        assert(h.held.referenced);
        assert(fs.existsSync(h.lease.file));
    } finally {
        h.dispose();
    }
});
test('complete-wire 65536-byte boundary includes nonce/hash/sequence overhead and reports refusal metadata', async () => {
    for (const extra of [0, 1]) {
        const h = await transport();
        try {
            const base = {
                    kind: 'pilot-evidence',
                    nonce,
                    bindingSHA256: binding,
                    sequence: 0,
                    stage: 'boundary',
                    data: { v: '' },
                },
                n = 65536 - Buffer.byteLength(JSON.stringify(base)) + extra;
            const task = h.send('boundary', { v: 'x'.repeat(n) });
            if (extra)
                await assert.rejects(
                    task,
                    (e) =>
                        e.reportingFailure.counter === 'completeFrameBytes' &&
                        e.reportingFailure.encodedBytes === 65537,
                );
            else {
                await task;
                assert.equal(Buffer.byteLength(JSON.stringify(h.wire[0])), 65536);
                assert.equal(h.acks.length, 1);
            }
        } finally {
            h.dispose();
        }
    }
});
