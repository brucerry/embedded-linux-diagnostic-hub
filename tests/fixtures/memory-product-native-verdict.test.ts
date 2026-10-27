import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProductNativeShutdown } from './memory-product-native-verdict';

const valid = () => ({
    sshHasResources: false,
    consoleHasResources: false,
    activity: { lease: false, suspended: false },
    capture: {
        owners: { writer: 0, reader: 0, pin: 0, export: 0, rpc: 0, cleanup: 0 },
        services: { rpcTimer: false, storeOpen: false, catalogOpen: false },
        cache: { completed: 12, expiredPins: 3 },
    },
    // No journal was ever opened: this is intentionally not an ended=true requirement.
    console: { closed: false },
});
const options = () => ({
    captureExpected: true,
    downloads: [{ state: 'completed' }],
});
const rejects = (snapshot: unknown, input: unknown = options()) =>
    assert.throws(() => assertProductNativeShutdown(snapshot, input as ReturnType<typeof options>));

test('actual named shutdown owners and terminal downloads pass with cached metadata separate', () => {
    const result = assertProductNativeShutdown(valid(), {
        captureExpected: true,
        downloads: [{ state: 'completed' }, { state: 'cancelled' }, { state: 'interrupted' }],
    });
    assert.equal(result.verified, true);
    assert.equal(result.capturePresent, true);
    assert.deepEqual(result.cachedMetadata, { completed: 12, expiredPins: 3 });
    assert.deepEqual(result.downloadStates, {
        completed: 1,
        cancelled: 1,
        interrupted: 1,
    });
});

test('never-created capture and console journal require actual resource booleans, not fake closed status', () => {
    const snapshot = { ...valid(), capture: null };
    assert.equal(
        assertProductNativeShutdown(snapshot, {
            captureExpected: false,
            downloads: [],
        }).capturePresent,
        false,
    );
    rejects(snapshot);
    rejects({ ...valid(), capture: undefined }, { captureExpected: false, downloads: [] });
});

test('missing, inherited, malformed and truthy-coerced native resource facts fail closed', () => {
    for (const snapshot of [undefined, null, [], 0, 'false', {}]) rejects(snapshot);
    for (const key of ['sshHasResources', 'consoleHasResources'] as const) {
        for (const value of [true, undefined, null, 0, '', 'false', [], {}])
            rejects({ ...valid(), [key]: value });
        const snapshot: Record<string, unknown> = valid();
        delete snapshot[key];
        rejects(snapshot);
    }
    const inherited = Object.create({ sshHasResources: false });
    Object.assign(inherited, valid());
    delete inherited.sshHasResources;
    rejects(inherited);
    for (const activity of [null, {}, { lease: true }, { lease: 0 }, { lease: undefined }])
        rejects({ ...valid(), activity });
    rejects(valid(), { captureExpected: undefined, downloads: [] });
});

test('every named capture owner rejects pending, missing and malformed counts', () => {
    for (const name of ['writer', 'reader', 'pin', 'export', 'rpc', 'cleanup']) {
        for (const count of [1, -1, '0', false, null, undefined, NaN, Infinity, 0.5]) {
            const snapshot = valid();
            Object.assign(snapshot.capture.owners, { [name]: count });
            rejects(snapshot);
        }
        const snapshot = valid();
        delete (snapshot.capture.owners as Record<string, unknown>)[name];
        rejects(snapshot);
    }
    const snapshot = valid();
    Object.assign(snapshot.capture.owners, { newOwner: 0 });
    rejects(snapshot);
});

test('all actual capture services must be false after shutdown, and unknown services require review', () => {
    for (const name of ['rpcTimer', 'storeOpen', 'catalogOpen']) {
        for (const state of [true, undefined, null, 0, 'false']) {
            const snapshot = valid();
            Object.assign(snapshot.capture.services, { [name]: state });
            rejects(snapshot);
        }
        const snapshot = valid();
        delete (snapshot.capture.services as Record<string, unknown>)[name];
        rejects(snapshot);
    }
    const snapshot = valid();
    Object.assign(snapshot.capture.services, { timer2: false });
    rejects(snapshot);
});

test('provided capture is validated even if no host was expected; cache never becomes active owners', () => {
    const snapshot = valid();
    snapshot.capture.owners.rpc = 1;
    rejects(snapshot, { captureExpected: false, downloads: [] });
    for (const cache of [undefined, null, {}, { completed: NaN, expiredPins: 0 }]) {
        const snapshot = valid();
        Object.assign(snapshot.capture, { cache });
        rejects(snapshot);
    }
});

test('started, missing and unknown actual download states cannot be accepted as terminal', () => {
    for (const downloads of [
        undefined,
        null,
        {},
        [null],
        [{}],
        [{ state: 'started' }],
        [{ state: 'done' }],
    ])
        rejects(valid(), { captureExpected: true, downloads });
    assert.deepEqual(
        assertProductNativeShutdown(valid(), {
            captureExpected: true,
            downloads: [],
        }).downloadStates,
        { completed: 0, cancelled: 0, interrupted: 0 },
    );
});

test('old parse-only shutdown receipt accepted failed shutdown snapshots; new verdict rejects each', () => {
    // Exact former acceptance boundary: JSON parsed and emitted after code0/PID exit, no owner assertion.
    const oldParseOnly = (snapshot: unknown) => JSON.parse(JSON.stringify({ snapshot })).snapshot;
    const failures = [
        { ...valid(), sshHasResources: true },
        { ...valid(), consoleHasResources: true },
        { ...valid(), activity: { lease: true } },
        {
            ...valid(),
            capture: {
                ...valid().capture,
                owners: { ...valid().capture.owners, export: 1 },
            },
        },
        {
            ...valid(),
            capture: {
                ...valid().capture,
                services: { ...valid().capture.services, rpcTimer: true },
            },
        },
        {
            ...valid(),
            capture: {
                ...valid().capture,
                services: { ...valid().capture.services, storeOpen: true },
            },
        },
        { ...valid(), capture: null },
    ];
    for (const snapshot of failures) {
        assert.ok(oldParseOnly(snapshot));
        rejects(snapshot);
    }
    const pending = [{ state: 'started' }];
    assert.ok(oldParseOnly(valid()));
    rejects(valid(), { captureExpected: true, downloads: pending });
});
