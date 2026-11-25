import assert from 'node:assert/strict';
import { MAC_CENSUS_LIMITS } from './macos-descendant-census.mjs';

/**
 * @typedef {{pid: number, startMicros: string}} ProcessIdentity
 * @typedef {{identity: ProcessIdentity, parent: ProcessIdentity|null}} CensusRow
 * @typedef {{pid: number, state: 'live'|'unreaped'|'unresolved'}} VisibleProcessState
 * @typedef {{sequence: number, elapsedMs: number, phase: string}} SampleMetadata
 * @typedef {{
 *   expectedDetailBytes: number,
 *   list: (capacity: number) => {pidCount: number, pids?: number[]},
 *   detail: (pid: number) => {returnedBytes: number, info?: ProcessIdentity & {parentPid: number, state: string}}
 * }} CensusPort
 */
const firstCapacity = 256;
const maxCapacity = MAC_CENSUS_LIMITS.rowsPerSnapshot;
const pidMax = 2_147_483_647;
const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= pidMax;

// A native binding must normalize the libproc return counts, not the amount it asked for.
// A full array never establishes that all PIDs fit. The estimate only chooses a starting size.
function listPids(port, start, problems) {
    for (let capacity = start; capacity <= maxCapacity; capacity *= 2) {
        let response;
        try {
            response = port.list(capacity);
        } catch {
            problems.add('enumeration-port-error');
            return null;
        }
        const { pidCount, pids } = response ?? {};
        if (pidCount === 0) {
            problems.add('enumeration-zero');
            return null;
        }
        if (!Number.isSafeInteger(pidCount) || pidCount < 0) {
            problems.add('enumeration-invalid');
            return null;
        }
        if (pidCount >= capacity) continue;
        if (!Array.isArray(pids) || pids.length !== pidCount) {
            problems.add('enumeration-invalid');
            return null;
        }
        const unique = new Set(pids);
        if (unique.size !== pidCount || [...unique].some((pid) => pid !== 0 && !validPid(pid))) {
            problems.add('enumeration-invalid');
            return null;
        }
        // The kernel's PID 0 is not a process identity in the downstream user-process model.
        unique.delete(0);
        if (!unique.size) {
            problems.add('no-user-pids-visible');
            return null;
        }
        return { capacity, pids: [...unique].sort((a, b) => a - b) };
    }
    problems.add('enumeration-saturated');
    return null;
}

function detail(port, pid, expectedDetailBytes, problems) {
    let response;
    try {
        response = port.detail(pid);
    } catch {
        problems.add('detail-port-error');
        return null;
    }
    const { returnedBytes, info } = response ?? {};
    if (returnedBytes === 0) {
        // The process can have vanished, be unreaped but not queryable by this flavor,
        // or be hidden. No one of those explanations follows from this result.
        problems.add('detail-zero');
        return null;
    }
    if (!Number.isSafeInteger(returnedBytes) || returnedBytes < 0) {
        problems.add('detail-invalid');
        return null;
    }
    if (returnedBytes < expectedDetailBytes) {
        problems.add('detail-short');
        return null;
    }
    if (
        returnedBytes !== expectedDetailBytes ||
        !info ||
        info.pid !== pid ||
        (info.parentPid !== 0 && !validPid(info.parentPid)) ||
        info.parentPid === pid ||
        typeof info.startMicros !== 'string' ||
        !/^[1-9][0-9]{0,15}$/.test(info.startMicros)
    ) {
        problems.add('detail-invalid');
        return null;
    }
    if (!['live', 'unreaped'].includes(info.state)) {
        problems.add('detail-state-unresolved');
        return null;
    }
    return {
        identity: { pid, startMicros: info.startMicros },
        parentPid: info.parentPid,
        state: info.state,
    };
}

function sameInstance(a, b) {
    return (
        a &&
        b &&
        a.identity.pid === b.identity.pid &&
        a.identity.startMicros === b.identity.startMicros
    );
}

function sameState(a, b) {
    return a.parentPid === b.parentPid && a.state === b.state;
}

// Avoid returning invalid rows to the downstream graph even if a malformed/inconsistent
// port replies with a parent cycle. No inferred edges survive that contradiction.
function hasCycle(rows) {
    const parents = new Map(rows.map(({ identity, parent }) => [identity.pid, parent?.pid]));
    const visited = new Set();
    for (const pid of parents.keys()) {
        const trail = new Set();
        for (
            let current = pid;
            current !== undefined && !visited.has(current);
            current = parents.get(current)
        ) {
            if (trail.has(current)) return true;
            trail.add(current);
        }
        for (const member of trail) visited.add(member);
    }
    return false;
}

