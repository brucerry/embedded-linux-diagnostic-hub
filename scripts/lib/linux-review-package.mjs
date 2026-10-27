import { createHash } from 'node:crypto';

// Package consistency metadata, NOT publisher authentication or native qualification.
export const LINUX_REVIEW_ENTRY = 'app/resources/linux-setup-review.cjs';
export const LINUX_REVIEW_CAPABILITY = 'app/resources/linux-setup-review.json';
export const MAX_LINUX_REVIEW_BUNDLE = 1048576;
const fields = ['schema', 'product', 'version', 'platform', 'arch', 'purpose', 'entry',
    'bytes', 'sha256', 'mutation', 'nativeBinding', 'provenance'];
const versionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
export const reviewBundleHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function createLinuxReviewCapability(version, bundle) {
    if (typeof version !== 'string' || version.length > 80 || !versionPattern.test(version) ||
        !Buffer.isBuffer(bundle) || bundle.length < 1 || bundle.length > MAX_LINUX_REVIEW_BUNDLE)
        throw Error('LINUX_REVIEW_PACKAGE_INPUT');
    return Object.freeze({ schema: 1, product: 'diagnostic-hub', version, platform: 'linux',
        arch: 'x64', purpose: 'read-only-appdir-review', entry: LINUX_REVIEW_ENTRY,
        bytes: bundle.length, sha256: reviewBundleHash(bundle), mutation: false,
        nativeBinding: false, provenance: 'unverified' });
}
export function validateLinuxReviewCapability(value, version) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join('\n') !== [...fields].sort().join('\n') ||
        typeof version !== 'string' || version.length > 80 || !versionPattern.test(version) ||
        value.schema !== 1 || value.product !== 'diagnostic-hub' || value.version !== version ||
        value.platform !== 'linux' || value.arch !== 'x64' ||
        value.purpose !== 'read-only-appdir-review' || value.entry !== LINUX_REVIEW_ENTRY ||
        !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_LINUX_REVIEW_BUNDLE ||
        typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
        value.mutation !== false || value.nativeBinding !== false || value.provenance !== 'unverified')
        throw Error('LINUX_REVIEW_CAPABILITY');
    return Object.freeze({ ...value });
}
/** Decision only. No executable discovery, download, process or native operation is performed. */
export function linuxReviewHelperDecision(input) {
    // Snapshot all comparison facts before passing control to any caller.
    const { platform, arch, intent, envelope, version, entryBytes, entrySHA256 } = { ...input };
    if (platform !== 'linux' || arch !== 'x64')
        return Object.freeze({ status: 'refused', reason: 'unsupported-platform' });
    if (intent !== 'review')
        return Object.freeze({ status: 'refused', reason: 'mutation-unqualified' });
    if (envelope !== 'explicit-linux-folder')
        return Object.freeze({ status: 'refused', reason: 'complete-folder-required' });
    const capability = validateLinuxReviewCapability(input.capability, version);
    if (entryBytes !== capability.bytes || entrySHA256 !== capability.sha256)
        throw Error('LINUX_REVIEW_ENTRY_IDENTITY');
    return Object.freeze({ status: 'read-only-review', entry: LINUX_REVIEW_ENTRY,
        mutation: false, nativeBinding: false, provenance: 'unverified' });
}

/** Require the helper's physical code to be one exact regular-file payload member. */
export function assertLinuxReviewManifestEntry(files, expected) {
    if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1 ||
        expected.bytes > MAX_LINUX_REVIEW_BUNDLE || typeof expected.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expected.sha256) || !Array.isArray(files))
        throw Error('LINUX_REVIEW_MANIFEST_ENTRY');
    const entries = files.filter(file => file && file.path === LINUX_REVIEW_ENTRY);
    if (entries.length !== 1 || entries[0].kind !== 'file' ||
        entries[0].bytes !== expected.bytes || entries[0].sha256 !== expected.sha256)
        throw Error('LINUX_REVIEW_MANIFEST_ENTRY');
}
