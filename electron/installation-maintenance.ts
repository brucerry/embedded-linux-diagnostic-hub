import { physicalFS } from './physical-fs.ts';
import { assertPlainAncestors } from './setup-paths.ts';
import { unlinkOwnedFile, replaceOwnedMetadata } from './setup-paths.ts';
import { createHash, randomUUID } from 'node:crypto';
const { lstatSync } = physicalFS;
const { open } = physicalFS.promises;
import path from 'node:path';
import {
    INSTALLATION_PRODUCT,
    INSTALLATION_RECORD,
    MAX_INSTALLATION_MANIFEST_BYTES,
    validateInstallationRecord,
} from '../shared/installation.ts';

export const SETUP_PAYLOAD = 'diagnostic-hub-setup-payload.json';
export const SETUP_OWNER = '.diagnostic-hub-ownership.json';
export const SETUP_UNINSTALLER = 'Uninstall Diagnostic Hub.exe';
export function maintenancePaths(root: string) {
    const canonical = path.resolve(root);
    const key = createHash('sha256')
        .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
        .digest('hex')
        .slice(0, 20);
    const work = path.join(path.dirname(canonical), '.DiagnosticHub-maintenance-' + key);
    return {
        work,
        lock: path.join(work, 'lock.json'),
        journal: path.join(work, 'journal.json'),
        ack: path.join(work, 'boot-ack.json'),
    };
}
export function assertNoMaintenance(root: string) {
    const assertUnlocked = (candidate: string) => {
        try {
            lstatSync(maintenancePaths(candidate).lock);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        throw Error(
            'Installation maintenance is in progress. Finish or recover it with verified setup before launching.',
        );
    };
    assertUnlocked(root);
    const ownerFile = path.join(root, SETUP_OWNER);
    let ownerStat;
    try {
        ownerStat = lstatSync(ownerFile);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    if (
        !ownerStat.isFile() ||
        ownerStat.isSymbolicLink() ||
        ownerStat.nlink !== 1 ||
        ownerStat.size > 16384
    )
        throw Error('Unsafe setup ownership at startup.');
    const ownerBytes = readSetupMetadataBytesSync(ownerFile, 16384, physicalFS, ownerStat);
    if (ownerBytes.length > 16384) throw Error('Setup ownership exceeds startup bound.');
    const owner = JSON.parse(ownerBytes.toString('utf8')) as Record<string, unknown>;
    if (
        owner.schemaVersion !== 1 ||
        owner.product !== INSTALLATION_PRODUCT ||
        typeof owner.root !== 'string' ||
        !path.isAbsolute(owner.root) ||
        owner.root.length > 240
    )
        return;
    const work = maintenancePaths(owner.root).work;
    const equal = (a: string, b: string) =>
        process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (
        !equal(path.dirname(path.resolve(root)), work) ||
        !/^(stage|previous)-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            path.basename(root),
        )
    )
        return;
    const recordFile = path.join(root, INSTALLATION_RECORD),
        recordStat = lstatSync(recordFile);
    if (
        !recordStat.isFile() ||
        recordStat.isSymbolicLink() ||
        recordStat.nlink !== 1 ||
        recordStat.size > 16384
    )
        throw Error('Unsafe moved installation identity.');
    const recordBytes = readSetupMetadataBytesSync(recordFile, 16384, physicalFS, recordStat);
    if (recordBytes.length > 16384)
        throw Error('Moved installation identity exceeds startup bound.');
    const record = validateInstallationRecord(JSON.parse(recordBytes.toString('utf8')));
    if (owner.installationId !== record.installationId)
        throw Error('Moved setup ownership identity differs.');
    // Owned stage/previous slots belong to one logical installation and use its existing lock.
    // This only checks bounded local identity; it never hashes payload or changes paths/permissions.
    assertUnlocked(owner.root);
}

const retainedMetadataReads = new Set<object>();
export interface SetupMetadataReadSnapshot {
    phase: string;
    descriptorReturned: boolean;
    closeAcknowledged: boolean;
}
/** Close/open uncertainty is retained, never retried or treated as a missing metadata file. */
export class SetupMetadataReadFailure extends AggregateError {
    constructor(
        errors: unknown[],
        readonly owner: { snapshot(): SetupMetadataReadSnapshot },
    ) {
        super(errors, 'Setup metadata descriptor custody is unacknowledged.', { cause: errors[0] });
    }
}
type MetadataIO = Pick<typeof physicalFS.promises, 'lstat' | 'open'>;
function setupMetadataIdentity(stat: import('node:fs').Stats, bound: number) {
    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size > bound ||
        !Number.isSafeInteger(stat.dev) ||
        stat.dev < 0 ||
        !Number.isSafeInteger(stat.ino) ||
        stat.ino <= 0 ||
        !Number.isInteger(stat.mode) ||
        !Number.isFinite(stat.mtimeMs) ||
        !Number.isFinite(stat.ctimeMs)
    )
        throw Error('Unsafe or oversized setup metadata.');
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink, stat.mode];
}
type MetadataSyncIO = Pick<
    typeof physicalFS,
    'lstatSync' | 'openSync' | 'fstatSync' | 'readSync' | 'closeSync'
