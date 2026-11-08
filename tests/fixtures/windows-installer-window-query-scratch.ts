import fs from 'node:fs/promises';
import path from 'node:path';

interface DirectoryIdentity {
    realpath: string;
    device: bigint;
    inode: bigint;
}
interface ProbeHandle {
    writeFile(bytes: Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
}
/** Controlled tests substitute these filesystem boundaries; native callers use the defaults. */
export interface WindowQueryScratchHost {
    platform: string;
    inspectDirectory(directory: string): Promise<DirectoryIdentity>;
    mkdir(directory: string): Promise<void>;
    openProbe(file: string): Promise<ProbeHandle>;
}
export interface WindowQueryScratch {
    readonly directory: string;
}
type ScratchProvenance = 'native-filesystem' | 'controlled-memory';
const capabilities = new WeakMap<
    WindowQueryScratch,
    {
        used: boolean;
        provenance: ScratchProvenance;
        verify: () => Promise<void>;
    }
>();
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const nativeHost: WindowQueryScratchHost = {
    platform: process.platform,
    async inspectDirectory(directory) {
        const info = await fs.lstat(directory, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink()) throw Error('SCRATCH_NOT_PHYSICAL');
        return { realpath: await fs.realpath(directory), device: info.dev, inode: info.ino };
    },
    mkdir: (directory) => fs.mkdir(directory, { mode: 0o700 }),
    openProbe: (file) => fs.open(file, 'wx', 0o600),
};

/** Create only a NEW selected directory. Retain it and the fixed probe; never remove existing data. */
export async function prepareWindowQueryScratch(
    directory: string,
    host: WindowQueryScratchHost = nativeHost,
): Promise<WindowQueryScratch> {
    if (host.platform !== 'win32') throw Error('WINDOW_QUERY_WINDOWS_REQUIRED');
    if (
        typeof directory !== 'string' ||
        !/^[a-z]:\\/i.test(directory) ||
        /[\x00-\x1f"%/]/.test(directory) ||
        path.win32.normalize(directory) !== directory ||
        directory.split('\\').some((part) => part === '.' || part === '..') ||
        path.win32.dirname(directory) === directory
    )
        throw Error('WINDOW_QUERY_SCRATCH_PATH_INVALID');
    const parent = path.win32.dirname(directory);
    const inspectDirectory = host.inspectDirectory.bind(host);
    const inspect = async (name: string) => {
        const identity = await inspectDirectory(name);
        if (
            !samePath(identity.realpath, name) ||
            typeof identity.device !== 'bigint' ||
            typeof identity.inode !== 'bigint' ||
            identity.device < 0n ||
            identity.inode <= 0n
        )
            throw Error('WINDOW_QUERY_SCRATCH_IDENTITY_INVALID');
        return Object.freeze({ ...identity });
    };
    const before = await inspect(parent);
    const custody = {
        directory,
        creationRequested: false,
        created: false,
        probe: path.win32.join(directory, '.window-query-write-probe'),
        handle: null as ProbeHandle | null,
        probeClosed: false,
    };
    try {
        custody.creationRequested = true;
        await host.mkdir(directory); // No recursive/existing-directory acceptance.
        custody.created = true;
        const owned = await inspect(directory);
        custody.handle = await host.openProbe(custody.probe); // Native default is exclusive wx.
        const errors: unknown[] = [];
        try {
            await custody.handle.writeFile(Buffer.from('window-query writable scratch\n'));
            await custody.handle.sync();
        } catch (error) {
            errors.push(error);
        }
        try {
            await custody.handle.close();
            custody.probeClosed = true;
        } catch (error) {
            errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, 'SCRATCH_PROBE_UNCONFIRMED');
        const after = await inspect(directory),
            parentAfter = await inspect(parent);
        if (
            after.device !== owned.device ||
            after.inode !== owned.inode ||
            parentAfter.device !== before.device ||
            parentAfter.inode !== before.inode
        )
            throw Error('WINDOW_QUERY_SCRATCH_IDENTITY_CHANGED');
        const capability = Object.freeze({ directory });
        capabilities.set(capability, {
            used: false,
            provenance: host === nativeHost ? 'native-filesystem' : 'controlled-memory',
            verify: async () => {
                const current = await inspect(directory),
                    currentParent = await inspect(parent);
                if (
                    current.device !== owned.device ||
                    current.inode !== owned.inode ||
                    currentParent.device !== before.device ||
                    currentParent.inode !== before.inode
                )
                    throw Error('WINDOW_QUERY_SCRATCH_IDENTITY_CHANGED_AT_USE');
            },
        });
        return capability;
    } catch (cause) {
        // A failed/uncertain allocation or close is retained for the future native adapter.
        // No unlink, retry, fabricated closure or implicit permission to clean up follows.
        throw Object.assign(new Error('WINDOW_QUERY_SCRATCH_PREPARATION_FAILED', { cause }), {
            custody,
        });
    }
}

/** Recheck once at use. This is a path observation, not an atomic Windows directory pin. */
export async function consumeWindowQueryScratch(
    scratch: WindowQueryScratch,
    requiredProvenance: ScratchProvenance,
): Promise<string> {
    const record = capabilities.get(scratch);
    if (!record || record.used) throw Error('WINDOW_QUERY_SCRATCH_UNADMITTED_OR_USED');
    if (record.provenance !== requiredProvenance)
        throw Error('WINDOW_QUERY_SCRATCH_PROVENANCE_MISMATCH');
    record.used = true;
    await record.verify();
    return scratch.directory;
}
