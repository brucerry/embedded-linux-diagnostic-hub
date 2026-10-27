import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { soakCoverage, viewerCoverage } from './memory-resource-core';

export const aggregatePending: Record<string, string> = {};
export const aggregateSupported = (viewer: boolean) =>
    [...soakCoverage, ...(viewer ? viewerCoverage : [])].filter(
        (id) => !Object.hasOwn(aggregatePending, id),
    );
export const serialLifecycleCoverage = {
    'pending-open': ['pending-open'],
    'held-write-cancel': ['cancel-write', 'blocked-write'],
    timeout: ['timeout'],
    'owner-loss': ['owner-loss'],
    'stale-generation': ['stale-generation'],
    'repeat-delay': ['run-repeat-delay'],
    'page-navigation': ['page-switch-active'],
    'unmount-remount': ['unmount-remount'],
} as const;
export function scheduledCatalog(ordinal: number, mode: string) {
    assert.ok(Number.isSafeInteger(ordinal) && ordinal >= 0);
    assert.equal(mode, ordinal % 2 ? 'growing' : 'constant');
    return ordinal % 2 === 0 ? 1 : ordinal % 4 === 1 ? 2 : 3;
}
export function serialExpectation(bytes: number, tail: string) {
    assert.ok(Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 64 * 1024 ** 2);
    const suffix = Buffer.from(tail);
    assert.ok(suffix.length <= Math.min(256, bytes));
    const hash = createHash('sha256'),
        block = Buffer.alloc(16384, 120);
    let left = bytes - suffix.length;
    while (left) {
        const count = Math.min(left, block.length);
        hash.update(block.subarray(0, count));
        left -= count;
    }
    hash.update(suffix);
    hash.update('\r\nqualification# ');
    return { bytes: bytes + Buffer.byteLength('\r\nqualification# '), sha256: hash.digest('hex') };
}

export interface AggregateWindowTransition {
    kind: 'browser' | 'native';
    requestedHidden: boolean;
    windowId: number;
    nativeWindowState: string;
    documentVisibility: DocumentVisibilityState;
    activityLeaseHeld: boolean | null;
    leaseRetained: boolean | null;
    backgroundThrottling: boolean | null;
}
export function assertAggregateWindowTransition(value: AggregateWindowTransition, hidden: boolean) {
    assert.equal(value.requestedHidden, hidden);
    assert.ok(Number.isSafeInteger(value.windowId) && value.windowId > 0);
    assert.equal(value.nativeWindowState, hidden ? 'minimized' : 'normal');
    if (value.kind === 'browser') {
        assert.equal(value.documentVisibility, hidden ? 'hidden' : 'visible');
        assert.equal(value.activityLeaseHeld, null);
        assert.equal(value.leaseRetained, null);
        assert.equal(value.backgroundThrottling, null);
    } else {
        assert.equal(value.kind, 'native');
        assert.equal(
            value.activityLeaseHeld,
            true,
            'Native minimization must retain the actual flow lease.',
        );
        assert.equal(
            value.leaseRetained,
            true,
            'Native window transition replaced its flow lease.',
        );
        assert.equal(
            value.backgroundThrottling,
            false,
            'Actual product background execution must stay enabled.',
        );
        // Electron keeps this visible while the production flow lease disables throttling.
        assert.equal(value.documentVisibility, 'visible');
    }
}
export function assertCoverageReceipt(actual: string[], viewer: boolean) {
    const supported = aggregateSupported(viewer);
    assert.equal(new Set(actual).size, actual.length);
    for (const item of actual)
        assert.ok(supported.includes(item as never), 'Unbound aggregate case: ' + item);
}

export function aggregateCaptureAccounting(
    before: readonly { id: string; committedBytes: number; observedBytes: number | null }[],
    after: readonly { id: string; committedBytes: number; observedBytes: number | null }[],
) {
    const prior = new Map(before.map((row) => [row.id, row]));
    assert.equal(prior.size, before.length);
    assert.equal(new Set(after.map((row) => row.id)).size, after.length);
    for (const row of before) {
        const current = after.find((value) => value.id === row.id);
        assert.ok(current, 'Capture vanished before accounting.');
        assert.equal(
            current.committedBytes,
            row.committedBytes,
            'A previous settled capture changed.',
        );
        assert.equal(
            current.observedBytes,
            row.observedBytes,
            'A previous observed byte count changed.',
        );
    }
    const created = after.filter((row) => !prior.has(row.id));
    for (const row of created) {
        assert.ok(Number.isSafeInteger(row.committedBytes) && row.committedBytes >= 0);
        assert.ok(
            row.observedBytes === null ||
                (Number.isSafeInteger(row.observedBytes) &&
                    row.observedBytes >= row.committedBytes),
        );
    }
    return {
        captures: created.map((row) => ({ ...row })),
        committedBytes: created.reduce((sum, row) => sum + row.committedBytes, 0),
        observedBytes: created.some((row) => row.observedBytes === null)
            ? null
            : created.reduce((sum, row) => sum + row.observedBytes!, 0),
        knownObservedSubtotal: created.reduce((sum, row) => sum + (row.observedBytes ?? 0), 0),
        unknownObservedCaptureIds: created
            .filter((row) => row.observedBytes === null)
            .map((row) => row.id),
        createdRecords: created.length,
        scope: 'Every actual newly-created automation capture before reconciliation, including successful rearms, partial, cancelled, quota and lifecycle captures. Requested bytes and non-capture console journals are separate.',
    };
}

/** Missing or malformed native resource flags cannot become zero-valued owner counts. */
export function aggregateNativeResourceCounts(value: unknown) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    const snapshot = value as Record<string, unknown>;
    const flag = (row: Record<string, unknown>, key: string) => {
        assert.ok(Object.hasOwn(row, key), 'Native resource flag absent: ' + key);
        assert.equal(typeof row[key], 'boolean', 'Native resource flag malformed: ' + key);
        return Number(row[key]);
    };
    assert.ok(Object.hasOwn(snapshot, 'activity'));
    const activity = snapshot.activity;
    assert.ok(activity && typeof activity === 'object' && !Array.isArray(activity));
    return {
        nativeSshResources: flag(snapshot, 'sshHasResources'),
        nativeConsoleResources: flag(snapshot, 'consoleHasResources'),
        nativeActivityLease: flag(activity as Record<string, unknown>, 'lease'),
    };
}

export function assertDistinctAggregateScopes(
    expected: { selected: readonly string[]; filtered: readonly string[]; all: readonly string[] },
    actual?: { selected: readonly string[]; filtered: readonly string[]; all: readonly string[] },
) {
    const normalized = Object.fromEntries(
        Object.entries(expected).map(([name, ids]) => [name, [...ids].sort()]),
    );
    assert.ok(
        new Set(Object.values(normalized).map((ids) => JSON.stringify(ids))).size === 3,
        'Selected/filtered/all memberships must discriminate an always-all exporter.',
    );
    for (const name of ['selected', 'filtered'] as const)
        assert.ok(expected[name].every((id) => expected.all.includes(id)));
    if (actual)
        for (const name of ['selected', 'filtered', 'all'] as const)
            assert.deepEqual(
                [...actual[name]].sort(),
                normalized[name],
                'Actual export membership mismatch: ' + name,
            );
    return normalized;
}
