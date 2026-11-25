import assert from 'node:assert/strict';

export const MAC_CENSUS_LIMITS = Object.freeze({
    bytes: 4 * 1024 * 1024,
    snapshots: 512,
    rowsPerSnapshot: 8192,
    totalRows: 131_072,
    observedInstances: 1024,
    observationMs: 240_000,
    intervalMs: 1000,
});
const contextFields = [
    'version',
    'sourceCommit',
    'sourceTree',
    'runId',
    'runAttempt',
    'lane',
    'caseId',
    'archiveSHA256',
    'offlineEvidenceSHA256',
    'observationId',
    'root',
];
const phaseIndex = Object.freeze({ running: 0, prequit: 1, closing: 2, postquit: 3 });

function keys(value, wanted) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...wanted].sort(), 'Unexpected Mac census shape.');
}
function processIdentity(value) {
    keys(value, ['pid', 'startMicros']);
    assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2_147_483_647);
    // An exact process start identity in an independently bound observation session; a PID,
    // process name or rounded start time does not qualify as an observer's identity source.
    assert.match(value.startMicros, /^[1-9][0-9]{0,15}$/);
    return `${value.pid}:${value.startMicros}`;
}
function validateContext(value) {
    keys(value, contextFields);
    assert.match(value.version, /^\d{1,10}\.\d{1,10}\.\d{1,10}(?:-[A-Za-z0-9.-]{1,64})?$/);
    for (const field of ['sourceCommit', 'sourceTree'])
        assert.match(value[field], /^[a-f0-9]{40}$/);
    for (const field of ['archiveSHA256', 'offlineEvidenceSHA256'])
        assert.match(value[field], /^[a-f0-9]{64}$/);
    for (const field of ['runId', 'runAttempt']) assert.match(value[field], /^[1-9][0-9]{0,31}$/);
    assert.match(value.observationId, /^[a-f0-9]{32}$/);
    assert.ok(['darwin-x64', 'darwin-arm64'].includes(value.lane));
    assert.equal(value.caseId, 'macos-bundle:offline-launch');
    return processIdentity(value.root);
}
function parseRecord(bytes) {
    assert.ok(
        Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAC_CENSUS_LIMITS.bytes,
    );
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
        record = JSON.parse(text);
    assert.equal(text, JSON.stringify(record) + '\n', 'Require canonical Mac census JSON.');
    return record;
}

/** Validate one observation without using a process command, signal, or an identity from a
 * loose parent PID. A disappeared/recycled parent makes the snapshot incomplete. */
function snapshotGraph(rows) {
    const byPid = new Map(),
        parents = new Map(),
        children = new Map();
    for (const row of rows) {
        keys(row, ['identity', 'parent']);
        const key = processIdentity(row.identity);
        assert.ok(
            !byPid.has(row.identity.pid),
            'Multiple Mac instances for one PID in a snapshot.',
        );
        byPid.set(row.identity.pid, key);
        parents.set(key, row.parent);
    }
    let linked = true;
    for (const [key, parent] of parents) {
        if (parent === null) continue;
        const parentKey = processIdentity(parent);
        assert.notEqual(parentKey, key, 'Mac process cannot be its own parent.');
        if (byPid.get(parent.pid) !== parentKey) {
            linked = false;
            continue;
        }
        const siblings = children.get(parentKey) ?? [];
        siblings.push(key);
        children.set(parentKey, siblings);
    }
    // Each usable edge belongs to the same census. Detect cycles even outside the owned group.
    const visited = new Set();
    for (const key of parents.keys()) {
        if (visited.has(key)) continue;
        const trail = new Set();
        let current = key;
        while (current && !visited.has(current)) {
            assert.ok(!trail.has(current), 'Cyclic Mac process census.');
            trail.add(current);
            const parent = parents.get(current);
            if (parent === null || byPid.get(parent.pid) !== processIdentity(parent)) break;
            current = byPid.get(parent.pid);
        }
        for (const item of trail) visited.add(item);
    }
    return { byPid, instances: new Set(byPid.values()), children, linked };
}

/**
 * Offline observer-side model. The expected binding belongs to an independent caller;
 * this code does not authenticate it, acquire evidence, infer a complete history from
 * polling, inspect loaded bytes, signal a process, or allow a publication/native pass.
 */
