import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const artifactName = 'Diagnostic-Hub-linux-x64.tar.gz';
export const productTree = '25bee80732419d25b98614c414ef3d336bd9f03d';
export const lockSHA256 = '6eda133d8af11aae5e896876515130792e781f2054d071e2f68a9bcc4272b64c';
export const permanentInputs = Object.freeze({
    'linux-installed-AppRun': { source: 'scripts/linux-installed-launcher.sh', mode: 0o755, cap: 16384 },
    'linux-setup-bootstrap.cjs': { source: 'dist-electron/linux-setup-bootstrap.cjs', mode: 0o644, cap: 1048576 },
    'linux-setup-install.cjs': { source: 'dist-electron/linux-setup-install.cjs', mode: 0o644, cap: 1048576 },
    'diagnostic_hub_rename_noreplace.node': {
        source: 'dist-linux-native/diagnostic_hub_rename_noreplace.node', mode: 0o644, cap: 33554432,
    },
});

const snapshot = (stats) => [stats.dev, stats.ino, stats.uid, stats.nlink, stats.mode,
    stats.size, stats.mtimeNs, stats.ctimeNs];
const asBigInt = { bigint: true };
const MAX_ARCHIVE = 2 * 1024 ** 3;
const sourceManifestPin = 'e8959a2e567247223cf66a010a3e1f8fef68062ef85aff6094d3e1d527d2c7ab';
const sourceManifestPath = fileURLToPath(new URL('./pins/SOURCE-FILES.json', import.meta.url));
const readers = {
    'linux-permanent-member-modes.mjs': 'c6a682e6b50b1144d4e3a6fd50cae1a625294812d64d1875495b02a5d1ddc9a5',
    'linux-archive-members.mjs': '2fe87a75f393db9e35642f34831aac6180009448c0f0487465b7342d12bbcc1d',
    'linux-release-observation.ts': 'e906341ba6cf75d0aedb9ec83a2d48000059ea39019e9346ba800c824d4db54f',
    'linux-build-record.mjs': 'be4a7b703744d2d0427174270b985942b5b3fbc7609f4e892d27165dd5ecc589',
};

async function readDigest(file, cap, { expectedMode, collect = false, gitBlob = false } = {}) {
    assert.equal(await realpath(file), file, 'CANONICAL_FILE');
    const info = await lstat(file, asBigInt);
    assert.ok(info.isFile() && info.nlink === 1n && info.uid === BigInt(process.getuid()) &&
        (gitBlob || info.size > 0n) && info.size <= BigInt(cap) &&
        (info.mode & 0o7022n) === 0n, 'OWNED_REGULAR_FILE');
    if (expectedMode !== undefined) assert.equal(Number(info.mode & 0o7777n), expectedMode, 'STAGED_MODE');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        assert.deepEqual(snapshot(await handle.stat(asBigInt)), snapshot(info), 'FILE_CHANGED');
        const hash = createHash(gitBlob ? 'sha1' : 'sha256');
        if (gitBlob) hash.update('blob ' + info.size + '\0');
        const parts = [];
        const buffer = Buffer.alloc(65536);
        let bytes = 0;
        while (bytes < Number(info.size)) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(info.size) - bytes), bytes);
            assert.ok(bytesRead, 'FILE_SHORT_READ');
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            if (collect) parts.push(Buffer.from(chunk));
            bytes += bytesRead;
        }
        assert.deepEqual(snapshot(await handle.stat(asBigInt)), snapshot(info), 'FILE_CHANGED');
        assert.deepEqual(snapshot(await lstat(file, asBigInt)), snapshot(info), 'FILE_PATH_CHANGED');
        if (gitBlob)
            return { oid: hash.digest('hex'), executable: (info.mode & 0o111n) !== 0n };
        return { bytes, sha256: hash.digest('hex'), ...(collect ? { body: Buffer.concat(parts) } : {}) };
    } finally {
        await handle.close();
    }
}

async function verifyTrackedSource(project) {
    const manifest = await readDigest(sourceManifestPath, 262144, { collect: true });
    assert.equal(manifest.sha256, sourceManifestPin, 'TRACKED_SOURCE_MANIFEST');
    const { tree, files } = JSON.parse(manifest.body.toString('utf8'));
    assert.equal(tree, productTree, 'TRACKED_SOURCE_TREE');
    const entries = Object.entries(files);
    assert.equal(entries.length, 1229, 'TRACKED_SOURCE_COUNT');
    for (const [relative, [oid, executable]] of entries) {
        assert.ok(relative !== '.' && path.posix.normalize(relative) === relative &&
            !path.posix.isAbsolute(relative) && !/[\\\0]/.test(relative) &&
            !relative.split('/').some((part) => part === '..' || part === '.git'), 'TRACKED_SOURCE_PATH');
        let observed;
        try {
            observed = await readDigest(path.join(project, relative), 32 * 1024 ** 2, { gitBlob: true });
        } catch (error) {
            throw new assert.AssertionError({ message: 'TRACKED_SOURCE_CUSTODY: ' + relative, cause: error });
        }
        assert.deepEqual(observed, { oid, executable }, 'TRACKED_SOURCE_IDENTITY: ' + relative);
    }
    return entries.length;
}

