import { createHash } from 'node:crypto';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { validatedWindowsInstallRoot } from './windows-installer-fixed-launch.ts';

export const WINDOWS_PAYLOAD_LIMITS = Object.freeze({
    entries: 4096,
    fileBytes: 512 * 1024 * 1024,
    totalBytes: 1024 * 1024 * 1024,
    readBytes: 64 * 1024,
});
export interface PinnedPayloadFile {
    readonly relativePath: string;
    readonly size: number;
    readonly sha256: string;
}
export interface PayloadFileHandle {
    stat(): Promise<BigIntStats>;
    read(buffer: Buffer, position: number): Promise<number>;
    close(): Promise<void>;
}
export interface WindowsPayloadIo {
    platform: string;
    lstat(file: string): Promise<BigIntStats>;
    realpath(file: string): Promise<string>;
    entries(directory: string): AsyncIterable<string>;
    open(file: string): Promise<PayloadFileHandle>;
}

// Real, read-only Node filesystem operations. This adapter cannot pin Windows
// directories or deny replacement through CreateProcess. It is not admission.
export function nodeWindowsPayloadIo(): WindowsPayloadIo {
    return {
        platform: process.platform,
        lstat: (file) => lstat(file, { bigint: true }),
        realpath,
        async *entries(directory) {
            const handle = await opendir(directory);
            for await (const entry of handle) yield entry.name;
        },
        async open(file) {
            const handle = await open(file, 'r');
            return {
                stat: () => handle.stat({ bigint: true }),
                read: async (buffer, position) =>
                    (await handle.read(buffer, 0, buffer.length, position)).bytesRead,
                close: () => handle.close(),
            };
        },
    };
}

function fail(code: string): never {
    throw Error('WINDOWS_PAYLOAD_' + code);
}
function sameStat(a: BigIntStats, b: BigIntStats): boolean {
    return (
        ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every(
            (key) => a[key as keyof BigIntStats] === b[key as keyof BigIntStats],
        ) &&
        a.isFile() === b.isFile() &&
        a.isDirectory() === b.isDirectory() &&
        !b.isSymbolicLink()
    );
}
type Node = { relativePath: string; file?: PinnedPayloadFile };
function inventory(files: readonly PinnedPayloadFile[]): Map<string, Node> {
    if (!Array.isArray(files) || !files.length || files.length > WINDOWS_PAYLOAD_LIMITS.entries)
        fail('INVENTORY_INVALID');
    const nodes = new Map<string, Node>();
    let total = 0;
    for (const entry of files) {
        // Copy primitives before any asynchronous filesystem work. Never load
        // expectations from the installation or a neighbouring checksum file.
        const relativePath = entry?.relativePath,
            size = entry?.size,
            sha256 = entry?.sha256;
        if (
            typeof relativePath !== 'string' ||
            relativePath.includes('\\') ||
            !relativePath ||
            relativePath.startsWith('/') ||
            relativePath.endsWith('/') ||
            !Number.isSafeInteger(size) ||
            size < 0 ||
            size > WINDOWS_PAYLOAD_LIMITS.fileBytes ||
            typeof sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(sha256)
        )
            fail('INVENTORY_INVALID');
        try {
            validatedWindowsInstallRoot('C:\\' + relativePath.replaceAll('/', '\\'));
        } catch {
            fail('INVENTORY_PATH_INVALID');
        }
        const key = relativePath.toLowerCase();
        if (nodes.has(key)) fail('INVENTORY_COLLISION');
        nodes.set(key, { relativePath, file: Object.freeze({ relativePath, size, sha256 }) });
        const parts = relativePath.split('/');
        for (let i = 1; i < parts.length; i++) {
            const directory = parts.slice(0, i).join('/'),
                existing = nodes.get(directory.toLowerCase());
            if (existing && (existing.file || existing.relativePath !== directory))
                fail('INVENTORY_COLLISION');
            if (!existing) nodes.set(directory.toLowerCase(), { relativePath: directory });
        }
        total += size;
        if (
            nodes.size > WINDOWS_PAYLOAD_LIMITS.entries ||
            total > WINDOWS_PAYLOAD_LIMITS.totalBytes
        )
            fail('INVENTORY_LIMIT');
    }
    if (!nodes.get('diagnostic hub.exe')?.file || !nodes.get('resources/app.asar')?.file)
        fail('REQUIRED_FILES_MISSING');
    return nodes;
}

