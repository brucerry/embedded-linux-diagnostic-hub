import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleMacCensusPort } from '../scripts/lib/macos-census-port.mjs';
import {
    inspectMacDescendantCensus,
    MAC_CENSUS_LIMITS,
} from '../scripts/lib/macos-descendant-census.mjs';

// Fake normalized return records only, not claims about the layout/status of a native SDK.
const bytes = 128;
const micro = (offset: number) => String(1_795_537_200_000_000 + offset);
const identity = (pid: number, offset = pid) => ({ pid, startMicros: micro(offset) });
const info = (pid: number, parentPid = 0, state = 'live', offset = pid) => ({
    ...identity(pid, offset),
    parentPid,
    state,
});
const details = (pid: number) => (pid === 50 ? info(50, 1) : pid === 51 ? info(51, 50) : info(pid));
const full = (pid: number) => ({ returnedBytes: bytes, info: details(pid) });
const listed = (pids: number[]) => ({ pidCount: pids.length, pids });
const running = { sequence: 1, elapsedMs: 0, phase: 'running' };
const prequit = { sequence: 2, elapsedMs: 250, phase: 'prequit' };
const postquit = { sequence: 3, elapsedMs: 500, phase: 'postquit' };
const port = (overrides = {}) => ({
    expectedDetailBytes: bytes,
    list: () => listed([0, 51, 1, 50]),
    detail: full,
    ...overrides,
});
const basic = (overrides = {}, label = running) => sampleMacCensusPort(port(overrides), label);

test('stable reads are bounded, deterministic, and only retain the normalized PID identity graph', () => {
    const calls: string[] = [];
    const out = basic({
        list: (capacity: number) => {
            calls.push(`list-${capacity}`);
            return listed([51, 0, 50, 1]);
        },
        detail: (pid: number) => {
            calls.push(`detail-${pid}`);
            return {
                ...full(pid),
                info: { ...details(pid), privateCommandLine: 'never copied' },
            };
        },
    });
    assert.deepEqual(calls, [
        'list-256',
        'detail-1',
        'detail-50',
        'detail-51',
        'detail-1',
        'detail-50',
        'detail-1',
        'detail-51',
        'detail-50',
        'list-256',
    ]);
    assert.deepEqual(out, {
        sample: {
            ...running,
            visibility: 'complete',
            rows: [
                { identity: identity(1), parent: null },
                { identity: identity(50), parent: identity(1) },
                { identity: identity(51), parent: identity(50) },
            ],
        },
        states: [1, 50, 51].map((pid) => ({ pid, state: 'live' })),
        problems: [],
    });
});

test('enumeration retries saturation geometrically and discards data from the full read', () => {
    const caps: number[] = [];
    const out = basic({
        list: (capacity: number) => {
            caps.push(capacity);
            return capacity === 256 ? { pidCount: capacity, pids: [999] } : listed([1, 50, 51]);
        },
    });
    assert.deepEqual(caps, [256, 512, 512]);
    assert.equal(out.sample.visibility, 'complete');
    assert.deepEqual(out.problems, []);
    assert.equal(
        out.sample.rows.some(({ identity }) => identity.pid === 999),
        false,
    );
});

test('saturation at cap is unavailable and never falls through to detail', () => {
    const caps: number[] = [];
    const out = basic({
        list: (capacity: number) => {
            caps.push(capacity);
            return { pidCount: capacity, pids: [] };
        },
        detail: () => assert.fail('truncated enumeration must not drive detail'),
    });
    assert.deepEqual(caps, [256, 512, 1024, 2048, 4096, MAC_CENSUS_LIMITS.rowsPerSnapshot]);
    assert.deepEqual(out, {
        sample: { ...running, visibility: 'unavailable', rows: [] },
        problems: ['enumeration-saturated'],
        states: null,
    });
});

test('zero/error and malformed lists are unavailable, not empty complete censuses', () => {
    for (const [list, reason] of [
        [() => listed([]), 'enumeration-zero'],
        [
            () => {
                throw new Error('untrusted port details');
            },
            'enumeration-port-error',
        ],
        [() => listed([0]), 'no-user-pids-visible'],
        [() => listed([1, 50, 50]), 'enumeration-invalid'],
        [() => listed([1, -1]), 'enumeration-invalid'],
        [() => listed([1, ...Array<number>(1)]), 'enumeration-invalid'],
        [() => ({ pidCount: 3, pids: [1, 50] }), 'enumeration-invalid'],
    ] as const) {
        const out = basic({ list, detail: () => assert.fail('invalid list drove detail') });
        assert.equal(out.sample.visibility, 'unavailable');
        assert.deepEqual(out.sample.rows, []);
        assert.deepEqual(out.problems, [reason]);
        assert.equal(out.states, null);
    }
});

