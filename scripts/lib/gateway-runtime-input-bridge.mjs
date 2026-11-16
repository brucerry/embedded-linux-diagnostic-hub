import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startDiagnosticGatewayCommand } from './diagnostic-gateway-command.mjs';

const retained = new Set();
const names = ['asn1', 'bcrypt-pbkdf', 'safer-buffer', 'ssh2', 'tweetnacl'];
export const GATEWAY_RUNTIME_CHILD_FILES = Object.freeze([
    'scripts/ci/prepare-gateway-runtime-inputs.py',
    'scripts/ci/gateway-runtime-native.py',
    'scripts/ci/prepare-gateway-runtime-child.py',
    'scripts/ci/gateway-runtime-inputs.json',
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fields(value, expected) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}
function absolute(value) {
    assert.ok(
        typeof value === 'string' &&
            value.startsWith('/') &&
            value !== '/' &&
            value.length <= 4096 &&
            !/[\\\x00-\x20\x7f]/.test(value),
    );
    assert.equal(path.posix.normalize(value), value);
}
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
};

/** Bounded child and original-byte handoff. No default launch, filesystem or network ports.
 * The caller independently selects source hashes and trusted system Python; a child's manifest
 * is not authenticated provenance or installation success. Final census/SRI checks remain required.
 * Deadlines retain custody; this controller has no signal, deletion, retry or cleanup operation.
 */