// Compare a complete externally pinned file inventory to actual opened bytes.
// Matching samples are a necessary observation, never a launch authorization:
// Node path/stat checks cannot close Windows reparse/replacement races, attest
// ACLs, or prove the provenance/completeness of the caller's trusted inventory.
// Only directory entries and unnamed file data streams are compared, not NTFS
// alternate streams or every reparse tag. This is not a Windows filesystem attestation.
export async function compareWindowsInstalledPayload(
    installRoot: string,
    pinnedFiles: readonly PinnedPayloadFile[],
    io: WindowsPayloadIo = nodeWindowsPayloadIo(),
) {
    const root = validatedWindowsInstallRoot(installRoot),
        expected = inventory(pinnedFiles);
    if (io.platform !== 'win32') fail('WINDOWS_REQUIRED');
    const resolve = (relativePath: string) => path.win32.join(root, ...relativePath.split('/'));
    const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    for (const node of expected.values())
        if (resolve(node.relativePath).length > 240) fail('PATH_LIMIT');
    const sampled = new Map<string, BigIntStats>();
    const observedFiles: { relativePath: string; size: number; sha256: string; fileId: string }[] =
        [];
    async function sample(file: string, directory: boolean) {
        const stat = await io.lstat(file);
        if (
            stat.isSymbolicLink() ||
            (directory ? !stat.isDirectory() : !stat.isFile()) ||
            typeof stat.ino !== 'bigint' ||
            stat.ino <= 0n ||
            typeof stat.dev !== 'bigint' ||
            stat.dev < 0n ||
            (!directory && stat.nlink !== 1n)
        )
            fail('NODE_INVALID');
        if (!samePath(await io.realpath(file), file)) fail('PATH_REDIRECTED');
        return stat;
    }
    // Check every lexical ancestor, not just the final root. These are samples,
    // not native locks or an assertion about every Windows reparse tag.
    const drive = path.win32.parse(root).root;
    let ancestor = drive;
    for (const component of ['', ...root.slice(drive.length).split('\\')]) {
        if (component) ancestor = path.win32.join(ancestor, component);
        sampled.set(ancestor, await sample(ancestor, true));
    }
    const visited = new Set<string>();
    async function walk(directory: string, relative: string) {
        const names = new Set<string>();
        for await (const name of io.entries(directory)) {
            if (
                typeof name !== 'string' ||
                !name ||
                name.includes('/') ||
                name.includes('\\') ||
                name === '.' ||
                name === '..'
            )
                fail('ENTRY_INVALID');
            const rel = relative ? relative + '/' + name : name,
                key = rel.toLowerCase();
            const expectedNode = expected.get(key);
            if (
                names.has(name.toLowerCase()) ||
                !expectedNode ||
                expectedNode.relativePath !== rel ||
                visited.has(key)
            )
                fail('INVENTORY_MISMATCH');
            names.add(name.toLowerCase());
            visited.add(key);
            const file = resolve(rel),
                stat = await sample(file, !expectedNode.file);
            sampled.set(file, stat);
            if (!expectedNode.file) {
                await walk(file, rel);
                continue;
            }
            const pinned = expectedNode.file;
            if (stat.size !== BigInt(pinned.size)) fail('SIZE_MISMATCH');
            const handle = await io.open(file);
            let digest: string;
            try {
                if (!sameStat(stat, await handle.stat())) fail('OPEN_IDENTITY_CHANGED');
                const hash = createHash('sha256'),
                    buffer = Buffer.alloc(WINDOWS_PAYLOAD_LIMITS.readBytes);
                let bytes = 0;
                for (;;) {
                    const count = await handle.read(buffer, bytes);
                    if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length)
                        fail('READ_INVALID');
                    if (!count) break;
                    bytes += count;
                    if (bytes > pinned.size) fail('SIZE_MISMATCH');
                    hash.update(buffer.subarray(0, count));
                }
                if (bytes !== pinned.size) fail('SIZE_MISMATCH');
                digest = hash.digest('hex');
                if (digest !== pinned.sha256) fail('DIGEST_MISMATCH');
                if (!sameStat(stat, await handle.stat())) fail('READ_IDENTITY_CHANGED');
            } finally {
                await handle.close();
            }
            observedFiles.push(
                Object.freeze({
                    relativePath: rel,
                    size: pinned.size,
                    sha256: digest,
                    fileId: stat.dev.toString() + ':' + stat.ino.toString(),
                }),
            );
        }
    }
    await walk(root, '');
    if (visited.size !== expected.size) fail('INVENTORY_MISMATCH');
    for (const [file, before] of sampled) {
        if (!sameStat(before, await sample(file, before.isDirectory())))
            fail('PATH_IDENTITY_CHANGED');
    }
    // No capability, spawn callback, or token is returned. The fixed launcher
    // has no default native host and cannot use this comparison to enable one.
    return Object.freeze({
        installRoot: root,
        nativeLaunchAdmitted: false as const,
        files: Object.freeze(
            observedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
        ),
    });
}
