import { createHash } from 'node:crypto';
import path from 'node:path';
import { createLinuxBuildRecord } from './linux-build-record.mjs';

export const LINUX_CI_SOURCE = Object.freeze({ files: 709, bytes: 7203931,
    sha256: 'f6e61516aad735db21487bcef0ce6a25ea70874c0916e3e44b4d3dec6e735ef3' });
export const LINUX_CI_LIMITS = Object.freeze({ beforeDependencies: 16 * 1024 ** 3,
    beforePackage: 12 * 1024 ** 3, copyReserve: 2 * 1024 ** 3,
    asset: 2 * 1024 ** 3, payload: 2 * 1024 ** 3, files: 20000, directories: 20000,
    control: 4 * 1024 ** 2, metadata: 10 * 1024 ** 2, receipt: 8192, record: 65536 });
export const LINUX_CI_ASSETS = Object.freeze(['Diagnostic-Hub-linux-x64.AppImage', 'Diagnostic-Hub-linux-x64.tar.gz']);
export const LINUX_CI_METADATA = Object.freeze({ 'source-manifest.json': 1048576,
    'private-source.json': 65536, 'tooling-identity.json': 65536, 'admission.json': 8192,
    'pre-package.json': 65536, 'flat-inventory.json': 4194304,
    'diagnostic-hub-setup-payload.json': 4194304, 'linux-build-info.json': 65536,
    'Diagnostic-Hub-linux-x64.AppImage.sha256': 256, 'Diagnostic-Hub-linux-x64.tar.gz.sha256': 256,
    'build-result.json': 8192, 'upload-accounting.json': 8192 });
