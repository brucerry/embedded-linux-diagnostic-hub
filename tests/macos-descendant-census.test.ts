import assert from 'node:assert/strict';
import test from 'node:test';
import {
    inspectMacDescendantCensus,
    MAC_CENSUS_LIMITS,
} from '../scripts/lib/macos-descendant-census.mjs';

// Authored read-only census data, never a live process or native observation.
const schema = { schemaVersion: 1, kind: 'macos-descendant-census' };
const identity = (pid: number, start: number) => ({
    pid,
    startMicros: String(1_795_537_200_000_000 + start),
});
type Identity = ReturnType<typeof identity>;
const root = identity(50, 1),
    child = identity(51, 2),
    grandchild = identity(52, 3),
    launchd = identity(1, 0);
const row = (self: Identity, parent: Identity | null = null) => ({ identity: self, parent });
const expected = {
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
    root,
};
const sample = (phase: string, sequence: number, rows: ReturnType<typeof row>[]) => ({
    phase,
    sequence,
    elapsedMs: (sequence - 1) * 250,
    visibility: 'complete',
    rows,
});
const ready = () => sample('running', 1, [row(root)]);
const prequit = () => sample('prequit', 2, [row(root), row(child, root)]);
const retired = () => sample('postquit', 3, []);
const encode = (snapshots: unknown[], context = expected) =>
    Buffer.from(JSON.stringify({ ...schema, context, snapshots }) + '\n');
function inspect(snapshots: unknown[]) {
    const result = inspectMacDescendantCensus(encode(snapshots), expected);
    assert.equal(result.physicalDescendantClosure, false);
    assert.equal(result.releaseAcceptance, false);
    return result;
}

test('three complete synthetic samples record only absence of previously observed instances', () => {
    const result = inspect([ready(), prequit(), retired()]);
    assert.equal(result.status, 'observed-owned-instances-absent-unqualified');
    assert.deepEqual(result.problems, []);
    assert.equal(result.completeSnapshots, 3);
    assert.equal(result.observedDescendants, 1);
    assert.equal(result.observedInstancesAbsentInFinal, 2);
});

test('one complete snapshot and an entirely unavailable process history cannot establish retirement', () => {
    const onlyRunning = inspect([ready()]);
    assert.equal(onlyRunning.status, 'observed-history-incomplete');
    assert.equal(onlyRunning.observedInstancesAbsentInFinal, null);
    assert.ok(onlyRunning.problems.includes('missing-lifecycle-anchor'));
    for (const snapshots of [
        [],
        [{ ...ready(), visibility: 'unavailable', rows: [] }],
        [sample('postquit', 1, [row(identity(root.pid, 101))])],
    ]) {
        const result = inspect(snapshots);
        assert.equal(result.status, 'root-identity-unobserved');
        assert.equal(result.observedInstancesAbsentInFinal, null);
    }
});

test('complete snapshots cannot classify a new reparented child of a never-observed ancestor', () => {
    // Between polls an unseen child might spawn a helper, then disappear before the
    // helper is first seen under launchd. The same rows could describe an unrelated helper.
    const potentiallyReparented = identity(53, 5);
    const result = inspect([
        ready(),
        sample('prequit', 2, [row(root)]),
        sample('postquit', 3, [row(launchd), row(potentiallyReparented, launchd)]),
    ]);
    assert.equal(result.status, 'observed-owned-instances-absent-unqualified');
    assert.equal(result.observedDescendants, 0);
    assert.equal(result.observedInstancesAbsentInFinal, 1);
    assert.equal(result.physicalDescendantClosure, false);
    assert.equal(result.releaseAcceptance, false);
});

test('a known descendant is tracked through reparenting and brings its children into scope', () => {
    const result = inspect([
        ready(),
        prequit(),
        sample('closing', 3, [row(launchd), row(child, launchd), row(grandchild, child)]),
        sample('postquit', 4, [row(launchd), row(grandchild, launchd)]),
    ]);
    assert.equal(result.status, 'observed-owned-instances-still-present');
    assert.equal(result.rootSeenInFinal, false);
    assert.equal(result.observedDescendants, 2);
    assert.equal(result.observedDescendantsInFinal, 1);
    assert.equal(result.observedInstancesAbsentInFinal, 2);
});

test('recycled PIDs never substitute for the owned root or descendants', () => {
    const recycledRoot = identity(root.pid, 99);
    const recycled = identity(child.pid, 100);
    const result = inspect([
        ready(),
        prequit(),
        sample('postquit', 3, [
            row(recycledRoot),
            row(recycled, recycledRoot),
            row(grandchild, recycled),
        ]),
    ]);
    assert.equal(result.status, 'observed-owned-instances-absent-unqualified');
    assert.equal(result.observedDescendants, 1);
    assert.equal(result.rootSeenInFinal, false);
    assert.equal(result.observedDescendantsInFinal, 0);
});

