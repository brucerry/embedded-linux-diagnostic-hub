import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from '@playwright/test';
import type { ProductGateway } from './memory-product-gateway';
import type { ProductSshRead } from './memory-product-ssh-ui';
import {
    assertNativeProductTarget,
    assertNativeProductTrust,
    assertNativeProductSshActive,
    assertNativeProductSshReleased,
    assertNativeProductSshLoss,
    exerciseProductNativeSsh,
} from './memory-product-native-ssh-ui';

const target = () => ({
    host: '127.0.0.1',
    port: 22222,
    username: 'qualification',
    auth: 'password' as const,
    password: 'synthetic-local-only',
    expectedFingerprint: 'SHA256:' + 'A'.repeat(43),
});
const main = () => ({
    sshHasResources: true,
    capture: { owners: { writer: 0, reader: 0, pin: 0, export: 0, rpc: 0, cleanup: 0 } },
    ssh: {
        connected: true,
        connections: [{ current: true }],
        terminals: [],
        terminal: null,
        collecting: false,
        pendingOperations: 0,
        independentExecution: 0,
        consoleActor: 0,
        clockRead: 0,
        streams: {
            currentStates: 0,
            retiringStates: 0,
            producers: 0,
            readers: 0,
            pendingAcks: 0,
            pendingDataBytes: 0,
            shutdownWaiters: 0,
        },
        execSlots: { active: 0, queued: 0 },
    },
});
const active = () => {
    const value = main();
    value.capture.owners.writer = 2;
    value.ssh.independentExecution = 1;
    value.ssh.streams.currentStates = 1;
    value.ssh.streams.producers = 1;
    return value;
};
const disconnected = () => {
    const value = main();
    value.ssh.connected = false;
    value.ssh.connections = [];
    value.sshHasResources = false;
    return value;
};
const row = () => ({
    id: 'fixture-capture',
    state: 'incomplete' as const,
    committedBytes: 0,
    observedBytes: null,
    command: 'stalled-native',
    failure: { code: 'io', message: 'Synthetic transport loss' },
});
const lostRead = () =>
    ({
        bytes: 0,
        frames: 0,
        streamBytes: { stdout: 0, stderr: 0, serial: 0 },
        streamSamples: { stdout: [], stderr: [], serial: [] },
        crcAndBoundariesVerified: true,
        outcome: { completion: 'transport-error', exitCode: null },
    }) as unknown as ProductSshRead;

test('only owned loopback target settings and the exact prior UI-confirmed pin receipt are accepted', () => {
    const expected = assertNativeProductTarget(target()),
        trust = { source: 'actual-native-host-dialog' as const, ...expected };
    assert.deepEqual(assertNativeProductTrust(trust, expected), trust);
    for (const host of ['192.168.1.1', 'example.com', '0.0.0.0', 'localhost'])
        assert.throws(() => assertNativeProductTarget({ ...target(), host }));
    for (const change of [
        { expectedFingerprint: '' },
        { password: '' },
        { port: 0 },
        { expectedFingerprint: 'unknown' },
    ])
        assert.throws(() => assertNativeProductTarget({ ...target(), ...change }));
    assert.throws(() =>
        assertNativeProductTrust({ ...trust, fingerprint: 'SHA256:other' }, expected),
    );
    assert.throws(() => assertNativeProductTrust({ ...trust, endpoint: '127.0.0.1:22' }, expected));
    assert.throws(() =>
        assertNativeProductTrust(
            { ...trust, source: 'gateway-http' as typeof trust.source },
            expected,
        ),
    );
});

test('native active proof requires actual main independent producer and raw writer, never console/legacy ownership', () => {
    assert.equal(assertNativeProductSshActive(active()).independentExecution, 1);
    for (const path of ['independentExecution', 'producers', 'writer']) {
        const value = active();
        if (path === 'independentExecution') value.ssh.independentExecution = 0;
        else if (path === 'producers') value.ssh.streams.producers = 0;
        else value.capture.owners.writer = 0;
        assert.throws(() => assertNativeProductSshActive(value));
    }
    const consoleOnly = active();
    consoleOnly.ssh.consoleActor = 1;
    assert.throws(() => assertNativeProductSshActive(consoleOnly));
    for (const value of [null, {}, { ssh: active().ssh }, { ...active(), capture: null }])
        assert.throws(() => assertNativeProductSshActive(value));
    const missing = active();
    delete (missing.ssh.streams as Record<string, unknown>).pendingAcks;
    assert.throws(() => assertNativeProductSshActive(missing));
    const malformed = active();
    Object.assign(malformed.ssh.streams, { producers: '1' });
    assert.throws(() => assertNativeProductSshActive(malformed));
});

