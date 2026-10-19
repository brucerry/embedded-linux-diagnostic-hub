import assert from 'node:assert/strict';
import contract from './soak-evidence-contract.json' with { type: 'json' };
const tag = 3,
    crc = /^[a-f0-9]{8}$/,
    utc = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const minimumMillis = -62167219200000,
    maximumMillis = 253402300799999;
const integer = (n) => Number.isSafeInteger(n) && !Object.is(n, -0);
function timestamp(value) {
    assert(typeof value === 'string' && utc.test(value), 'Provenance exact UTC timestamp');
    const millis = Date.parse(value);
    assert(integer(millis) && new Date(millis).toISOString() === value, 'Provenance UTC calendar');
    return millis;
}
function ordinalRange(count, first) {
    assert(
        integer(count) && count > 0 && count <= contract.serialGeometry.frameLimit,
        'Provenance count',
    );
    assert(
        integer(first) && first >= 0 && first <= Number.MAX_SAFE_INTEGER - (count - 1),
        'Provenance ordinal range',
    );
}
/** Canonical JSON inputs only; caller already owns bounded staging credit. */
export function encodeProvenance(rows) {
    assert(Array.isArray(rows) && rows.length > 0, 'Provenance tuples');
    const count = rows.length,
        first = rows[0]?.[0];
    ordinalRange(count, first);
    let previous;
    const deltas = [],
        runs = [];
    for (let index = 0; index < count; index++) {
        const row = rows[index];
        assert(
            Array.isArray(row) && row.length === 3 && row[0] === first + index,
            'Provenance consecutive observed ordinals',
        );
        const millis = timestamp(row[1]);
        assert(typeof row[2] === 'string' && crc.test(row[2]), 'Provenance observed CRC');
        if (index) {
            const delta = millis - previous;
            assert(integer(delta), 'Provenance signed millisecond delta');
            deltas.push(delta);
        }
        previous = millis;
        const last = runs.at(-1);
        if (last?.[1] === row[2]) last[0]++;
        else runs.push([1, row[2]]);
    }
    return [tag, count, first, rows[0][1], deltas, runs];
}
/** Validate every scalar and all expansion credit before allocating any output tuple array. */
export function decodeProvenance(node, quota, depth = 0, limits = contract.limits) {
    assert(Array.isArray(node) && node.length === 6 && node[0] === tag, 'Provenance codec shape');
    const [, count, first, firstTime, deltas, runs] = node;
    ordinalRange(count, first);
    assert(
        Array.isArray(deltas) &&
            deltas.length === count - 1 &&
            Array.isArray(runs) &&
            runs.length > 0 &&
            runs.length <= count,
        'Provenance vectors',
    );
    let millis = timestamp(firstTime),
        total = 0,
        prior;
    for (const delta of deltas) {
        assert(integer(delta), 'Provenance signed millisecond delta');
        millis += delta;
        assert(integer(millis), 'Provenance timestamp arithmetic');
        assert(millis >= minimumMillis && millis <= maximumMillis, 'Provenance timestamp range');
    }
    for (const run of runs) {
        assert(
            Array.isArray(run) &&
                run.length === 2 &&
                integer(run[0]) &&
                run[0] > 0 &&
                run[0] <= count &&
                typeof run[1] === 'string' &&
                crc.test(run[1]) &&
                run[1] !== prior,
            'Provenance CRC run',
        );
        total += run[0];
        assert(total <= count, 'Provenance CRC expansion');
        prior = run[1];
    }
    assert(total === count, 'Provenance incomplete CRC runs');
    let expandedBytes = 41 * count + 1;
    for (let index = 0; index < count; index++) expandedBytes += String(first + index).length;
    const nodes = 1 + 4 * count,
        members = 4 * count;
    assert(depth + 2 <= limits.depth, 'Provenance expansion depth');
    assert((quota.bytes ?? 0) + expandedBytes <= limits.reportBytes, 'Provenance expansion bytes');
    assert(
        (quota.nodes ?? 0) + nodes <= limits.nodes &&
            (quota.members ?? 0) + members <= limits.members,
        'Provenance expansion object quota',
    );
    quota.bytes = (quota.bytes ?? 0) + expandedBytes;
    quota.nodes = (quota.nodes ?? 0) + nodes;
    quota.members = (quota.members ?? 0) + members;
    const output = new Array(count);
    millis = timestamp(firstTime);
    let runIndex = 0,
        remaining = runs[0][0];
    for (let index = 0; index < count; index++) {
        if (index) millis += deltas[index - 1];
        output[index] = [
            first + index,
            index ? new Date(millis).toISOString() : firstTime,
            runs[runIndex][1],
        ];
        if (--remaining === 0 && index + 1 < count) remaining = runs[++runIndex][0];
    }
    return output;
}
