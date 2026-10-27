import { physicalFS } from './physical-fs.ts';
const { lstat, realpath, unlink, rmdir, rename, mkdir, writeFile, copyFile } = physicalFS.promises;
const { constants } = physicalFS;
import path from 'node:path';

const same = (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/** Validate the full existing parent chain immediately before a filesystem mutation. */
export async function assertPlainAncestors(target: string) {
    if (!path.isAbsolute(target)) throw Error('Setup mutation paths must be absolute.');
    const parent = path.dirname(path.resolve(target));
    let cursor = parent;
    while (true) {
        const stat = await lstat(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw Error('Setup mutation parent aliases are refused.');
        const next = path.dirname(cursor);
        if (next === cursor) break;
        cursor = next;
    }
    if (!same(await realpath(parent), parent))
        throw Error('Setup mutation parent identity differs.');
}
async function leaf(target: string, kind: 'file' | 'directory') {
    const stat = await lstat(target);
    if (
        stat.isSymbolicLink() ||
        (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    )
        throw Error('Setup mutation requires an owned plain ' + kind + '.');
}
export async function unlinkOwnedFile(target: string) {
    await assertPlainAncestors(target);
    await leaf(target, 'file');
    await unlink(target);
}
export async function removeOwnedDirectory(target: string) {
    await assertPlainAncestors(target);
    await leaf(target, 'directory');
    await rmdir(target);
}
export async function moveOwnedDirectory(source: string, destination: string) {
    await assertPlainAncestors(source);
    await leaf(source, 'directory');
    await assertPlainAncestors(destination);
    try {
        await lstat(destination);
        throw Error('An existing move destination must be preserved.');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(source, destination);
}
export async function replaceOwnedMetadata(source: string, destination: string) {
    await assertPlainAncestors(source);
    await leaf(source, 'file');
    await assertPlainAncestors(destination);
    try {
        await leaf(destination, 'file');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(source, destination);
}
export async function ensurePlainDirectory(directory: string, exclusive = false) {
    if (!path.isAbsolute(directory)) throw Error('Setup directory paths must be absolute.');
    const absolute = path.resolve(directory);
    if (exclusive) {
        try {
            await lstat(absolute);
            throw Error('An existing setup directory must be preserved.');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    let cursor = path.parse(absolute).root;
    await leaf(cursor, 'directory');
    for (const segment of path.relative(cursor, absolute).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        if (exclusive && cursor === absolute) {
            await assertPlainAncestors(cursor);
            await mkdir(cursor);
            continue;
        }
        try {
            await leaf(cursor, 'directory');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await assertPlainAncestors(cursor);
            await mkdir(cursor);
        }
    }
    await assertPlainAncestors(absolute);
    await leaf(absolute, 'directory');
}
export async function writeOwnedFile(
    target: string,
    bytes: string | Uint8Array,
    options?: { flag?: string; mode?: number },
) {
    if (options?.flag !== undefined && options.flag !== 'wx')
        throw Error('Setup direct file writes must be exclusive.');
    await assertPlainAncestors(target);
    await writeFile(target, bytes, { flag: 'wx', mode: options?.mode ?? 0o600 });
}
export async function copyOwnedFile(source: string, destination: string) {
    await assertPlainAncestors(source);
    await leaf(source, 'file');
    await assertPlainAncestors(destination);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
}
