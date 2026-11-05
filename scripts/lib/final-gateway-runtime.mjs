import assert from 'node:assert/strict';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseGatewayArchiveBuildRecord } from './gateway-build-record.mjs';
import { validatePreparedGatewayLock } from './gateway-lock-plan.mjs';
import { openGatewayArchiveBytes } from './inner-archive-inspection.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function parse(bytes) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024 ** 2);
    return JSON.parse(decoder.decode(bytes));
}
function absolute(value) {
    assert.ok(
        typeof value === 'string' &&
            value.startsWith('/') &&
            value !== '/' &&
            Buffer.byteLength(value) <= 4096 &&
            path.posix.normalize(value) === value &&
            !/[\\\x00-\x1f\x7f]/.test(value),
    );
}
function metadata(stat, kind, uid) {
    assert.ok(
        stat && !stat.isSymbolicLink() && (kind === 'file' ? stat.isFile() : stat.isDirectory()),
    );
    const value = Object.fromEntries(
        ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map((key) => [
            key,
            stat[key],
        ]),
    );
    for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'size'])
        assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0);
    assert.ok(
        (value.uid === uid || value.uid === 0) &&
            !(value.mode & 0o7022) &&
            Number.isFinite(value.mtimeMs) &&
            Number.isFinite(value.ctimeMs),
    );
    if (kind === 'file') assert.equal(value.nlink, 1);
    return value;
}
export class GatewayRuntimeObservationFailure extends Error {
    constructor(error, owner) {
        super('Final Gateway observation failed; custody retained where unacknowledged.', {
            cause: error,
        });
        this.owner = owner;
    }
}
/** Actual read-only installation census + already-owned direct child observation.
 * No filesystem/process defaults, install, code import/resolve hook, launch, signal or credentials.
 * File census is independent of child self-report; it is not npm-tar SRI or mapped-JS proof.
 */
