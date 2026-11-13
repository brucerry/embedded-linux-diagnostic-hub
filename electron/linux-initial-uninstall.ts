import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
    checkedLinuxModelView,
    checkedLinuxModelConfiguration,
    linuxModelReviewSHA256,
    type LinuxModelConfiguration,
    type LinuxModelKernel,
    type LinuxModelLease,
    type LinuxModelView,
    type LinuxModelScope,
    type LinuxModelSource,
} from './linux-transaction-model.ts';
import {
    INSTALLATION_PRODUCT,
    INSTALLATION_RECORD,
    INSTALLATION_MANIFEST,
    MAX_INSTALLATION_MANIFEST_BYTES,
    validateInstallationRecord,
    validateInstallationManifest,
} from '../shared/installation.ts';
import { SETUP_OWNER } from './installation-maintenance.ts';

type Entry = {
    path: string;
    kind: 'file' | 'directory';
    dev: number;
    ino: number;
    uid: number;
    mode: number;
    bytes?: number;
    sha256?: string;
};
type Snapshot = {
    schemaVersion: 1;
    root: string;
    host: LinuxModelConfiguration['host'];
    removalOwner: LinuxModelConfiguration['owner'];
    initial: LinuxModelView;
    entries: Entry[];
    maintenance: Entry;
    originals: { path: string; base64: string; sha256: string }[];
    /** Historical published cleanup stays external and immutable; this never deletes it. */
    confirmedCleanup?: { entries: Entry[]; anchor: Entry };
};
type Progress = {
    schemaVersion: 1;
    snapshotSHA256: string;
    phase:
        | 'prepared'
        | 'root-issued'
        | 'root-retained'
        | 'maintenance-issued'
        | 'deleting'
        | 'complete';
    index: number;
    leaf: 'source' | 'move-issued' | 'staged' | 'unlink-issued';
};
export interface LinuxInitialUninstallIO {
    configuration(): LinuxModelConfiguration;
    initial(): Promise<{
        configuration: LinuxModelConfiguration;
        scope: LinuxModelScope;
        view: LinuxModelView;
    }>;
    kernel: LinuxModelKernel;
    source(): LinuxModelSource;
    activity(paths: string[]): Record<string, 'inactive' | 'active' | 'unknown'>;
    stat(file: string): Stats;
    maybe(file: string): Stats | null;
    names(directory: string, limit: number): string[];
    read(file: string, cap: number, privateFile?: boolean): Buffer;
    hash(file: string, size: number): string;
    mkdir(directory: string): void;
    write(file: string, bytes: Buffer, exclusive: boolean, prior?: Buffer): void;
    move(source: string, destination: string, expected: Entry): void;
    remove(disposal: string, expected: Entry): void;
    available(): boolean;
    diagnostics(): unknown;
    healthy(): void;
    knownRelease(): boolean;
    reserved(): void;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const metadata = [INSTALLATION_RECORD, INSTALLATION_MANIFEST, SETUP_OWNER];
const SNAPSHOT_CAP = MAX_INSTALLATION_MANIFEST_BYTES * 6 + 131072;
const retained = new Set<object>();
const owners = new WeakMap<object, { io: LinuxInitialUninstallIO; state(): unknown }>();
function fields(value: unknown, keys: string[]): asserts value is Record<string, any> {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== keys.length ||
        Object.keys(value).some((key) => !keys.includes(key))
    )
        throw Error('LINUX_UNINSTALL_GRAMMAR');
}
function sameEntry(info: Stats, entry: Entry) {
    return (
        !info.isSymbolicLink() &&
        info.dev === entry.dev &&
        info.ino === entry.ino &&
        info.uid === entry.uid &&
        info.mode === entry.mode &&
        (entry.kind === 'file'
            ? info.isFile() && info.nlink === 1 && info.size === entry.bytes
            : info.isDirectory() && info.nlink > 0)
    );
}
function entry(relative: string, info: Stats, kind: Entry['kind'], sha256?: string): Entry {
    if (
        info.isSymbolicLink() ||
        !Number.isSafeInteger(info.dev) ||
        info.dev < 0 ||
        !Number.isSafeInteger(info.ino) ||
        info.ino <= 0 ||
        (info.mode & 0o7022) !== 0 ||
        (kind === 'file' && (!info.isFile() || info.nlink !== 1)) ||
        (kind === 'directory' && !info.isDirectory())
    )
        throw Error('LINUX_UNINSTALL_ENTRY');
    return {
        path: relative,
        kind,
        dev: info.dev,
        ino: info.ino,
        uid: info.uid,
        mode: info.mode,
        ...(kind === 'file' ? { bytes: info.size, sha256 } : {}),
    };
}

function originalJournal(view: LinuxModelView) {
    const journal = view.journal ?? view.history?.completed?.journal,
        original = view.journal ? view.history?.journalOriginal : view.history?.completed;
    if (!journal || !original) throw Error('LINUX_UNINSTALL_INITIAL_NO_MENU_REQUIRED');
    return {
        journal,
        original,
        name: view.journal ? 'journal.json' : 'completed-journal.json',
    };
}

/** Supported no-menu removal: an initial installation or the first confirmed successor
 * with complete published predecessor cleanup and no remaining prior payload.
 * This never promotes a pending update to an uninstallable committed installation. */
