import assert from 'node:assert/strict';
import path from 'node:path';
import { verifyGatewayArchiveReadback } from './gateway-archive-readback.mjs';
import { prepareDiagnosticGatewayInstall } from './diagnostic-gateway-install.mjs';
import { createFinalGatewayObserver } from './final-gateway-runtime.mjs';
import { startGatewayHealthOnlySmoke } from './diagnostic-gateway-runtime.mjs';
import { SOURCE_LIMITS } from './committed-source-bridge.mjs';
import { WEB_ARCHIVE_LIMITS } from './web-archive-limits.mjs';

const held = new Set();
const required = Object.freeze(['asn1', 'bcrypt-pbkdf', 'safer-buffer', 'ssh2', 'tweetnacl']);
function fields(value, names) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}
function absolute(value) {
    assert.ok(typeof value === 'string' && value.startsWith('/') && value !== '/');
    assert.equal(path.posix.normalize(value), value);
    assert.ok(value.length <= 4096 && !/[\\\x00-\x20\x7f]/.test(value));
}
function boundedBindings(expected, builder) {
    fields(expected, ['context', 'buildRecord', 'artifacts']);
    fields(expected.context, [
        'scope',
        'version',
        'sourceCommit',
        'sourceTree',
        'runId',
        'runAttempt',
        'jobKey',
    ]);
    for (const value of Object.values(expected.context))
        assert.ok(typeof value === 'string' && value.length <= 128);
    assert.ok(Array.isArray(expected.artifacts) && expected.artifacts.length === 2);
    for (const value of [expected.buildRecord, ...expected.artifacts]) {
        fields(value, ['name', 'bytes', 'sha256']);
        assert.ok(typeof value.name === 'string' && value.name.length <= 256);
        assert.ok(typeof value.sha256 === 'string' && value.sha256.length === 64);
        assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0);
    }
    fields(builder, [
        'runtime',
        'esbuildEntryPath',
        'esbuildEntrySHA256',
        'esbuildEntryFormat',
        'npmEntryPath',
        'npmEntrySHA256',
        'npmVersion',
        'npmPackageSHA256',
    ]);
    fields(builder.runtime, [
        'executablePath',
        'executableSHA256',
        'node',
        'platform',
        'arch',
        'versions',
        'execArgv',
        'nodeOptions',
    ]);
    for (const [key, value] of [...Object.entries(builder), ...Object.entries(builder.runtime)]) {
        if (['runtime', 'versions', 'execArgv', 'nodeOptions'].includes(key)) continue;
        assert.ok(typeof value === 'string' && value.length <= 4096);
    }
    assert.deepEqual(builder.runtime.execArgv, []);
    assert.equal(builder.runtime.nodeOptions, null);
    const versions = builder.runtime.versions;
    assert.ok(versions && typeof versions === 'object' && !Array.isArray(versions));
    assert.ok(Object.keys(versions).length <= 100);
    for (const [key, value] of Object.entries(versions))
        assert.ok(key.length <= 100 && typeof value === 'string' && value.length <= 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(builder)) <= 16384);
}

/** Local draft with NO default IO or command-line entrypoint. A later native adapter must
 * independently obtain the current producer selections, real toolchain and owned IO ports.
 * Inputs/fixture labels do not authenticate GitHub or grant release/installer admission.
 * installRuntimeInputs must use only the five fixed original archives, never npm/hooks/optional
 * packages; its reported success is ignored in favor of the existing byte census/origin observer.
 * Failed/uncertain custody is retained. There is no deletion, adoption, retry or forced cleanup.
 */
