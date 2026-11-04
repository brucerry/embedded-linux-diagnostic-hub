import assert from 'node:assert/strict';
import path from 'node:path';
import { valid } from 'semver';
import { validateSourceBridge, sourceDigest } from './committed-source-bridge.mjs';
import { GATEWAY_PAYLOAD_FILES } from './gateway-lock-plan.mjs';
import { requireObservedClosure } from './owned-child.mjs';
import { WEB_ARCHIVE_LIMITS } from './web-archive-producer.mjs';

const hash = /^[a-f0-9]{64}$/;
function keys(v, fields) {
    assert.ok(v && typeof v === 'object' && !Array.isArray(v));
    assert.deepEqual(Object.keys(v).sort(), [...fields].sort());
}
function absolute(v) {
    assert.ok(
        typeof v === 'string' &&
            v.startsWith('/') &&
            v !== '/' &&
            path.posix.normalize(v) === v &&
            !/[\\\x00-\x1f\x7f]/.test(v),
    );
}
function command(v, expected) {
    keys(v, ['owner', 'id', 'role', 'cwd', 'command', 'lifecycle']);
    for (const k of ['owner', 'role', 'cwd', 'command']) assert.deepEqual(v[k], expected[k]);
    assert.ok(Number.isSafeInteger(v.id) && v.id > 0);
    const row = v.lifecycle;
    keys(row, [
        'pid',
        'spawnObserved',
        'exitObserved',
        'closeObserved',
        'code',
        'signal',
        'closeCode',
        'closeSignal',
        'error',
        'timedOut',
        'terminationRequested',
        'killErrors',
        'elapsedMs',
    ]);
    for (const field of ['spawnObserved', 'exitObserved', 'closeObserved'])
        assert.equal(row[field], true);
    requireObservedClosure(row);
    assert.equal(row.code, 0);
    assert.equal(row.terminationRequested, false);
    assert.deepEqual(row.killErrors, []);
    assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0);
}