>;
/** Startup equivalent of the asynchronous reader. An original path sample can be supplied
 * by an existing presence/unsafe-file guard; the descriptor must still match that exact sample.
 * No pathname readFileSync, writes, retries or inference of Windows path-lock authority. */
export function readSetupMetadataBytesSync(
    file: string,
    bound: number,
    filesystem: MetadataSyncIO = physicalFS,
    original?: import('node:fs').Stats,
): Buffer {
    if (
        !Number.isSafeInteger(bound) ||
        bound <= 0 ||
        bound > MAX_INSTALLATION_MANIFEST_BYTES + 65536
    )
        throw Error('Invalid setup metadata bound.');
    const inspect = filesystem.lstatSync.bind(filesystem),
        acquire = filesystem.openSync.bind(filesystem),
        stat = filesystem.fstatSync.bind(filesystem),
        read = filesystem.readSync.bind(filesystem),
        close = filesystem.closeSync.bind(filesystem);
    const before = setupMetadataIdentity(original ?? inspect(file), bound);
    const lease: {
        fd: unknown;
        phase: string;
        lateFD?: unknown;
        closeReturn?: unknown;
        lateClose?: unknown;
    } = { fd: undefined, phase: 'opening' };
    const owner = Object.freeze({
        snapshot: () =>
            Object.freeze({
                phase: lease.phase,
                descriptorReturned: Number.isSafeInteger(lease.fd) && (lease.fd as number) >= 0,
                closeAcknowledged: lease.phase === 'retired',
            }),
    });
    retainedMetadataReads.add(lease);
    let value: Buffer | undefined,
        primary: unknown,
        failed = false,
        acquired = false;
    try {
        const C = physicalFS.constants;
        lease.fd = acquire(file, C.O_RDONLY | (C.O_NOFOLLOW ?? 0) | (C.O_NONBLOCK ?? 0));
        if (lease.fd && typeof (lease.fd as any).then === 'function')
            void Promise.resolve(lease.fd).then(
                (late) => {
                    lease.lateFD = late;
                },
                () => {},
            );
        if (!Number.isSafeInteger(lease.fd) || (lease.fd as number) < 0)
            throw Error('Unsupported setup metadata descriptor acknowledgement.');
        acquired = true;
        lease.phase = 'reading';
        const fd = lease.fd as number;
        const same = (current: import('node:fs').Stats) => {
            const identity = setupMetadataIdentity(current, bound);
            if (identity.some((part, i) => part !== before[i]))
                throw Error('Setup metadata identity changed during its bounded read.');
        };
        same(stat(fd));
        const buffer = Buffer.alloc(Math.min(65536, before[2] + 1)),
            chunks: Buffer[] = [];
        let bytes = 0;
        for (;;) {
            const length = Math.min(buffer.length, before[2] + 1 - bytes);
            const count = read(fd, buffer, 0, length, bytes);
            if (!Number.isSafeInteger(count) || count < 0 || count > length)
                throw Error('Invalid setup metadata read acknowledgement.');
            if (!count) break;
            bytes += count;
            if (bytes > before[2] || bytes > bound)
                throw Error('Setup metadata grew during its bounded read.');
            chunks.push(Buffer.from(buffer.subarray(0, count)));
        }
        if (bytes !== before[2])
            throw Error('Setup metadata was truncated during its bounded read.');
        same(stat(fd));
        same(inspect(file));
        value = Buffer.concat(chunks);
    } catch (error) {
        primary = error;
        failed = true;
    }
    if (!acquired) {
        lease.phase = 'retained';
        throw new SetupMetadataReadFailure([primary], owner);
    }
    lease.phase = 'closing';
    try {
        const returned: unknown = close(lease.fd as number);
        lease.closeReturn = returned;
        if (returned && typeof (returned as any).then === 'function')
            void Promise.resolve(returned).then(
                (late) => {
                    lease.lateClose = late;
                },
                () => {},
            );
        if (returned !== undefined) throw Error('Unsupported metadata close acknowledgement.');
    } catch (error) {
        lease.phase = 'retained';
        throw new SetupMetadataReadFailure(failed ? [primary, error] : [error], owner);
    }
    lease.phase = 'retired';
    retainedMetadataReads.delete(lease);
    if (failed) throw primary;
    return value!;
}
/** Descriptor-bound bounded read, including a one-byte growth sentinel. No pathname readFile,
 * deletion, retry or permission change. Path samples do not prove atomic Windows reparse exclusion. */
