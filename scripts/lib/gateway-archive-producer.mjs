import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'fflate';
import { valid } from 'semver';
import { observeSourceBridge, sourceDigest } from './committed-source-bridge.mjs';
import { localSourceProvider } from './committed-source-provider.mjs';
import { WEB_ARCHIVE_LIMITS } from './web-archive-producer.mjs';
import { LinuxTarCensus } from './linux-archive-members.mjs';
import { OwnedGatewayStage } from './owned-gateway-stage.mjs';
import {
    GATEWAY_SOURCE_FILES,
    GATEWAY_PAYLOAD_FILES,
    gatewayStageFiles,
    projectGatewayLock,
    validatePreparedGatewayLock,
} from './gateway-lock-plan.mjs';

function closed(value, fields) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
}
function context(value) {
    closed(value, [
        'scope',
        'version',
        'sourceCommit',
        'sourceTree',
        'runId',
        'runAttempt',
        'jobKey',
    ]);
    assert.equal(value.scope, 'gateway');
    assert.ok(valid(value.version));
    for (const key of ['sourceCommit', 'sourceTree']) assert.match(value[key], /^[a-f0-9]{40}$/);
    for (const key of ['runId', 'runAttempt']) assert.match(value[key], /^[1-9][0-9]{0,31}$/);
    assert.match(value.jobKey, /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/);
    return Object.freeze({ ...value });
}
function toolchain(value) {
    closed(value, [
        'runtime',
        'esbuildEntryPath',
        'esbuildEntrySHA256',
        'npmEntryPath',
        'npmEntrySHA256',
        'npmVersion',
        'npmPackageSHA256',
    ]);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024);
    assert.ok(valid(value.npmVersion));
    for (const field of ['esbuildEntrySHA256', 'npmEntrySHA256', 'npmPackageSHA256'])
        assert.match(value[field], /^[a-f0-9]{64}$/);
    assert.ok(
        value.esbuildEntryPath.startsWith('/') &&
            value.esbuildEntryPath.endsWith('/esbuild/bin/esbuild'),
    );
    assert.ok(
        value.npmEntryPath.startsWith('/') && value.npmEntryPath.endsWith('/npm/bin/npm-cli.js'),
    );
    const r = value.runtime;
    closed(r, [
        'executablePath',
        'executableSHA256',
        'node',
        'platform',
        'arch',
        'versions',
        'execArgv',
        'nodeOptions',
    ]);
    assert.match(r.executableSHA256, /^[a-f0-9]{64}$/);
    assert.match(r.node, /^v24\./);
    assert.ok(
        r.executablePath.startsWith('/') &&
            ['linux', 'darwin'].includes(r.platform) &&
            ['x64', 'arm64'].includes(r.arch),
    );
    assert.equal(r.versions.node, r.node.slice(1));
    assert.ok(Array.isArray(r.execArgv));
    assert.equal(r.nodeOptions, null);
    return JSON.parse(JSON.stringify(value));
}
function entries(files) {
    assert.ok(files instanceof Map);
    assert.deepEqual([...files.keys()].sort(), [...GATEWAY_PAYLOAD_FILES].sort());
    const values = [],
        directories = new Set();
    let total = 0;
    for (const [path, bytes] of files) {
        assert.ok(Buffer.isBuffer(bytes) && bytes.length <= WEB_ARCHIVE_LIMITS.member);
        total += bytes.length;
        assert.ok(total <= WEB_ARCHIVE_LIMITS.expanded);
        const parts = path.split('/');
        parts.pop();
        while (parts.length) {
            directories.add(parts.join('/'));
            parts.pop();
        }
        values.push({
            kind: 'file',
            path,
            mode: 0o644,
            bytes: bytes.length,
            sha256: sourceDigest(bytes),
        });
    }
    assert.ok(files.get('dist-gateway/main.cjs').length > 0);
    for (const path of directories) values.push({ kind: 'directory', path, mode: 0o755 });
    return values.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
/** Canonical USTAR writer for this exact eight-file layout; never truncates a path or invokes tar. */
export function encodeGatewayTar(files) {
    const inventory = entries(files),
        chunks = [];
    const octal = (header, at, width, number) => {
        const value = number.toString(8);
        assert.ok(value.length <= width - 1);
        header.write(value.padStart(width - 1, '0') + '\0', at, width, 'ascii');
    };
    for (const entry of inventory) {
        const header = Buffer.alloc(512),
            name = entry.path + (entry.kind === 'directory' ? '/' : '');
        assert.ok(Buffer.byteLength(name) <= 100);
        header.write(name, 0, 100, 'utf8');
        octal(header, 100, 8, entry.mode);
        octal(header, 108, 8, 0);
        octal(header, 116, 8, 0);
        octal(header, 124, 12, entry.bytes ?? 0);
        octal(header, 136, 12, 0);
        header.fill(32, 148, 156);
        header[156] = entry.kind === 'directory' ? 53 : 48;
        Buffer.from('ustar\0').copy(header, 257);
        Buffer.from('00').copy(header, 263);
        const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8);
        assert.ok(checksum.length <= 6);
        header.write(checksum.padStart(6, '0') + '\0 ', 148, 8, 'ascii');
        chunks.push(header);
        if (entry.kind === 'file') {
            const bytes = files.get(entry.path);
            chunks.push(bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
        }
    }
    chunks.push(Buffer.alloc(1024));
    return Buffer.concat(chunks);
}
/** Strict owned-stage census plus byte-exact canonical header/padding check, without extraction. */
export function inspectOwnedGatewayTar(bytes, files) {
    assert.ok(
        Buffer.isBuffer(bytes) && bytes.length <= WEB_ARCHIVE_LIMITS.expanded + 4096 * 1024 + 1024,
    );
    const census = new LinuxTarCensus();
    for (let at = 0; at < bytes.length; at += 65536) census.push(bytes.subarray(at, at + 65536));
    const value = census.finish();
    assert.deepEqual(value.entries, entries(files));
    assert.ok(bytes.equals(encodeGatewayTar(files)), 'Noncanonical Gateway tar bytes.');
    return value;
}
function hashes(files) {
    return [...files]
        .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sourceDigest(bytes) }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export class GatewayProducerFailure extends Error {
    constructor(cause, owner) {
        super('Gateway producer failed; generated workspace and uncertain owners retained.', {
            cause,
        });
        this.owner = owner;
    }
}
/** Real staging sequence; command dispatch is deliberately an explicit admitted capability, not JSON input. */
export async function produceGatewayArchive(input, options, io) {
    const expected = context(input),
        selected = { sourceCommit: expected.sourceCommit, sourceTree: expected.sourceTree };
    assert.ok(
        io &&
            typeof io.execute === 'function' &&
            typeof io.observeToolchain === 'function' &&
            io.filesystem,
    );
    const provider = await (io.sourceFactory ?? localSourceProvider)(options.sourceRoot);
    const source = await observeSourceBridge(selected, provider),
        sourceFiles = new Map();
    for (const path of GATEWAY_SOURCE_FILES) {
        const file = await provider.file(path),
            pinned = source.inventory.find((entry) => entry.path === path);
        assert.ok(
            pinned &&
                pinned.bytes === file.bytes.length &&
                pinned.sha256 === sourceDigest(file.bytes),
        );
        sourceFiles.set(path, Buffer.from(file.bytes));
    }
    const packageSource = JSON.parse(sourceFiles.get('package.json').toString('utf8'));
    assert.equal(packageSource.version, expected.version);
    // Validate/project source data before allocating an owned namespace or dispatching anything.
    projectGatewayLock(
        packageSource,
        JSON.parse(sourceFiles.get('package-lock.json').toString('utf8')),
    );
    const builder = toolchain(await io.observeToolchain());
    const stage = new OwnedGatewayStage(io.filesystem, options.sourceRoot, options.leaf);
    try {
        await stage.initialize();
        const build = await stage.execute(stage.plan('build', builder), io.execute);
        assert.deepEqual(
            await observeSourceBridge(selected, provider),
            source,
            'Source changed during Gateway build.',
        );
        assert.deepEqual(toolchain(await io.observeToolchain()), builder);
        const compiled = await stage.readBuild(),
            prepared = gatewayStageFiles(sourceFiles, compiled);
        await stage.putPayload(prepared.files);
        const lockPreparation = await stage.execute(stage.plan('lock', builder), io.execute);
        let files = await stage.collect(GATEWAY_PAYLOAD_FILES);
        const stagedManifest = JSON.parse(files.get('package.json').toString('utf8'));
        assert.deepEqual(stagedManifest, prepared.manifest);
        validatePreparedGatewayLock(
            JSON.parse(files.get('package-lock.json').toString('utf8')),
            prepared.manifest,
            prepared.sourceLock,
        );
        for (const [path, bytes] of prepared.files)
            if (!['package.json', 'package-lock.json'].includes(path))
                assert.ok(files.get(path).equals(bytes), 'Staged source/compiled bytes changed.');
        const payload = hashes(files),
            raw = encodeGatewayTar(files),
            tarInventory = inspectOwnedGatewayTar(raw, files);
        const archiveBytes = Buffer.from(gzipSync(raw, { mtime: 0 }));
        assert.ok(archiveBytes.length <= WEB_ARCHIVE_LIMITS.archive);
        assert.ok(Buffer.from(gunzipSync(archiveBytes)).equals(raw)); // Our own encoded bytes only, not untrusted archive admission.
        assert.deepEqual(await observeSourceBridge(selected, provider), source);
        assert.deepEqual(toolchain(await io.observeToolchain()), builder);
        assert.deepEqual(hashes(await stage.collect(GATEWAY_PAYLOAD_FILES)), payload);
        const name = `Diagnostic-Hub-Gateway-${expected.version}.tar.gz`,
            archive = { name, bytes: archiveBytes.length, sha256: sourceDigest(archiveBytes) };
        assert.ok((await stage.publish(name, archiveBytes)).equals(archiveBytes));
        const checksumBytes = Buffer.from(`${archive.sha256}  ${name}\n`),
            checksum = {
                name: name + '.sha256',
                bytes: checksumBytes.length,
                sha256: sourceDigest(checksumBytes),
            };
        assert.ok((await stage.publish(checksum.name, checksumBytes)).equals(checksumBytes));
        assert.deepEqual(await observeSourceBridge(selected, provider), source);
        assert.deepEqual(toolchain(await io.observeToolchain()), builder);
        assert.deepEqual(hashes(await stage.collect(GATEWAY_PAYLOAD_FILES)), payload);
        stage.assertQuiescent();
        const record = {
            schemaVersion: 1,
            kind: 'gateway-source-build-archive',
            status: 'built',
            context: expected,
            sourceBridge: source,
            sourceBridgeSHA256: sourceDigest(JSON.stringify(source) + '\n'),
            builder,
            build,
            lockPreparation,
            sourceLockSHA256: prepared.sourceLockSHA256,
            projectedLockSHA256: sourceDigest(prepared.files.get('package-lock.json')),
            preparedLockSHA256: sourceDigest(files.get('package-lock.json')),
            stage: {
                owner: stage.token,
                workspace: 'retained-no-deletion',
                ownerCompletion: 'not-asserted',
            },
            payload,
            tarInventory,
            archive,
            checksum,
            productRuntime: null,
            loaderProvenance: null,
            normalGC: null,
            forcedGC: null,
            retirement: null,
            releaseAcceptance: false,
        };
        const recordBytes = Buffer.from(JSON.stringify(record) + '\n');
        assert.ok(recordBytes.length <= 16 * 1024 ** 2);
        assert.ok((await stage.publish('gateway-build.json', recordBytes)).equals(recordBytes));
        assert.deepEqual(
            await observeSourceBridge(selected, provider),
            source,
            'Source changed after Gateway manifest write.',
        );
        assert.deepEqual(hashes(await stage.collect(GATEWAY_PAYLOAD_FILES)), payload);
        assert.deepEqual(toolchain(await io.observeToolchain()), builder);
        const owner = stage.seal();
        return { record, owner };
    } catch (error) {
        stage.fail(error);
        throw new GatewayProducerFailure(error, stage);
    }
}
