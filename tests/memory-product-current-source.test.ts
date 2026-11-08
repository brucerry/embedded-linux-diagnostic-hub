import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as current from './fixtures/memory-product-current-observer';
import * as historical from './fixtures/memory-product-host-ownership';
import * as historicalNative from './fixtures/memory-product-native-main-transform';
import * as historicalState from './fixtures/memory-product-native-main-state';
import { observerSourceIdentity } from './fixtures/memory-product-source-profile';
const binding = (realm: current.HostRealm = 'native') => ({
    protocol: 2,
    production: current.currentObserverSource.commit,
    sourceTree: current.currentObserverSource.tree,
    realm,
    pins: current.hostPins(realm),
});
const oldBinding = (realm: current.HostRealm = 'native') => ({
    protocol: 1,
    production: '96a56cdbb462320c54fe74022d7436e665a31d31',
    realm,
    pins: historical.hostPins(realm),
});
const streams = () => ({
    currentStates: 0,
    retiringStates: 0,
    producers: 0,
    readers: 0,
    pendingAcks: 0,
    pendingDataBytes: 0,
    shutdownWaiters: 0,
});
const context = () => ({
    quit: { phase: 'ready' },
    captureOpening: 0,
    captureOpeningUnconfirmed: 0,
    collectionTask: null,
    connectionAttempts: { busy: false },
    hostVerification: { pending: null },
    reportExports: { owner: undefined, stopping: true },
    ownsProfile: true,
    updateOwnership: {
        operation: undefined,
        observations: new Set(),
        resources: new Map(),
        publications: new Map(),
        stopping: true,
    },
});

// Exact committed e9bb9bc blobs are source DATA only: never import, compile or launch them.
async function readE9SourceData(file: string) {
    const retained = [
        {
            source: 'electron/main.ts',
            data: 'memory-product-e9-main.txt',
            bytes: 37138,
            gitBlob: '21c3de8f5082d595e8559e870bd07ab2d4e081a9',
        },
        {
            source: 'shared/quit-cleanup.ts',
            data: 'memory-product-e9-quit-cleanup.txt',
            bytes: 6188,
            gitBlob: '0ebda34b40ce0d637ef5d2b4f02c827af9c8d3ac',
        },
    ].find((item) => file === path.join(process.cwd(), item.source));
    if (!retained) return fs.readFile(file, 'utf8');
    const bytes = await fs.readFile(new URL('./fixtures/' + retained.data, import.meta.url));
    assert.equal(bytes.length, retained.bytes);
    assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        current.nativeMainSourcePins[retained.source],
    );
    assert.equal(
        createHash('sha1')
            .update('blob ' + bytes.length + '\0')
            .update(bytes)
            .digest('hex'),
        retained.gitBlob,
    );
    return bytes.toString('utf8');
}

test('retained e9bb9bc profile pins exact source data and rejects newer worktree bytes without changing identities', async () => {
    assert.deepEqual(current.currentObserverSource, {
        commit: 'e9bb9bc2c599fc47f7f422d7dcae291337b55478',
        tree: 'f1119793f8109d4d81faba07ace52f43e346e4e4',
        scope: 'private-source-preparation-only',
    });
    assert.ok(Object.isFrozen(current.currentObserverSource));
    assert.ok(Object.isFrozen(current.nativeMainSourcePins));
    assert.equal(
        historicalNative.nativeMainSourcePins['electron/main.ts'],
        historicalState.nativeMainPreimage,
    );
    assert.equal(
        historicalState.nativeMainPreimage,
        '5c2fb3610fdf1801e521be69cc726572df82d4357c03a2c488695783855b78ef',
    );
    assert.equal(
        historical.hostOwnerSourcePins['backend/ssh/session.ts'],
        'e62a116121347e2a1eec0415441bfee3bb908ad5e7b9819c6c7befba8f0bba5f',
    );
    assert.equal(Object.keys(current.nativeMainSourcePins).length, 14);
    const changed = Object.keys(current.nativeMainSourcePins).filter(
        (file) =>
            current.nativeMainSourcePins[file] !== historicalNative.nativeMainSourcePins[file],
    );
    assert.deepEqual(changed.sort(), [
        'backend/ssh/session.ts',
        'electron/connection-attempts.ts',
        'electron/main.ts',
        'electron/report-export.ts',
        'electron/update-ownership.ts',
    ]);
    for (const [file, expected] of Object.entries(current.nativeMainSourcePins)) {
        const source = await readE9SourceData(path.join(process.cwd(), file));
        assert.equal(createHash('sha256').update(source).digest('hex'), expected);
    }
    await current.verifyNativeMainSources(process.cwd(), readE9SourceData);
    await assert.rejects(current.verifyNativeMainSources(process.cwd()), /preimage changed/);
    await assert.rejects(
        current.verifyNativeMainSources(process.cwd(), (file) =>
            file === path.join(process.cwd(), 'electron/main.ts')
                ? readE9SourceData(file)
                : fs.readFile(file, 'utf8'),
        ),
        /preimage changed: shared\/quit-cleanup\.ts/,
    );
    await assert.rejects(
        historicalNative.verifyNativeMainSources(process.cwd()),
        /preimage changed/,
    );
});

