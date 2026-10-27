import path from 'node:path';
import { createHash } from 'node:crypto';
import { physicalFS } from './physical-fs';
import {
    INSTALLATION_MANIFEST,
    INSTALLATION_PRODUCT,
    INSTALLATION_RECORD,
    MAX_INSTALLATION_MANIFEST_BYTES,
    installationActions,
    validateInstallationManifest,
    validateInstallationRecord,
    type InstallationManifest,
} from '../shared/installation';
import { maintenancePaths, SETUP_OWNER, SETUP_PAYLOAD } from './installation-maintenance';
import { assertLinuxReviewManifestEntry, validateLinuxReviewCapability, linuxReviewHelperDecision,
    LINUX_REVIEW_CAPABILITY, LINUX_REVIEW_ENTRY } from '../scripts/lib/linux-review-package.mjs';
import { checkedLinuxMenuRecord } from './linux-menu-ownership.ts';

/** Reconstruction, not recovery of the missing historical Linux aggregate. Read-only by design. */
export interface LinuxReviewHost {
    platform: string;
    arch: string;
    uid: number;
    euid: number;
    home: string;
    appData: string;
    sourceRoot: string;
    version: string;
    requirePackagedReviewCapability?: true;
}
export interface LinuxReviewNode {
    kind: 'file' | 'directory' | 'other';
    uid: number;
    mode: number;
    dev: number;
    ino: number;
    nlink: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
}
/** No write, launch, process-query, removal or integration capability is accepted here. */
export interface LinuxReviewIO {
    node(file: string): Promise<LinuxReviewNode | null>;
    canonical(directory: string): Promise<string>;
    names(directory: string, limit: number): Promise<string[]>;
    bytes(file: string, limit: number, uid: number): Promise<Buffer>;
    digest(file: string, bytes: number, uid: number): Promise<string>;
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const inside = (parent: string, child: string) => {
    const relative = path.posix.relative(parent, child);
    return (
        relative === '' ||
        (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative))
    );
};
const canonicalSyntax = (file: string) =>
    typeof file === 'string' &&
    file.length > 1 &&
    file.length <= 240 &&
    file.startsWith('/') &&
    path.posix.normalize(file) === file &&
    !/[\\\x00-\x1f\x7f]/.test(file);
const sameNode = (a: LinuxReviewNode, b: LinuxReviewNode | null) =>
    b !== null && (Object.keys(a) as (keyof LinuxReviewNode)[]).every((key) => a[key] === b[key]);