export const ciHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const ciJSON = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function linuxCINpmConfigPaths(root) {
    if (typeof root !== 'string' || root === '/' || !root.startsWith('/') ||
        path.posix.normalize(root) !== root || root.endsWith('/') || /[\\\x00-\x1f\x7f]/.test(root))
        throw Error('CI_NPM_CONFIG');
    return Object.freeze({ user: root + '/npm-user.npmrc', global: root + '/npm-global.npmrc' });
}
function npmConfigSnapshot(value, expectedPath, uid) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        value.path !== expectedPath || value.bytes !== 0 || value.sha256 !== ciHash(Buffer.alloc(0)) ||
        value.mode !== 0o600 || value.uid !== uid || value.nlink !== 1 ||
        !Number.isSafeInteger(value.dev) || value.dev < 0 || !Number.isSafeInteger(value.ino) || value.ino <= 0)
        throw Error('CI_NPM_CONFIG');
    return Object.freeze({ path: value.path, bytes: value.bytes, sha256: value.sha256,
        mode: value.mode, uid: value.uid, nlink: value.nlink, dev: value.dev, ino: value.ino });
}
async function inspectNpmConfigs(root, uid, io) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw Error('CI_NPM_CONFIG');
    const paths = linuxCINpmConfigPaths(root), user = npmConfigSnapshot(await io.inspectEmpty(paths.user), paths.user, uid),
        global = npmConfigSnapshot(await io.inspectEmpty(paths.global), paths.global, uid);
    if (user.dev === global.dev && user.ino === global.ino) throw Error('CI_NPM_CONFIG');
    return Object.freeze({ user, global });
}
/** Real exclusive creation is injected only by the already guarded admission phase. */
export async function createLinuxCINpmConfigs(root, uid, io) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw Error('CI_NPM_CONFIG');
    const paths = linuxCINpmConfigPaths(root);
    for (const name of [paths.user, paths.global])
        if (await io.createEmpty(name) !== true) throw Error('CI_NPM_CONFIG');
    return inspectNpmConfigs(root, uid, io);
}
/** Revalidate empty private files and original independent identities before later npm work. */
export async function verifyLinuxCINpmConfigs(root, uid, io, retained) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !retained || typeof retained !== 'object' ||
        Array.isArray(retained) || Object.keys(retained).sort().join(',') !== 'global,user') throw Error('CI_NPM_CONFIG');
    const paths = linuxCINpmConfigPaths(root), expected = Object.freeze({
        user: npmConfigSnapshot(retained.user, paths.user, uid), global: npmConfigSnapshot(retained.global, paths.global, uid) });
    if (expected.user.dev === expected.global.dev && expected.user.ino === expected.global.ino) throw Error('CI_NPM_CONFIG');
    const observed = await inspectNpmConfigs(root, uid, io);
    if (JSON.stringify(observed) !== JSON.stringify(expected)) throw Error('CI_NPM_CONFIG');
    return observed;
}
export function artifactOnlyDispatch(event, flag) { return event === 'workflow_dispatch' && flag === true; }
export function validateLinuxCIInput(input) {
    const v = structuredClone(input);
    if (!v || Object.keys(v).sort().join(',') !== 'appSHA,artifactOnly,buildId,event,repository,runAttempt,runId,workflowSHA' ||
        !artifactOnlyDispatch(v.event, v.artifactOnly) || v.repository !== 'brucerry/embedded-linux-diagnostic-hub' ||
        v.runAttempt !== '1' || typeof v.runId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v.runId) ||
        typeof v.appSHA !== 'string' || !/^[a-f0-9]{40}$/.test(v.appSHA) ||
        typeof v.workflowSHA !== 'string' || !/^[a-f0-9]{40}$/.test(v.workflowSHA) || v.appSHA === v.workflowSHA ||
        typeof v.buildId !== 'string' || !/^[a-f0-9]{32}$/.test(v.buildId)) throw Error('CI_INPUT');
    return v;
}
/** Admission headroom, not a hard peak-disk quota or product acceptance threshold. */
export function requireLinuxCISpace(freeBytes, phase, assetsBytes = 0) {
    if (typeof freeBytes !== 'bigint' || freeBytes < 0n || !Number.isSafeInteger(assetsBytes) ||
        assetsBytes < 0 || assetsBytes > 2 * LINUX_CI_LIMITS.asset) throw Error('CI_SPACE');
    const required = phase === 'dependencies' ? LINUX_CI_LIMITS.beforeDependencies :
        phase === 'package' ? LINUX_CI_LIMITS.beforePackage : phase === 'copy' ?
            assetsBytes + LINUX_CI_LIMITS.copyReserve + LINUX_CI_LIMITS.metadata : null;
    if (required === null || freeBytes < BigInt(required)) throw Error('CI_SPACE');
    return { freeBytes: freeBytes.toString(), requiredBytes: required, phase };
}
export function accountLinuxCIUpload(input, withoutAccounting = false) {
    if (!Array.isArray(input) || typeof withoutAccounting !== 'boolean') throw Error('CI_UPLOAD');
    const files = structuredClone(input), names = new Set(); let assetBytes = 0, metadataBytes = 0;
    const expected = [...LINUX_CI_ASSETS, ...Object.keys(LINUX_CI_METADATA)]
        .filter(n => !withoutAccounting || n !== 'upload-accounting.json').sort();
    for (const v of files) {
        if (!v || Object.keys(v).sort().join(',') !== 'bytes,name,sha256' ||
            typeof v.name !== 'string' || names.has(v.name) || !expected.includes(v.name) ||
            !Number.isSafeInteger(v.bytes) || v.bytes < 1 || typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256))
            throw Error('CI_UPLOAD');
        names.add(v.name);
        if (LINUX_CI_ASSETS.includes(v.name)) {
            if (v.bytes > LINUX_CI_LIMITS.asset) throw Error('CI_ASSET_CAP'); assetBytes += v.bytes;
        } else {
            if (v.bytes > LINUX_CI_METADATA[v.name]) throw Error('CI_METADATA_CAP'); metadataBytes += v.bytes;
        }
    }
    if ([...names].sort().join('\n') !== expected.join('\n') || metadataBytes > LINUX_CI_LIMITS.metadata)
        throw Error('CI_UPLOAD');
    return { files: files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        assetBytes, metadataBytes, totalBytes: assetBytes + metadataBytes };
}
/** Compare the final snapshot with the independently retained first table and serialized receipt. */
export function verifyLinuxCIUploadReadback(retainedFiles, expectedAccounting, finalFiles) {
    const receipt = structuredClone(expectedAccounting);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        Object.keys(receipt).sort().join(',') !== 'bytes,sha256') throw Error('CI_UPLOAD');
    const retained = accountLinuxCIUpload(retainedFiles, true);
    const expected = accountLinuxCIUpload([...retained.files, { name: 'upload-accounting.json', ...receipt }]);
    const actual = accountLinuxCIUpload(finalFiles);
    for (let n = 0; n < expected.files.length; n++) {
        const a = expected.files[n], b = actual.files[n];
        if (a.name !== b.name || a.bytes !== b.bytes || a.sha256 !== b.sha256) throw Error('CI_CHANGED');
    }
    return actual;
}
export function privateLinuxCIRecord(source, assets, archiveBytes, sourceBytes) {
    return createLinuxBuildRecord({ mode: 'private-build', version: source.version, commit: source.commit,
        assets, archiveBytes, source, sourceRecordSHA256: ciHash(sourceBytes), validationEvidence: null });
}
/** Fakeable inventory boundary; concrete stable/nonfollow IO is supplied only by explicit CLI main. */
export async function inventoryLinuxCIFlat(root, io) {
    const files = [], directories = [], seen = new Set(); let bytes = 0, control = 64;
    async function visit(relative) {
        const children = await io.children(root, relative);
        if (!Array.isArray(children) || children.length > 40000) throw Error('CI_PAYLOAD');
        for (const name of children) {
            if (typeof name !== 'string' || !name || /[\\/\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..')
                throw Error('CI_PAYLOAD');
            const path = relative ? relative + '/' + name : name, key = path.normalize('NFC');
            if (path.length > 1024 || seen.has(key)) throw Error('CI_PAYLOAD'); seen.add(key);
            const observed = await io.inspect(root, path);
            if (!observed || !['file', 'directory'].includes(observed.kind) ||
                !Number.isSafeInteger(observed.mode) || observed.mode < 0 || observed.mode > 0o777 ||
                (observed.mode & 0o022) || !(observed.mode & 0o400)) throw Error('CI_PAYLOAD');
            if (observed.kind === 'directory') {
                if (!(observed.mode & 0o100) || directories.length >= LINUX_CI_LIMITS.directories) throw Error('CI_PAYLOAD');
                control += Buffer.byteLength(JSON.stringify(path)) + 1;
                directories.push(path); await visit(path);
            } else {
                if (!Number.isSafeInteger(observed.bytes) || observed.bytes < 0 || files.length >= LINUX_CI_LIMITS.files ||
                    bytes + observed.bytes > LINUX_CI_LIMITS.payload) throw Error('CI_PAYLOAD');
                const sha256 = await io.hash(root, path, observed);
                if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw Error('CI_PAYLOAD');
                const file = { path, bytes: observed.bytes, sha256, mode: observed.mode };
                control += Buffer.byteLength(JSON.stringify(file)) + 1; files.push(file); bytes += observed.bytes;
            }
            if (control > LINUX_CI_LIMITS.control) throw Error('CI_PAYLOAD_CAP');
        }
    }
    await visit(''); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); directories.sort();
    return { files, directories, payloadBytes: bytes, inventorySHA256: ciHash(Buffer.from(JSON.stringify(files))) };
}
