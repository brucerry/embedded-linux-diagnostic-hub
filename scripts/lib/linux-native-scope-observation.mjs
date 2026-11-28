import assert from 'node:assert/strict';

function population(events) {
    assert.ok(typeof events === 'string' && events.length > 0 && events.length <= 1024);
    const rows = new Map();
    for (const row of events.trimEnd().split('\n')) {
        const match = /^([a-z_][a-z0-9_]{0,30}) ([0-9]{1,20})$/.exec(row);
        assert.ok(match && !rows.has(match[1]), 'Malformed cgroup event data');
        rows.set(match[1], match[2]);
    }
    assert.ok(['0', '1'].includes(rows.get('populated')), 'Missing population readback');
    assert.equal(rows.get('frozen') ?? '0', '0', 'Frozen is not retired');
    return rows.get('populated');
}

/** A pinned-scope readback format for the Linux producer. A pair from a
 * runner cannot on its own prove process custody or authorize any cleanup.
 * Distinguish an observed zero from ENOENT or a vanished descriptor.
 */
export function inspectLinuxNativeScopeObservation(selected, observed) {
    assert.ok(selected && [selected.device, selected.inode].every((n) =>
        typeof n === 'string' && /^[1-9][0-9]{0,19}$/.test(n) && BigInt(n) < (1n << 64n)),
        'Expected separately measured scope identity');
    const { before, after } = observed ?? {};
    for (const row of [before, after]) {
        assert.ok(row && typeof row === 'object' && !Array.isArray(row), 'No cgroup snapshot');
        assert.deepEqual(Object.keys(row).sort(), ['device', 'events', 'inode', 'monotonicNs']);
        assert.equal(row.device, selected.device, 'Different scope device');
        assert.equal(row.inode, selected.inode, 'Different scope inode');
        assert.ok(typeof row.monotonicNs === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(row.monotonicNs),
            'Invalid scope snapshot timestamp');
    }
    assert.ok(BigInt(before.monotonicNs) < BigInt(after.monotonicNs), 'Scope observations out of order');
    assert.equal(population(before.events), '1', 'Observed scope did not start populated');
    assert.equal(population(after.events), '0', 'Observed scope still populated');
    return Object.freeze({
        status: 'same-scope-population-transition-consistent',
        scopeOwnership: 'not-verified',
        cleanupAuthorized: false,
        releaseAcceptance: false,
    });
}

/** Record one bounded kernel snapshot using a caller-owned, already pinned FD.
 * Acquisition and authorization of that descriptor remain the caller's job.
 */
export async function capturePinnedLinuxScopeSnapshot(handle) {
    const before = await handle.stat({ bigint: true });
    assert.ok(before.isFile() && before.dev > 0n && before.ino > 0n, 'Invalid scope descriptor');
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    assert.ok(bytesRead > 0 && bytesRead <= 1024, 'Missing or oversized scope readback');
    const events = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    population(events);
    const monotonicNs = process.hrtime.bigint().toString();
    const after = await handle.stat({ bigint: true });
    assert.ok(after.isFile() && before.dev === after.dev && before.ino === after.ino,
        'Scope descriptor changed during capture');
    return Object.freeze({
        device: before.dev.toString(),
        inode: before.ino.toString(),
        monotonicNs,
        events,
    });
}
