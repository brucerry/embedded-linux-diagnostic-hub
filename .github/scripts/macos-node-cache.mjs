import path from 'node:path';

// Layout conventions, not executable provenance or live image observations:
// actions/toolkit@0c3a9c332b678ff1e776f93d728a4ad279803abe tool-cache.find
// actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 base-distribution
// actions/runner-images@4a3efbb98bd2d06646222d4cbab17be441c0863b macOS assets/bashrc
// Exact cached-version inventory pins are from that image documentation snapshot.
export const MAC_NODE_CACHE_VERSIONS = Object.freeze({ x64: '24.19.0', arm64: '24.22.2' });
const fields = ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const reasons = new Set(['context', 'path', 'unsafe', 'incomplete', 'architecture', 'changed']);
class Refusal extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
function requireThat(value, reason) {
    if (!value) throw new Refusal(reason);
}
function canonical(value) {
    requireThat(
        typeof value === 'string' &&
            value.length <= 4096 &&
            Buffer.byteLength(value, 'utf8') <= 4096 &&
            value !== '/' &&
            !value.endsWith('/') &&
            path.posix.isAbsolute(value) &&
            path.posix.normalize(value) === value &&
            !/[\\\x00-\x1f\x7f]/.test(value),
        'path',
    );
    return value;
}

// Private path data only. A real caller must bind home and cache variables to its
// actual OS account; this layout constructor does not authenticate caller labels.
export function macNodeCacheLayout(config) {
    const arch = config.arch;
    requireThat(['x64', 'arm64'].includes(arch), 'context');
    const home = canonical(config.home),
        root = canonical(config.cacheRoot);
    requireThat(
        root === path.posix.join(home, 'hostedtoolcache') && config.agentRoot === root,
        'path',
    );
    const version = MAC_NODE_CACHE_VERSIONS[arch],
        installation = path.posix.join(root, 'node', version, arch),
        executable = canonical(path.posix.join(installation, 'bin', 'node')),
        marker = canonical(installation + '.complete'),
        parts = path.posix.dirname(executable).slice(1).split('/');
    requireThat(parts.length <= 64, 'path');
    const directories = Array.from({ length: parts.length + 1 }, (_, i) =>
        i ? '/' + parts.slice(0, i).join('/') : '/',
    );
    return { arch, home, root, version, executable, marker, directories };
}

/** Pure read-only candidate resolver: no default adapter, process, action or environment IO.
 * Ports must supply nonfollowing metadata, canonical readback, X_OK and exactly 32 inert
 * header bytes. A future caller must bind real observations; authored ports are not CI proof.
 * The returned candidate path is private caller data, never a public report or authority to
 * execute. This does not identify the actual Node version, authenticate publisher bytes,
 * remove races before a later invocation, or admit the runner/product/release. */
export function resolveMacNodeCache(config, ports) {
    try {
        const arch = config.arch,
            rawIdentity = ports.identity(),
            identity = {
                platform: rawIdentity.platform,
                arch: rawIdentity.arch,
                uid: rawIdentity.uid,
                euid: rawIdentity.euid,
            };
        requireThat(
            identity.platform === 'darwin' &&
                ['x64', 'arm64'].includes(arch) &&
                identity.arch === arch &&
                Number.isSafeInteger(identity.uid) &&
                identity.uid > 0 &&
                identity.euid === identity.uid,
            'context',
        );
        const { home, version, executable, marker, directories } = macNodeCacheLayout({
            arch,
            home: config.home,
            cacheRoot: config.cacheRoot,
            agentRoot: config.agentRoot,
        });
        const seen = new Map(),
            owner = BigInt(identity.uid);
        function snapshot(file, kind) {
            const raw = ports.lstat(file);
            requireThat(raw !== null && typeof raw === 'object', 'incomplete');
            const value = { kind: raw.kind };
            for (const field of fields) {
                value[field] = raw[field];
                requireThat(typeof value[field] === 'bigint', 'unsafe');
            }
            requireThat(
                value.kind === kind &&
                    value.dev >= 0n &&
                    value.ino > 0n &&
                    value.mode >= 0n &&
                    (value.uid === 0n || value.uid === owner) &&
                    (value.mode & 0o7022n) === 0n &&
                    value.nlink > 0n &&
                    value.size >= 0n &&
                    (kind !== 'file' || value.nlink === 1n),
                'unsafe',
            );
            requireThat(ports.realpath(file) === file, 'path');
            return value;
        }
        for (const file of directories) {
            const value = snapshot(file, 'directory');
            if (file === home) requireThat(value.uid === owner, 'unsafe');
            seen.set(file, value);
        }
        const completed = snapshot(marker, 'file');
        requireThat(completed.size === 0n, 'incomplete');
        seen.set(marker, completed);
        const before = snapshot(executable, 'file');
        requireThat(before.size >= 32n && ports.executable(executable) === true, 'unsafe');
        seen.set(executable, before);

        // Only thin little-endian Mach-O64 executable headers are supported here.
        // Header CPU identity is not complete Mach-O validation or binary authenticity.
        const header = ports.readHeader(executable, 32);
        requireThat(header instanceof Uint8Array && header.byteLength === 32, 'architecture');
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        requireThat(
            view.getUint32(0, true) === 0xfeedfacf &&
                view.getUint32(4, true) === (arch === 'x64' ? 0x01000007 : 0x0100000c) &&
                view.getUint32(12, true) === 2,
            'architecture',
        );
        for (const [file, first] of seen) {
            const again = snapshot(file, first.kind);
            requireThat(
                fields.every((field) => first[field] === again[field]),
                'changed',
            );
        }
        return {
            status: 'CACHE_METADATA_CANDIDATE',
            candidate: executable,
            expectedVersion: version,
            expectedArchitecture: arch,
            actualRuntimeVersion: 'unverified',
            nativeQualification: false,
            releaseAcceptance: false,
        };
    } catch (error) {
        return {
            status: 'REFUSED',
            reason:
                error instanceof Refusal && reasons.has(error.reason)
                    ? error.reason
                    : 'read-failed',
            nativeQualification: false,
            releaseAcceptance: false,
        };
    }
}