export function createFinalGatewayObserver(
    archive,
    recordBytes,
    expected,
    sourceLockBytes,
    selection,
    filesystem,
) {
    assert.deepEqual(Object.keys(selection).sort(), ['node', 'root', 'uid']);
    absolute(selection.root);
    absolute(selection.node.path);
    assert.match(selection.node.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(selection.node).sort(), ['path', 'sha256']);
    assert.ok(Number.isSafeInteger(selection.uid) && selection.uid >= 0);
    for (const name of ['realpath', 'lstat', 'readdir', 'open'])
        assert.equal(typeof filesystem?.[name], 'function');
    assert.ok(
        Buffer.isBuffer(recordBytes) &&
            recordBytes.length > 0 &&
            recordBytes.length <= 16 * 1024 ** 2,
    );
    const sourceLock = parse(sourceLockBytes);
    recordBytes = Buffer.from(recordBytes);
    const record = parseGatewayArchiveBuildRecord(recordBytes, expected),
        recordSHA256 = hash(recordBytes),
        contents = openGatewayArchiveBytes(archive, record);
    let manifest, lock;
    try {
        assert.equal(hash(sourceLockBytes), record.sourceLockSHA256);
        manifest = parse(contents.read('package.json'));
        lock = parse(contents.read('package-lock.json'));
        assert.equal(hash(contents.read('package-lock.json')), record.preparedLockSHA256);
        validatePreparedGatewayLock(lock, manifest, sourceLock);
    } finally {
        contents.releaseBytes();
    }
    const selected = structuredClone(selection),
        required = Object.keys(lock.packages)
            .filter((p) => p && !lock.packages[p].optional)
            .sort();
    const payload = new Map(record.payload.map((row) => [row.path, { ...row }]));
    let phase = 'prepared',
        operation,
        baseline,
        child,
        primary,
        pending = 0,
        sequence = 0;
    const descriptors = new Set(),
        diagnostics = [],
        listeners = new Set();
    const fail = (error) => {
        primary ??= error;
        if (error !== primary && diagnostics.length < 32) diagnostics.push(error);
        phase = 'failed';
    };
    const snapshot = () =>
        Object.freeze({
            phase,
            pendingIO: pending,
            descriptors: descriptors.size,
            primaryFailure: Boolean(primary),
            cleanupDiagnostics: diagnostics.length,
            listenersHeld: listeners.size,
            processRetirementProven: false,
            executionAllowed: false,
        });
    async function io(fn) {
        pending++;
        try {
            return await fn();
        } finally {
            pending--;
        }
    }
    async function stableFile(file, maximum, collect = false) {
        assert.equal(await io(() => filesystem.realpath(file)), file, 'Aliased installed path.');
        const before = metadata(await io(() => filesystem.lstat(file)), 'file', selected.uid);
        assert.ok(before.size <= maximum);
        const lease = { path: file, handle: null };
        descriptors.add(lease);
        let handle, result, first;
        try {
            handle = await io(() =>
                filesystem.open(
                    file,
                    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                ),
            );
            lease.handle = handle;
            assert.deepEqual(metadata(await io(() => handle.stat()), 'file', selected.uid), before);
            const digest = createHash('sha256'),
                buffer = Buffer.alloc(65536),
                chunks = [];
            let total = 0;
            for (;;) {
                const length = Math.min(buffer.length, before.size + 1 - total);
                const { bytesRead } = await io(() => handle.read(buffer, 0, length, total));
                assert.ok(Number.isSafeInteger(bytesRead) && bytesRead >= 0 && bytesRead <= length);
                if (!bytesRead) break;
                total += bytesRead;
                assert.ok(total <= before.size);
                digest.update(buffer.subarray(0, bytesRead));
                if (collect) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
            }
            assert.equal(total, before.size);
            assert.deepEqual(metadata(await io(() => handle.stat()), 'file', selected.uid), before);
            assert.deepEqual(
                metadata(await io(() => filesystem.lstat(file)), 'file', selected.uid),
                before,
            );
            assert.equal(await io(() => filesystem.realpath(file)), file);
            result = {
                bytes: total,
                sha256: digest.digest('hex'),
                identity: before,
                ...(collect ? { content: Buffer.concat(chunks) } : {}),
            };
        } catch (error) {
            first = error;
            fail(error);
        }
        if (handle)
            try {
                await io(() => handle.close());
                descriptors.delete(lease);
                lease.handle = null;
            } catch (error) {
                first ??= error;
                fail(error);
            }
        // A rejected/unknown open keeps the registered lease. Rejection does not prove no acquisition.
        if (first) throw first;
        return result;
    }
    async function census() {
        const inventory = [],
            packageFiles = new Map();
        let total = 0,
            entries = 0;
        async function walk(relative = '') {
            assert.ok(++entries <= 4096, 'Installed census entry bound exceeded.');
            const directory = path.posix.join(selected.root, relative);
            assert.equal(await io(() => filesystem.realpath(directory)), directory);
            const before = metadata(
                await io(() => filesystem.lstat(directory)),
                'directory',
                selected.uid,
            );
            const rows = await io(() => filesystem.readdir(directory, { withFileTypes: true }));
            assert.ok(Array.isArray(rows) && rows.length <= 4096);
            const names = new Set();
            for (const row of rows.sort((a, b) => (a.name < b.name ? -1 : 1))) {
                assert.ok(
                    typeof row.name === 'string' &&
                        row.name &&
                        Buffer.byteLength(row.name) <= 1024 &&
                        !/[\\/\x00-\x1f\x7f]/.test(row.name) &&
                        !['.', '..'].includes(row.name) &&
                        !names.has(row.name),
                );
                names.add(row.name);
                assert.equal(row.isSymbolicLink(), false);
                const name = relative ? relative + '/' + row.name : row.name;
                assert.ok(Buffer.byteLength(name) <= 4096);
                assert.ok(
                    name === 'node_modules' ||
                        name.startsWith('node_modules/') ||
                        payload.has(name) ||
                        [...payload.keys()].some((p) => p.startsWith(name + '/')),
                    'Unexpected or credential-bearing installed path.',
                );
                if (row.isDirectory()) await walk(name);
                else {
                    assert.ok(
                        ++entries <= 4096 && row.isFile() && !name.endsWith('.node'),
                        'Unsupported installed file/native addon.',
                    );
                    const packageJSON =
                        name.startsWith('node_modules/') && name.endsWith('/package.json');
                    const current = await stableFile(
                        path.posix.join(selected.root, name),
                        packageJSON ? 1024 ** 2 : 64 * 1024 ** 2,
                        packageJSON,
                    );
                    total += current.bytes;
                    assert.ok(total <= 256 * 1024 ** 2, 'Installed census byte bound exceeded.');
                    if (payload.has(name)) {
                        const wanted = payload.get(name);
                        assert.equal(current.bytes, wanted.bytes);
                        assert.equal(
                            current.sha256,
                            wanted.sha256,
                            'Installed payload differs from admitted tar.',
                        );
                    }
                    inventory.push({
                        path: name,
                        bytes: current.bytes,
                        sha256: current.sha256,
                        identity: current.identity,
                    });
                    if (packageJSON) packageFiles.set(name, parse(current.content));
                }
            }
            assert.deepEqual(
                metadata(await io(() => filesystem.lstat(directory)), 'directory', selected.uid),
                before,
            );
            const after = await io(() => filesystem.readdir(directory, { withFileTypes: true }));
            assert.deepEqual(after.map((r) => r.name).sort(), [...names].sort());
        }
        await walk();
        for (const name of payload.keys())
            assert.ok(
                inventory.some((r) => r.path === name),
                'Missing installed payload.',
            );
        const roots = Object.keys(lock.packages).filter(Boolean);
        for (const name of required) {
            const observed = packageFiles.get(name + '/package.json');
            assert.ok(observed, 'Missing required installed package.');
            assert.equal(observed.name, name.split('node_modules/').at(-1));
            assert.equal(observed.version, lock.packages[name].version);
        }
        for (const row of inventory.filter((r) => r.path.startsWith('node_modules/'))) {
            if (row.path === 'node_modules/.package-lock.json') continue;
            const parent = roots
                .filter((p) => row.path.startsWith(p + '/'))
                .sort((a, b) => b.length - a.length)[0];
            assert.ok(
                parent && required.includes(parent),
                'Extraneous or optional installed package.',
            );
            assert.ok(
                !row.path.slice(parent.length + 1).includes('node_modules/'),
                'Unresolved nested installed dependency.',
            );
        }
        inventory.sort((a, b) => (a.path < b.path ? -1 : 1));
        const node = await stableFile(selected.node.path, 256 * 1024 ** 2);
        assert.equal(node.sha256, selected.node.sha256, 'Selected Node file bytes differ.');
        assert.ok(node.identity.mode & 0o111, 'Selected Node file is not executable.');
        assert.equal(descriptors.size, 0);
        assert.equal(pending, 0);
        return {
            root: selected.root,
            files: inventory,
            treeSHA256: hash(Buffer.from(JSON.stringify(inventory) + '\n')),
            lockedPackageMetadataAgreement: required,
            selectedNode: { path: selected.node.path, ...node },
            dependencyArchiveIntegrity: null,
            loadedJavaScriptMapping: null,
        };
    }
    const owner = Object.freeze({
        snapshot,
        diagnostics: () => Object.freeze([...diagnostics]),
        observeInstallation() {
            if (operation) return operation;
            assert.equal(phase, 'prepared');
            phase = 'observing-installation';
            operation = census().then(
                (value) => {
                    baseline = value;
                    phase = 'ready';
                    return structuredClone(value);
                },
                (error) => {
                    fail(error);
                    throw new GatewayRuntimeObservationFailure(error, owner);
                },
            );
            return operation;
        },
        observeChild(value) {
            assert.equal(phase, 'ready', 'Exact installed snapshot is not ready.');
            assert.ok(!child && value && typeof value === 'object');
            child = value;
            phase = 'observing-child';
            let resolve, reject, join;
            const completion = new Promise((yes, no) => {
                resolve = yes;
                reject = no;
            });
            completion.catch(() => {});
            const joined = new Promise((done) => (join = done));
            const row = {
                sequence: ++sequence,
                spawn: false,
                exit: null,
                close: null,
                stdoutClosed: false,
                stderrClosed: false,
                stdoutBytes: 0,
                stderrBytes: 0,
            };
            let finishing = false,
                spawnIdentity;
            function bad(error) {
                fail(error);
                reject(new GatewayRuntimeObservationFailure(error, owner));
            }
            function argumentsMatch() {
                return (
                    child.spawnfile === selected.node.path &&
                    Array.isArray(child.spawnargs) &&
                    child.spawnargs.length === 2 &&
                    child.spawnargs[0] === selected.node.path &&
                    child.spawnargs[1] ===
                        path.posix.join(selected.root, 'dist-gateway/main.cjs') &&
                    child.stdin === null
                );
            }
            const identity = () => ({
                pid: child.pid,
                executable: child.spawnfile,
                arguments: Array.isArray(child.spawnargs) ? [...child.spawnargs] : null,
            });
            async function finish() {
                if (finishing || !row.close || !row.stdoutClosed || !row.stderrClosed) return;
                finishing = true;
                try {
                    assert.ok(
                        row.spawn &&
                            Number.isSafeInteger(child.pid) &&
                            child.pid > 0 &&
                            argumentsMatch(),
                        'Unsupported/missing direct-child identity.',
                    );
                    assert.deepEqual(
                        identity(),
                        spawnIdentity,
                        'Parent-reported child identity changed.',
                    );
                    assert.deepEqual(row.exit, { code: 0, signal: null });
                    assert.deepEqual(row.close, row.exit);
                    assert.equal(primary, undefined);
                    const after = await census();
                    assert.deepEqual(
                        after,
                        baseline,
                        'Installed bytes changed during owned child lifetime.',
                    );
                    assert.equal(primary, undefined);
                    assert.deepEqual(
                        identity(),
                        spawnIdentity,
                        'Parent-reported child identity changed during census.',
                    );
                    detach();
                    assert.equal(primary, undefined);
                    const facts = {
                        schemaVersion: 1,
                        kind: 'final-gateway-runtime-observation',
                        scope: 'installed-bytes-and-direct-child',
                        selectedSource: { ...record.context },
                        archive: { ...record.archive },
                        buildRecordSHA256: recordSHA256,
                        installation: structuredClone(baseline),
                        parentReportedChild: structuredClone(spawnIdentity),
                        directChildEvents: { ...row },
                        kernelExecutableMapping: null,
                        loadedDependencyMapping: null,
                        descendantRetirement: null,
                        gatewayResourceOwnership: null,
                        configurationIdentity: null,
                        reviewedPolicy: null,
                        normalGC: null,
                        forcedGC: null,
                        releaseAcceptance: false,
                    };
                    const bytes = Buffer.from(JSON.stringify(facts) + '\n');
                    assert.ok(bytes.length <= 4 * 1024 ** 2);
                    phase = 'direct-observation-complete';
                    resolve(Object.freeze({ record: facts, bytes, sha256: hash(bytes) }));
                    join(snapshot());
                } catch (error) {
                    bad(error);
                    try {
                        detach();
                    } catch (cleanup) {
                        fail(cleanup);
                    }
                    if (!descriptors.size && !pending && !listeners.size) join(snapshot());
                }
            }
            function bind(emitter, event, callback, once = false) {
                const registration = { emitter, event, callback };
                listeners.add(registration);
                assert.equal(
                    emitter[once ? 'once' : 'on'](event, callback),
                    emitter,
                    'Unsupported asynchronous listener registration.',
                );
            }
            function detach() {
                for (const registration of [...listeners]) {
                    assert.equal(
                        registration.emitter.off(registration.event, registration.callback),
                        registration.emitter,
                        'Unacknowledged listener retirement.',
                    );
                    listeners.delete(registration);
                }
            }
            try {
                for (const name of ['stdout', 'stderr']) {
                    assert.ok(child[name] && typeof child[name].once === 'function');
                    bind(child[name], 'data', (bytes) => {
                        if (row[name + 'Closed']) {
                            bad(Error('Output after stream closure.'));
                            return;
                        }
                        if (!Buffer.isBuffer(bytes)) {
                            bad(Error('Unsupported child output event.'));
                            return;
                        }
                        row[name + 'Bytes'] += bytes.length;
                        if (!Number.isSafeInteger(row[name + 'Bytes']))
                            bad(Error('Child output counter overflow.'));
                    });
                    bind(child[name], 'error', () => bad(Error('Child stream failed.')));
                    bind(
                        child[name],
                        'close',
                        () => {
                            row[name + 'Closed'] = true;
                            void finish();
                        },
                        true,
                    );
                }
                bind(child, 'error', () => bad(Error('Owned Gateway child reported an error.')));
                bind(
                    child,
                    'spawn',
                    () => {
                        row.spawn = true;
                        spawnIdentity = identity();
                        if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || !argumentsMatch())
                            bad(Error('Child does not match selected Node/entry plan.'));
                    },
                    true,
                );
                bind(
                    child,
                    'exit',
                    (code, signal) => {
                        row.exit = { code, signal };
                        if (code !== 0 || signal !== null)
                            bad(Error('Gateway child did not exit normally with zero status.'));
                        void finish();
                    },
                    true,
                );
                bind(
                    child,
                    'close',
                    (code, signal) => {
                        row.close = { code, signal };
                        void finish();
                    },
                    true,
                );
            } catch (error) {
                bad(error);
            }
            return Object.freeze({
                completion,
                joined,
                snapshot: () =>
                    Object.freeze({ ...row, custody: snapshot(), processRetirementProven: false }),
            });
        },
    });
    return owner;
}