export async function runSameJobGatewayHealthSmoke(raw, supplied) {
    fields(raw, ['readback', 'expected', 'builder', 'sourceRoot', 'temporaryRoot', 'uid']);
    for (const key of ['sourceRoot', 'temporaryRoot']) absolute(raw[key]);
    assert.ok(Number.isSafeInteger(raw.uid) && raw.uid > 0);
    const limits = {
        recordBytes: 16 * 1024 ** 2,
        archiveBytes: WEB_ARCHIVE_LIMITS.archive,
        checksumBytes: 1024,
        sourcePackageBytes: SOURCE_LIMITS.blob,
        sourceLockBytes: SOURCE_LIMITS.blob,
        compiledBytes: WEB_ARCHIVE_LIMITS.member,
    };
    fields(raw.readback, Object.keys(limits));
    for (const [key, maximum] of Object.entries(limits))
        assert.ok(
            Buffer.isBuffer(raw.readback[key]) &&
                raw.readback[key].length > 0 &&
                raw.readback[key].length <= maximum,
        );
    boundedBindings(raw.expected, raw.builder);
    const input = {
        sourceRoot: raw.sourceRoot,
        temporaryRoot: raw.temporaryRoot,
        uid: raw.uid,
        expected: structuredClone(raw.expected),
        builder: structuredClone(raw.builder),
        readback: Object.fromEntries(
            Object.entries(raw.readback).map(([key, value]) => {
                assert.ok(Buffer.isBuffer(value));
                return [key, Buffer.from(value)];
            }),
        ),
    };
    for (const key of [
        'writeExclusive',
        'installRuntimeInputs',
        'resolveModule',
        'randomBytes',
        'launch',
        'request',
        'setTimer',
        'clearTimer',
        'now',
        'assertSettled',
    ])
        assert.equal(typeof supplied[key], 'function');
    for (const key of ['realpath', 'lstat', 'mkdir', 'readdir', 'open'])
        assert.equal(typeof supplied.filesystem?.[key], 'function');
    assert.equal(typeof supplied.custody?.snapshot, 'function');
    const ports = Object.freeze({ ...supplied });
    const filesystem = Object.freeze({ ...supplied.filesystem });
    let phase = 'readback',
        pending = 0,
        runtime,
        observer,
        failed = false,
        retired = false;
    const operations = [],
        unknown = new Set();
    function resourceSnapshot() {
        try {
            const value = ports.custody.snapshot();
            if (value && typeof value.then === 'function') {
                unknown.add(value);
                Promise.resolve(value).catch(() => {});
                return { status: 'unknown' };
            }
            return value && typeof value === 'object' ? value : { status: 'unknown' };
        } catch {
            return { status: 'unknown' };
        }
    }
    const owner = Object.freeze({
        snapshot: () => {
            const suppliedCustody = resourceSnapshot();
            return Object.freeze({
                phase,
                pendingCalls: pending,
                failed,
                retired,
                operations: operations.map(({ phase, state }) => ({ phase, state })),
                unknownReturns: unknown.size,
                suppliedCustody,
                runtime: runtime?.snapshot() ?? null,
                files: observer?.snapshot() ?? null,
                wholeGroupRetirement: null,
                releaseAcceptance: false,
            });
        },
        get runtime() {
            return runtime;
        },
        get custody() {
            return ports.custody;
        },
    });
    held.add(owner);
    async function io(next, operation) {
        phase = next;
        assert.ok(operations.length < 64);
        const lease = { phase: next, state: 'issued' };
        operations.push(lease);
        pending++; // Before dispatch; the supplied owner must retain uncertain native effects.
        try {
            const value = await operation();
            lease.state = 'returned';
            return value;
        } catch (error) {
            lease.state = 'rejected-effects-not-inferred';
            throw error;
        } finally {
            pending--;
        }
    }
    function synchronous(value) {
        if (value === undefined) return;
        unknown.add(value);
        try {
            if (typeof value?.then === 'function') Promise.resolve(value).catch(() => {});
        } catch {}
        throw Error('Unsupported asynchronous settlement acknowledgement.');
    }
    async function directory(file) {
        assert.equal(await io('directory-identity', () => filesystem.realpath(file)), file);
        const stat = await io('directory-identity', () => filesystem.lstat(file));
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === input.uid);
        assert.ok(!(stat.mode & 0o7022));
        for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size'])
            assert.ok(Number.isSafeInteger(stat[key]) && stat[key] >= 0);
    }
    try {
        const record = verifyGatewayArchiveReadback(input.readback, input.expected);
        assert.equal(input.expected.context.runAttempt, '1');
        assert.equal(input.expected.context.version, '0.6.0');
        assert.deepEqual(record.builder, input.builder);
        assert.equal(record.build.cwd, input.sourceRoot);
        const node = input.builder.runtime;
        assert.equal(node.node, 'v24.22.2'); // New publisher path; old runtime pin stays unchanged.
        assert.equal(node.platform, 'linux');
        assert.equal(node.arch, 'x64');
        assert.deepEqual(node.execArgv, []);
        assert.equal(node.nodeOptions, null);
        absolute(node.executablePath);
        assert.ok(
            input.temporaryRoot !== input.sourceRoot &&
                !input.temporaryRoot.startsWith(input.sourceRoot + '/') &&
                !input.sourceRoot.startsWith(input.temporaryRoot + '/'),
        );
        assert.notEqual(resourceSnapshot().status, 'unknown', 'Unsupported custody snapshot.');
        assert.equal(unknown.size, 0);
        await directory(input.temporaryRoot);
        const namespace =
            input.temporaryRoot +
            '/diagnostic-hub-gateway-' +
            input.expected.context.runId +
            '-attempt-1';
        await io('reserve-namespace', () => filesystem.mkdir(namespace));
        await directory(namespace);
        await io('reserve-validation', () => filesystem.mkdir(namespace + '/validation'));
        const target = namespace + '/validation/gateway-runtime';
        const prepared = await io('copy-canonical-payload', () =>
            prepareDiagnosticGatewayInstall(
                input.readback.archiveBytes,
                input.readback.recordBytes,
                input.expected.context,
                target,
                filesystem,
                ports.writeExclusive,
            ),
        );
        await directory(prepared.installRoot);
        await io('reserve-inputs', () => filesystem.mkdir(target + '/inputs'));
        const originals = await io('prepare-five-runtime-inputs', () =>
            ports.installRuntimeInputs({
                sourceLockBytes: Buffer.from(input.readback.sourceLockBytes),
                installRoot: prepared.installRoot,
                archivesRoot: target + '/inputs/runtime-archives',
            }),
        );
        assert.ok(Array.isArray(originals) && originals.length === required.length);
        assert.deepEqual(
            originals.map((row) => row.path).sort(),
            required.map((name) => 'node_modules/' + name),
        );
        const archives = originals.map((row) => {
            fields(row, ['path', 'bytes']);
            assert.ok(Buffer.isBuffer(row.bytes) && row.bytes.length <= 16 * 1024 ** 2);
            return { path: row.path, bytes: Buffer.from(row.bytes) };
        });
        observer = createFinalGatewayObserver(
            input.readback.archiveBytes,
            input.readback.recordBytes,
            input.expected.context,
            input.readback.sourceLockBytes,
            {
                root: prepared.installRoot,
                node: { path: node.executablePath, sha256: node.executableSHA256 },
                uid: input.uid,
            },
            filesystem,
        );
        const installation = await io('installed-byte-census', () =>
            observer.observeInstallation(),
        );
        phase = 'original-dependency-byte-comparison';
        const dependencyOrigin = observer.observeDependencyOrigin(archives);
        // Resolve as data only. No SSH2 load, host key, Server, Client or module-init claim here.
        assert.equal(
            await io('module-resolution', () =>
                ports.resolveModule(prepared.installRoot + '/package.json', 'ssh2'),
            ),
            prepared.installRoot + '/node_modules/ssh2/lib/index.js',
        );
        for (const [parent, specifier] of [
            ['lib/protocol/constants.js', 'cpu-features'],
            ['lib/protocol/crypto.js', './crypto/build/Release/sshcrypto.node'],
        ]) {
            let absent = false;
            try {
                await io('native-resolution-absence', () =>
                    ports.resolveModule(
                        prepared.installRoot + '/node_modules/ssh2/' + parent,
                        specifier,
                    ),
                );
            } catch (error) {
                if (error?.code !== 'MODULE_NOT_FOUND') throw error;
                absent = true;
            }
            assert.ok(absent, 'Optional or native module unexpectedly resolves.');
        }
        phase = 'random-token';
        const tokenLease = { phase, state: 'issued' };
        operations.push(tokenLease);
        let token;
        try {
            token = ports.randomBytes(32);
        } catch (error) {
            tokenLease.state = 'rejected-effects-not-inferred';
            throw error;
        }
        if (!Buffer.isBuffer(token) || token.length !== 32) {
            tokenLease.state = 'unsupported-return';
            if (token !== undefined) {
                unknown.add(token);
                try {
                    if (typeof token?.then === 'function') Promise.resolve(token).catch(() => {});
                } catch {}
            }
            throw Error('Unsupported random-byte acquisition.');
        }
        tokenLease.state = 'returned';
        phase = 'health-only-runtime';
        runtime = startGatewayHealthOnlySmoke(
            {
                root: prepared.installRoot,
                nodePath: node.executablePath,
                version: input.expected.context.version,
                token: token.toString('hex'),
            },
            { ...ports, observer },
        );
        const result = await runtime.result;
        await runtime.closed;
        const finalFiles = observer.snapshot();
        assert.equal(finalFiles.phase, 'direct-observation-complete');
        assert.equal(finalFiles.primaryFailure, false);
        assert.equal(finalFiles.pendingIO + finalFiles.descriptors + finalFiles.listenersHeld, 0);
        assert.equal(pending, 0);
        synchronous(ports.assertSettled());
        assert.notEqual(resourceSnapshot().status, 'unknown', 'Unsupported custody snapshot.');
        assert.equal(unknown.size, 0);
        phase = 'health-and-direct-close-observed';
        retired = true;
        held.delete(owner);
        return Object.freeze({
            installation,
            dependencyOrigin,
            runtime: result,
            originalBuildRecord: { ...input.expected.buildRecord },
            jobAuthentication: null,
            uploadAttribution: null,
            configuredTargetAuthenticated: false,
            releaseAcceptance: false,
        });
    } catch (cause) {
        failed = true;
        // Keep the raw cause (including undefined) and live child/file owners private and reachable.
        throw Object.assign(Error('Same-job health smoke failed; custody retained.', { cause }), {
            owner,
        });
    }
}
