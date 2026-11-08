import { readStableArtifactFile } from './stable-artifact-file.mjs';
export { readStableArtifactFile } from './stable-artifact-file.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateWebBuildCustody } from './owned-web-build.mjs';
import {
    observeSourceBridge,
    sourceDigest,
    validateSourceBridge,
} from './committed-source-bridge.mjs';

import { WEB_ARCHIVE_LIMITS } from './web-archive-limits.mjs';
export { WEB_ARCHIVE_LIMITS } from './web-archive-limits.mjs';
const hash = /^[a-f0-9]{64}$/;
const oid = /^[a-f0-9]{40}$/;
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
    assert.equal(
        value.scope,
        'web',
        'Gateway archive production needs a reviewed staged-lock/payload census; unsupported before build.',
    );
    assert.match(
        value.version,
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?$/,
    );
    assert.match(value.sourceCommit, oid);
    assert.match(value.sourceTree, oid);
    for (const key of ['runId', 'runAttempt']) assert.match(value[key], /^[1-9][0-9]*$/);
    assert.match(value.jobKey, /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/);
    return Object.freeze({ ...value });
}
function localContext(value) {
    closed(value, ['scope', 'version', 'sourceCommit', 'sourceTree', 'diagnosticId']);
    assert.equal(value.scope, 'local-web-diagnostic');
    assert.match(
        value.version,
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?$/,
    );
    assert.match(value.sourceCommit, oid);
    assert.match(value.sourceTree, oid);
    assert.match(value.diagnosticId, /^[a-f0-9]{32}$/);
    return Object.freeze({ ...value });
}
function memberName(path, seen) {
    assert.ok(typeof path === 'string' && Buffer.byteLength(path) <= WEB_ARCHIVE_LIMITS.path);
    assert.equal(path.normalize('NFC'), path);
    assert.ok(!/[\\:\x00-\x1f\x7f]/.test(path));
    const parts = path.split('/');
    assert.ok(
        parts.every(
            (part) =>
                part &&
                part !== '.' &&
                part !== '..' &&
                !/[ .]$/.test(part) &&
                !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    );
    const key = path.toLowerCase();
    assert.ok(!seen.has(key), 'Aliased archive payload.');
    for (const prior of seen)
        assert.ok(
            !key.startsWith(prior + '/') && !prior.startsWith(key + '/'),
            'File/directory alias.',
        );
    seen.add(key);
}
function payload(files) {
    assert.ok(files instanceof Map && files.size > 0 && files.size <= WEB_ARCHIVE_LIMITS.entries);
    const seen = new Set(),
        records = [],
        values = Object.create(null);
    let total = 0;
    for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        memberName(path, seen);
        assert.ok(Buffer.isBuffer(bytes) && bytes.length <= WEB_ARCHIVE_LIMITS.member);
        total += bytes.length;
        assert.ok(total <= WEB_ARCHIVE_LIMITS.expanded);
        values[path] = Buffer.from(bytes);
        records.push({ path, bytes: bytes.length, sha256: sourceDigest(bytes) });
    }
    for (const name of ['index.html', 'capture-download-sw.js', 'capture-download-frame.js'])
        assert.ok(Object.hasOwn(values, name), 'Missing shipping web entry: ' + name);
    return { records, values };
}
function builder(value) {
    closed(value, ['runtime', 'viteEntryPath', 'viteEntrySHA256']);
    assert.match(value.viteEntrySHA256, hash);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024);
    assert.ok(
        typeof value.viteEntryPath === 'string' &&
            value.viteEntryPath.startsWith('/') &&
            value.viteEntryPath.endsWith('/vite/bin/vite.js'),
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
    assert.match(r.executableSHA256, hash);
    assert.match(r.node, /^v24\./);
    assert.ok(['linux', 'darwin'].includes(r.platform));
    assert.ok(['x64', 'arm64'].includes(r.arch));
    assert.ok(typeof r.executablePath === 'string' && r.executablePath.startsWith('/'));
    assert.ok(r.versions && r.versions.node === r.node.slice(1));
    assert.ok(Array.isArray(r.execArgv) && r.execArgv.every((arg) => typeof arg === 'string'));
    assert.ok(r.nodeOptions === null || typeof r.nodeOptions === 'string');
    // Snapshot all nested identity collections before awaiting a build.
    return JSON.parse(JSON.stringify(value));
}
function buildOutcome(result, observedBuilder) {
    closed(result, ['pid', 'exitCode', 'signal', 'error', 'command', 'environment', 'custody']);
    assert.ok(
        Array.isArray(result.command) &&
            result.command.length === 9 &&
            result.command.every((value) => typeof value === 'string'),
    );
    assert.equal(result.command[0], observedBuilder.runtime.executablePath);
    assert.equal(result.command[1], observedBuilder.viteEntryPath);
    assert.deepEqual(
        [
            result.command[2],
            result.command[3],
            result.command[5],
            result.command[6],
            result.command[7],
        ],
        ['build', '--config', '--mode', 'web', '--outDir'],
    );
    assert.ok(result.command[4].startsWith('/') && result.command[4].endsWith('/vite.config.mts'));
    assert.ok(result.command[8].startsWith('/'));
    assert.deepEqual(result.environment, { NODE_ENV: 'production', WEB_BASE_PATH: './' });
    assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0);
    assert.equal(result.error, null);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    validateWebBuildCustody(result.custody);
    return result;
}
/** An actual producer's fixed sequence, with injectable IO only for memory tests. No workload/runtime pass. */
export async function produceWebArchive(input, sourceProvider, io) {
    return produceArchive(context(input), sourceProvider, io, false);
}
/** Explicit local diagnostic only. No service IDs, native defaults or release capability. */
export async function produceLocalWebArchive(input, sourceProvider, io) {
    return produceArchive(localContext(input), sourceProvider, io, true);
}
async function produceArchive(expected, sourceProvider, io, local) {
    const selected = { sourceCommit: expected.sourceCommit, sourceTree: expected.sourceTree };
    const source = await observeSourceBridge(selected, sourceProvider);
    const packageBytes = await io.packageJSON();
    const packageRecord = source.inventory.find((file) => file.path === 'package.json');
    assert.ok(packageRecord && sourceDigest(packageBytes) === packageRecord.sha256);
    assert.equal(JSON.parse(packageBytes.toString('utf8')).version, expected.version);
    const observedBuilder = builder(await io.builder());
    const result = structuredClone(await io.build());
    buildOutcome(result, observedBuilder);
    // A rejected/unknown build cannot be promoted into output collection or publication.
    const before = payload(await io.output());
    assert.deepEqual(
        await observeSourceBridge(selected, sourceProvider),
        source,
        'Source changed during build.',
    );
    assert.deepEqual(builder(await io.builder()), observedBuilder, 'Builder identity changed.');
    // Read-only consumers of this module do not need the producer's ZIP encoder.
    const { zipSync, unzipSync } = await import('fflate');
    const archive = Buffer.from(zipSync(before.values));
    assert.ok(archive.length > 0 && archive.length <= WEB_ARCHIVE_LIMITS.archive);
    const decoded = unzipSync(archive);
    assert.deepEqual(
        Object.keys(decoded).sort(),
        before.records.map((file) => file.path),
    );
    for (const file of before.records) assert.equal(sourceDigest(decoded[file.path]), file.sha256);
    const name = `Diagnostic-Hub-Web-${expected.version}.zip`;
    const artifact = { name, bytes: archive.length, sha256: sourceDigest(archive) };
    // Recheck all observed inputs before the new output is written; no pre-existing path overwrite.
    assert.deepEqual(payload(await io.output()).records, before.records, 'Build output changed.');
    assert.deepEqual(
        await observeSourceBridge(selected, sourceProvider),
        source,
        'Source changed before archive write.',
    );
    const published = await io.writeArchive(name, archive);
    assert.deepEqual(published, artifact, 'Written archive bytes differ.');
    // Failure after writing preserves the archive but emits no completed build record.
    assert.deepEqual(
        await observeSourceBridge(selected, sourceProvider),
        source,
        'Source changed after archive write.',
    );
    assert.deepEqual(
        payload(await io.output()).records,
        before.records,
        'Build output changed after archive write.',
    );
    assert.deepEqual(
        builder(await io.builder()),
        observedBuilder,
        'Builder identity changed after archive write.',
    );
    const checksumBytes = Buffer.from(`${artifact.sha256}  ${artifact.name}\n`);
    const checksum = {
        name: name + '.sha256',
        bytes: checksumBytes.length,
        sha256: sourceDigest(checksumBytes),
    };
    assert.deepEqual(
        await io.writeChecksum(checksum.name, checksumBytes),
        checksum,
        'Written checksum bytes differ.',
    );
    assert.deepEqual(
        await observeSourceBridge(selected, sourceProvider),
        source,
        'Source changed before build-record handoff.',
    );
    assert.deepEqual(
        payload(await io.output()).records,
        before.records,
        'Output changed before build-record handoff.',
    );
    assert.deepEqual(
        builder(await io.builder()),
        observedBuilder,
        'Builder changed before build-record handoff.',
    );
    const record = {
        schemaVersion: 1,
        kind: local ? 'local-web-source-build-archive' : 'web-source-build-archive',
        status: 'built',
        context: expected,
        sourceBridgeSHA256: sourceDigest(JSON.stringify(source) + '\n'),
        sourceBridge: source,
        builder: observedBuilder,
        build: { preset: 'shipping-vite-web', ...result },
        archive: artifact,
        checksum,
        payload: before.records,
        productRuntime: null,
        loaderProvenance: null,
        normalGC: null,
        forcedGC: null,
        releaseAcceptance: false,
        ...(local ? { serviceProvenance: null } : {}),
    };
    validateRecord(record, expected, local);
    const recordBytes = Buffer.from(JSON.stringify(record) + '\n');
    assert.ok(recordBytes.length <= 16 * 1024 ** 2, 'Build record exceeds its storage bound.');
    assert.deepEqual(
        await io.writeRecord(record, recordBytes),
        {
            name: local ? 'local-web-build.json' : 'web-build.json',
            bytes: recordBytes.length,
            sha256: sourceDigest(recordBytes),
        },
        'Written build record bytes differ.',
    );
    return record;
}

