import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { valid } from 'semver';
import type { UpdateInfo, UpdateReceipt } from '../shared/types';
const MAX_BYTES = 512 * 1024 * 1024;
const samePath = (a: string, b: string) =>
    process.platform === 'win32'
        ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
        : path.resolve(a) === path.resolve(b);
export function portableExecutable(
    platform: string,
    packaged: boolean,
    executable: string,
    environment: NodeJS.ProcessEnv,
): string | null {
    if (!packaged) return null;
    const file =
        platform === 'win32'
            ? environment.PORTABLE_EXECUTABLE_FILE
            : platform === 'linux'
              ? environment.APPIMAGE
              : executable;
    // Portable extraction process.execPath is deliberately not a fallback on Windows/Linux.
    if (!file || !path.isAbsolute(file) || file.length > 4096) return null;
    if (platform === 'darwin') {
        const marker = path.sep + 'Contents' + path.sep + 'MacOS' + path.sep;
        const index = file.lastIndexOf(marker);
        if (index > 0 && file.slice(0, index).endsWith('.app'))
            return path.resolve(file.slice(0, index));
    }
    return path.resolve(file);
}
export class UpdateReceipts {
    private marker: string;
    constructor(
        private directory: string,
        private platform: string,
    ) {
        this.marker = path.join(directory, 'handoff.json');
    }
    private destination(version: string) {
        if (
            !valid(version) ||
            valid(version) !== version ||
            !['win32', 'linux'].includes(this.platform)
        )
            throw Error('Invalid update destination.');
        return path.join(
            this.directory,
            version,
            this.platform === 'win32' ? 'Diagnostic-Hub.exe' : 'Diagnostic-Hub-linux-x64.AppImage',
        );
    }
    private validate(value: unknown): UpdateReceipt {
        const v = value as UpdateReceipt;
        if (
            !v ||
            typeof v !== 'object' ||
            typeof v.previousVersion !== 'string' ||
            !valid(v.previousVersion) ||
            typeof v.version !== 'string' ||
            typeof v.executable !== 'string' ||
            !samePath(v.executable, this.destination(v.version)) ||
            !/^[a-f0-9]{64}$/.test(v.hash) ||
            !['verified', 'restart-requested', 'restart-failed', 'confirmed'].includes(v.state) ||
            typeof v.updatedAt !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T/.test(v.updatedAt) ||
            !Number.isFinite(Date.parse(v.updatedAt))
        )
            throw Error('Invalid update handoff receipt.');
        return {
            previousVersion: v.previousVersion,
            version: v.version,
            executable: this.destination(v.version),
            hash: v.hash,
            state: v.state,
            updatedAt: v.updatedAt,
        };
    }
    async write(input: Omit<UpdateReceipt, 'updatedAt'>): Promise<void> {
        const receipt = this.validate({ ...input, updatedAt: new Date().toISOString() });
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temporary = this.marker + '.' + randomUUID() + '.part';
        try {
            await writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
            await rename(temporary, this.marker);
        } finally {
            await rm(temporary, { force: true });
        }
    }
    async read(): Promise<UpdateReceipt | null> {
        try {
            const stat = await lstat(this.marker);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
                throw Error('Invalid update handoff receipt.');
            return this.validate(JSON.parse(await readFile(this.marker, 'utf8')));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw e;
        }
    }
    private async attestedLocation(location: string, anchor: string): Promise<boolean> {
        const relative = path.relative(anchor, location);
        if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..'))
            return false;
        const root = await lstat(anchor);
        if (!root.isDirectory() || root.isSymbolicLink()) return false;
        // Native ancestor aliases may be canonicalized; owned descendants must not redirect.
        const canonicalRoot = await realpath(anchor);
        let descendant = anchor;
        for (const part of relative.split(path.sep)) {
            descendant = path.join(descendant, part);
            if ((await lstat(descendant)).isSymbolicLink()) return false;
        }
        return samePath(await realpath(location), path.join(canonicalRoot, relative));
    }
    async verifyFile(
        file: string,
        hash?: string,
        anchor = hash ? this.directory : path.dirname(file),
    ): Promise<string> {
        const stat = await lstat(file);
        if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > MAX_BYTES ||
            !(await this.attestedLocation(file, anchor))
        )
            throw Error('The update executable location changed or is unavailable.');
        if (hash) {
            const digest = createHash('sha256');
            let size = 0;
            for await (const chunk of createReadStream(file)) {
                size += chunk.length;
                if (size > MAX_BYTES) throw Error('The update executable has changed.');
                digest.update(chunk);
            }
            if (digest.digest('hex') !== hash) throw Error('The update executable has changed.');
        }
        return file;
    }
    async info(currentVersion: string, currentPath: string | null): Promise<UpdateInfo> {
        let receipt = await this.read();
        let handoffConfirmed = false;
        if (
            receipt &&
            currentPath &&
            currentVersion === receipt.version &&
            samePath(currentPath, receipt.executable)
        ) {
            await this.verifyFile(receipt.executable, receipt.hash);
            handoffConfirmed = true;
            if (receipt.state !== 'confirmed') {
                await this.write({ ...receipt, state: 'confirmed' });
                receipt = await this.read();
            }
        }
        return { currentVersion, currentPath, receipt, handoffConfirmed };
    }
    private async currentLocation(currentPath: string) {
        if (this.platform === 'darwin' && currentPath.endsWith('.app')) {
            const stat = await lstat(currentPath);
            if (
                !stat.isDirectory() ||
                stat.isSymbolicLink() ||
                !(await this.attestedLocation(currentPath, path.dirname(currentPath)))
            )
                throw Error('The current application bundle location changed.');
            await this.verifyFile(
                path.join(currentPath, 'Contents', 'MacOS', 'Diagnostic Hub'),
                undefined,
                currentPath,
            );
            return currentPath;
        }
        return this.verifyFile(currentPath);
    }
    async selectedPath(target: unknown, currentPath: string | null): Promise<string> {
        if (target === 'current' && currentPath) return this.currentLocation(currentPath);
        if (target === 'verified') {
            const receipt = await this.read();
            if (receipt) return this.verifyFile(receipt.executable, receipt.hash);
        }
        throw Error('Choose an available application-owned executable location.');
    }
}
