import { physicalFS } from './physical-fs.ts';
import { assertPlainAncestors } from './setup-paths.ts';
import { unlinkOwnedFile, replaceOwnedMetadata } from './setup-paths.ts';
import { createHash, randomUUID } from 'node:crypto';
const { lstatSync, readFileSync } = physicalFS;
const { readFile, open, lstat } = physicalFS.promises;
import path from 'node:path';
import {
    INSTALLATION_PRODUCT,
    INSTALLATION_RECORD,
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
    const ownerBytes = readFileSync(ownerFile);
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
    const recordBytes = readFileSync(recordFile);
    if (recordBytes.length > 16384)
        throw Error('Moved installation identity exceeds startup bound.');
    const record = validateInstallationRecord(JSON.parse(recordBytes.toString('utf8')));
    if (owner.installationId !== record.installationId)
        throw Error('Moved setup ownership identity differs.');
    // Owned stage/previous slots belong to one logical installation and use its existing lock.
    // This only checks bounded local identity; it never hashes payload or changes paths/permissions.
    assertUnlocked(owner.root);
}

export async function boundedSetupJSON(file: string, bound = 16384): Promise<unknown> {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > bound)
        throw Error('Unsafe or oversized setup metadata.');
    const bytes = await readFile(file);
    if (bytes.length > bound) throw Error('Setup metadata exceeds its bound.');
    return JSON.parse(bytes.toString('utf8'));
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