export function startGatewayRuntimeInputBridge(rawSelection, rawRequest, supplied) {
    fields(rawSelection, ['sourceRoot', 'pythonPath', 'pythonSHA256', 'uid', 'sourceFiles']);
    fields(rawSelection.sourceFiles, GATEWAY_RUNTIME_CHILD_FILES);
    fields(rawRequest, ['sourceLockBytes', 'installRoot', 'archivesRoot']);
    for (const p of [
        rawSelection.sourceRoot,
        rawSelection.pythonPath,
        rawRequest.installRoot,
        rawRequest.archivesRoot,
    ])
        absolute(p);
    assert.ok(Number.isSafeInteger(rawSelection.uid) && rawSelection.uid > 0);
    for (const digest of [rawSelection.pythonSHA256, ...Object.values(rawSelection.sourceFiles)])
        assert.match(digest, /^[a-f0-9]{64}$/);
    assert.ok(
        Buffer.isBuffer(rawRequest.sourceLockBytes) &&
            rawRequest.sourceLockBytes.length > 0 &&
            rawRequest.sourceLockBytes.length <= 700 * 1024,
    );
    assert.ok(rawRequest.installRoot.endsWith('/validation/gateway-runtime/install'));
    assert.equal(
        rawRequest.archivesRoot,
        path.posix.dirname(rawRequest.installRoot) + '/inputs/runtime-archives',
    );
    assert.ok(!rawRequest.installRoot.startsWith(rawSelection.sourceRoot + '/'));
    for (const name of ['launch', 'setTimer', 'clearTimer', 'now', 'readFile', 'fileSnapshot'])
        assert.equal(typeof supplied[name], 'function');
    const selection = structuredClone(rawSelection),
        request = {
            installRoot: rawRequest.installRoot,
            archivesRoot: rawRequest.archivesRoot,
            sourceLockBytes: Buffer.from(rawRequest.sourceLockBytes),
        },
        ports = Object.freeze({ ...supplied });
    const result = deferred(),
        closed = deferred(),
        originals = [],
        unknown = new Set();
    let command,
        failed = false,
        phase = 'source-admission',
        pending = 0,
        finished = false;
    const owner = Object.freeze({
        result: result.promise,
        closed: closed.promise,
        get child() {
            return command;
        },
        snapshot: () =>
            Object.freeze({
                phase,
                failed,
                pendingCalls: pending,
                retainedOriginals: originals.length,
                unknownReturns: unknown.size,
                child: command?.snapshot() ?? null,
                directClosed: finished,
                wholeGroupRetirement: null,
                releaseAcceptance: false,
            }),
    });
    retained.add(owner);
    async function read(file, maximum) {
        pending++;
        try {
            const bytes = await ports.readFile(file, maximum);
            assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum);
            return Buffer.from(bytes);
        } finally {
            pending--;
        }
    }
    function filesIdle(allowFailed = false) {
        const snapshot = ports.fileSnapshot();
        if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.then === 'function') {
            unknown.add(snapshot);
            try {
                if (typeof snapshot?.then === 'function') Promise.resolve(snapshot).catch(() => {});
            } catch {}
            return false;
        }
        return (
            (allowFailed || snapshot.primaryFailure === false) &&
            ['pending', 'handles', 'uncertainPublications'].every(
                (key) => Number.isSafeInteger(snapshot[key]) && snapshot[key] === 0,
            )
        );
    }
    async function finish() {
        if (finished || pending) return;
        if (command) await command.closed;
        if (pending || unknown.size || !filesIdle(true)) return;
        finished = true;
        retained.delete(owner);
        closed.resolve(owner.snapshot());
    }
    void (async () => {
        try {
            const source = new Map();
            for (const name of GATEWAY_RUNTIME_CHILD_FILES) {
                const bytes = await read(
                    selection.sourceRoot + '/' + name,
                    name.endsWith('.json') ? 16384 : 128 * 1024,
                );
                assert.equal(
                    hash(bytes),
                    selection.sourceFiles[name],
                    'Child source differs from selected source.',
                );
                source.set(name, bytes);
            }
            const python = await read(selection.pythonPath, 128 * 1024 ** 2);
            assert.equal(hash(python), selection.pythonSHA256, 'System Python identity differs.');
            const profile = source.get('scripts/ci/gateway-runtime-inputs.json');
            const input = Buffer.from(
                JSON.stringify({
                    schemaVersion: 1,
                    sourceLockBase64: request.sourceLockBytes.toString('base64'),
                    profileBase64: profile.toString('base64'),
                    installRoot: request.installRoot,
                    archivesRoot: request.archivesRoot,
                    checkoutRoot: selection.sourceRoot,
                    uid: selection.uid,
                }) + '\n',
            );
            assert.ok(input.length <= 1024 ** 2);
            phase = 'runtime-input-child';
            command = startDiagnosticGatewayCommand(
                {
                    role: 'runtimeInputs',
                    owner: hash(input).slice(0, 32),
                    id: 1,
                    cwd: selection.sourceRoot,
                    command: [
                        selection.pythonPath,
                        '-I',
                        '-B',
                        '-S',
                        selection.sourceRoot + '/scripts/ci/prepare-gateway-runtime-child.py',
                    ],
                    input,
                },
                { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
                { ...ports, requireSpawnIdentity: true },
            );
            await command.result;
            await command.closed;
            phase = 'strict-handoff';
            const output = command.output();
            assert.equal(output.stderr.length, 0, 'Unexpected child diagnostics on success.');
            assert.ok(output.stdout.length > 0 && output.stdout.length <= 8192);
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                output.stdout,
            );
            const manifest = JSON.parse(text);
            assert.equal(
                text,
                JSON.stringify(manifest) + '\n',
                'Noncanonical, duplicate or trailing handoff bytes.',
            );
            fields(manifest, [
                'schemaVersion',
                'status',
                'sourceLockSHA256',
                'profileSHA256',
                'archives',
            ]);
            assert.equal(manifest.schemaVersion, 1);
            assert.equal(manifest.status, 'prepared-inputs-not-runtime');
            assert.equal(manifest.sourceLockSHA256, hash(request.sourceLockBytes));
            assert.equal(manifest.profileSHA256, hash(profile));
            assert.ok(
                Array.isArray(manifest.archives) && manifest.archives.length === names.length,
            );
            for (let i = 0; i < names.length; i++) {
                const row = manifest.archives[i];
                fields(row, ['path', 'file', 'bytes', 'sha256']);
                assert.equal(row.path, 'node_modules/' + names[i]);
                assert.equal(row.file, String(i + 1) + '.tgz');
                assert.ok(
                    Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 16 * 1024 ** 2,
                );
                assert.match(row.sha256, /^[a-f0-9]{64}$/);
            }
            phase = 'original-archive-readback';
            for (let i = 0; i < names.length; i++) {
                const row = manifest.archives[i];
                const bytes = await read(
                    request.archivesRoot + '/' + String(i + 1) + '.tgz',
                    16 * 1024 ** 2,
                );
                originals.push({ path: row.path, bytes }); // Keep returned original before later rejection.
                assert.equal(bytes.length, row.bytes);
                assert.equal(hash(bytes), row.sha256);
            }
            assert.ok(filesIdle() && unknown.size === 0);
            phase = 'originals-handed-off-not-qualified';
            await finish();
            assert.ok(finished);
            result.resolve(
                originals.map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes) })),
            );
        } catch (cause) {
            failed = true;
            result.reject(
                Object.assign(Error('Runtime input bridge failed; custody retained.', { cause }), {
                    owner,
                }),
            );
            // A late child closure may close controller resources; failure never becomes success.
            void finish().catch(() => {});
        }
    })();
    return owner;
}