async function sameJob(project, archive, expected, reader) {
    assert.deepEqual(await readDigest(archive, MAX_ARCHIVE), expected, 'ARCHIVE_DIGEST');
    const fromArchive = await reader.readLinuxTarPermanentMembers(archive, { expected });
    // This reader's optional consumer is the ordinary verify/extract API. Assert modes
    // explicitly so the build-only path needs no consumer or extraction.
    reader.assertLinuxPermanentMemberModes(fromArchive);
    const expectedRoles = [];
    const release = path.dirname(archive);
    for (const [name, spec] of Object.entries(permanentInputs)) {
        const source = await readDigest(path.join(project, spec.source), spec.cap);
        const staged = await readDigest(path.join(release, 'linux-unpacked/resources', name), spec.cap,
            { expectedMode: spec.mode });
        assert.deepEqual(staged, source, 'AFTERPACK_SOURCE_BYTES');
        expectedRoles.push({ path: 'resources/' + name, kind: 'file', mode: spec.mode, ...source });
    }
    const sort = (list) => list.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    assert.deepEqual(sort(fromArchive), sort(expectedRoles), 'ARCHIVE_STAGED_BYTES');
    assert.deepEqual(await readDigest(archive, MAX_ARCHIVE), expected, 'ARCHIVE_FINAL_READBACK');
    return { artifact: { name: artifactName, ...expected }, members: expectedRoles };
}

export async function verifyBuildOnlyTar(project, archive, sidecar, reader) {
    assert.ok(process.getuid() > 0 && process.getuid() === process.geteuid(), 'NONROOT_BUILD_OUTPUT');
    assert.equal(await realpath(project), project, 'CANONICAL_PROJECT');
    assert.equal(archive, path.join(project, 'release', artifactName), 'ARCHIVE_OUTPUT_NAME');
    assert.equal(sidecar, archive + '.sha256', 'SAME_JOB_SIDECAR_PATH');
    const sum = await readDigest(sidecar, 128, { collect: true });
    const expected = await readDigest(archive, MAX_ARCHIVE);
    assert.deepEqual(sum.body, Buffer.from(`${expected.sha256}  ${artifactName}\n`), 'CHECKSUM_SIDECAR');
    return await sameJob(project, archive, expected, reader);
}

async function main([project, phase]) {
    assert.ok(project && ['capture-checksum', 'verify'].includes(phase), 'TAR_PROOF_ARGUMENTS');
    assert.ok(process.getuid() > 0 && process.getuid() === process.geteuid(), 'NONROOT_BUILD_OUTPUT');
    assert.equal(await realpath(project), project, 'CANONICAL_PROJECT');
    assert.equal((await readDigest(path.join(project, 'package-lock.json'), 1048576)).sha256, lockSHA256, 'LOCK_PIN');
    const archive = path.join(project, 'release', artifactName);
    const sidecar = archive + '.sha256';
    if (phase === 'capture-checksum') {
        // Only the build step writes the checksum. The next step verifies it against new reads.
        const hash = await readDigest(archive, MAX_ARCHIVE);
        const output = await open(sidecar, 'wx', 0o600);
        try {
            await output.writeFile(`${hash.sha256}  ${artifactName}\n`);
            await output.sync();
        } finally {
            await output.close();
        }
        return;
    }
    const readerRoot = path.join(project, 'scripts/lib');
    const trackedSourcePaths = await verifyTrackedSource(project);
    for (const [file, hash] of Object.entries(readers))
        assert.equal((await readDigest(path.join(readerRoot, file), 131072)).sha256, hash, 'PRODUCTION_READER_PIN');
    const reader = await import(pathToFileURL(path.join(readerRoot, 'linux-permanent-member-modes.mjs')).href);
    const result = await verifyBuildOnlyTar(project, archive, sidecar, reader);
    console.log(JSON.stringify({ kind: 'linux-tar-build-only', productTree, lockSHA256, trackedSourcePaths, ...result }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof assert.AssertionError ? error.message : 'TAR_PROOF_IO_OR_FORMAT');
        process.exitCode = 1;
    }
}