function initial(view: LinuxModelView, configuration: LinuxModelConfiguration) {
    checkedLinuxModelView(view, configuration);
    const current = view.root,
        { journal } = originalJournal(view);
    if (
        configuration.menu ||
        current?.menu ||
        !current ||
        view.stage ||
        view.previous ||
        Object.values(view.activity).some((state) => state !== 'inactive') ||
        journal.transactionId !== current.transactionId ||
        journal.candidateSHA256 !== current.verifiedManifestSHA256 ||
        (view.journal
            ? Boolean(view.history?.completed)
            : view.history?.journalOriginal !== null) ||
        view.history?.lineage?.length
    )
        throw Error('LINUX_UNINSTALL_INITIAL_NO_MENU_REQUIRED');
    if (journal.phase === 'candidate-confirmed') {
        const cleanup = view.history?.cleanup;
        if (
            journal.previousSHA256 === null ||
            !cleanup ||
            cleanup.configuration.transactionId !== journal.transactionId ||
            cleanup.configuration.installationId !== current.installationId ||
            cleanup.progress.phase !== 'complete' ||
            cleanup.progress.index !== cleanup.entries ||
            cleanup.progress.leaf !== 'source' ||
            cleanup.seal?.state !== 'published' ||
            cleanup.initial.history?.cleanup ||
            cleanup.initial.history?.lineage?.length ||
            cleanup.initial.journal?.transactionId !== journal.transactionId ||
            cleanup.initial.journal.phase !== 'candidate-active' ||
            cleanup.initial.journal.previousSHA256 !== journal.previousSHA256 ||
            cleanup.initial.root?.verifiedManifestSHA256 !== current.verifiedManifestSHA256 ||
            cleanup.initial.root.installationId !== current.installationId ||
            cleanup.initial.root.profile !== current.profile
        )
            throw Error('LINUX_UNINSTALL_CONFIRMED_CLEANUP_REQUIRED');
        return true;
    }
    if (
        journal.phase !== 'candidate-active' ||
        journal.previousSHA256 !== null ||
        view.history?.cleanup
    )
        throw Error('LINUX_UNINSTALL_INITIAL_NO_MENU_REQUIRED');
    return false;
}

/** Concrete current-payload removal for the supported no-menu states. Mandatory ports are the existing guarded native backend,
 * never a default filesystem or evidence flag. A private disposal slot plus cooperative root
 * reservation is the threat contract; Linux has no atomic compare-and-unlink syscall. */