export function inspectMacDescendantCensus(bytes, expected) {
    const rootKey = validateContext(expected);
    const record = parseRecord(bytes);
    keys(record, ['schemaVersion', 'kind', 'context', 'snapshots']);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.kind, 'macos-descendant-census');
    validateContext(record.context);
    assert.deepEqual(record.context, expected, 'Mac census does not bind the selected case/run.');
    const observed = new Set([rootKey]),
        confirmedAbsent = new Set(),
        problems = new Set();
    const { snapshots } = record;
    assert.ok(Array.isArray(snapshots) && snapshots.length <= MAC_CENSUS_LIMITS.snapshots);
    let totalRows = 0,
        previous = null,
        anchored = false,
        prequitCount = 0,
        completeSnapshots = 0,
        final = null,
        finalReliable = false;
    for (const [index, sample] of snapshots.entries()) {
        keys(sample, ['sequence', 'elapsedMs', 'phase', 'visibility', 'rows']);
        assert.ok(Number.isSafeInteger(sample.sequence) && sample.sequence > 0);
        assert.ok(
            Number.isSafeInteger(sample.elapsedMs) &&
                sample.elapsedMs >= 0 &&
                sample.elapsedMs <= MAC_CENSUS_LIMITS.observationMs,
        );
        assert.ok(typeof sample.phase === 'string' && Object.hasOwn(phaseIndex, sample.phase));
        assert.ok(['complete', 'incomplete', 'unavailable'].includes(sample.visibility));
        assert.ok(
            Array.isArray(sample.rows) && sample.rows.length <= MAC_CENSUS_LIMITS.rowsPerSnapshot,
        );
        totalRows += sample.rows.length;
        assert.ok(totalRows <= MAC_CENSUS_LIMITS.totalRows);
        if (sample.visibility === 'unavailable') assert.equal(sample.rows.length, 0);
        if (sample.sequence !== index + 1) problems.add('sequence-gap');
        if (
            previous &&
            (sample.elapsedMs <= previous.elapsedMs ||
                sample.elapsedMs - previous.elapsedMs > MAC_CENSUS_LIMITS.intervalMs)
        )
            problems.add('observation-gap');
        if (
            (previous && phaseIndex[sample.phase] < phaseIndex[previous.phase]) ||
            (sample.phase === 'postquit' && index !== snapshots.length - 1)
        )
            problems.add('phase-order');
        if (sample.phase === 'prequit') prequitCount++;

        const graph = snapshotGraph(sample.rows);
        const reliable = sample.visibility === 'complete' && graph.linked;
        if (sample.visibility !== 'complete') problems.add('visibility-incomplete');
        if (!graph.linked) problems.add('parent-start-identity-unresolved');
        if (reliable) completeSnapshots++;
        const rootPresent = graph.instances.has(rootKey);
        if (rootPresent) anchored = true;
        if (['running', 'prequit'].includes(sample.phase) && !rootPresent)
            problems.add('root-identity-not-visible-before-quit');

        // A process already seen in the group remains owned after reparenting. It can also
        // bring newly observed descendants into the group, even after the root has exited.
        const queue = [...observed].filter((key) => graph.instances.has(key));
        const queued = new Set(queue);
        for (let i = 0; i < queue.length; i++) {
            const key = queue[i];
            if (confirmedAbsent.has(key)) problems.add('missing-instance-reappeared');
            observed.add(key);
            assert.ok(observed.size <= MAC_CENSUS_LIMITS.observedInstances);
            for (const child of graph.children.get(key) ?? [])
                if (!queued.has(child)) {
                    queued.add(child);
                    queue.push(child);
                }
        }
        if (reliable && anchored)
            for (const key of observed) if (!graph.instances.has(key)) confirmedAbsent.add(key);
        previous = sample;
        final = graph;
        finalReliable = reliable;
    }

    const finalPhase = previous?.phase === 'postquit';
    if (snapshots[0]?.phase !== 'running' || prequitCount !== 1 || !finalPhase)
        problems.add('missing-lifecycle-anchor');
    if (!anchored) problems.add('root-start-identity-unobserved');
    // Never turn absence in an incomplete census (or a prequit sample) into retirement.
    const finalOwned = finalPhase ? [...observed].filter((key) => final?.instances.has(key)) : [];
    const sufficient = anchored && problems.size === 0 && finalReliable;
    return {
        status: !anchored
            ? 'root-identity-unobserved'
            : !sufficient
              ? 'observed-history-incomplete'
              : finalOwned.length
                ? 'observed-owned-instances-still-present'
                : 'observed-owned-instances-absent-unqualified',
        problems: [...problems].sort(),
        completeSnapshots,
        observedDescendants: observed.size - 1,
        rootSeenInFinal: finalPhase && finalOwned.includes(rootKey),
        observedDescendantsInFinal: finalOwned.filter((key) => key !== rootKey).length,
        observedInstancesAbsentInFinal: sufficient ? observed.size - finalOwned.length : null,
        physicalDescendantClosure: false,
        releaseAcceptance: false,
    };
}