export async function boundedSetupJSON(
    file: string,
    bound = 16384,
    filesystem: MetadataIO = physicalFS.promises,
): Promise<unknown> {
    if (
        !Number.isSafeInteger(bound) ||
        bound <= 0 ||
        bound > MAX_INSTALLATION_MANIFEST_BYTES + 65536
    )
        throw Error('Invalid setup metadata bound.');
    const inspect = filesystem.lstat.bind(filesystem),
        acquire = filesystem.open.bind(filesystem);
    const before = setupMetadataIdentity(await inspect(file), bound);
    const lease: { handle: import('node:fs/promises').FileHandle | null; phase: string } = {
        handle: null,
        phase: 'opening',
    };
    const owner = Object.freeze({
        snapshot: () =>
            Object.freeze({
                phase: lease.phase,
                descriptorReturned: Boolean(lease.handle),
                closeAcknowledged: lease.phase === 'retired',
            }),
    });
    retainedMetadataReads.add(lease);
    let value: unknown,
        primary: unknown,
        failed = false,
        close: (() => Promise<void>) | null = null;
    try {
        const C = physicalFS.constants;
        lease.handle = await acquire(file, C.O_RDONLY | (C.O_NOFOLLOW ?? 0) | (C.O_NONBLOCK ?? 0));
        lease.phase = 'reading';
        const handle = lease.handle,
            stat = handle.stat.bind(handle),
            read = handle.read.bind(handle);
        close = handle.close.bind(handle);
        const same = async (current: Promise<import('node:fs').Stats>) => {
            const identity = setupMetadataIdentity(await current, bound);
            if (identity.some((part, i) => part !== before[i]))
                throw Error('Setup metadata identity changed during its bounded read.');
        };
        await same(stat());
        const buffer = Buffer.alloc(Math.min(65536, before[2] + 1)),
            chunks: Buffer[] = [];
        let bytes = 0;
        for (;;) {
            const length = Math.min(buffer.length, before[2] + 1 - bytes);
            const { bytesRead } = await read(buffer, 0, length, bytes);
            if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length)
                throw Error('Invalid setup metadata read acknowledgement.');
            if (!bytesRead) break;
            bytes += bytesRead;
            if (bytes > before[2] || bytes > bound)
                throw Error('Setup metadata grew during its bounded read.');
            chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        if (bytes !== before[2])
            throw Error('Setup metadata was truncated during its bounded read.');
        await same(stat());
        await same(inspect(file));
        value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                Buffer.concat(chunks),
            ),
        );
    } catch (error) {
        primary = error;
        failed = true;
    }
    if (!lease.handle || !close) {
        lease.phase = 'retained';
        throw new SetupMetadataReadFailure([primary], owner);
    }
    lease.phase = 'closing';
    try {
        if ((await close()) !== undefined)
            throw Error('Unsupported metadata close acknowledgement.');
    } catch (error) {
        lease.phase = 'retained';
        throw new SetupMetadataReadFailure(failed ? [primary, error] : [error], owner);
    }
    lease.phase = 'retired';
    retainedMetadataReads.delete(lease);
    if (failed) throw primary;
    return value;
}
export async function atomicSetupJSON(file: string, value: unknown) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    await assertPlainAncestors(temporary);
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(JSON.stringify(value, null, 2));
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await replaceOwnedMetadata(temporary, file);
    } catch (error) {
        await unlinkOwnedFile(temporary).catch(() => {});
        throw error;
    }
}
/** Small native/renderer-ready identity acknowledgement; never hashes payload at startup. */
export async function acknowledgeSetupBoot(context: {
    root: string;
    installationId: string;
    manifestSHA256: string;
    version: string;
    profile: string;
    nativeExecutable: string;
    processCreationMs: number | null;
}) {
    if (context.processCreationMs === null || !Number.isFinite(context.processCreationMs)) return;
    const files = maintenancePaths(context.root);
    let raw;
    try {
        raw = await boundedSetupJSON(files.journal);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    const journal = raw as Record<string, unknown>;
    if (
        journal.product !== INSTALLATION_PRODUCT ||
        journal.schemaVersion !== 1 ||
        journal.root !== context.root ||
        !['candidate-active', 'candidate-confirmed'].includes(String(journal.phase)) ||
        journal.installationId !== context.installationId ||
        journal.candidateDigest !== context.manifestSHA256 ||
        journal.candidateVersion !== context.version ||
        !/^[a-f0-9-]{36}$/.test(String(journal.transactionId))
    )
        return;
    await atomicSetupJSON(files.ack, {
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        transactionId: journal.transactionId,
        installationId: context.installationId,
        root: context.root,
        manifestSHA256: context.manifestSHA256,
        version: context.version,
        profile: context.profile,
        nativeExecutable: context.nativeExecutable,
        pid: process.pid,
        processCreationMs: context.processCreationMs,
        observedAt: new Date().toISOString(),
        source: 'trusted main-frame readUpdateInfo after native window visibility',
    });
}
