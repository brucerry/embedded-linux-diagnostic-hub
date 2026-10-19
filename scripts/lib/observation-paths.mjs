import assert from 'node:assert/strict';
import path from 'node:path';
import { metadataIdentity } from './windows-preflight.mjs';

function directory(file, identity) {
    const row = identity(file);
    assert.equal(row.path, file);
    assert(row.directory === true && row.file === false, 'Observation directory required');
    assert(
        typeof row.dev === 'string' &&
            typeof row.ino === 'string' &&
            /^\d+$/.test(row.dev) &&
            /^[1-9]\d*$/.test(row.ino),
        'Directory identity unavailable',
    );
    return row;
}
/** Compare existing objects, never replace short names or infer containment from a prefix. */
export function requireObservationDirectoryIdentity(actual, expected, identity = metadataIdentity) {
    const a = directory(actual, identity),
        b = directory(expected, identity);
    assert.equal(a.dev, b.dev, 'Observation directory device differs');
    assert.equal(a.ino, b.ino, 'Observation directory object differs');
    return a;
}
/** Inspect each original ancestor before accepting an OS-resolved alias, and pin its identity. */
export function bindObservationDirectory(
    actual,
    expected,
    { identity = metadataIdentity, paths = path.win32 } = {},
) {
    const snapshot = (root) => {
        assert(typeof root === 'string' && paths.isAbsolute(root));
        const rows = [];
        for (let file = root; ;) {
            // metadataIdentity refuses symlinks/junctions. Walking the original spelling also
            // checks ancestors that a realpath call alone would otherwise traverse silently.
            const {
                path: binding,
                realpath,
                directory: isDirectory,
                dev,
                ino,
            } = directory(file, identity);
            rows.push({ path: binding, realpath, directory: isDirectory, dev, ino });
            const parent = paths.dirname(file);
            if (parent === file) return rows;
            file = parent;
        }
    };
    const a = snapshot(actual),
        b = snapshot(expected),
        value = requireObservationDirectoryIdentity(actual, expected, identity);
    const resolved = requireObservationDirectoryIdentity(value.realpath, actual, identity);
    return {
        path: resolved.path,
        ancestries: { actual: a, expected: b },
        check() {
            assert.deepEqual(snapshot(actual), a, 'Observation input ancestry rebound');
            assert.deepEqual(snapshot(expected), b, 'Observation expected ancestry rebound');
            requireObservationDirectoryIdentity(value.realpath, actual, identity);
        },
    };
}