function directory(node: LinuxReviewNode, uid: number, owned: boolean) {
    if (
        node.kind !== 'directory' ||
        !Number.isSafeInteger(node.ino) ||
        !Number.isSafeInteger(node.dev) ||
        (owned ? node.uid !== uid : node.uid !== 0 && node.uid !== uid) ||
        (node.mode & 0o7022) !== 0
    )
        throw Error('Linux setup requires plain, owned directories without shared write access.');
}
function regular(node: LinuxReviewNode, limit: number, uid: number, privateFile: boolean) {
    if (
        node.kind !== 'file' ||
        node.uid !== uid ||
        node.nlink !== 1 ||
        !Number.isSafeInteger(node.size) ||
        node.size < 0 ||
        node.size > limit ||
        (node.mode & 0o7022) !== 0 ||
        (privateFile && (node.mode & 0o077) !== 0)
    )
        throw Error('Linux setup requires bounded, owned regular files without aliases.');
}
function fromStat(stat: import('node:fs').Stats): LinuxReviewNode {
    return {
        kind: stat.isSymbolicLink()
            ? 'other'
            : stat.isDirectory()
              ? 'directory'
              : stat.isFile()
                ? 'file'
                : 'other',
        uid: stat.uid,
        mode: stat.mode,
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
    };
}
/** Non-following/nonblocking opens reject FIFO/device metadata before reading. No native probes. */
export function createLinuxReviewDisk(
    filesystem: Pick<
        typeof physicalFS.promises,
        'lstat' | 'realpath' | 'opendir' | 'open'
    > = physicalFS.promises,
): LinuxReviewIO {
    return {
        async node(file) {
            try {
                return fromStat(await filesystem.lstat(file));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
        },
        canonical: (directory) => filesystem.realpath(directory),
        async names(directory, limit) {
            const result: string[] = [],
                handle = await filesystem.opendir(directory);
            try {
                for (;;) {
                    const entry = await handle.read();
                    if (!entry) break;
                    if (result.length >= limit)
                        throw Error('Linux directory inventory exceeds its bound.');
                    result.push(entry.name);
                }
            } finally {
                await handle.close();
            }
            return result;
        },
        async bytes(file, limit, uid) {
            const before = await this.node(file);
            if (!before) throw Error('Required Linux setup metadata is missing.');
            regular(before, limit, uid, true);
            const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = physicalFS.constants;
            const handle = await filesystem.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
            try {
                if (!sameNode(before, fromStat(await handle.stat())))
                    throw Error('Linux metadata identity changed.');
                const buffer = Buffer.alloc(limit + 1);
                let count = 0;
                while (count < buffer.length) {
                    const read = await handle.read(buffer, count, buffer.length - count, count);
                    if (!read.bytesRead) break;
                    count += read.bytesRead;
                }
                if (
                    count !== before.size ||
                    count > limit ||
                    !sameNode(before, fromStat(await handle.stat())) ||
                    !sameNode(before, await this.node(file))
                )
                    throw Error('Linux metadata changed during its bounded read.');
                return buffer.subarray(0, count);
            } finally {
                await handle.close();
            }
        },
        async digest(file, bytes, uid) {
            const before = await this.node(file);
            if (!before) throw Error('Linux payload file is missing.');
            regular(before, bytes, uid, false);
            if (before.size !== bytes) throw Error('Linux payload length differs.');
            const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = physicalFS.constants;
            const handle = await filesystem.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
            try {
                if (!sameNode(before, fromStat(await handle.stat())))
                    throw Error('Linux payload identity changed.');
                const buffer = Buffer.alloc(65536),
                    digest = createHash('sha256');
                let total = 0;
                for (;;) {
                    const read = await handle.read(
                        buffer,
                        0,
                        Math.min(buffer.length, bytes - total + 1),
                        total,
                    );
                    if (!read.bytesRead) break;
                    total += read.bytesRead;
                    if (total > bytes) throw Error('Linux payload exceeds declared length.');
                    digest.update(buffer.subarray(0, read.bytesRead));
                }
                if (
                    total !== bytes ||
                    !sameNode(before, fromStat(await handle.stat())) ||
                    !sameNode(before, await this.node(file))
                )
                    throw Error('Linux payload changed during verification.');
                return digest.digest('hex');
            } finally {
                await handle.close();
            }
        },
    };
}
export const linuxReviewDisk = createLinuxReviewDisk();

/** Future AppDir package shape is ROOT/app/diagnostic-hub; never infer an AppImage or arbitrary runtime. */
export function linuxReviewSourceRoot(executable: string) {
    if (
        !canonicalSyntax(executable) ||
        path.posix.basename(executable) !== 'diagnostic-hub' ||
        path.posix.basename(path.posix.dirname(executable)) !== 'app'
    )
        throw Error('Linux review requires the explicit complete-folder package runtime.');
    return path.posix.dirname(path.posix.dirname(executable));
}

/** Source/package review only; proposed actions are not executable permissions or native acceptance. */
export async function reviewLinuxAppDir(
    host: LinuxReviewHost,
    input: string,
    io: LinuxReviewIO = linuxReviewDisk,
) {
    // Copy caller identities before the first await; do not let an adapter mutate comparisons.
    host = { ...host };
    if (
        host.platform !== 'linux' ||
        host.arch !== 'x64' ||
        !Number.isSafeInteger(host.uid) ||
        host.uid <= 0 ||
        host.euid !== host.uid
    )
        throw Error('Linux AppDir review requires ordinary-user Linux x64.');
    if (![input, host.home, host.appData, host.sourceRoot].every(canonicalSyntax))
        throw Error('Choose canonical absolute Linux paths without aliases.');
    const root = input,
        snapshots = new Map<string, LinuxReviewNode | null>();
    const guardPath = async (target: string, allowMissing: boolean) => {
        const parts = target.split('/').filter(Boolean);
        let cursor = '';
        for (const part of parts) {
            cursor += '/' + part;
            const node = await io.node(cursor);
            if (!node && !allowMissing) throw Error('Required Linux setup directory is missing.');
            if (node) directory(node, host.uid, inside(host.home, cursor));
            if (snapshots.has(cursor) && !sameSnapshot(snapshots.get(cursor)!, node))
                throw Error('Linux setup parent identity changed.');
            snapshots.set(cursor, node ? { ...node } : null);
            if (node && (await io.canonical(cursor)) !== cursor)
                throw Error('Linux setup directory alias refused.');
        }
    };
    if (
        !inside(host.home, root) ||
        root === host.home ||
        path.posix.basename(root).startsWith('.DiagnosticHub-') ||
        inside(root, host.sourceRoot) ||
        inside(host.sourceRoot, root) ||
        inside(root, host.appData) ||
        inside(host.appData, root)
    )
        throw Error(
            'Keep app, source and retained profile/report data in separate owned locations.',
        );
    await guardPath(host.home, false);
    await guardPath(host.sourceRoot, false);
    await guardPath(host.appData, true);
    await guardPath(root, true);
    await guardPath(path.posix.dirname(maintenancePaths(root).work), false);
    if (await io.node(maintenancePaths(root).work))
        throw Error(
            'Linux maintenance or recovery material exists; preserve it for guarded recovery.',
        );
    const metadata = async (file: string, limit = 16384) => {
        const before = await io.node(file);
        if (!before) throw Error('Required Linux setup metadata is missing.');
        const bytes = await io.bytes(file, limit, host.uid);
        if (!sameNode(before, await io.node(file))) throw Error('Linux metadata identity changed.');
        snapshots.set(file, { ...before });
        return { value: JSON.parse(bytes.toString('utf8')) as unknown, bytes };
    };
    const candidate = validateInstallationManifest(
        (
            await metadata(
                path.posix.join(host.sourceRoot, SETUP_PAYLOAD),
                MAX_INSTALLATION_MANIFEST_BYTES,
            )
        ).value,
    );
    const admitManifest = (manifest: InstallationManifest) => {
        if (
            manifest.platform !== 'linux' ||
            manifest.arch !== 'x64' ||
            manifest.layout !== 'linux-folder' ||
            manifest.files.some((file) => file.kind !== 'file')
        )
            throw Error(
                'Only regular-file Linux AppDir payloads are supported by this review slice.',
            );
    };
    admitManifest(candidate);
    if (host.requirePackagedReviewCapability === true) {
        // Executed inside the controller's original read-only review/deadline, not before its clock.
        await guardPath(path.posix.join(host.sourceRoot, 'app', 'resources'), false);
        const capability = validateLinuxReviewCapability((await metadata(
            path.posix.join(host.sourceRoot, LINUX_REVIEW_CAPABILITY), 4096,
        )).value, host.version);
        assertLinuxReviewManifestEntry(candidate.files, capability);
        const entry = candidate.files.find(file => file.path === LINUX_REVIEW_ENTRY);
        if (!entry || entry.kind !== 'file')
            throw Error('LINUX_REVIEW_MANIFEST_ENTRY');
        const decision = linuxReviewHelperDecision({ platform: host.platform, arch: host.arch,
            intent: 'review', envelope: 'explicit-linux-folder', version: host.version,
            capability, entryBytes: entry.bytes, entrySHA256: entry.sha256 });
        if (decision.status !== 'read-only-review') throw Error('LINUX_REVIEW_HELPER_REFUSED');
        // verify() below checks every actual payload byte before returning any promptable review.
    }
    if (candidate.version !== host.version)
        throw Error('Linux source version does not match the worker.');
    const verify = async (base: string, manifest: InstallationManifest) => {
        for (const file of manifest.files) {
            if (file.kind !== 'file') throw Error('Linux payload aliases are not supported.');
            const filename = path.posix.join(base, file.path);
            await guardPath(path.posix.dirname(filename), false);
            const before = await io.node(filename);
            if (!before) throw Error('Linux payload file is missing.');
            regular(before, file.bytes, host.uid, false);
            if (
                before.size !== file.bytes ||
                (await io.digest(filename, file.bytes, host.uid)) !== file.sha256 ||
                !sameNode(before, await io.node(filename))
            )
                throw Error(
                    'Linux payload checksum or identity differs. Preserve the source or installation.',
                );
            snapshots.set(filename, { ...before });
        }
    };
    await verify(host.sourceRoot, candidate);
    let installed: InstallationManifest | null = null,
        id: string | null = null;
    let menuSelected = false;
    const rootNode = snapshots.get(root);
    if (rootNode && (await io.names(root, 20010)).length) {
        const record = validateInstallationRecord(
            (await metadata(path.posix.join(root, INSTALLATION_RECORD))).value,
        );
        const stored = await metadata(
            path.posix.join(root, INSTALLATION_MANIFEST),
            MAX_INSTALLATION_MANIFEST_BYTES,
        );
        installed = validateInstallationManifest(stored.value);
        admitManifest(installed);
        if (record.profile !== 'dedicated' || hash(stored.bytes) !== record.manifestSHA256)
            throw Error('Linux installation identity differs; retain all existing files.');
        const owner = (await metadata(path.posix.join(root, SETUP_OWNER))).value as Record<
            string,
            unknown
        >;
        // A private owned record declares authority; current external menu bytes are checked by the transaction observer.
        const choice = owner?.options as Record<string, unknown> | undefined;
        if (
            Object.keys(owner).some(
                (key) =>
                    ![
                        'schemaVersion',
                        'product',
                        'installationId',
                        'transactionId',
                        'root',
                        'options',
                        'integrations',
                    ].includes(key),
            ) ||
            !choice ||
            Object.keys(choice).length !== 3 ||
            !['startMenu', 'desktop', 'launch'].every((key) => typeof choice[key] === 'boolean') ||
            (owner.transactionId !== undefined &&
                (typeof owner.transactionId !== 'string' ||
                    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
                        owner.transactionId,
                    )))
        )
            throw Error('Unsupported Linux ownership metadata. Preserve the installation.');
        if (
            owner?.schemaVersion !== 1 ||
            owner.product !== INSTALLATION_PRODUCT ||
            owner.root !== root ||
            owner.installationId !== record.installationId ||
            !Array.isArray(owner.integrations) ||
            owner.integrations.length > 1
        )
            throw Error('Unsupported Linux installation ownership or integrations; preserve them.');
        if (owner.integrations.length === 1) {
            const declared = owner.integrations[0] as { path?: unknown };
            if (!declared || typeof declared.path !== 'string') throw Error('Unsupported Linux menu record.');
            checkedLinuxMenuRecord(declared, { host, root, installationId: record.installationId,
                menu: { dataHome: path.posix.dirname(path.posix.dirname(declared.path)), selected: true } });
            if (!choice.startMenu || choice.desktop || choice.launch) throw Error('Linux menu choices differ from declared ownership.');
            menuSelected = true;
        }
        await verify(root, installed);
        const allowed = new Set([
            ...installed.files.map((file) => file.path),
            INSTALLATION_RECORD,
            INSTALLATION_MANIFEST,
            SETUP_OWNER,
        ]);
        const dirs = new Set<string>();
        for (const file of allowed) {
            let parent = path.posix.dirname(file);
            while (parent !== '.') {
                dirs.add(parent);
                parent = path.posix.dirname(parent);
            }
        }
        let count = 0;
        const inventory = async (directory: string) => {
            for (const name of await io.names(directory, 20010)) {
                if (++count > 20010 || !name || name === '.' || name === '..' || name.includes('/'))
                    throw Error('Linux owned inventory exceeds its bounds.');
                const file = path.posix.join(directory, name),
                    relative = path.posix.relative(root, file),
                    node = await io.node(file);
                if (!node) throw Error('Linux installed content disappeared.');
                if (node.kind === 'directory' && dirs.has(relative)) {
                    await guardPath(file, false);
                    await inventory(file);
                } else if (node.kind !== 'file' || !allowed.has(relative))
                    throw Error('Foreign Linux installation content must be preserved.');
            }
        };
        await inventory(root);
        id = record.installationId;
    }
    for (const [file, before] of snapshots)
        if (!sameSnapshot(before, await io.node(file)))
            throw Error('Linux review location changed. Review again.');
    if (await io.node(maintenancePaths(root).work))
        throw Error('Linux maintenance began during review. Preserve its state.');
    return {
        root,
        state: installed ? ('owned' as const) : ('new' as const),
        installedVersion: installed?.version ?? null,
        candidateVersion: candidate.version,
        actions: [] as string[],
        proposedActions: installationActions(installed?.version ?? null, candidate.version),
        profile: path.posix.join(
            host.appData,
            'DiagnosticHub',
            'profiles',
            id ?? '(new installation)',
        ),
        reviewToken: hash(
            JSON.stringify({ root, candidate, installed, id, snapshots: [...snapshots] }),
        ),
        options: { startMenu: menuSelected, desktop: false, launch: false },
        needsRepair: false,
        qualification: 'source-review-only' as const,
        message:
            'Read-only Linux AppDir review. Install, menu, launch, recovery and Finalize are unavailable in this slice.',
    };
}
function sameSnapshot(before: LinuxReviewNode | null, after: LinuxReviewNode | null) {
    return before === null ? after === null : sameNode(before, after);
}
