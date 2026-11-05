import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Official release-page metadata, not locally observed or authenticated package/executable bytes. */
export const VERIFIER_CANDIDATE = Object.freeze({
    version: '2.103.3',
    sourceCommit: '63837fb778d6a39f02be0ce76ff89f2bc8d74bdc',
    publishedPackageSHA256: Object.freeze({
        x64: '4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d',
        arm64: 'ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63',
    }),
    publishedPackages: Object.freeze({
        'gh_2.103.3_linux_amd64.tar.gz': Object.freeze({
            arch: 'x64',
            sha256: '4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d',
        }),
        'gh_2.103.3_linux_arm64.tar.gz': Object.freeze({
            arch: 'arm64',
            sha256: 'ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63',
        }),
        'gh_2.103.3_linux_amd64.deb': Object.freeze({
            arch: 'x64',
            sha256: 'e3bafef96328d1a67de3a968bdfe1cc2ffd58cf6aba8b5e201356897ed06bb3d',
        }),
    }),
    metadataURL: 'https://github.com/cli/cli/releases/expanded_assets/v2.103.3',
});
export const ADMISSION_REVIEW_LEASE_MS = 24 * 60 * 60 * 1000;
/** These require independently admitted action-time evidence, not selection JSON or this inspector. */
export const VERIFIER_UNVERIFIED_REQUIREMENTS = Object.freeze([
    'authenticated-root-refresh-for-this-intake',
    'authenticated-persisted-tuf-history',
    'independently-selected-numeric-repository-identity',
    'current-security-and-revocation-review',
    'explicit-bounded-admission-lease',
    'identity-preserving-native-file-and-process-custody',
    'independently-observed-process-retirement',
    'exact-request-and-explicit-execution-grant',
]);
const sha = /^[a-f0-9]{64}$/;
const roles = ['root', 'timestamp', 'snapshot', 'targets'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
function closed(value, fields) {
    assert.ok(
        value && typeof value === 'object' && !Array.isArray(value),
        'Invalid admission selection.',
    );
    assert.deepEqual(
        Object.keys(value).sort(),
        [...fields].sort(),
        'Unknown or missing admission field.',
    );
}
function nullableHash(value) {
    if (value !== null)
        assert.ok(typeof value === 'string' && sha.test(value), 'Invalid admission digest.');
}
function integer(value, minimum = 0) {
    assert.ok(Number.isSafeInteger(value) && value >= minimum, 'Invalid admission integer.');
}
function nullableTime(value, nowMs) {
    if (value !== null) {
        integer(value, 1);
        assert.ok(value <= nowMs, 'Admission observation is in the future.');
    }
}
/**
 * Pure consistency/review model, NOT TUF/signature verification or execution authority.
 * Missing facts remain null. Neither JSON assertions nor a complete model can enable the verifier.
 */
export function inspectVerifierAdmission(input, context) {
    closed(context, ['nowMs']);
    integer(context.nowMs, 1);
    assert.ok(context.nowMs <= Number.MAX_SAFE_INTEGER - 180000);
    const nowMs = context.nowMs,
        plan = structuredClone(input),
        missing = [];
    closed(plan, ['schemaVersion', 'kind', 'binary', 'root', 'freshness', 'process']);
    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.kind, 'diagnostic-hub-verifier-admission-selection');
    const { binary, root, freshness, process } = plan;
    closed(binary, [
        'platform',
        'arch',
        'version',
        'sourceCommit',
        'packageName',
        'packageSHA256',
        'executableSHA256',
        'provenanceReceiptSHA256',
    ]);
    assert.equal(binary.platform, 'linux');
    assert.ok(['x64', 'arm64'].includes(binary.arch));
    assert.equal(
        binary.version,
        VERIFIER_CANDIDATE.version,
        'Different verifier release requires a new review.',
    );
    assert.equal(binary.sourceCommit, VERIFIER_CANDIDATE.sourceCommit);
    assert.ok(
        Object.hasOwn(VERIFIER_CANDIDATE.publishedPackages, binary.packageName),
        'Unreviewed verifier package.',
    );
    const publishedPackage = VERIFIER_CANDIDATE.publishedPackages[binary.packageName];
    assert.equal(publishedPackage.arch, binary.arch, 'Verifier package architecture differs.');
    assert.equal(
        binary.packageSHA256,
        publishedPackage.sha256,
        'Published package selection differs.',
    );
    for (const field of ['executableSHA256', 'provenanceReceiptSHA256']) {
        nullableHash(binary[field]);
        if (binary[field] === null) missing.push('binary.' + field);
    }
    closed(root, [
        'instance',
        'mediaType',
        'bootstrapSHA256',
        'exportSHA256',
        'targetSHA256',
        'targetBytes',
        'metadata',
        'exportedAtMs',
        'tufReceiptSHA256',
        'exportBindingReceiptSHA256',
    ]);
    assert.ok(['sigstore-public-good', 'github-private'].includes(root.instance));
    // gh v2.103.3 pins sigstore-go v1.3.0, whose trusted-root parser accepts this exact type.
    assert.equal(root.mediaType, 'application/vnd.dev.sigstore.trustedroot+json;version=0.1');
    for (const field of [
        'bootstrapSHA256',
        'exportSHA256',
        'targetSHA256',
        'tufReceiptSHA256',
        'exportBindingReceiptSHA256',
    ]) {
        nullableHash(root[field]);
        if (root[field] === null) missing.push('root.' + field);
    }
    if (root.targetBytes !== null) {
        integer(root.targetBytes, 1);
        assert.ok(root.targetBytes <= 4 * 1024 ** 2);
    } else missing.push('root.targetBytes');
    nullableTime(root.exportedAtMs, nowMs);
    if (root.exportedAtMs === null) missing.push('root.exportedAtMs');
    else
        assert.ok(
            nowMs - root.exportedAtMs < ADMISSION_REVIEW_LEASE_MS,
            'Root export needs fresh admission review.',
        );
    closed(root.metadata, roles);
    closed(freshness, [
        'checkedAtMs',
        'leaseUntilMs',
        'advisorySnapshotSHA256',
        'denylistSHA256',
        'deniedDigests',
        'versionFloors',
    ]);
    nullableTime(freshness.checkedAtMs, nowMs);
    if (freshness.checkedAtMs === null) missing.push('freshness.checkedAtMs');
    else
        assert.ok(
            nowMs - freshness.checkedAtMs < ADMISSION_REVIEW_LEASE_MS,
            'Security review is stale.',
        );
    for (const field of ['advisorySnapshotSHA256', 'denylistSHA256']) {
        nullableHash(freshness[field]);
        if (freshness[field] === null) missing.push('freshness.' + field);
    }
    assert.ok(Array.isArray(freshness.deniedDigests) && freshness.deniedDigests.length <= 1024);
    for (const denied of freshness.deniedDigests)
        assert.ok(typeof denied === 'string' && sha.test(denied));
    assert.equal(new Set(freshness.deniedDigests).size, freshness.deniedDigests.length);
    closed(freshness.versionFloors, roles);
    let earliestExpiry = Number.MAX_SAFE_INTEGER;
    for (const role of roles) {
        integer(freshness.versionFloors[role]);
        const metadata = root.metadata[role];
        if (metadata === null) {
            missing.push('root.metadata.' + role);
            continue;
        }
        closed(metadata, ['version', 'sha256', 'expiresMs']);
        integer(metadata.version, 1);
        assert.ok(metadata.version >= freshness.versionFloors[role], 'TUF metadata rollback.');
        assert.ok(typeof metadata.sha256 === 'string' && sha.test(metadata.sha256));
        integer(metadata.expiresMs, 1);
        assert.ok(metadata.expiresMs > nowMs, 'TUF metadata expired.');
        earliestExpiry = Math.min(earliestExpiry, metadata.expiresMs);
    }
    if (freshness.leaseUntilMs !== null) {
        integer(freshness.leaseUntilMs, 1);
        assert.ok(
            freshness.leaseUntilMs > nowMs &&
                freshness.leaseUntilMs <= earliestExpiry &&
                freshness.leaseUntilMs <= nowMs + ADMISSION_REVIEW_LEASE_MS,
            'Invalid admission lease.',
        );
        if (freshness.checkedAtMs !== null)
            assert.ok(
                freshness.leaseUntilMs <= freshness.checkedAtMs + ADMISSION_REVIEW_LEASE_MS,
                'Security lease exceeds review cap.',
            );
        if (root.exportedAtMs !== null)
            assert.ok(
                freshness.leaseUntilMs <= root.exportedAtMs + ADMISSION_REVIEW_LEASE_MS,
                'Root lease exceeds review cap.',
            );
    } else missing.push('freshness.leaseUntilMs');
    closed(process, [
        'ownerImplementationSHA256',
        'requestBindingSHA256',
        'mode',
        'commands',
        'maxAttempts',
        'workMs',
        'closeReserveMs',
        'totalMs',
        'stdoutLimit',
        'stderrLimit',
        'signals',
        'onUncertain',
        'descendants',
    ]);
    for (const field of ['ownerImplementationSHA256', 'requestBindingSHA256']) {
        nullableHash(process[field]);
        if (process[field] === null) missing.push('process.' + field);
    }
    assert.equal(process.mode, 'owned-no-signals');
    assert.equal(process.commands, 4); // two subjects, each --version then verify; no retries.
    assert.equal(process.maxAttempts, 1);
    assert.equal(process.workMs, 30000);
    assert.equal(process.closeReserveMs, 5000);
    assert.equal(process.totalMs, 180000); // includes all reads/commands/close observation; not a kill deadline.
    assert.equal(process.stdoutLimit, 16 * 1024 ** 2);
    assert.equal(process.stderrLimit, 1024 ** 2);
    assert.deepEqual(process.signals, []);
    assert.equal(process.onUncertain, 'retain-custody-no-retry');
    assert.equal(process.descendants, 'independent-retirement-required');
    if (freshness.leaseUntilMs !== null)
        assert.ok(
            freshness.leaseUntilMs > nowMs + process.totalMs,
            'Admission lease cannot cover the whole operation.',
        );
    assert.ok(
        earliestExpiry > nowMs + process.totalMs,
        'TUF metadata expires during the operation.',
    );
    const selected = [
        binary.packageSHA256,
        binary.executableSHA256,
        binary.provenanceReceiptSHA256,
        root.bootstrapSHA256,
        root.exportSHA256,
        root.targetSHA256,
        root.tufReceiptSHA256,
        root.exportBindingReceiptSHA256,
        ...roles.map((role) => root.metadata[role]?.sha256),
        freshness.advisorySnapshotSHA256,
        freshness.denylistSHA256,
        process.ownerImplementationSHA256,
        process.requestBindingSHA256,
    ].filter(Boolean);
    assert.ok(
        !selected.some((value) => freshness.deniedDigests.includes(value)),
        'Selected binary/root/evidence digest is denied.',
    );
    return Object.freeze({
        schemaVersion: 1,
        kind: 'diagnostic-hub-verifier-admission-review',
        status: missing.length
            ? 'blocked-missing-admission-evidence'
            : 'blocked-unverified-admission-evidence',
        executionAllowed: false,
        artifactAccessAllowed: false,
        qualification: false,
        releaseAcceptance: false,
        rootAuthenticationProven: false,
        binaryProvenanceProven: false,
        retirementProven: false,
        revocationStatus: 'not-established',
        unverifiedRequirements: VERIFIER_UNVERIFIED_REQUIREMENTS,
        selectionSHA256: hash(JSON.stringify(plan)),
        missing: Object.freeze(missing),
        reviewLeaseCapMs: ADMISSION_REVIEW_LEASE_MS,
        scope: 'Selection consistency only. A source-owned independently verified admission authority and process owner remain required; this record cannot enable execution.',
    });
}