test('native release proof rejects every outstanding stream/raw owner and unknown facts', () => {
    assert.equal(assertNativeProductSshReleased(main(), false).disconnected, false);
    assert.equal(assertNativeProductSshReleased(disconnected(), true).disconnected, true);
    for (const key of [
        'currentStates',
        'retiringStates',
        'producers',
        'readers',
        'pendingAcks',
        'pendingDataBytes',
        'shutdownWaiters',
    ]) {
        const value = disconnected();
        Object.assign(value.ssh.streams, { [key]: 1 });
        assert.throws(() => assertNativeProductSshReleased(value, true));
    }
    for (const key of ['writer', 'reader', 'pin', 'export', 'rpc', 'cleanup']) {
        const value = disconnected();
        Object.assign(value.capture.owners, { [key]: 1 });
        assert.throws(() => assertNativeProductSshReleased(value, true));
    }
    for (const key of ['pendingOperations', 'independentExecution', 'consoleActor', 'clockRead']) {
        const value = disconnected();
        Object.assign(value.ssh, { [key]: 1 });
        assert.throws(() => assertNativeProductSshReleased(value, true));
    }
    for (const key of ['active', 'queued']) {
        const value = disconnected();
        Object.assign(value.ssh.execSlots, { [key]: 1 });
        assert.throws(() => assertNativeProductSshReleased(value, true));
    }
    for (const value of [
        { ...disconnected(), sshHasResources: undefined },
        { ...disconnected(), sshHasResources: true },
        { ...disconnected(), ssh: { ...disconnected().ssh, terminals: undefined } },
        { ...disconnected(), ssh: { ...disconnected().ssh, connections: [{ current: true }] } },
    ])
        assert.throws(() => assertNativeProductSshReleased(value, true));
});

test('unassessed/missing native stream metadata cannot be defaulted to zero', () => {
    for (const key of [
        'connected',
        'collecting',
        'pendingOperations',
        'independentExecution',
        'consoleActor',
        'clockRead',
        'connections',
        'terminals',
        'execSlots',
        'streams',
    ]) {
        const value = disconnected();
        delete (value.ssh as Record<string, unknown>)[key];
        assert.throws(() => assertNativeProductSshReleased(value, true));
    }
    for (const n of [undefined, null, -1, NaN, Infinity, '0', false]) {
        const value = disconnected();
        Object.assign(value.ssh.streams, { pendingAcks: n });
        assert.throws(() => assertNativeProductSshReleased(value, true));
    }
    for (const collection of ['streams', 'execSlots', 'owners']) {
        const value = disconnected();
        Object.assign(
            collection === 'owners'
                ? value.capture.owners
                : collection === 'streams'
                  ? value.ssh.streams
                  : value.ssh.execSlots,
            { unknownOwner: 0 },
        );
        assert.throws(() => assertNativeProductSshReleased(value, true));
    }
});

test('stalled actual-loss guard rejects timeout, invented success/exit and unverified or produced output', () => {
    assert.equal(assertNativeProductSshLoss(row(), lostRead()).completion, 'transport-error');
    const timeout = lostRead();
    timeout.outcome!.completion = 'timeout';
    assert.throws(() => assertNativeProductSshLoss(row(), timeout));
    const success = lostRead();
    success.outcome!.completion = 'exit';
    success.outcome!.exitCode = 0;
    assert.throws(() => assertNativeProductSshLoss(row(), success));
    const unverified = lostRead();
    unverified.crcAndBoundariesVerified = false;
    assert.throws(() => assertNativeProductSshLoss(row(), unverified));
    const bytes = lostRead();
    bytes.bytes = 1;
    assert.throws(() => assertNativeProductSshLoss({ ...row(), committedBytes: 1 }, bytes));
    const missing = lostRead();
    missing.outcome = null;
    assert.equal(assertNativeProductSshLoss(row(), missing).completion, null);
});

test('unsupported console/unknown scenario refuses before any page or target operation', async () => {
    let calls = 0;
    const page = new Proxy(
        {},
        {
            get() {
                calls++;
                throw Error('A product operation was attempted.');
            },
        },
    ) as Page;
    await assert.rejects(
        exerciseProductNativeSsh(page, {} as ProductGateway, {
            ordinal: 0,
            payloadBytes: 4,
            scenarios: ['native-console-mode' as 'stream'],
            snapshot: async () => {
                calls++;
                return main();
            },
        }),
        /Unsupported native SSH scenario/,
    );
    assert.equal(calls, 0);
});