export function createLinuxInitialUninstall(io: LinuxInitialUninstallIO) {
    const configuration = clone(io.configuration()),
        root = configuration.root;
    const work = path.posix.join(
        path.posix.dirname(root),
        '.DiagnosticHub-maintenance-' + hash(root).slice(0, 20),
    );
    const removal = work + '-uninstall',
        payload = removal + '/payload',
        disposal = removal + '/disposal';
    const snapshotFile = removal + '/snapshot.json',
        progressFile = removal + '/state.json';
    const savedMaintenance = removal + '/original-maintenance';
    let used = false,
        lease: LinuxModelLease | null = null,
        primarySet = false,
        primary: unknown;
    let pending: string | null = null,
        lastReturn: unknown;
    const owner = Object.freeze({});
    owners.set(owner, { io, state: () => ({ lease, primary, primarySet, pending, lastReturn }) });
    retained.add(owner); // Retains the actual closure/resources through the private owner record.
    const adopt = async <T>(name: string, operation: () => Promise<T> | T) => {
        pending = name;
        try {
            const value = await operation();
            lastReturn = value;
            pending = null;
            return value;
        } catch (error) {
            if (!primarySet) {
                primarySet = true;
                primary = error;
            }
            throw error;
        }
    };
    const source = (snapshot: Snapshot) => {
        const observed = io.source();
        if (
            JSON.stringify(snapshot.host) !== JSON.stringify(io.configuration().host) ||
            observed.verifiedManifestSHA256 !== snapshot.initial.source.verifiedManifestSHA256
        )
            throw Error('LINUX_UNINSTALL_SOURCE_CHANGED');
    };
    const checkItem = (file: string, wanted: Entry, bytes = true) => {
        const info = io.stat(file);
        if (
            !sameEntry(info, wanted) ||
            info.uid !== configuration.host.uid ||
            (bytes && wanted.kind === 'file' && io.hash(file, wanted.bytes!) !== wanted.sha256)
        )
            throw Error('LINUX_UNINSTALL_CHANGED');
    };
    const parse = <T>(file: string, cap: number): { value: T; raw: Buffer } => {
        const raw = io.read(file, cap),
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        if (!Buffer.from(JSON.stringify(value)).equals(raw))
            throw Error('LINUX_UNINSTALL_PARTIAL_STATE');
        return { value, raw };
    };
    const snapshotCheck = (snapshot: Snapshot, liveSource = true) => {
        fields(snapshot, [
            'schemaVersion',
            'root',
            'host',
            'removalOwner',
            'initial',
            'entries',
            'maintenance',
            'originals',
            ...(Object.hasOwn(snapshot, 'confirmedCleanup') ? ['confirmedCleanup'] : []),
        ]);
        if (
            snapshot.schemaVersion !== 1 ||
            snapshot.root !== root ||
            !Array.isArray(snapshot.entries) ||
            snapshot.entries.length > 20010 ||
            !snapshot.entries.length ||
            !Array.isArray(snapshot.originals) ||
            snapshot.originals.length !== 3
        )
            throw Error('LINUX_UNINSTALL_SNAPSHOT');
        const selected = checkedLinuxModelConfiguration({
            ...configuration,
            // The installer journal's actor can differ from the actual remover. Preserve the
            // remover's own historical host/runtime pair; live IO/lease still uses the current owner.
            host: snapshot.host,
            owner: snapshot.removalOwner,
            installationId: snapshot.initial.root!.installationId,
            transactionId: originalJournal(snapshot.initial).journal.transactionId,
        });
        const confirmed = initial(snapshot.initial, selected);
        if (confirmed !== Object.hasOwn(snapshot, 'confirmedCleanup'))
            throw Error('LINUX_UNINSTALL_CONFIRMED_SNAPSHOT_REQUIRED');
        const originals = new Map<string, Buffer>();
        for (const original of snapshot.originals) {
            fields(original, ['path', 'base64', 'sha256']);
            const bytes = Buffer.from(original.base64, 'base64');
            if (
                !metadata.includes(original.path) ||
                originals.has(original.path) ||
                !bytes.length ||
                bytes.toString('base64') !== original.base64 ||
                hash(bytes) !== original.sha256
            )
                throw Error('LINUX_UNINSTALL_ORIGINAL');
            originals.set(original.path, bytes);
        }
        const decode = (name: string) =>
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(originals.get(name)!));
        const release = validateInstallationManifest(decode(INSTALLATION_MANIFEST));
        const record = validateInstallationRecord(decode(INSTALLATION_RECORD));
        const actualOwner = decode(SETUP_OWNER),
            current = snapshot.initial.root!;
        fields(actualOwner, [
            'schemaVersion',
            'product',
            'root',
            'installationId',
            'transactionId',
            'options',
            'integrations',
        ]);
        fields(actualOwner.options, ['startMenu', 'desktop', 'launch']);
        if (
            JSON.stringify(release) !== JSON.stringify(current.manifest) ||
            hash(originals.get(INSTALLATION_MANIFEST)!) !== current.verifiedManifestSHA256 ||
            record.manifestSHA256 !== current.verifiedManifestSHA256 ||
            record.profile !== 'dedicated' ||
            record.installationId !== current.installationId ||
            actualOwner.schemaVersion !== 1 ||
            actualOwner.product !== INSTALLATION_PRODUCT ||
            actualOwner.root !== root ||
            actualOwner.installationId !== current.installationId ||
            actualOwner.transactionId !== current.transactionId ||
            !Array.isArray(actualOwner.integrations) ||
            actualOwner.integrations.length ||
            Object.values(actualOwner.options).some((value) => value !== false)
        )
            throw Error('LINUX_UNINSTALL_ORIGINAL_BINDING');
        fields(snapshot.maintenance, ['path', 'kind', 'dev', 'ino', 'uid', 'mode']);
        if (
            snapshot.maintenance.path !== '' ||
            snapshot.maintenance.kind !== 'directory' ||
            snapshot.maintenance.uid !== configuration.host.uid ||
            !Number.isSafeInteger(snapshot.maintenance.dev) ||
            snapshot.maintenance.dev < 0 ||
            !Number.isSafeInteger(snapshot.maintenance.ino) ||
            snapshot.maintenance.ino <= 0 ||
            (snapshot.maintenance.mode & 0o7777) !== 0o700
        )
            throw Error('LINUX_UNINSTALL_MAINTENANCE_IDENTITY');
        const required = new Map(
            snapshot.initial.root!.manifest.files.map((file) => [file.path, file]),
        );
        const dirs = new Set<string>(['']);
        for (const name of [...required.keys(), ...metadata]) {
            let parent = path.posix.dirname(name);
            while (parent !== '.') {
                dirs.add(parent);
                parent = path.posix.dirname(parent);
            }
        }
        const names = new Set<string>();
        for (const item of snapshot.entries) {
            fields(item, [
                'path',
                'kind',
                'dev',
                'ino',
                'uid',
                'mode',
                ...(item.kind === 'file' ? ['bytes', 'sha256'] : []),
            ]);
            if (
                typeof item.path !== 'string' ||
                names.has(item.path) ||
                item.uid !== configuration.host.uid ||
                !Number.isSafeInteger(item.dev) ||
                item.dev < 0 ||
                !Number.isSafeInteger(item.ino) ||
                item.ino <= 0 ||
                !Number.isInteger(item.mode) ||
                (item.mode & 0o7022) !== 0
            )
                throw Error('LINUX_UNINSTALL_SNAPSHOT_ENTRY');
            names.add(item.path);
            if (item.kind === 'directory') {
                if (!dirs.delete(item.path)) throw Error('LINUX_UNINSTALL_DIRECTORY_PLAN');
            } else if (item.kind === 'file') {
                const known = required.get(item.path),
                    original = originals.get(item.path);
                if (
                    known
                        ? known.kind !== 'file' ||
                          known.bytes !== item.bytes ||
                          known.sha256 !== item.sha256
                        : !original ||
                          original.length !== item.bytes ||
                          hash(original) !== item.sha256
                )
                    throw Error('LINUX_UNINSTALL_FILE_PLAN');
                required.delete(item.path);
            } else throw Error('LINUX_UNINSTALL_ENTRY_KIND');
        }
        if (dirs.size || required.size || !metadata.every((name) => names.has(name)))
            throw Error('LINUX_UNINSTALL_INCOMPLETE_PLAN');
        const order = [...snapshot.entries].sort((a, b) =>
            a.kind !== b.kind
                ? a.kind === 'file'
                    ? -1
                    : 1
                : a.kind === 'file'
                  ? compare(a.path, b.path)
                  : b.path.split('/').length - a.path.split('/').length || compare(b.path, a.path),
        );
        // Empty root path is explicitly last, not tied with a top-level directory.
        const withoutRoot = order.filter((item) => item.path !== '');
        const rootEntry = snapshot.entries.find((item) => item.path === '')!;
        if (JSON.stringify([...withoutRoot, rootEntry]) !== JSON.stringify(snapshot.entries))
            throw Error('LINUX_UNINSTALL_ORDER');
        if (
            snapshot.host.uid !== configuration.host.uid ||
            snapshot.host.home !== configuration.host.home
        )
            throw Error('LINUX_UNINSTALL_HOST_CHANGED');
        if (liveSource) source(snapshot);
        if (confirmed) confirmedShape(snapshot);
    };
    const ledgerFiles = [
        'original-completed-journal.json',
        'original-journal.json',
        'seal-intent.json',
        'snapshot.json',
        'state.json',
        'unconfirmed-journal.json',
    ];
    const sameRecorded = (a: Record<string, unknown>, b: Entry) =>
        (['kind', 'dev', 'ino', 'uid', 'mode', 'bytes', 'sha256'] as const).every(
            (key) => a[key] === b[key],
        );
    const confirmedShape = (snapshot: Snapshot) => {
        const retained = snapshot.confirmedCleanup!;
        fields(retained, ['entries', 'anchor']);
        if (!Array.isArray(retained.entries) || retained.entries.length !== ledgerFiles.length + 2)
            throw Error('LINUX_UNINSTALL_CONFIRMED_INVENTORY');
        const names = [...ledgerFiles, 'disposal', ''],
            seen = new Set<string>(),
            cleanup = snapshot.initial.history!.cleanup!,
            prior = cleanup.initial.history!,
            journal = originalJournal(snapshot.initial);
        for (const [index, item] of retained.entries.entries()) {
            const file = index < ledgerFiles.length;
            fields(item, [
                'path',
                'kind',
                'dev',
                'ino',
                'uid',
                'mode',
                ...(file ? ['bytes', 'sha256'] : []),
            ]);
            const key = item.dev + ':' + item.ino;
            if (
                item.path !== names[index] ||
                item.kind !== (file ? 'file' : 'directory') ||
                !Number.isSafeInteger(item.dev) ||
                item.dev < 0 ||
                !Number.isSafeInteger(item.ino) ||
                item.ino <= 0 ||
                seen.has(key) ||
                item.uid !== configuration.host.uid ||
                item.mode !== (file ? 0o100600 : 0o40700) ||
                (file &&
                    (!Number.isSafeInteger(item.bytes) ||
                        item.bytes! < 1 ||
                        item.bytes! > SNAPSHOT_CAP ||
                        typeof item.sha256 !== 'string' ||
                        !/^[a-f0-9]{64}$/.test(item.sha256)))
            )
                throw Error('LINUX_UNINSTALL_CONFIRMED_ENTRY');
            seen.add(key);
        }
        const expected = new Map([
            ['snapshot.json', cleanup.snapshotSHA256],
            ['seal-intent.json', cleanup.seal!.intentSHA256],
            ['original-journal.json', prior.journalOriginal!.sha256],
            ['unconfirmed-journal.json', prior.journalOriginal!.sha256],
            ['original-completed-journal.json', prior.completed!.sha256],
        ]);
        for (const item of retained.entries)
            if (expected.has(item.path) && item.sha256 !== expected.get(item.path))
                throw Error('LINUX_UNINSTALL_CONFIRMED_ORIGINAL');
        const anchor = retained.anchor;
        fields(anchor, ['path', 'kind', 'dev', 'ino', 'uid', 'mode', 'bytes', 'sha256']);
        if (
            anchor.path !== journal.name ||
            anchor.kind !== 'file' ||
            anchor.mode !== 0o100600 ||
            anchor.uid !== configuration.host.uid ||
            !Number.isSafeInteger(anchor.dev) ||
            anchor.dev < 0 ||
            !Number.isSafeInteger(anchor.ino) ||
            anchor.ino <= 0 ||
            seen.has(anchor.dev + ':' + anchor.ino) ||
            anchor.bytes !== Buffer.from(journal.original.base64, 'base64').length ||
            anchor.sha256 !== journal.original.sha256
        )
            throw Error('LINUX_UNINSTALL_CONFIRMED_ANCHOR');
    };
    const confirmedReadback = (snapshot: Snapshot, maintenanceDirectory: string) => {
        if (!snapshot.confirmedCleanup) return;
        confirmedShape(snapshot);
        const retained = snapshot.confirmedCleanup,
            cleanup = snapshot.initial.history!.cleanup!,
            ledger = work + '-finalize-' + cleanup.configuration.transactionId,
            allowed = [...ledgerFiles, 'disposal'].sort();
        if (
            JSON.stringify(io.names(ledger, allowed.length + 1).sort()) !==
                JSON.stringify(allowed) ||
            io.names(ledger + '/disposal', 1).length
        )
            throw Error('LINUX_UNINSTALL_CONFIRMED_FOREIGN_CONTENT');
        for (const item of retained.entries)
            checkItem(ledger + (item.path ? '/' + item.path : ''), item);
        const readOriginal = (name: string, cap = 8192) => {
            const expected = retained.entries.find((item) => item.path === name)!,
                raw = io.read(ledger + '/' + name, cap);
            if (raw.length !== expected.bytes || hash(raw) !== expected.sha256)
                throw Error('LINUX_UNINSTALL_CONFIRMED_ORIGINAL_CHANGED');
            checkItem(ledger + '/' + name, expected);
            return raw;
        };
        const decode = (raw: Buffer) => {
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
            if (!Buffer.from(JSON.stringify(value)).equals(raw))
                throw Error('LINUX_UNINSTALL_CONFIRMED_PARTIAL_RECORD');
            return value;
        };
        const originalSnapshot = decode(readOriginal('snapshot.json', SNAPSHOT_CAP)),
            state = decode(readOriginal('state.json')),
            intent = decode(readOriginal('seal-intent.json'));
        fields(originalSnapshot, [
            'schemaVersion',
            'configuration',
            'initial',
            'entries',
            'originals',
        ]);
        if (
            originalSnapshot.schemaVersion !== 1 ||
            JSON.stringify(originalSnapshot.configuration) !==
                JSON.stringify(cleanup.configuration) ||
            linuxModelReviewSHA256(originalSnapshot.initial) !==
                linuxModelReviewSHA256(cleanup.initial) ||
            !Array.isArray(originalSnapshot.entries) ||
            originalSnapshot.entries.length !== cleanup.entries
        )
            throw Error('LINUX_UNINSTALL_CONFIRMED_SNAPSHOT_CHANGED');
        fields(state, ['schemaVersion', 'snapshotSHA256', 'phase', 'index', 'leaf']);
        if (
            state.schemaVersion !== 1 ||
            state.snapshotSHA256 !== cleanup.snapshotSHA256 ||
            state.phase !== 'complete' ||
            state.index !== cleanup.entries ||
            state.leaf !== 'source'
        )
            throw Error('LINUX_UNINSTALL_CONFIRMED_INCOMPLETE');
        fields(intent, [
            'schemaVersion',
            'root',
            'installationId',
            'transactionId',
            'uid',
            'snapshotSHA256',
            'original',
            'staged',
        ]);
        const journal = originalJournal(snapshot.initial);
        if (
            intent.schemaVersion !== 1 ||
            intent.root !== root ||
            intent.uid !== configuration.host.uid ||
            intent.installationId !== snapshot.initial.root!.installationId ||
            intent.transactionId !== journal.journal.transactionId ||
            intent.snapshotSHA256 !== cleanup.snapshotSHA256
        )
            throw Error('LINUX_UNINSTALL_CONFIRMED_INTENT_CHANGED');
        fields(intent.original, ['path', 'kind', 'dev', 'ino', 'uid', 'mode', 'bytes', 'sha256']);
        fields(intent.staged, ['path', 'kind', 'dev', 'ino', 'uid', 'mode', 'bytes', 'sha256']);
        const old = retained.entries.find((item) => item.path === 'unconfirmed-journal.json')!;
        if (
            intent.original.path !== 'journal.json' ||
            intent.staged.path !== 'confirmed-journal.json' ||
            !sameRecorded(intent.original, old) ||
            !sameRecorded(intent.staged, retained.anchor)
        )
            throw Error('LINUX_UNINSTALL_CONFIRMED_INTENT_ANCHOR');
        const before = cleanup.initial.history!;
        if (
            readOriginal('original-journal.json').toString('base64') !==
                before.journalOriginal!.base64 ||
            readOriginal('unconfirmed-journal.json').toString('base64') !==
                before.journalOriginal!.base64 ||
            readOriginal('original-completed-journal.json').toString('base64') !==
                before.completed!.base64
        )
            throw Error('LINUX_UNINSTALL_CONFIRMED_HISTORY_CHANGED');
        checkItem(maintenanceDirectory + '/' + journal.name, retained.anchor);
        if (
            io.read(maintenanceDirectory + '/' + journal.name, 8192).toString('base64') !==
            journal.original.base64
        )
            throw Error('LINUX_UNINSTALL_CONFIRMED_ANCHOR_CHANGED');
    };
    const captureConfirmed = (view: LinuxModelView) => {
        const cleanup = view.history!.cleanup!,
            ledger = work + '-finalize-' + cleanup.configuration.transactionId,
            journal = originalJournal(view),
            entries = ledgerFiles.map((name) => {
                const file = ledger + '/' + name,
                    info = io.stat(file);
                return entry(name, info, 'file', io.hash(file, info.size));
            });
        entries.push(entry('disposal', io.stat(ledger + '/disposal'), 'directory'));
        entries.push(entry('', io.stat(ledger), 'directory'));
        const file = work + '/' + journal.name,
            info = io.stat(file);
        return { entries, anchor: entry(journal.name, info, 'file', io.hash(file, info.size)) };
    };
    const activity = (paths = [payload, disposal]) => {
        if (Object.values(io.activity(paths)).some((value) => value !== 'inactive'))
            throw Error('LINUX_UNINSTALL_BUSY_OR_UNKNOWN');
    };
    const makeSnapshot = async (): Promise<Snapshot> => {
        const prepared = await io.initial();
        const confirmed = initial(prepared.view, prepared.configuration);
        const files = prepared.view.root!.manifest.files.map((file) => file.path);
        const originals = metadata.map((name) => {
            const bytes = io.read(root + '/' + name, MAX_INSTALLATION_MANIFEST_BYTES, false);
            return { path: name, base64: bytes.toString('base64'), sha256: hash(bytes) };
        });
        const allFiles = [...files, ...metadata].sort(),
            directories = new Set<string>(['']);
        for (const name of allFiles) {
            let p = path.posix.dirname(name);
            while (p !== '.') {
                directories.add(p);
                p = path.posix.dirname(p);
            }
        }
        const entries = allFiles.map((name) => {
            const info = io.stat(root + '/' + name);
            return entry(name, info, 'file', io.hash(root + '/' + name, info.size));
        });
        for (const name of [...directories]
            .filter(Boolean)
            .sort((a, b) => b.split('/').length - a.split('/').length || compare(b, a)))
            entries.push(entry(name, io.stat(root + '/' + name), 'directory'));
        entries.push(entry('', io.stat(root), 'directory'));
        const snapshot: Snapshot = {
            schemaVersion: 1,
            root,
            host: clone(prepared.configuration.host),
            removalOwner: clone(prepared.configuration.owner),
            initial: clone(prepared.view),
            entries,
            maintenance: entry('', io.stat(work), 'directory'),
            originals,
            ...(confirmed ? { confirmedCleanup: captureConfirmed(prepared.view) } : {}),
        };
        const fresh = await io.initial();
        if (linuxModelReviewSHA256(fresh.view) !== linuxModelReviewSHA256(prepared.view))
            throw Error('LINUX_UNINSTALL_REVIEW_CHANGED');
        snapshotCheck(snapshot);
        confirmedReadback(snapshot, work);
        return snapshot;
    };
    const validateProgress = (progress: Progress, snapshot: Snapshot, raw: Buffer) => {
        fields(progress, ['schemaVersion', 'snapshotSHA256', 'phase', 'index', 'leaf']);
        if (
            progress.schemaVersion !== 1 ||
            progress.snapshotSHA256 !== hash(raw) ||
            ![
                'prepared',
                'root-issued',
                'root-retained',
                'maintenance-issued',
                'deleting',
                'complete',
            ].includes(progress.phase) ||
            !['source', 'move-issued', 'staged', 'unlink-issued'].includes(progress.leaf) ||
            !Number.isInteger(progress.index) ||
            progress.index < 0 ||
            progress.index > snapshot.entries.length ||
            (progress.index === snapshot.entries.length && progress.leaf !== 'source') ||
            (progress.phase !== 'deleting' &&
                progress.phase !== 'complete' &&
                (progress.index !== 0 || progress.leaf !== 'source')) ||
            (progress.phase === 'complete' &&
                (progress.index !== snapshot.entries.length || progress.leaf !== 'source'))
        )
            throw Error('LINUX_UNINSTALL_PROGRESS');
    };
    const remaining = (snapshot: Snapshot, progress: Progress, hashes: boolean) => {
        const current = snapshot.entries[progress.index];
        const staged = io.maybe(disposal + '/entry');
        const from = current ? io.maybe(payload + (current.path ? '/' + current.path : '')) : null;
        if (
            current &&
            (progress.leaf === 'source'
                ? !from || staged
                : progress.leaf === 'move-issued'
                  ? Boolean(from) === Boolean(staged)
                  : progress.leaf === 'staged'
                    ? from || !staged
                    : Boolean(from))
        )
            throw Error('LINUX_UNINSTALL_LEAF_BOUNDARY');
        if (staged && (!current || progress.leaf === 'source'))
            throw Error('LINUX_UNINSTALL_FOREIGN_DISPOSAL');
        if (staged) checkItem(disposal + '/entry', current, hashes);
        const wanted = new Map(
            snapshot.entries.slice(progress.index).map((item) => [item.path, item]),
        );
        const seen = new Set<string>();
        if (io.maybe(payload)) {
            const visit = (relative: string) => {
                const file = payload + (relative ? '/' + relative : ''),
                    item = wanted.get(relative);
                if (!item) throw Error('LINUX_UNINSTALL_FOREIGN_CONTENT');
                checkItem(file, item, hashes);
                seen.add(relative);
                if (item.kind === 'directory')
                    for (const name of io.names(file, 20010))
                        visit(relative ? relative + '/' + name : name);
            };
            visit('');
        }
        for (const [name, item] of wanted)
            if (!seen.has(name)) {
                if (item !== current || (!staged && progress.leaf !== 'unlink-issued'))
                    throw Error('LINUX_UNINSTALL_MISSING_ENTRY');
            }
        if (staged && current && seen.has(current.path))
            throw Error('LINUX_UNINSTALL_DOUBLE_ENTRY');
        if (io.names(disposal, 2).some((name) => name !== 'entry'))
            throw Error('LINUX_UNINSTALL_FOREIGN_DISPOSAL');
    };
    const stored = (hashes = true, completedOnly = false, location = removal) => {
        const payload = location + '/payload',
            disposal = location + '/disposal',
            savedMaintenance = location + '/original-maintenance';
        const names = io.names(location, 6);
        if (
            names.some(
                (name) =>
                    ![
                        'snapshot.json',
                        'state.json',
                        'payload',
                        'disposal',
                        'original-maintenance',
                    ].includes(name),
            )
        )
            throw Error('LINUX_UNINSTALL_FOREIGN_STATE');
        const saved = parse<Snapshot>(location + '/snapshot.json', SNAPSHOT_CAP);
        snapshotCheck(saved.value, !completedOnly);
        const state = parse<Progress>(location + '/state.json', 8192);
        validateProgress(state.value, saved.value, saved.raw);
        if (completedOnly && state.value.phase !== 'complete')
            throw Error('LINUX_UNINSTALL_PENDING');
        activity([payload, disposal]);
        const phase = state.value.phase,
            liveRoot = io.maybe(root),
            quarantined = io.maybe(payload);
        const rootExpected = saved.value.entries.at(-1)!;
        if (phase === 'prepared' || phase === 'root-issued') {
            if (Boolean(liveRoot) === Boolean(quarantined) || (phase === 'prepared' && !liveRoot))
                throw Error('LINUX_UNINSTALL_ROOT_BOUNDARY');
            checkItem(liveRoot ? root : payload, rootExpected, false);
        } else if (liveRoot && !(completedOnly && location !== removal))
            throw Error('LINUX_UNINSTALL_FOREIGN_ROOT');
        else if (phase === 'root-retained' || phase === 'maintenance-issued') {
            if (!quarantined) throw Error('LINUX_UNINSTALL_MISSING_PAYLOAD');
            checkItem(payload, rootExpected, false);
        }
        const old = completedOnly && location !== removal ? null : io.maybe(work),
            kept = io.maybe(savedMaintenance);
        if (
            phase === 'prepared' ||
            phase === 'root-issued' ||
            phase === 'root-retained' ||
            phase === 'maintenance-issued'
        ) {
            if (Boolean(old) === Boolean(kept) || (phase !== 'maintenance-issued' && !old))
                throw Error('LINUX_UNINSTALL_MAINTENANCE_BOUNDARY');
        } else if (old || !kept) throw Error('LINUX_UNINSTALL_FOREIGN_MAINTENANCE');
        const original = originalJournal(saved.value.initial),
            journalPath = (old ? work : savedMaintenance) + '/' + original.name;
        checkItem(old ? work : savedMaintenance, saved.value.maintenance, false);
        if (
            io.names(old ? work : savedMaintenance, 2).join() !== original.name ||
            io.read(journalPath, 8192).toString('base64') !== original.original.base64
        )
            throw Error('LINUX_UNINSTALL_ORIGINAL_JOURNAL_CHANGED');
        confirmedReadback(saved.value, old ? work : savedMaintenance);
        if (phase === 'deleting') remaining(saved.value, state.value, hashes);
        if (phase === 'complete' && (quarantined || io.names(disposal, 1).length))
            throw Error('LINUX_UNINSTALL_INCOMPLETE');
        return {
            kind: 'resume' as const,
            snapshot: saved.value,
            progress: state.value,
            rawState: state.raw,
        };
    };
    const inspect = async (hashes = true) => {
        if (!io.available()) throw Error('LINUX_UNINSTALL_NATIVE_CAPABILITY_REQUIRED');
        if (!io.maybe(removal)) return { kind: 'fresh' as const, snapshot: await makeSnapshot() };
        return stored(hashes);
    };
    const reviewHash = (value: unknown) => hash(JSON.stringify(value));
    let completion: ReturnType<typeof stored> | undefined,
        archive: string | null = null;
    const completed = () => {
        const current = stored(true, true, archive ?? removal);
        if (completion && reviewHash(current) !== reviewHash(completion))
            throw Error('LINUX_UNINSTALL_COMPLETION_CHANGED');
        completion = current;
        return clone(current);
    };
    return Object.freeze({
        completed,
        archiveCompleted() {
            if (configuration.action !== 'install' || !completion || archive)
                throw Error('LINUX_UNINSTALL_ARCHIVE_UNPREPARED');
            io.reserved();
            completed();
            const target = work + '-removed-' + completion.snapshot.initial.root!.installationId;
            if (io.maybe(target)) throw Error('LINUX_UNINSTALL_ARCHIVE_EXISTS');
            const expected = entry('', io.stat(removal), 'directory');
            io.move(removal, target, expected);
            archive = target;
            completed();
            return target;
        },
        inspect: () => adopt('inspect', () => inspect()),
        reviewHash,
        describe(review: Awaited<ReturnType<typeof inspect>>) {
            return (
                'Diagnostic Hub Linux setup\nOperation: uninstall-current\nApplication: ' +
                root +
                '\nInstalled version: ' +
                review.snapshot.initial.root!.manifest.version +
                '\nSettings/reports retained: ' +
                review.snapshot.initial.root!.profile +
                '\nOnly this current no-menu payload is removed. ' +
                (review.snapshot.confirmedCleanup
                    ? 'Its predecessor cleanup is complete and published. The external cleanup ledger and original transaction records are retained. '
                    : 'Original transaction records are retained, including any completed initial Finalize journal. ') +
                'Prior recovery payloads are not removed.'
            );
        },
        async run(review: Awaited<ReturnType<typeof inspect>>, consent: boolean) {
            if (configuration.action !== 'uninstall-current')
                throw Error('LINUX_UNINSTALL_SELECTION');
            if (used) throw Error('LINUX_UNINSTALL_CONSUMED');
            used = true;
            if (consent !== true) throw Error('LINUX_UNINSTALL_CONSENT');
            let complete = false;
            try {
                lease = await adopt('reserve', () =>
                    io.kernel.acquire({
                        root,
                        uid: configuration.host.uid,
                        key: 'dh-linux-' + hash(configuration.host.uid + '\0' + root),
                        owner: configuration.owner,
                    }),
                );
                if (!lease) return { status: 'refused' as const, owner };
                await io.kernel.current(lease.handle);
                let actual = await inspect();
                if (reviewHash(actual) !== reviewHash(review))
                    throw Error('LINUX_UNINSTALL_REVIEW_CHANGED');
                const snapshot = actual.snapshot;
                let progress: Progress, rawState: Buffer;
                if (actual.kind === 'fresh') {
                    io.mkdir(removal);
                    io.mkdir(disposal);
                    const raw = Buffer.from(JSON.stringify(snapshot));
                    if (raw.length > SNAPSHOT_CAP) throw Error('LINUX_UNINSTALL_SNAPSHOT_BOUND');
                    io.write(snapshotFile, raw, true);
                    progress = {
                        schemaVersion: 1,
                        snapshotSHA256: hash(raw),
                        phase: 'prepared',
                        index: 0,
                        leaf: 'source',
                    };
                    rawState = Buffer.from(JSON.stringify(progress));
                    io.write(progressFile, rawState, true);
                } else {
                    progress = actual.progress;
                    rawState = actual.rawState;
                }
                const save = (next: Progress) => {
                    const bytes = Buffer.from(JSON.stringify(next));
                    io.write(progressFile, bytes, false, rawState);
                    progress = next;
                    rawState = bytes;
                };
                const guard = async () => {
                    await io.kernel.current(lease!.handle);
                    await inspect(false);
                };
                if (progress.phase === 'prepared' || progress.phase === 'root-issued') {
                    await guard();
                    if (io.maybe(root)) {
                        save({ ...progress, phase: 'root-issued' });
                        await guard();
                        io.move(root, payload, snapshot.entries.at(-1)!);
                    }
                    save({ ...progress, phase: 'root-retained' });
                }
                if (progress.phase === 'root-retained' || progress.phase === 'maintenance-issued') {
                    await guard();
                    if (io.maybe(work)) {
                        save({ ...progress, phase: 'maintenance-issued' });
                        await guard();
                        io.move(work, savedMaintenance, snapshot.maintenance);
                    }
                    save({ ...progress, phase: 'deleting' });
                }
                while (progress.phase === 'deleting' && progress.index < snapshot.entries.length) {
                    await guard();
                    const item = snapshot.entries[progress.index],
                        from = payload + (item.path ? '/' + item.path : '');
                    if (io.maybe(from)) {
                        checkItem(from, item);
                        if (item.kind === 'directory' && io.names(from, 1).length)
                            throw Error('LINUX_UNINSTALL_DIRECTORY_NOT_EMPTY');
                        save({ ...progress, leaf: 'move-issued' });
                        await guard();
                        io.move(from, disposal + '/entry', item);
                        save({ ...progress, leaf: 'staged' });
                    }
                    if (io.maybe(disposal + '/entry')) {
                        checkItem(disposal + '/entry', item);
                        if (item.kind === 'directory' && io.names(disposal + '/entry', 1).length)
                            throw Error('LINUX_UNINSTALL_DIRECTORY_NOT_EMPTY');
                        save({ ...progress, leaf: 'unlink-issued' });
                        await guard();
                        await adopt('unlink-issued', () => io.remove(disposal + '/entry', item));
                    } else if (progress.leaf !== 'unlink-issued')
                        throw Error('LINUX_UNINSTALL_UNISSUED_ABSENCE');
                    save({ ...progress, index: progress.index + 1, leaf: 'source' });
                }
                if (progress.phase === 'deleting') save({ ...progress, phase: 'complete' });
                complete = progress.phase === 'complete';
                await guard();
                if ((await io.kernel.release(lease.handle, lease.identity)) !== true)
                    throw Error('LINUX_UNINSTALL_RELEASE_UNKNOWN');
                lease = null;
                io.healthy();
                return {
                    status: 'current-payload-removed' as const,
                    owner,
                    profileRetained: true as const,
                    originalRecordsRetained: true as const,
                    priorRecoveryPayloadsRemoved: false as const,
                    finalizationAuthority: false as const,
                };
            } catch (error) {
                if (!primarySet) {
                    primarySet = true;
                    primary = error;
                }
                if (complete && io.knownRelease()) {
                    lease = null;
                    return { status: 'refused' as const, owner };
                }
                return { status: 'retained-unknown' as const, owner };
            }
        },
        diagnostics: () =>
            Object.freeze({
                primarySet,
                pending,
                reservation: lease ? 'held' : 'none',
                backend: io.diagnostics(),
            }),
    });
}