test('failed or changed ending enumeration blocks visibility; reordering is not a change', () => {
    for (const [ending, reason] of [
        [listed([1, 50]), 'enumerated-membership-changed'],
        [listed([1, 50, 52]), 'enumerated-membership-changed'],
        [listed([]), 'enumeration-zero'],
    ] as const) {
        let calls = 0;
        const out = basic({ list: () => (++calls === 1 ? listed([1, 50, 51]) : ending) });
        assert.equal(out.sample.visibility, 'incomplete');
        assert.deepEqual(out.sample.rows, []);
        assert.equal(out.states, null);
        assert.deepEqual(out.problems, [reason]);
    }
    let calls = 0;
    assert.equal(
        basic({ list: () => (++calls === 1 ? listed([1, 50, 51]) : listed([51, 1, 50])) }).sample
            .visibility,
        'complete',
    );
});

test('zero detail for a listed PID, a short read and unknown state never assert absence or decode partial data', () => {
    for (const [makeResponse, reason] of [
        [() => ({ returnedBytes: 0 }), 'detail-zero'],
        [() => ({ returnedBytes: bytes - 1, info: details(51) }), 'detail-short'],
        [() => ({ returnedBytes: bytes + 1, info: details(51) }), 'detail-invalid'],
        [
            () => ({ returnedBytes: bytes, info: info(51, 50, 'unknown') }),
            'detail-state-unresolved',
        ],
        [() => ({ returnedBytes: bytes, info: info(52, 50) }), 'detail-invalid'],
        [() => ({ returnedBytes: bytes, info: info(51, 51) }), 'detail-invalid'],
        [
            () => ({ returnedBytes: bytes, info: { ...details(51), startMicros: '01' } }),
            'detail-invalid',
        ],
        [
            () => {
                throw Error('unknown native error');
            },
            'detail-port-error',
        ],
    ] as const) {
        let reads = 0;
        const out = basic({
            detail: (pid: number) => (pid === 51 && ++reads === 2 ? makeResponse() : full(pid)),
        });
        assert.equal(out.sample.visibility, 'incomplete');
        assert.deepEqual(out.problems, [reason]);
        assert.deepEqual(
            out.states?.find(({ pid }) => pid === 51),
            { pid: 51, state: 'unresolved' },
        );
        assert.equal(
            out.sample.rows.some(({ identity }) => identity.pid === 51),
            false,
        );
    }
});

test('same numeric PID with changed start, parent or state does not form a stable record', () => {
    for (const [newInfo, reason] of [
        [info(51, 50, 'live', 100), 'pid-instance-changed'],
        [info(51, 1, 'live'), 'detail-changed'],
        [info(51, 50, 'unreaped'), 'detail-changed'],
    ] as const) {
        let reads = 0;
        const out = basic({
            detail: (pid: number) =>
                pid === 51 && ++reads === 2 ? { returnedBytes: bytes, info: newInfo } : full(pid),
        });
        assert.equal(out.sample.visibility, 'incomplete');
        assert.deepEqual(out.problems, [reason]);
        assert.deepEqual(out.states?.at(-1), { pid: 51, state: 'unresolved' });
        assert.equal(
            out.sample.rows.some(({ identity }) => identity.pid === 51),
            false,
        );
    }
});

test('recycled parent after its initial reads cannot create an edge from a stable child PPID', () => {
    let reads = 0;
    const out = basic({
        detail: (pid: number) =>
            pid === 50 && ++reads === 3
                ? { returnedBytes: bytes, info: info(50, 1, 'live', 100) }
                : full(pid),
    });
    assert.equal(out.sample.visibility, 'incomplete');
    assert.deepEqual(out.problems, ['parent-instance-unresolved']);
    assert.deepEqual(out.sample.rows.at(-1), { identity: identity(51), parent: null });
    assert.deepEqual(
        out.states?.find(({ pid }) => pid === 50),
        { pid: 50, state: 'unresolved' },
    );
});