test('historical and current host schemas cannot admit each other, omitted tree or modified pins', () => {
    assert.deepEqual(historical.validateHostBinding(oldBinding(), 'native'), oldBinding());
    assert.deepEqual(current.validateHostBinding(binding(), 'native'), binding());
    assert.throws(() => current.validateHostBinding(oldBinding(), 'native'));
    assert.throws(() => historical.validateHostBinding(binding(), 'native'));
    for (const mutate of [
        (v: any) => {
            delete v.sourceTree;
        },
        (v: any) => {
            v.sourceTree = '0'.repeat(40);
        },
        (v: any) => {
            v.production = oldBinding().production;
        },
        (v: any) => {
            v.pins = oldBinding().pins;
        },
        (v: any) => {
            v.protocol = 1;
        },
        (v: any) => {
            v.extra = true;
        },
    ]) {
        const value = binding();
        mutate(value);
        assert.throws(() => current.validateHostBinding(value, 'native'));
    }
    assert.throws(() => observerSourceIdentity('unreviewed' as any));
    assert.throws(() => current.validateHostBinding(binding(), 'unsupported' as any));
});

test('current host source admission rejects the stale SSH dependency before observing model state', async () => {
    assert.deepEqual(await current.verifyProductHostSources(process.cwd(), 'native'), binding());
    await assert.rejects(
        historicalNative.verifyNativeMainSources(process.cwd()),
        /preimage changed/,
    );
    for (const file of Object.keys(current.hostPins('native'))) {
        const observation = current.createProductHostObservation(
            process.cwd(),
            'native',
            async (name) => {
                const source = await fs.readFile(name, 'utf8');
                return name.endsWith('/' + file) ? source + '\n' : source;
            },
        );
        assert.throws(
            () => observation.observeProductOwnership({ streams: streams() }),
            /unconfirmed/,
        );
        await assert.rejects(observation.beforeInit(), /preimage changed/);
        assert.throws(
            () => observation.observeProductOwnership({ streams: streams() }),
            /unconfirmed/,
        );
    }
});

test('current observation and readback retain counters and refuse historical evidence without rewriting it', () => {
    const snapshot = { streams: streams() };
    const old = historical.observeProductHost(snapshot, oldBinding(), 'native');
    const before = structuredClone(old);
    const now = current.observeProductHost(snapshot, binding(), 'native');
    assert.deepEqual(current.verifyProductHostObservation(now, snapshot, 'native'), now);
    assert.throws(() => current.verifyProductHostObservation(old, snapshot, 'native'));
    assert.throws(() => historical.verifyProductHostObservation(now, snapshot, 'native'));
    assert.deepEqual(old, before);
    assert.equal(current.assertHostStreamsRetired(now).scope, 'observed-host-stream-custody-only');
    const pending = current.observeProductHost(
        { streams: { ...streams(), retiringStates: 1 } },
        binding(),
        'native',
    );
    assert.throws(() => current.assertHostStreamsRetired(pending), /unconfirmed/);
});

test('current main model emits the current preimage and both profiles reject cross-profile retirement', () => {
    const input = context();
    const old = historicalState.observeNativeMain(input);
    const now = current.observeNativeMain(input);
    assert.equal(now.sourceMain, current.nativeMainPreimage);
    assert.equal(old.sourceMain, historicalState.nativeMainPreimage);
    assert.throws(() => current.assertNativeMainRetired(old));
    assert.throws(() => historicalState.assertNativeMainRetired(now));
    assert.equal(current.assertNativeMainRetired(now).processRetirement, 'not-implied');
    input.captureOpening = 1;
    assert.throws(
        () => current.assertNativeMainRetired(current.observeNativeMain(input)),
        /owner remains/,
    );
});

