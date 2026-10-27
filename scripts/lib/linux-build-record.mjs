import { createHash } from 'node:crypto';

// Data-only build metadata. No Git lookup, filesystem access, execution or trust issuer.
export const LINUX_BUILD_REPOSITORY = 'brucerry/embedded-linux-diagnostic-hub';
export const LINUX_BUILD_ASSETS = ['Diagnostic-Hub-linux-x64.AppImage', 'Diagnostic-Hub-linux-x64.tar.gz'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = (value, length) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + length + '}$').test(value);
export function linuxBuildClosed(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join('\n') !== fields.slice().sort().join('\n')) throw Error('LINUX_BUILD_RECORD');
    return value;
}
export function linuxBuildJSON(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 65536) throw Error('LINUX_BUILD_RECORD_CAP');
    return JSON.parse(bytes.toString('utf8'));
}
function identity(value) {
    if (typeof value.version !== 'string' || value.version.length > 80 ||
        !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(value.version) ||
        !hex(value.commit, 40)) throw Error('LINUX_BUILD_IDENTITY');
}
export function validatePrivateLinuxSource(value) {
    const v = structuredClone(value);
    linuxBuildClosed(v, ['schema', 'kind', 'repository', 'version', 'commit', 'tree', 'sourceManifestSHA256', 'buildId']);
    identity(v);
    if (v.schema !== 1 || v.kind !== 'private-linux-build-source' || v.repository !== LINUX_BUILD_REPOSITORY ||
        !hex(v.tree, 40) || !hex(v.sourceManifestSHA256, 64) || !hex(v.buildId, 32)) throw Error('LINUX_PRIVATE_SOURCE');
    return v;
}
/** Preserve historical published metadata shapes while excluding the new private variant. */
export function assertPublishedLinuxMetadataMode(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        value.kind === 'private-linux-build' || value.mode === 'private-build' ||
        Object.hasOwn(value, 'sourceRecordSHA256')) throw Error('LINUX_PRIVATE_METADATA_NOT_RELEASE');
}
function assets(value) {
    linuxBuildClosed(value, LINUX_BUILD_ASSETS);
    if (!LINUX_BUILD_ASSETS.every(name => hex(value[name], 64))) throw Error('LINUX_BUILD_ASSETS');
}
function validationShape(v) {
    linuxBuildClosed(v, ['status', 'resultSHA256']);
    if (!['unperformed', 'failed', 'verified'].includes(v.status) ||
        (v.status === 'unperformed' ? v.resultSHA256 !== null : !hex(v.resultSHA256, 64)))
        throw Error('LINUX_BUILD_VALIDATION');
}
/** A result must be separately selected by its exact digest and bound to this artifact/build. */
function validation(context, evidence) {
    if (evidence === null || evidence === undefined) return { status: 'unperformed', resultSHA256: null };
    linuxBuildClosed(evidence, ['bytes', 'sha256']);
    if (!hex(evidence.sha256, 64) || !Buffer.isBuffer(evidence.bytes) || evidence.bytes.length < 1 ||
        evidence.bytes.length > 65536 || sha(evidence.bytes) !== evidence.sha256)
        throw Error('LINUX_VALIDATION_RESULT_HASH');
    const v = linuxBuildJSON(evidence.bytes);
    linuxBuildClosed(v, ['schema', 'kind', 'status', 'version', 'commit', 'buildId', 'assets']);
    assets(v.assets);
    if (v.schema !== 1 || v.kind !== 'linux-packaged-loopback-ssh' ||
        !['passed', 'failed', 'unperformed'].includes(v.status) ||
        v.version !== context.version || v.commit !== context.commit || v.buildId !== context.buildId ||
        !LINUX_BUILD_ASSETS.every(name => v.assets[name] === context.assets[name])) throw Error('LINUX_VALIDATION_RESULT_IDENTITY');
    return v.status === 'unperformed' ? { status: 'unperformed', resultSHA256: null } :
        { status: v.status === 'passed' ? 'verified' : 'failed', resultSHA256: evidence.sha256 };
}
/** Legacy published record keys remain compatible; private records cannot impersonate a release. */
export function createLinuxBuildRecord(input) {
    const v = structuredClone(input);
    linuxBuildClosed(v, ['mode', 'version', 'commit', 'assets', 'archiveBytes', 'source', 'sourceRecordSHA256', 'validationEvidence']);
    // structuredClone turns Buffers into Uint8Array; preserve a private byte copy for validation.
    const evidence = v.validationEvidence;
    if (evidence !== null && evidence !== undefined) {
        linuxBuildClosed(evidence, ['bytes', 'sha256']);
        if (!(evidence.bytes instanceof Uint8Array)) throw Error('LINUX_BUILD_VALIDATION');
        v.validationEvidence = { bytes: Buffer.from(evidence.bytes), sha256: evidence.sha256 };
    }
    identity(v); assets(v.assets);
    if (!['published-release', 'private-build'].includes(v.mode) ||
        !Number.isSafeInteger(v.archiveBytes) || v.archiveBytes < 1 || v.archiveBytes > 2 * 1024 ** 3)
        throw Error('LINUX_BUILD_IDENTITY');
    const source = v.mode === 'private-build' ? validatePrivateLinuxSource(v.source) : null;
    if (source ? source.version !== v.version || source.commit !== v.commit || !hex(v.sourceRecordSHA256, 64) :
        v.source !== null || v.sourceRecordSHA256 !== null) throw Error('LINUX_BUILD_SOURCE');
    const result = validation({ ...v, buildId: source?.buildId ?? null }, v.validationEvidence);
    const common = { version: v.version, commit: v.commit, platform: 'linux', arch: 'x64', assets: v.assets };
    if (!source) return { ...common, validation: result.status === 'unperformed' ?
        'unperformed: packaged loopback SSH; real-PC acceptance remains separate.' :
        result.status + ': packaged loopback SSH; independently selected result SHA256=' + result.resultSHA256 +
        '; real-PC acceptance remains separate.' };
    return { schema: 1, kind: 'private-linux-build', ...common, sourceTree: source.tree,
        sourceManifestSHA256: source.sourceManifestSHA256, buildId: source.buildId,
        sourceRecordSHA256: v.sourceRecordSHA256, archiveBytes: v.archiveBytes, validation: result };
}
export function validatePrivateLinuxBuild(value, source, sourceRecordSHA256) {
    const v = structuredClone(value), s = validatePrivateLinuxSource(source);
    linuxBuildClosed(v, ['schema', 'kind', 'version', 'commit', 'platform', 'arch', 'assets', 'sourceTree',
        'sourceManifestSHA256', 'buildId', 'sourceRecordSHA256', 'archiveBytes', 'validation']);
    assets(v.assets); validationShape(v.validation);
    if (!hex(sourceRecordSHA256, 64) || v.schema !== 1 || v.kind !== 'private-linux-build' ||
        v.version !== s.version || v.commit !== s.commit || v.platform !== 'linux' || v.arch !== 'x64' ||
        v.sourceTree !== s.tree || v.sourceManifestSHA256 !== s.sourceManifestSHA256 || v.buildId !== s.buildId ||
        v.sourceRecordSHA256 !== sourceRecordSHA256 || !Number.isSafeInteger(v.archiveBytes) ||
        v.archiveBytes < 1 || v.archiveBytes > 2 * 1024 ** 3) throw Error('LINUX_PRIVATE_BUILD');
    return v;
}
