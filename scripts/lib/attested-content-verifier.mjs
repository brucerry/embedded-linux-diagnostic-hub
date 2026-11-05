import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';

const digest = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const ATTESTATION_VERIFIER_LIMITS = Object.freeze({
    subject: 2 * 1024 ** 3,
    record: 1024 ** 2,
    tool: 256 * 1024 ** 2,
    bundle: 16 * 1024 ** 2,
    trustedRoot: 4 * 1024 ** 2,
    output: 16 * 1024 ** 2,
    timeout: 30000,
});
function closed(value, fields) {
    assert.ok(
        value && typeof value === 'object' && !Array.isArray(value),
        'Invalid verifier input.',
    );
    assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), 'Invalid verifier fields.');
    return value;
}
function nativePath(value) {
    assert.ok(
        typeof value === 'string' &&
            value.length <= 4096 &&
            path.posix.isAbsolute(value) &&
            path.posix.normalize(value) === value &&
            !/[\\\x00-\x1f\x7f]/.test(value),
        'Invalid verifier path.',
    );
}
function version(value) {
    assert.ok(
        typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value),
        'Unsupported verifier version.',
    );
    const parts = value.split('.').map(Number);
    assert.ok(
        parts.every(Number.isSafeInteger) && parts[0] === 2 && parts[1] >= 102,
        'Unsupported verifier version.',
    );
}
function identity(value, kind, uid) {
    assert.ok(
        value &&
            (kind === 'file'
                ? value.isFile() && !value.isSymbolicLink()
                : value.isDirectory() && !value.isSymbolicLink()),
        'Unsafe verifier file type.',
    );
    for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'size'])
        assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0, 'Unsafe verifier identity.');
    assert.ok(
        value.mode <= 0o177777 &&
            value.nlink >= 1 &&
            Number.isFinite(value.mtimeMs) &&
            Number.isFinite(value.ctimeMs) &&
            (value.uid === uid || (kind === 'file' && value.uid === 0)) &&
            !(value.mode & 0o7022) &&
            (kind !== 'file' || value.nlink === 1),
        'Unsafe verifier ownership or mode.',
    );
    return Object.fromEntries(
        ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map((key) => [
            key,
            value[key],
        ]),
    );
}
function equalIdentity(before, after, kind, uid) {
    assert.deepEqual(identity(after, kind, uid), before, 'Verifier input changed.');
}
/** Stable hash observation only; no archive decoding, extraction or application loading. */
async function selectedFile(selected, cap, filesystem, uid, executable = false, collect = false) {
    nativePath(selected.path);
    assert.equal(
        await filesystem.realpath(selected.path),
        selected.path,
        'Noncanonical verifier path.',
    );
    const before = identity(await filesystem.lstat(selected.path), 'file', uid);
    assert.ok(
        before.size > 0 &&
            before.size <= cap &&
            (selected.bytes === undefined || before.size === selected.bytes),
        'Verifier input size mismatch.',
    );
    if (executable) assert.ok(before.mode & 0o100, 'Verifier is not executable.');
    const handle = await filesystem.open(
        selected.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const errors = [];
    let result;
    try {
        equalIdentity(before, await handle.stat(), 'file', uid);
        const checksum = createHash('sha256'),
            buffer = Buffer.alloc(65536);
        let bytes = 0,
            prefix = Buffer.alloc(4),
            prefixBytes = 0,
            last = -1;
        const chunks = [];
        for (;;) {
            const length = Math.min(buffer.length, before.size + 1 - bytes);
            const { bytesRead } = await handle.read(buffer, 0, length, bytes);
            assert.ok(
                Number.isSafeInteger(bytesRead) && bytesRead >= 0 && bytesRead <= length,
                'Invalid verifier read.',
            );
            if (!bytesRead) break;
            if (prefixBytes < prefix.length) {
                const copied = Math.min(prefix.length - prefixBytes, bytesRead);
                buffer.copy(prefix, prefixBytes, 0, copied);
                prefixBytes += copied;
            }
            bytes += bytesRead;
            assert.ok(bytes <= before.size, 'Verifier input grew.');
            checksum.update(buffer.subarray(0, bytesRead));
            if (collect) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
            last = buffer[bytesRead - 1];
        }
        assert.equal(bytes, before.size, 'Verifier input truncated.');
        assert.equal(checksum.digest('hex'), selected.sha256, 'Verifier input digest mismatch.');
        if (executable) {
            assert.equal(prefixBytes, prefix.length, 'Truncated verifier executable magic.');
            assert.deepEqual(
                prefix,
                Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
                'Verifier must be a native Linux executable.',
            );
        }
        equalIdentity(before, await handle.stat(), 'file', uid);
        equalIdentity(before, await filesystem.lstat(selected.path), 'file', uid);
        assert.equal(
            await filesystem.realpath(selected.path),
            selected.path,
            'Verifier path changed.',
        );
        result = {
            identity: before,
            bytes,
            last,
            ...(collect ? { content: Buffer.concat(chunks) } : {}),
        };
    } catch (error) {
        errors.push(error);
    }
    try {
        await handle.close();
    } catch (error) {
        errors.push(error);
    }
    if (errors.length)
        throw new Error('Verifier stable read or close failed.', {
            cause: new AggregateError(errors),
        });
    return result;
}
async function configuration(directory, filesystem, uid, expected) {
    nativePath(directory);
    assert.equal(
        await filesystem.realpath(directory),
        directory,
        'Noncanonical verifier configuration.',
    );
    const before = identity(await filesystem.lstat(directory), 'directory', uid);
    assert.equal(before.uid, uid, 'Foreign verifier configuration owner.');
    assert.equal(before.mode & 0o7777, 0o700, 'Verifier configuration must be private.');
    assert.deepEqual(
        await filesystem.readdir(directory),
        [],
        'Verifier configuration must be empty.',
    );
    equalIdentity(before, await filesystem.lstat(directory), 'directory', uid);
    if (expected) assert.deepEqual(before, expected, 'Verifier configuration changed.');
    return before;
}
function validate(request) {
    closed(request, [
        'subject',
        'bundle',
        'tool',
        'trustedRoot',
        'configurationDirectory',
        'constraints',
    ]);
    closed(request.subject, ['path', 'kind', 'name', 'bytes', 'sha256']);
    assert.ok(
        ['archive', 'record'].includes(request.subject.kind),
        'Unknown attestation subject kind.',
    );
    closed(request.bundle, ['path', 'bytes', 'sha256']);
    closed(request.tool, ['path', 'sha256', 'version']);
    closed(request.trustedRoot, ['path', 'bytes', 'sha256']);
    for (const [key, limit] of [
        ['subject', ATTESTATION_VERIFIER_LIMITS.subject],
        ['bundle', ATTESTATION_VERIFIER_LIMITS.bundle],
        ['trustedRoot', ATTESTATION_VERIFIER_LIMITS.trustedRoot],
    ]) {
        const v = request[key];
        assert.ok(
            Number.isSafeInteger(v.bytes) &&
                v.bytes > 0 &&
                v.bytes <= limit &&
                digest.test(v.sha256),
            'Invalid selected verifier input.',
        );
    }
    if (request.subject.kind === 'record')
        assert.ok(
            request.subject.bytes <= ATTESTATION_VERIFIER_LIMITS.record,
            'Record subject bound exceeded.',
        );
    assert.ok(typeof request.tool.sha256 === 'string' && digest.test(request.tool.sha256));
    version(request.tool.version);
    assert.ok(
        typeof request.subject.name === 'string' &&
            request.subject.name.length > 0 &&
            request.subject.name.length <= 255 &&
            !/[\\/\x00-\x1f\x7f]/.test(request.subject.name) &&
            !['.', '..'].includes(request.subject.name),
        'Invalid subject name.',
    );
    const c = closed(request.constraints, [
        'repository',
        'certificateIdentity',
        'issuer',
        'signerDigest',
        'sourceDigest',
        'sourceRef',
        'predicateType',
    ]);
    assert.equal(c.repository, 'brucerry/embedded-linux-diagnostic-hub');
    assert.equal(c.issuer, 'https://token.actions.githubusercontent.com');
    assert.equal(
        c.predicateType,
        'https://embedded-linux-diagnostic-hub.dev/attestation/content/v1',
    );
    assert.ok(
        typeof c.certificateIdentity === 'string' &&
            c.certificateIdentity.startsWith('https://github.com/') &&
            c.certificateIdentity.length <= 1024 &&
            !/[\s\x00-\x1f\x7f]/.test(c.certificateIdentity),
    );
    assert.ok(
        typeof c.signerDigest === 'string' &&
            commit.test(c.signerDigest) &&
            typeof c.sourceDigest === 'string' &&
            commit.test(c.sourceDigest),
    );
    assert.ok(
        typeof c.sourceRef === 'string' &&
            /^refs\/(heads|tags)\/[^\s\\\x00-\x1f\x7f]+$/.test(c.sourceRef) &&
            c.sourceRef.length <= 1024,
    );
    const paths = [
        request.subject.path,
        request.bundle.path,
        request.tool.path,
        request.trustedRoot.path,
        request.configurationDirectory,
    ];
    paths.forEach(nativePath);
    assert.equal(new Set(paths).size, paths.length, 'Verifier paths overlap.');
}
/**
 * Inert verifier-port model. Live binary/root admission and process retirement are unavailable.
 * Dependencies are a direct source-owned unit-test seam; production callers pass only the request
 * and are blocked before filesystem/process access. No JSON request can enable execution.
 * Path pre/post observations detect drift, but do not confine a malicious same-UID process.
 * @param {any} request
 * @param {{filesystem?: any, execute?: Function, uid?: number, platform?: string}} dependencies
 */
export async function verifyLocalAttestation(request, dependencies = {}) {
    if (
        !dependencies ||
        typeof dependencies !== 'object' ||
        !Object.hasOwn(dependencies, 'filesystem') ||
        !Object.hasOwn(dependencies, 'execute') ||
        !dependencies.filesystem ||
        typeof dependencies.filesystem !== 'object' ||
        !['realpath', 'lstat', 'open', 'readdir'].every(
            (method) => typeof dependencies.filesystem[method] === 'function',
        ) ||
        typeof dependencies.execute !== 'function'
    )
        throw new Error(
            'Live verifier blocked: independent binary/root admission and owned process retirement unavailable.',
        );
    request = structuredClone(request);
    validate(request);
    const {
        filesystem,
        execute,
        uid = process.getuid?.(),
        platform = process.platform,
    } = dependencies;
    assert.equal(platform, 'linux', 'Offline verifier currently supports Linux only.');
    assert.ok(Number.isSafeInteger(uid) && uid >= 0);
    /** @type {Array<[any, number, boolean]>} */
    const specifications = [
        [
            request.subject,
            request.subject.kind === 'record'
                ? ATTESTATION_VERIFIER_LIMITS.record
                : ATTESTATION_VERIFIER_LIMITS.subject,
            false,
        ],
        [request.bundle, ATTESTATION_VERIFIER_LIMITS.bundle, false],
        [request.tool, ATTESTATION_VERIFIER_LIMITS.tool, true],
        [request.trustedRoot, ATTESTATION_VERIFIER_LIMITS.trustedRoot, false],
    ];
    const observed = [];
    for (const [selected, cap, executable] of specifications)
        observed.push(
            await selectedFile(
                selected,
                cap,
                filesystem,
                uid,
                executable,
                selected === request.subject && request.subject.kind === 'record',
            ),
        );
    assert.equal(observed[3].last, 10, 'Trusted-root JSONL must end with a newline.');
    const configIdentity = await configuration(request.configurationDirectory, filesystem, uid);
    const environment = Object.freeze({
        HOME: request.configurationDirectory,
        GH_CONFIG_DIR: request.configurationDirectory,
        XDG_CONFIG_HOME: request.configurationDirectory,
        XDG_CACHE_HOME: request.configurationDirectory,
        GH_HOST: 'github.com',
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
        TERM: 'dumb',
        LC_ALL: 'C',
    });
    async function run(args, maximum) {
        let result;
        try {
            result = await execute(request.tool.path, args, {
                cwd: request.configurationDirectory,
                env: environment,
                shell: false,
                timeout: ATTESTATION_VERIFIER_LIMITS.timeout,
                maxBuffer: maximum,
                stdio: ['ignore', 'pipe', 'pipe'],
                encoding: 'buffer',
                windowsHide: true,
            });
        } catch {
            throw new Error('Pinned offline verifier execution failed.');
        }
        assert.ok(
            Buffer.isBuffer(result) && result.length > 0 && result.length <= maximum,
            'Invalid verifier output.',
        );
        return result;
    }
    async function recheck() {
        for (let i = 0; i < specifications.length; i++) {
            const [selected, cap, executable] = specifications[i];
            const current = await selectedFile(
                selected,
                cap,
                filesystem,
                uid,
                executable,
                selected === request.subject && request.subject.kind === 'record',
            );
            assert.deepEqual(current, observed[i], 'Selected verifier input changed.');
        }
        await configuration(request.configurationDirectory, filesystem, uid, configIdentity);
    }
    const versionText = decoder.decode(await run(['--version'], 4096));
    const match =
        /^gh version (\d+\.\d+\.\d+)(?: \([^\r\n]*\))?\r?\n(?:https:\/\/github\.com\/cli\/cli\/releases\/tag\/v\d+\.\d+\.\d+\r?\n)?$/.exec(
            versionText,
        );
    assert.ok(match && match[1] === request.tool.version, 'Pinned verifier version mismatch.');
    await recheck();
    const c = request.constraints;
    const stdout = await run(
        [
            'attestation',
            'verify',
            request.subject.path,
            '--bundle',
            request.bundle.path,
            '--custom-trusted-root',
            request.trustedRoot.path,
            '--repo',
            c.repository,
            '--hostname',
            'github.com',
            '--cert-identity',
            c.certificateIdentity,
            '--cert-oidc-issuer',
            c.issuer,
            '--signer-digest',
            c.signerDigest,
            '--source-digest',
            c.sourceDigest,
            '--source-ref',
            c.sourceRef,
            '--deny-self-hosted-runners',
            '--digest-alg',
            'sha256',
            '--format',
            'json',
            '--predicate-type',
            c.predicateType,
        ],
        ATTESTATION_VERIFIER_LIMITS.output,
    );
    await recheck();
    const text = decoder.decode(stdout);
    assert.ok(!text.startsWith('\uFEFF'), 'Unexpected verifier BOM.');
    let verificationResults;
    try {
        verificationResults = JSON.parse(text);
    } catch {
        throw new Error('Malformed verifier JSON output.');
    }
    assert.ok(
        Array.isArray(verificationResults) &&
            verificationResults.length > 0 &&
            verificationResults.length <= 64,
        'No bounded verified attestations.',
    );
    // JSON.parse alone permits duplicate keys. Canonicalization is intentionally not demanded of gh output;
    // a string-aware scanner refuses ambiguous duplicate object members at every nesting level.
    rejectDuplicateKeys(text);
    return {
        subject: {
            kind: request.subject.kind,
            name: request.subject.name,
            bytes: request.subject.bytes,
            sha256: request.subject.sha256,
        },
        ...(request.subject.kind === 'record'
            ? { recordBytes: Buffer.from(observed[0].content) }
            : {}),
        verificationResults,
        verifier: {
            toolSHA256: request.tool.sha256,
            toolVersion: request.tool.version,
            trustedRootSHA256: request.trustedRoot.sha256,
            bundleSHA256: request.bundle.sha256,
        },
    };
}
function rejectDuplicateKeys(text) {
    const containers = [];
    let index = 0;
    while (index < text.length) {
        const char = text[index++];
        if (char === '{') containers.push(new Set());
        else if (char === '[') containers.push(null);
        else if (char === '}' || char === ']') containers.pop();
        else if (char === '"') {
            const start = index - 1;
            while (index < text.length) {
                const next = text[index++];
                if (next === '\\') index++;
                else if (next === '"') break;
            }
            let after = index;
            while (/\s/.test(text[after] ?? '') && after < text.length) after++;
            if (text[after] === ':') {
                const keys = containers.at(-1),
                    key = JSON.parse(text.slice(start, index));
                assert.ok(keys && !keys.has(key), 'Duplicate verifier JSON key.');
                keys.add(key);
            }
        }
        assert.ok(containers.length <= 64, 'Verifier JSON nesting limit exceeded.');
    }
}