/** Strict stored-record schema. This does not authenticate a service or inspect supplied archive bytes. */
export function validateGatewayArchiveBuildRecord(v, expected) {
    keys(v, [
        'schemaVersion',
        'kind',
        'status',
        'context',
        'sourceBridge',
        'sourceBridgeSHA256',
        'builder',
        'build',
        'lockPreparation',
        'sourceLockSHA256',
        'projectedLockSHA256',
        'preparedLockSHA256',
        'stage',
        'payload',
        'tarInventory',
        'archive',
        'checksum',
        'productRuntime',
        'loaderProvenance',
        'normalGC',
        'forcedGC',
        'retirement',
        'releaseAcceptance',
    ]);
    keys(expected, [
        'scope',
        'version',
        'sourceCommit',
        'sourceTree',
        'runId',
        'runAttempt',
        'jobKey',
    ]);
    assert.equal(expected.scope, 'gateway');
    assert.ok(valid(expected.version));
    for (const field of ['sourceCommit', 'sourceTree'])
        assert.match(expected[field], /^[a-f0-9]{40}$/);
    for (const field of ['runId', 'runAttempt'])
        assert.match(expected[field], /^[1-9][0-9]{0,31}$/);
    assert.match(expected.jobKey, /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/);
    assert.deepEqual(v.context, expected);
    assert.equal(v.schemaVersion, 1);
    assert.equal(v.kind, 'gateway-source-build-archive');
    assert.equal(v.status, 'built');
    assert.equal(v.releaseAcceptance, false);
    for (const field of [
        'productRuntime',
        'loaderProvenance',
        'normalGC',
        'forcedGC',
        'retirement',
    ])
        assert.equal(v[field], null);
    validateSourceBridge(v.sourceBridge, {
        sourceCommit: expected.sourceCommit,
        sourceTree: expected.sourceTree,
    });
    assert.equal(v.sourceBridgeSHA256, sourceDigest(JSON.stringify(v.sourceBridge) + '\n'));
    for (const field of ['sourceLockSHA256', 'projectedLockSHA256', 'preparedLockSHA256'])
        assert.match(v[field], hash);
    assert.equal(
        v.sourceLockSHA256,
        v.sourceBridge.inventory.find((x) => x.path === 'package-lock.json')?.sha256,
    );
    keys(v.builder, [
        'runtime',
        'esbuildEntryPath',
        'esbuildEntrySHA256',
        'esbuildEntryFormat',
        'npmEntryPath',
        'npmEntrySHA256',
        'npmVersion',
        'npmPackageSHA256',
    ]);
    assert.ok(Buffer.byteLength(JSON.stringify(v.builder)) <= 16384);
    const builder = v.builder,
        runtime = builder.runtime;
    keys(runtime, [
        'executablePath',
        'executableSHA256',
        'node',
        'platform',
        'arch',
        'versions',
        'execArgv',
        'nodeOptions',
    ]);
    absolute(runtime.executablePath);
    assert.match(runtime.executableSHA256, hash);
    assert.match(runtime.node, /^v24\./);
    assert.ok(
        ['linux', 'darwin'].includes(runtime.platform) && ['x64', 'arm64'].includes(runtime.arch),
    );
    assert.equal(runtime.versions.node, runtime.node.slice(1));
    assert.ok(
        Array.isArray(runtime.execArgv) && runtime.execArgv.every((x) => typeof x === 'string'),
    );
    assert.equal(runtime.nodeOptions, null);
    absolute(builder.esbuildEntryPath);
    absolute(builder.npmEntryPath);
    assert.ok(
        builder.esbuildEntryPath.endsWith('/esbuild/bin/esbuild') &&
            builder.npmEntryPath.endsWith('/npm/bin/npm-cli.js'),
    );
    assert.equal(builder.esbuildEntryFormat, 'node-script');
    assert.ok(valid(builder.npmVersion));
    for (const field of ['esbuildEntrySHA256', 'npmEntrySHA256', 'npmPackageSHA256'])
        assert.match(builder[field], hash);
    keys(v.stage, ['owner', 'workspace', 'ownerCompletion']);
    assert.match(v.stage.owner, /^[a-f0-9]{32}$/);
    assert.equal(v.stage.workspace, 'retained-no-deletion');
    assert.equal(v.stage.ownerCompletion, 'not-asserted');
    const root = v.build.cwd;
    absolute(root);
    assert.ok(Array.isArray(v.build.command));
    const prefix = '--outfile=' + root + '/validation/',
        outfile = v.build.command[6];
    assert.ok(
        typeof outfile === 'string' &&
            outfile.startsWith(prefix) &&
            outfile.endsWith('/build/main.cjs'),
    );
    const leaf = outfile.slice(prefix.length, -'/build/main.cjs'.length);
    assert.match(leaf, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
    const stage = root + '/validation/' + leaf;
    command(v.build, {
        owner: v.stage.owner,
        role: 'build',
        cwd: root,
        command: [
            runtime.executablePath,
            builder.esbuildEntryPath,
            root + '/gateway/main.ts',
            '--bundle',
            '--platform=node',
            '--format=cjs',
            outfile,
            '--external:ssh2',
        ],
    });
    command(v.lockPreparation, {
        owner: v.stage.owner,
        role: 'lock',
        cwd: stage + '/stage',
        command: [
            runtime.executablePath,
            builder.npmEntryPath,
            'install',
            '--package-lock-only',
            '--offline',
            '--ignore-scripts',
            '--omit=optional',
            '--no-audit',
            '--no-fund',
            '--global=false',
            '--workspaces=false',
            '--prefix=' + stage + '/stage',
            '--cache=' + stage + '/cache',
            '--userconfig=' + stage + '/config/user.npmrc',
            '--globalconfig=' + stage + '/config/global.npmrc',
        ],
    });
    assert.ok(v.lockPreparation.id > v.build.id);
    assert.ok(Array.isArray(v.payload));
    assert.deepEqual(
        v.payload.map((x) => x.path),
        [...GATEWAY_PAYLOAD_FILES].sort(),
    );
    let total = 0,
        expanded = 11 * 512 + 1024;
    for (const file of v.payload) {
        keys(file, ['path', 'bytes', 'sha256']);
        assert.ok(
            Number.isSafeInteger(file.bytes) &&
                file.bytes >= 0 &&
                file.bytes <= WEB_ARCHIVE_LIMITS.member,
        );
        assert.match(file.sha256, hash);
        total += file.bytes;
        expanded += Math.ceil(file.bytes / 512) * 512;
    }
    assert.ok(
        total <= WEB_ARCHIVE_LIMITS.expanded &&
            v.payload.find((x) => x.path === 'dist-gateway/main.cjs').bytes > 0,
    );
    assert.equal(
        v.payload.find((x) => x.path === 'package-lock.json').sha256,
        v.preparedLockSHA256,
    );
    const entries = [
        ...v.payload.map((x) => ({ kind: 'file', ...x, mode: 0o644 })),
        ...['dist-gateway', 'docs', 'gateway'].map((path) => ({
            kind: 'directory',
            path,
            mode: 0o755,
        })),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    assert.deepEqual(v.tarInventory, {
        format: 'ustar',
        entries,
        files: 8,
        directories: 3,
        payloadBytes: total,
        expandedBytes: expanded,
    });
    keys(v.archive, ['name', 'bytes', 'sha256']);
    assert.equal(v.archive.name, `Diagnostic-Hub-Gateway-${expected.version}.tar.gz`);
    assert.ok(
        Number.isSafeInteger(v.archive.bytes) &&
            v.archive.bytes > 0 &&
            v.archive.bytes <= WEB_ARCHIVE_LIMITS.archive,
    );
    assert.match(v.archive.sha256, hash);
    const checksum = Buffer.from(`${v.archive.sha256}  ${v.archive.name}\n`);
    assert.deepEqual(v.checksum, {
        name: v.archive.name + '.sha256',
        bytes: checksum.length,
        sha256: sourceDigest(checksum),
    });
    return v;
}
export function parseGatewayArchiveBuildRecord(bytes, expected) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 16 * 1024 ** 2);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
        value = JSON.parse(text);
    assert.equal(text, JSON.stringify(value) + '\n', 'Noncanonical Gateway build record.');
    return validateGatewayArchiveBuildRecord(value, expected);
}
