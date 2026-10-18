import assert from 'node:assert/strict';
import { metadataIdentity, fixedAncestorPlan } from './windows-preflight.mjs';
export const directoryFactsScope = Object.freeze({
    schema: 1,
    profile: 'literal-directory-security-facts-v1',
    scope: 'owner-group-dacl-only',
    filesystemProfile: 'Get-Acl-DirectorySecurity',
    collectionApproval: false,
    tokenContext: 'not-collected',
    effectiveAccess: 'not-evaluated',
    sacl: 'not-requested',
    mandatoryLabel: 'not-requested',
    resourceAttributes: 'not-requested',
    cap: 'not-requested',
    aceSemantics: 'opaque-not-evaluated',
    aceOrder: 'provider-returned',
    atomicCustody: false,
    protectionAfterReturn: false,
    privatePathApproved: false,
    admissionChanged: false,
});
export const directoryCandidateLabels = Object.freeze([
    'output-root',
    'canonical-temp',
    'runner-temp',
    'localappdata-temp',
    'userprofile-temp',
]);
export function directoryFactsPlan(candidates) {
    assert(candidates && Array.isArray(candidates.rows) && candidates.rows.length === 5);
    assert.deepEqual(
        candidates.rows.map((r) => r.name),
        directoryCandidateLabels,
    );
    const paths = [
        ...new Set(
            candidates.rows.filter((r) => r.status === 'observed').map((r) => r.identity.path),
        ),
    ];
    assert.deepEqual(candidates.paths, paths, 'Unplanned directory candidate.');
    const plan = fixedAncestorPlan(paths);
    return {
        ...plan,
        labels: candidates.rows.map((r) => ({
            name: r.name,
            availability: r.status === 'observed' ? 'observed' : 'unavailable',
            pathIndex: r.status === 'observed' ? plan.paths.indexOf(r.identity.path) : null,
        })),
    };
}
export function directoryIdentity(literal) {
    const identity = metadataIdentity(literal);
    assert(
        identity.directory && !identity.file && identity.realpath === literal,
        'Physical literal directory identity required.',
    );
    assert(
        /^\d{1,20}$/.test(identity.dev) && /^[1-9]\d{0,19}$/.test(identity.ino),
        'Stable filesystem identity unavailable.',
    );
    return { dev: identity.dev, ino: identity.ino };
}
const exact = (object, keys) => {
    assert(object && typeof object === 'object' && !Array.isArray(object));
    assert.deepEqual(Object.keys(object).sort(), keys.sort());
};
const nullableSid = (v) =>
    v === null || (typeof v === 'string' && /^S-1-\d+(?:-\d+)+$/.test(v) && v.length <= 184);