/**
 * A normalized, synchronous data-port adapter only; there is no libproc binding or
 * command runner here. The future platform binding owns its reviewed ABI size, reads,
 * raw status-to-state mapping and timeout. Its surface must provide list(capacity)
 * -> {pidCount,pids} and detail(pid) -> {returnedBytes,info}. Only a complete,
 * zombie-aware detail read may supply {pid,startMicros,parentPid,state}. Unknown
 * raw states must not be mapped to live. Full BSD detail visibility on macOS is
 * user-scoped; the existing v1 model cannot call a filtered host list complete.
 * A native integration must review scoped owned-PID selection and minimization
 * rather than log unrelated process details or use elevated permissions. Until
 * then missing detail correctly leaves this observation incomplete. This is a
 * polling observation, never an atomic census, continuous visibility, or a release
 * qualification.
 * @param {CensusPort} port
 * @param {SampleMetadata} _metadata
 */
export function sampleMacCensusPort(port, { sequence, elapsedMs, phase }) {
    const expectedDetailBytes = port.expectedDetailBytes;
    assert.equal(typeof port.list, 'function');
    assert.equal(typeof port.detail, 'function');
    assert.ok(
        Number.isSafeInteger(expectedDetailBytes) &&
            expectedDetailBytes > 0 &&
            expectedDetailBytes <= 4096,
    );
    assert.ok(
        Number.isSafeInteger(sequence) && sequence > 0 && sequence <= MAC_CENSUS_LIMITS.snapshots,
    );
    assert.ok(
        Number.isSafeInteger(elapsedMs) &&
            elapsedMs >= 0 &&
            elapsedMs <= MAC_CENSUS_LIMITS.observationMs,
    );
    assert.ok(['running', 'prequit', 'closing', 'postquit'].includes(phase));

    const problems = new Set();
    /**
     * @param {'complete'|'incomplete'|'unavailable'} visibility
     * @param {CensusRow[]} [rows]
     * @param {VisibleProcessState[]|null} [states]
     */
    const result = (visibility, rows = [], states = null) => ({
        sample: { sequence, elapsedMs, phase, visibility, rows },
        states,
        problems: [...problems].sort(),
    });
    const start = listPids(port, firstCapacity, problems);
    if (!start) return result('unavailable');

    const first = new Map(
        start.pids.map((pid) => [pid, detail(port, pid, expectedDetailBytes, problems)]),
    );
    const stable = new Map();
    const edges = new Map();
    const inconsistentParents = new Set();
    for (const pid of start.pids) {
        const before = first.get(pid),
            after = detail(port, pid, expectedDetailBytes, problems);
        if (before && after && !sameInstance(before, after)) problems.add('pid-instance-changed');
        else if (before && after && !sameState(before, after)) problems.add('detail-changed');
        else if (before && after) {
            stable.set(pid, after);
            if (after.parentPid) {
                const parentBefore = first.get(after.parentPid);
                // Bracket this child's second read with two identity reads of the
                // parent; a matching numeric PPID alone cannot justify an edge.
                const parentAfter = parentBefore
                    ? detail(port, after.parentPid, expectedDetailBytes, problems)
                    : null;
                if (sameInstance(parentBefore, parentAfter) && sameState(parentBefore, parentAfter))
                    edges.set(pid, parentAfter.identity);
                else {
                    if (parentBefore) inconsistentParents.add(after.parentPid);
                    problems.add('parent-instance-unresolved');
                }
            }
        }
    }

    const finish = listPids(port, start.capacity, problems);
    if (!finish) return result('incomplete');
    if (
        start.pids.length !== finish.pids.length ||
        start.pids.some((pid, i) => pid !== finish.pids[i])
    ) {
        problems.add('enumerated-membership-changed');
        return result('incomplete');
    }
    for (const pid of inconsistentParents) stable.delete(pid);
    const states = start.pids.map((pid) => ({
        pid,
        state: stable.get(pid)?.state ?? 'unresolved',
    }));
    const rows = [];
    for (const [pid, { identity, parentPid }] of stable) {
        const parent = edges.get(pid) ?? null;
        if (
            parentPid &&
            (!parent || stable.get(parentPid)?.identity.startMicros !== parent.startMicros)
        ) {
            // Retain the positively identified process, not its unverified edge. In an
            // incomplete sample null means no confirmed edge, not proven orphanhood.
            problems.add('parent-instance-unresolved');
            rows.push({ identity, parent: null });
        } else rows.push({ identity, parent });
    }
    if (hasCycle(rows)) {
        problems.add('parent-cycle');
        for (const row of rows) row.parent = null;
    }
    // An unreaped identity is still present in v1. Keep its state in the adapter
    // result, not the v1 wire shape. A PID tagged unresolved has no proven identity.
    return result(problems.size ? 'incomplete' : 'complete', rows, states);
}