test('a later parent state change invalidates the stale living state and every edge to it', () => {
    let reads = 0;
    const out = basic({
        list: () => listed([1, 50, 51, 52]),
        detail: (pid: number) => {
            if (pid === 50 && ++reads === 4)
                return { returnedBytes: bytes, info: info(50, 1, 'unreaped') };
            if (pid === 52) return { returnedBytes: bytes, info: info(52, 50) };
            return full(pid);
        },
    });
    assert.equal(out.sample.visibility, 'incomplete');
    assert.deepEqual(out.problems, ['parent-instance-unresolved']);
    assert.deepEqual(
        out.states?.find(({ pid }) => pid === 50),
        { pid: 50, state: 'unresolved' },
    );
    assert.equal(
        out.sample.rows.some(({ identity, parent }) => identity.pid === 50 || parent?.pid === 50),
        false,
    );
});

test('missing exact parent and contradictory cycles conservatively remove unsupported edges', () => {
    const missing = basic({
        list: () => listed([1, 51]),
    });
    assert.equal(missing.sample.visibility, 'incomplete');
    assert.deepEqual(missing.problems, ['parent-instance-unresolved']);
    assert.deepEqual(missing.sample.rows.at(-1), { identity: identity(51), parent: null });
    const cycle = basic({
        detail: (pid: number) =>
            pid === 50 ? { returnedBytes: bytes, info: info(50, 51) } : full(pid),
    });
    assert.equal(cycle.sample.visibility, 'incomplete');
    assert.deepEqual(cycle.problems, ['parent-cycle']);
    assert.ok(cycle.sample.rows.every(({ parent }) => parent === null));
});

const context = {
    version: '0.6.0',
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    runId: '123',
    runAttempt: '2',
    lane: 'darwin-arm64',
    caseId: 'macos-bundle:offline-launch',
    archiveSHA256: 'c'.repeat(64),
    offlineEvidenceSHA256: 'd'.repeat(64),
    observationId: 'e'.repeat(32),
    root: identity(50),
};
function inspect(final: ReturnType<typeof basic>['sample']) {
    const record = {
        schemaVersion: 1,
        kind: 'macos-descendant-census',
        context,
        snapshots: [basic().sample, basic({}, prequit).sample, final],
    };
    const out = inspectMacDescendantCensus(Buffer.from(JSON.stringify(record) + '\n'), context);
    assert.equal(out.physicalDescendantClosure, false);
    assert.equal(out.releaseAcceptance, false);
    return out;
}

test('stable unreaped is not living, unresolved or retired through the actual v1 entry', () => {
    const unreaped = basic(
        {
            list: () => listed([1, 51]),
            detail: (pid: number) =>
                pid === 51 ? { returnedBytes: bytes, info: info(51, 1, 'unreaped') } : full(pid),
        },
        postquit,
    );
    assert.equal(unreaped.sample.visibility, 'complete');
    assert.deepEqual(unreaped.states, [
        { pid: 1, state: 'live' },
        { pid: 51, state: 'unreaped' },
    ]);
    const visible = inspect(unreaped.sample);
    assert.equal(visible.status, 'observed-owned-instances-still-present');
    assert.equal(visible.observedDescendantsInFinal, 1);
    assert.equal(visible.observedInstancesAbsentInFinal, 1);

    const unresolved = basic(
        {
            list: () => listed([1, 51]),
            detail: (pid: number) => (pid === 51 ? { returnedBytes: 0 } : full(pid)),
        },
        postquit,
    );
    assert.deepEqual(unresolved.states?.at(-1), { pid: 51, state: 'unresolved' });
    const unknown = inspect(unresolved.sample);
    assert.equal(unknown.status, 'observed-history-incomplete');
    assert.equal(unknown.observedInstancesAbsentInFinal, null);

    const reaped = basic({ list: () => listed([1]) }, postquit);
    const nonqualified = inspect(reaped.sample);
    assert.equal(nonqualified.status, 'observed-owned-instances-absent-unqualified');
    assert.equal(nonqualified.observedInstancesAbsentInFinal, 2);
});

test('rejects invalid port ABI configuration and out-of-budget caller metadata', () => {
    assert.throws(() => basic({ expectedDetailBytes: 0 }));
    assert.throws(() => basic({ expectedDetailBytes: 4097 }));
    assert.throws(() => basic({}, { ...running, phase: 'unsupported' }));
    assert.throws(() => basic({}, { ...running, elapsedMs: MAC_CENSUS_LIMITS.observationMs + 1 }));
    assert.throws(() => basic({}, { ...running, sequence: MAC_CENSUS_LIMITS.snapshots + 1 }));
});