test('positive root survival is not hidden by the expected postquit label', () => {
    const result = inspect([ready(), prequit(), sample('postquit', 3, [row(root)])]);
    assert.equal(result.status, 'observed-owned-instances-still-present');
    assert.equal(result.rootSeenInFinal, true);
});

test('missing or replaced exact parent identity keeps the history incomplete', () => {
    for (const claimedParent of [identity(root.pid, 99), identity(900, 12)]) {
        const result = inspect([
            ready(),
            sample('prequit', 2, [row(root), row(child, claimedParent)]),
            retired(),
        ]);
        assert.equal(result.status, 'observed-history-incomplete');
        assert.ok(result.problems.includes('parent-start-identity-unresolved'));
        assert.equal(result.observedDescendants, 0);
        assert.equal(result.observedInstancesAbsentInFinal, null);
    }
});

test('partial visibility and missing cadence cannot be converted into retirement with a clean final sample', () => {
    for (const [change, reason] of [
        [{ visibility: 'unavailable', rows: [] }, 'visibility-incomplete'],
        [{ visibility: 'incomplete' }, 'visibility-incomplete'],
        [{ sequence: 3 }, 'sequence-gap'],
        [{ elapsedMs: MAC_CENSUS_LIMITS.intervalMs + 1 }, 'observation-gap'],
        [{ elapsedMs: 0 }, 'observation-gap'],
        [{ phase: 'closing' }, 'missing-lifecycle-anchor'],
    ] as const) {
        const result = inspect([ready(), { ...prequit(), ...change }, retired()]);
        assert.equal(result.status, 'observed-history-incomplete');
        assert.ok(result.problems.includes(reason));
        assert.equal(result.observedInstancesAbsentInFinal, null);
    }
});

test('presence is retained but absence is unknown if the final observer read was incomplete', () => {
    const result = inspect([
        ready(),
        prequit(),
        { ...sample('postquit', 3, [row(child)]), visibility: 'incomplete' },
    ]);
    assert.equal(result.status, 'observed-history-incomplete');
    assert.equal(result.observedDescendantsInFinal, 1);
    assert.equal(result.observedInstancesAbsentInFinal, null);
});

test('same start identity reappearing after a declared complete absence makes history incomplete', () => {
    const result = inspect([
        ready(),
        prequit(),
        sample('closing', 3, []),
        sample('postquit', 4, [row(child)]),
    ]);
    assert.equal(result.status, 'observed-history-incomplete');
    assert.ok(result.problems.includes('missing-instance-reappeared'));
    assert.equal(result.observedInstancesAbsentInFinal, null);
});

test('refuses ambiguous PID rows, cyclic ancestry and unsupported process identity', () => {
    for (const rows of [
        [row(root), row(identity(root.pid, 99))],
        [row(root, child), row(child, root)],
        [row(root, root)],
        [row({ ...root, startMicros: 'rounded-time' })],
        [row({ ...root, startMicros: '0000000000000042' })],
    ])
        assert.throws(() => inspect([sample('running', 1, rows)]));
});

test('will not select its own run, attempt, package, source, offline envelope or root', () => {
    for (const delta of [
        { runId: '321' },
        { runAttempt: '1' },
        { lane: 'darwin-x64' },
        { sourceCommit: 'f'.repeat(40) },
        { sourceTree: 'f'.repeat(40) },
        { archiveSHA256: 'f'.repeat(64) },
        { offlineEvidenceSHA256: 'f'.repeat(64) },
        { observationId: 'f'.repeat(32) },
        { root: identity(root.pid, 99) },
    ])
        assert.throws(
            () => inspectMacDescendantCensus(encode([], { ...expected, ...delta }), expected),
            /does not bind/,
        );
});

test('record, snapshot, and row limits are hard; JSON must be canonical', () => {
    assert.throws(() =>
        inspectMacDescendantCensus(Buffer.alloc(MAC_CENSUS_LIMITS.bytes + 1), expected),
    );
    assert.throws(() => inspect(Array(MAC_CENSUS_LIMITS.snapshots + 1).fill(ready())));
    assert.throws(() =>
        inspect([
            sample('running', 1, Array(MAC_CENSUS_LIMITS.rowsPerSnapshot + 1).fill(row(root))),
        ]),
    );
    assert.throws(
        () =>
            inspectMacDescendantCensus(
                Buffer.from(
                    encode([])
                        .toString()
                        .replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
                ),
                expected,
            ),
        /canonical/,
    );
});

test('ever-observed instance count is bounded even within one valid snapshot', () => {
    const rows = [
        row(root),
        ...Array.from({ length: MAC_CENSUS_LIMITS.observedInstances }, (_, i) =>
            row(identity(100 + i, 100 + i), root),
        ),
    ];
    assert.throws(() => inspect([sample('running', 1, rows)]));
});