const boundedError = (v) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 512;
export function parseDirectoryDescriptorReport(text, paths) {
    assert(
        typeof text === 'string' && Buffer.byteLength(text) <= 32768,
        'Directory response JSON bound.',
    );
    const report = JSON.parse(text.replace(/^\uFEFF/, ''));
    exact(report, [
        ...Object.keys(directoryFactsScope),
        'complete',
        'descriptorBytes',
        'descriptorUtf8Bytes',
        'rows',
        'stoppedAt',
        'error',
    ]);
    for (const [key, value] of Object.entries(directoryFactsScope))
        assert.deepEqual(report[key], value, 'Directory scope mismatch: ' + key);
    assert(typeof report.complete === 'boolean');
    assert(
        Array.isArray(report.rows) &&
            report.rows.length <= paths.length &&
            report.rows.length <= 24,
    );
    let binary = 0,
        textBytes = 0;
    report.rows.forEach((row, index) => {
        exact(row, [
            'path',
            'availability',
            'owner',
            'group',
            'sddl',
            'descriptorBytes',
            'daclPresent',
            'daclNull',
            'daclState',
            'aceCount',
            'aces',
            'error',
        ]);
        assert.equal(row.path, paths[index], 'Unplanned/reordered descriptor row.');
        assert(['observed', 'unavailable'].includes(row.availability));
        assert(nullableSid(row.owner) && nullableSid(row.group));
        if (row.sddl !== null) {
            assert(typeof row.sddl === 'string' && Buffer.byteLength(row.sddl) <= 16384);
            assert(
                /^O:(?:S-1-\d+(?:-\d+)+|[A-Z]{2})G:(?:S-1-\d+(?:-\d+)+|[A-Z]{2})(?:D:.*)?$/s.test(
                    row.sddl,
                ),
                'Malformed scoped SDDL header.',
            );
            textBytes += Buffer.byteLength(row.sddl);
        }
        if (row.descriptorBytes !== null) {
            assert(
                Number.isInteger(row.descriptorBytes) &&
                    row.descriptorBytes >= 20 &&
                    row.descriptorBytes <= 16384,
            );
            binary += row.descriptorBytes;
        }
        for (const key of ['daclPresent', 'daclNull'])
            assert(row[key] === null || typeof row[key] === 'boolean');
        assert(['unavailable', 'absent', 'null', 'empty', 'nonempty'].includes(row.daclState));
        assert(
            row.aceCount === null ||
                (Number.isInteger(row.aceCount) && row.aceCount >= 0 && row.aceCount <= 128),
        );
        if (row.aces !== null) {
            assert(
                Array.isArray(row.aces) &&
                    row.aces.length <= 128 &&
                    row.aces.length === row.aceCount,
            );
            let aceBytes = 0;
            for (const ace of row.aces) {
                exact(ace, ['type', 'flags', 'binary']);
                for (const key of ['type', 'flags'])
                    assert(Number.isInteger(ace[key]) && ace[key] >= 0 && ace[key] <= 255);
                assert(typeof ace.binary === 'string');
                const bytes = Buffer.from(ace.binary, 'base64');
                assert.equal(bytes.toString('base64'), ace.binary, 'Noncanonical opaque ACE.');
                assert(bytes.length >= 4 && bytes.length <= 16384);
                assert.equal(bytes[0], ace.type);
                assert.equal(bytes[1], ace.flags);
                assert.equal(
                    bytes.readUInt16LE(2),
                    bytes.length,
                    'Opaque ACE length/header mismatch.',
                );
                aceBytes += bytes.length;
            }
            assert(
                row.descriptorBytes !== null && aceBytes + 8 <= row.descriptorBytes,
                'Opaque ACL exceeds descriptor extent.',
            );
        }
        if (row.daclState === 'absent' || row.daclState === 'null') {
            assert.equal(row.daclPresent, row.daclState === 'null');
            assert.equal(row.daclNull, true);
            assert.equal(row.aceCount, null);
            assert.equal(row.aces, null);
        }
        if (row.daclState === 'empty' || row.daclState === 'nonempty') {
            assert.equal(row.daclPresent, true);
            assert.equal(row.daclNull, false);
            assert(row.aces !== null && row.aceCount !== null);
            assert.equal(row.aceCount === 0, row.daclState === 'empty');
        }
        if (row.availability === 'observed') {
            assert(row.owner && row.group && row.sddl && row.descriptorBytes !== null);
            assert.notEqual(row.daclState, 'unavailable');
            assert.equal(row.error, null);
        } else assert(boundedError(row.error));
    });
    assert(binary <= 32768 && textBytes <= 32768, 'Aggregate descriptor bound.');
    assert.equal(report.descriptorBytes, binary);
    assert.equal(report.descriptorUtf8Bytes, textBytes);
    if (report.complete) {
        assert.equal(report.rows.length, paths.length);
        assert(report.rows.every((r) => r.availability === 'observed'));
        assert.equal(report.error, null);
        assert.equal(report.stoppedAt, null);
    } else {
        assert(boundedError(report.error));
        assert(
            Number.isInteger(report.stoppedAt) &&
                report.stoppedAt >= 0 &&
                report.stoppedAt < paths.length,
        );
        assert(
            report.rows.length === report.stoppedAt || report.rows.length === report.stoppedAt + 1,
        );
        assert(report.rows.slice(0, report.stoppedAt).every((r) => r.availability === 'observed'));
        if (report.rows.length > report.stoppedAt) {
            assert.equal(report.rows[report.stoppedAt].availability, 'unavailable');
            assert.equal(report.rows[report.stoppedAt].error, report.error);
        }
    }
    return report;
}
export function directoryEvidence({ sourceSHA256, plan, before, after, response, failures }) {
    const count = plan?.paths.length ?? null;
    const allIdentities = count !== null && before.length === count && after.length === count;
    const drift =
        allIdentities && before.some((id, i) => JSON.stringify(id) !== JSON.stringify(after[i]));
    const comparison = allIdentities
        ? drift
            ? 'drift-detected'
            : 'no-drift-detected'
        : 'not-complete';
    const selected = response?.rows.length ? response.rows.map((r) => r.path) : (plan?.paths ?? []);
    let rows = selected.map((literal, i) => ({
        path: literal,
        before: before[i] ?? null,
        after: after[i] ?? null,
        descriptor: response?.rows[i]
            ? Object.fromEntries(Object.entries(response.rows[i]).filter(([key]) => key !== 'path'))
            : null,
    }));
    const result = {
        ...directoryFactsScope,
        sourceSHA256,
        identityMethod: 'independent-lstat-realpath-pre-post',
        identityComparison: comparison,
        identityLimitation:
            'path-based; equality does not exclude ABA or establish continuing custody',
        plannedRows: count,
        candidates: plan?.labels ?? null,
        descriptorAvailability: response ? 'reported' : 'unavailable',
        providerComplete: response?.complete ?? null,
        providerStoppedAt: response?.stoppedAt ?? null,
        rows,
        failures: [...failures],
        complete: Boolean(
            response?.complete &&
            allIdentities &&
            !drift &&
            failures.length === 0 &&
            plan.labels.every((r) => r.availability === 'observed'),
        ),
    };
    if (response && !response.complete)
        result.failures.push({ stage: 'Get-Acl', error: response.error });
    if (drift)
        result.failures.push({
            stage: 'identity',
            error: 'Filesystem identity drift detected; no atomic custody claim.',
        });
    if (plan?.labels.some((r) => r.availability !== 'observed'))
        result.failures.push({
            stage: 'candidates',
            error: 'One or more fixed candidate labels unavailable; no fallback.',
        });
    // Preserve identity facts if a combined result cannot retain whole descriptor records within32KiB.
    if (Buffer.byteLength(JSON.stringify(result)) > 32768) {
        result.complete = false;
        result.descriptorAvailability = 'omitted-by-bound';
        result.rows = rows.map((r) => ({ ...r, descriptor: null }));
        result.failures = [
            {
                stage: 'result-bound',
                error: 'Combined directory report exceeded32KiB; whole descriptor records omitted.',
            },
        ];
    }
    assert(Buffer.byteLength(JSON.stringify(result)) <= 32768, 'Directory evidence bound.');
    return result;
}
export function requireDirectoryFactsComplete(report) {
    assert(
        report?.complete === true,
        'Directory facts unavailable/partial; no subsequent probe admission.',
    );
}