test('retained e9 nonshipping transform restores exact source data and refuses newer bytes, old binding, mutation and replay', async () => {
    const raw = await readE9SourceData(path.join(process.cwd(), 'electron/main.ts'));
    for (const anchor of [
        "    app.on('window-all-closed', () => app.quit());",
        '        return (captureHostPromise ??= NativeCaptureHost.open(',
        '        }));\n    };\n    const resetCaptureRenderer',
    ])
        assert.equal(raw.split(anchor).length, 2);
    const transformed = current.transformNativeOwnedSource(raw, 'electron/main.ts', binding());
    const restored = transformed.code
        .slice(transformed.importPrefix.length)
        .replace(transformed.observation + '\n', '')
        .replace(
            '        return (captureHostPromise ??= __memoryCaptureOpening.run(() => NativeCaptureHost.open(',
            '        return (captureHostPromise ??= NativeCaptureHost.open(',
        )
        .replace(
            '        })));\n    };\n    const resetCaptureRenderer',
            '        }));\n    };\n    const resetCaptureRenderer',
        );
    assert.equal(restored, raw);
    const newer = await fs.readFile('electron/main.ts', 'utf8');
    assert.throws(
        () => current.transformNativeOwnedSource(newer, 'electron/main.ts', binding()),
        /preimage/,
    );
    assert.ok(
        transformed.importPrefix.includes(
            "from '../tests/fixtures/memory-product-current-observer'",
        ),
    );
    assert.ok(
        !transformed.importPrefix.includes(
            "from '../tests/fixtures/memory-product-host-ownership'",
        ),
    );
    assert.throws(() => current.transformNativeOwnedSource(raw, 'electron/main.ts', oldBinding()));
    assert.throws(() =>
        historicalNative.transformNativeOwnedSource(raw, 'electron/main.ts', binding()),
    );
    assert.throws(() =>
        current.transformNativeOwnedSource(transformed.code, 'electron/main.ts', binding()),
    );
    for (const altered of [
        raw + '\n',
        raw.replace('NativeCaptureHost.open(', 'NativeCaptureHost.changed('),
        raw + "\n    app.on('window-all-closed', () => app.quit());",
    ])
        assert.throws(
            () => current.transformNativeOwnedSource(altered, 'electron/main.ts', binding()),
            /preimage/,
        );
});

test('active private hosts and readback explicitly select current wrappers without changing old workflow source', async () => {
    for (const file of [
        'tests/fixtures/memory-product-native-host.ts',
        'tests/fixtures/memory-product-gateway-host.ts',
        'tests/fixtures/memory-product-gateway.ts',
    ]) {
        const source = await fs.readFile(file, 'utf8');
        assert.ok(source.includes("from './memory-product-current-observer'"));
    }
    const source = await fs.readFile('tests/fixtures/memory-product-native-host.ts', 'utf8');
    assert.ok(
        source.indexOf('await verifyNativeMainSources(sourceRoot)') <
            source.indexOf('await fs.mkdir(desktop'),
    );
});

test('current shutdown model binds both current main and stream observations and rejects a mixed profile', () => {
    const ssh = { streams: streams() };
    const snapshot = {
        ssh,
        sshHasResources: false,
        consoleHasResources: false,
        streamOwnership: current.observeProductHost(ssh, binding(), 'native'),
        mainOwnership: current.observeNativeMain(context()),
        activity: { lease: false },
        capture: null,
        console: {
            references: 0,
            readers: 0,
            pins: 0,
            pendingReaders: 0,
            pendingPins: 0,
            requests: 0,
            exports: 0,
            transition: false,
            writer: false,
            closed: false,
        },
    };
    const options = { captureExpected: false, downloads: [] };
    assert.equal(
        current.assertProductNativeShutdown(snapshot, options).mainRetirement.processRetirement,
        'not-implied',
    );
    assert.throws(() =>
        current.assertProductNativeShutdown(
            { ...snapshot, mainOwnership: historicalState.observeNativeMain(context()) },
            options,
        ),
    );
    assert.throws(() =>
        current.assertProductNativeShutdown(
            {
                ...snapshot,
                streamOwnership: historical.observeProductHost(ssh, oldBinding(), 'native'),
            },
            options,
        ),
    );
});
