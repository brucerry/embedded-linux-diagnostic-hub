import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const digest = (b) => createHash('sha256').update(b).digest('hex');
const facts = ['canonicalFileURL', 'withinAdmittedRoot', 'exactURLInCensus'];
const matches = ['sourceMatchesCensus', 'sourceMatchesEntry'];
/** One observed 115-unit failure shape only. URL conversion is pure; never open notification paths. */
export function createRejectionFingerprint(p, expected, artifactPath) {
    if (
        typeof p?.url !== 'string' ||
        p.url.length > 8192 ||
        !p.url.startsWith('file:') ||
        p.length !== 115 ||
        p.isModule !== false
    )
        return null;
    let canonicalFileURL = false,
        withinAdmittedRoot = false;
    try {
        const u = new URL(p.url),
            filename = fileURLToPath(u),
            root = path.posix.dirname(artifactPath);
        canonicalFileURL =
            u.protocol === 'file:' &&
            u.host === '' &&
            !u.search &&
            !u.hash &&
            pathToFileURL(filename).href === p.url &&
            path.posix.normalize(filename) === filename &&
            !/[\\\x00-\x1f\x7f]/.test(filename);
        withinAdmittedRoot =
            canonicalFileURL && (filename === root || filename.startsWith(root + '/'));
    } catch {}
    return {
        schema: 'rejected-file-script-fingerprint-v1',
        status: 'pending',
        declaredUnits: 115,
        canonicalFileURL,
        withinAdmittedRoot,
        exactURLInCensus: expected.has(p.url),
        sourceUnits: null,
        sourceBytes: null,
        sourceSHA256: null,
        sourceMatchesCensus: null,
        sourceMatchesEntry: null,
    };
}
/** Validation precedes copying/hashing. Inspector itself supplies an entire string; this is a
 * response acceptance bound, not a transport allocation quota. Never admits the rejected script. */
export function fingerprintRejectedSource(state, source, expected, artifactURL) {
    state.status = 'invalid-response';
    if (typeof source !== 'string' || source.length !== 115) return;
    const bytes = Buffer.from(source);
    if (
        bytes.length > 460 ||
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== source
    )
        return;
    state.sourceUnits = source.length;
    state.sourceBytes = bytes.length;
    state.sourceSHA256 = digest(bytes);
    state.sourceMatchesCensus = [...expected.values()].some(
        (v) => v.sha256 === state.sourceSHA256 && v.text === source,
    );
    const entry = expected.get(artifactURL);
    state.sourceMatchesEntry = !!(
        entry &&
        entry.sha256 === state.sourceSHA256 &&
        entry.text === source
    );
    state.status = 'fingerprinted';
}
export function validateRejectionFingerprint(v) {
    assert.deepEqual(
        Object.keys(v).sort(),
        [
            'schema',
            'status',
            'declaredUnits',
            ...facts,
            'sourceUnits',
            'sourceBytes',
            'sourceSHA256',
            ...matches,
        ].sort(),
    );
    assert.equal(v.schema, 'rejected-file-script-fingerprint-v1');
    assert.equal(v.declaredUnits, 115);
    assert.ok(['pending', 'fingerprinted', 'invalid-response', 'rpc-rejected'].includes(v.status));
    for (const k of facts) assert.equal(typeof v[k], 'boolean');
    assert.ok(!v.withinAdmittedRoot || v.canonicalFileURL);
    if (v.status === 'fingerprinted') {
        assert.equal(v.sourceUnits, 115);
        assert.ok(
            Number.isSafeInteger(v.sourceBytes) && v.sourceBytes >= 115 && v.sourceBytes <= 460,
        );
        assert.match(v.sourceSHA256, /^[a-f0-9]{64}$/);
        for (const k of matches) assert.equal(typeof v[k], 'boolean');
        assert.ok(!v.sourceMatchesEntry || v.sourceMatchesCensus);
    } else
        for (const k of ['sourceUnits', 'sourceBytes', 'sourceSHA256', ...matches])
            assert.equal(v[k], null);
    return structuredClone(v);
}