/** Bounded stable regular-file read. No filesystem default: the actual caller supplies its IO. */
/** Data/schema authority only. Source, archive bytes and service outcome need independent reobservation. */
export function validateWebArchiveBuildRecord(value, expected) {
    return validateRecord(value, expected, false);
}
export function validateLocalWebArchiveBuildRecord(value, expected) {
    return validateRecord(value, expected, true);
}
function validateRecord(value, expected, local) {
    closed(value, [
        'schemaVersion',
        'kind',
        'status',
        'context',
        'sourceBridgeSHA256',
        'sourceBridge',
        'builder',
        'build',
        'archive',
        'checksum',
        'payload',
        'productRuntime',
        'loaderProvenance',
        'normalGC',
        'forcedGC',
        'releaseAcceptance',
        ...(local ? ['serviceProvenance'] : []),
    ]);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.kind, local ? 'local-web-source-build-archive' : 'web-source-build-archive');
    if (local) assert.equal(value.serviceProvenance, null);
    assert.equal(value.status, 'built');
    assert.equal(value.releaseAcceptance, false);
    assert.deepEqual(value.context, local ? localContext(expected) : context(expected));
    validateSourceBridge(value.sourceBridge, {
        sourceCommit: expected.sourceCommit,
        sourceTree: expected.sourceTree,
    });
    assert.equal(value.sourceBridgeSHA256, sourceDigest(JSON.stringify(value.sourceBridge) + '\n'));
    const observedBuilder = builder(value.builder),
        { preset, ...result } = value.build;
    assert.equal(preset, 'shipping-vite-web');
    buildOutcome(result, observedBuilder);
    for (const field of ['productRuntime', 'loaderProvenance', 'normalGC', 'forcedGC'])
        assert.equal(value[field], null);
    closed(value.archive, ['name', 'bytes', 'sha256']);
    assert.equal(value.archive.name, `Diagnostic-Hub-Web-${expected.version}.zip`);
    assert.ok(
        Number.isSafeInteger(value.archive.bytes) &&
            value.archive.bytes > 0 &&
            value.archive.bytes <= WEB_ARCHIVE_LIMITS.archive,
    );
    assert.match(value.archive.sha256, hash);
    const checksum = Buffer.from(`${value.archive.sha256}  ${value.archive.name}\n`);
    assert.deepEqual(value.checksum, {
        name: value.archive.name + '.sha256',
        bytes: checksum.length,
        sha256: sourceDigest(checksum),
    });
    assert.ok(
        Array.isArray(value.payload) &&
            value.payload.length > 0 &&
            value.payload.length <= WEB_ARCHIVE_LIMITS.entries,
    );
    const names = new Set();
    let total = 0;
    for (const file of value.payload) {
        closed(file, ['path', 'bytes', 'sha256']);
        memberName(file.path, names);
        assert.ok(
            Number.isSafeInteger(file.bytes) &&
                file.bytes >= 0 &&
                file.bytes <= WEB_ARCHIVE_LIMITS.member,
        );
        total += file.bytes;
        assert.ok(total <= WEB_ARCHIVE_LIMITS.expanded);
        assert.match(file.sha256, hash);
    }
    for (const name of ['index.html', 'capture-download-sw.js', 'capture-download-frame.js'])
        assert.ok(value.payload.some((file) => file.path === name));
    assert.deepEqual(
        value.payload.map((file) => file.path),
        value.payload.map((file) => file.path).sort(),
    );
    return value;
}
export function parseWebArchiveBuildRecord(bytes, expected) {
    return parseRecord(bytes, expected, false);
}
export function parseLocalWebArchiveBuildRecord(bytes, expected) {
    return parseRecord(bytes, expected, true);
}
function parseRecord(bytes, expected, local) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 16 * 1024 ** 2);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
        value = JSON.parse(text);
    assert.equal(text, JSON.stringify(value) + '\n', 'Noncanonical web build record.');
    return validateRecord(value, expected, local);
}
