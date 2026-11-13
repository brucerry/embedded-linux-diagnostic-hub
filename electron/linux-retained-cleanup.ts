import path from 'node:path';
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import type { Stats } from 'node:fs';
import {
    checkedLinuxModelConfiguration,
    checkedLinuxModelPlan,
    checkedLinuxModelView,
    assertLinuxRetainedFinalizePreimages,
    linuxModelReviewSHA256,
    type LinuxModelConfiguration,
    type LinuxModelPlan,
    type LinuxModelView,
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

export interface LinuxRetainedCleanupEntry {
    path: string;
    kind: 'file' | 'directory';
    dev: number;
    ino: number;
    uid: number;
    mode: number;
    bytes?: number;
    sha256?: string;
}
export interface LinuxRetainedCleanupSnapshot {
    schemaVersion: 1;
    configuration: LinuxModelConfiguration;
    initial: LinuxModelView;
    entries: LinuxRetainedCleanupEntry[];
    originals: { path: string; base64: string; sha256: string }[];
    /** Exact immutable first-seal ledger and its published journal, never another payload. */
    parent?: { entries: LinuxRetainedCleanupEntry[]; anchor: LinuxRetainedCleanupEntry };
}
export interface LinuxRetainedCleanupProgress {
    schemaVersion: 1;
    snapshotSHA256: string;
    phase: 'prepared' | 'previous-issued' | 'previous-retained' | 'deleting' | 'complete';
    index: number;
    leaf: 'source' | 'move-issued' | 'staged' | 'unlink-issued';
}
export interface LinuxRetainedCleanupReview {
    kind: 'fresh' | 'resume';
    snapshot: LinuxRetainedCleanupSnapshot;
    progress: LinuxRetainedCleanupProgress | null;
    rawSnapshot: Buffer | null;
    rawState: Buffer | null;
    seal?: LinuxRetainedSeal;
}
/** Immutable issued operations over pinned files, not a flag authorizing arbitrary repair. */
export interface LinuxRetainedSealIntent {
    schemaVersion: 1;
    root: string;
    installationId: string;
    transactionId: string;
    uid: number;
    snapshotSHA256: string;
    original: LinuxRetainedCleanupEntry;
    staged: LinuxRetainedCleanupEntry;
}
export interface LinuxRetainedSeal {
    intent: LinuxRetainedSealIntent;
    intentSHA256: string;
    state: 'preparing' | 'ready' | 'gap' | 'published';
}
declare const interruptionSelectionBrand: unique symbol;
declare const interruptionBrand: unique symbol;
/** Opaque source-owned qualification selection. No CLI/environment or serialized flag admits it. */
export interface LinuxSealInterruptionSelection {
    readonly [interruptionSelectionBrand]: true;
}
export interface LinuxSealInterruption {
    readonly [interruptionBrand]: true;
}
export interface LinuxSealInterruptionObservation {
    view: LinuxModelView;
    cleanup: LinuxRetainedCleanupReview;
    staged: LinuxRetainedCleanupEntry;
    kind: 'cooperative-seal-preparing-pause';
    nativeQualified: false;
    releaseAcceptance: false;
    abruptInterruptionObserved: false;
}
/** A private publisher's actual synchronous read at the already-durable transition. */
export interface LinuxSealInterruptionRead {
    view: LinuxModelView;
    cleanup: LinuxRetainedCleanupReview;
    staged: LinuxRetainedCleanupEntry;
    fileDescriptors: number;
    directories: number;
    pending: string | null;
}
/** Mandatory owned-FD ports. No default filesystem, process, reservation or cleanup exists here. */
export interface LinuxRetainedCleanupIO {
    configuration(): LinuxModelConfiguration;
    initial(): Promise<LinuxModelView>;
    stat(file: string): Stats;
    maybe(file: string): Stats | null;
    names(directory: string, limit: number): string[];
    read(file: string, cap: number, privateFile?: boolean): Buffer;
    hash(file: string, size: number): string;
    mkdir(directory: string): void;
    write(file: string, bytes: Buffer, exclusive: boolean, prior?: Buffer): void;
    move(source: string, destination: string, expected: LinuxRetainedCleanupEntry): void;
    remove(file: string, expected: LinuxRetainedCleanupEntry): void;
    /** Rechecks the current installation, source, original journals, lease and target inactivity.
     * It must not pretend a partially removed predecessor still has a complete inventory. */
    guard(snapshot: LinuxRetainedCleanupSnapshot): Promise<void>;
    /** The owned launch checks its current child/readback synchronously at the effect seam. */
    live(): void;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const metadata = [INSTALLATION_RECORD, INSTALLATION_MANIFEST, SETUP_OWNER];
const CAP = MAX_INSTALLATION_MANIFEST_BYTES * 6 + 131072;
const MAX_ENTRIES = 20010;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const retained = new Set<object>();
const owners = new WeakMap<object, { state(): unknown }>();
type InterruptionState = {
    phase: 'selected' | 'binding' | 'bound' | 'observing' | 'paused' | 'retained-unknown';
    primarySet: boolean;
    primary?: unknown;
    lastReturned?: unknown;
    unsupportedPromise?: {
        joinSet: boolean;
        join?: unknown;
        settled: 'pending' | 'resolved' | 'rejected';
        outcomeSet: boolean;
        outcome?: unknown;
        intrinsicFailureSet: boolean;
        intrinsicFailure?: unknown;
    };
};
const genuinePromise = utilTypes.isPromise,
    intrinsicThen = Promise.prototype.then,
    intrinsicApply = Reflect.apply;
const interruptionSelections = new WeakMap<object, InterruptionState>();
const interruptions = new WeakMap<
    object,
    {
        backend: object;
        selection: LinuxSealInterruptionSelection;
        observation: LinuxSealInterruptionObservation;
    }
>();
function fields(value: unknown, keys: string[]): asserts value is Record<string, any> {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== keys.length ||
        Object.keys(value).some((key) => !keys.includes(key))
    )
        throw Error('LINUX_FINALIZE_CLEANUP_GRAMMAR');
}
function identity(info: Stats, item: LinuxRetainedCleanupEntry) {
    return (
        !info.isSymbolicLink() &&
        info.dev === item.dev &&
        info.ino === item.ino &&
        info.uid === item.uid &&
        info.mode === item.mode &&
        (item.kind === 'file'
            ? info.isFile() && info.nlink === 1 && info.size === item.bytes
            : info.isDirectory() && info.nlink > 0)
    );
}
function entry(
    name: string,
    info: Stats,
    kind: LinuxRetainedCleanupEntry['kind'],
    sha256?: string,
) {
    if (
        info.isSymbolicLink() ||
        !Number.isSafeInteger(info.dev) ||
        info.dev < 0 ||
        !Number.isSafeInteger(info.ino) ||
        info.ino < 1 ||
        !Number.isInteger(info.uid) ||
        info.uid < 1 ||
        (info.mode & 0o7022) !== 0 ||
        (kind === 'file' && (!info.isFile() || info.nlink !== 1)) ||
        (kind === 'directory' && (!info.isDirectory() || info.nlink < 1))
    )
        throw Error('LINUX_FINALIZE_CLEANUP_ENTRY');
    return {
        path: name,
        kind,
        dev: info.dev,
        ino: info.ino,
        uid: info.uid,
        mode: info.mode,
        ...(kind === 'file' ? { bytes: info.size, sha256 } : {}),
    } satisfies LinuxRetainedCleanupEntry;
}

/** Retained cleanup over the initial no-menu install or one complete published parent seal.
 * The exact current and baseline journals stay outside this component and are never removed. */
function initial(view: LinuxModelView, configuration: LinuxModelConfiguration) {
    checkedLinuxModelView(view, configuration);
    assertLinuxRetainedFinalizePreimages(view, configuration);
    const current = view.root,
        previous = view.previous,
        journal = view.journal,
        completed = view.history?.completed;
    if (
        configuration.action !== 'finalize' ||
        configuration.menu ||
        current?.menu ||
        previous?.menu ||
        !current ||
        !previous ||
        !journal ||
        !completed ||
        !view.history?.journalOriginal ||
        view.history.lineage?.length ||
        view.stage ||
        Object.values(view.activity).some((state) => state !== 'inactive') ||
        journal.phase !== 'candidate-active' ||
        journal.transactionId !== configuration.transactionId ||
        journal.transactionId !== current.transactionId ||
        journal.installationId !== current.installationId ||
        journal.installationId !== previous.installationId ||
        journal.candidateSHA256 !== current.verifiedManifestSHA256 ||
        journal.previousSHA256 !== previous.verifiedManifestSHA256 ||
        (!view.history.cleanup &&
            (completed.journal.previousSHA256 !== null ||
                completed.journal.phase !== 'candidate-active')) ||
        completed.journal.transactionId !== previous.transactionId ||
        completed.journal.candidateSHA256 !== previous.verifiedManifestSHA256 ||
        current.profile !== previous.profile ||
        current.profile !== journal.profile ||
        (current.identity.dev === previous.identity.dev &&
            current.identity.ino === previous.identity.ino)
    )
        throw Error('LINUX_FINALIZE_CLEANUP_FIRST_UPDATE_REQUIRED');
}

export function checkedLinuxRetainedSealIntent(
    input: LinuxRetainedSealIntent,
    snapshot: LinuxRetainedCleanupSnapshot,
    snapshotSHA256: string,
) {
    fields(input, [
        'schemaVersion',
        'root',
        'installationId',
        'transactionId',
        'uid',
        'snapshotSHA256',
        'original',
        'staged',
    ]);
    const configuration = snapshot.configuration,
        original = snapshot.initial.history!.journalOriginal!,
        confirmed = Buffer.from(
            JSON.stringify({ ...snapshot.initial.journal!, phase: 'candidate-confirmed' }),
        );
    if (
        input.schemaVersion !== 1 ||
        input.root !== configuration.root ||
        input.installationId !== configuration.installationId ||
        input.transactionId !== configuration.transactionId ||
        input.uid !== configuration.host.uid ||
        input.snapshotSHA256 !== snapshotSHA256
    )
        throw Error('LINUX_FINALIZE_SEAL_BINDING');
    for (const [item, name, bytes, digest] of [
        [
            input.original,
            'journal.json',
            Buffer.from(original.base64, 'base64').length,
            original.sha256,
        ],
        [input.staged, 'confirmed-journal.json', confirmed.length, hash(confirmed)],
    ] as const) {
        fields(item, ['path', 'kind', 'dev', 'ino', 'uid', 'mode', 'bytes', 'sha256']);
        if (
            item.path !== name ||
            item.kind !== 'file' ||
            item.uid !== input.uid ||
            !Number.isSafeInteger(item.dev) ||
            item.dev < 0 ||
            !Number.isSafeInteger(item.ino) ||
            item.ino < 1 ||
            !Number.isSafeInteger(item.mode) ||
            item.mode < 0 ||
            item.mode > 0o177777 ||
            (item.mode & 0o170000) !== 0o100000 ||
            (item.mode & 0o7077) !== 0 ||
            (name === 'confirmed-journal.json' && item.mode !== 0o100600) ||
            item.bytes !== bytes ||
            item.sha256 !== digest
        )
            throw Error('LINUX_FINALIZE_SEAL_IDENTITY');
    }
    if (input.original.dev !== input.staged.dev || input.original.ino === input.staged.ino)
        throw Error('LINUX_FINALIZE_SEAL_ALIAS');
    return clone(input);
}

export function createLinuxSealInterruptionSelection(): LinuxSealInterruptionSelection {
    const selection = Object.freeze({}) as LinuxSealInterruptionSelection;
    interruptionSelections.set(selection, { phase: 'selected', primarySet: false });
    return selection;
}
export function isLinuxSealInterruption(value: unknown): value is LinuxSealInterruption {
    return Boolean(value && typeof value === 'object' && interruptions.has(value));
}
const copyInterruptionObservation = (
    value: LinuxSealInterruptionObservation,
): LinuxSealInterruptionObservation => ({
    ...clone(value),
    cleanup: {
        ...clone(value.cleanup),
        rawSnapshot: value.cleanup.rawSnapshot ? Buffer.from(value.cleanup.rawSnapshot) : null,
        rawState: value.cleanup.rawState ? Buffer.from(value.cleanup.rawState) : null,
    },
});

/** Bind once before native effects. Only this backend receives the parameterless publisher;
 * observation data is read through its captured real ports, never supplied to a public mint.
 * Memory-port controls test this contract but are not native observations. */
export function bindLinuxSealInterruption(
    selection: LinuxSealInterruptionSelection,
    input: LinuxModelPlan,
    readActual: () => LinuxSealInterruptionRead,
) {
    const state =
        selection && typeof selection === 'object'
            ? interruptionSelections.get(selection)
            : undefined;
    if (!state || state.phase !== 'selected') throw Error('LINUX_SEAL_INTERRUPTION_SELECTION');
    state.phase = 'binding';
    const failed = (error: unknown): never => {
        if (!state.primarySet) {
            state.primarySet = true;
            state.primary = error;
        }
        state.phase = 'retained-unknown';
        throw error;
    };
    let plan: LinuxModelPlan;
    try {
        plan = checkedLinuxModelPlan(input);
        initial(plan.review, plan);
        if (typeof readActual !== 'function') throw Error('LINUX_SEAL_INTERRUPTION_READER');
    } catch (error) {
        return failed(error);
    }
    const backend = Object.freeze({}),
        reviewSHA256 = linuxModelReviewSHA256(plan.review);
    state.phase = 'bound';
    return Object.freeze({
        pause(): LinuxSealInterruption {
            if (state.phase !== 'bound') throw Error('LINUX_SEAL_INTERRUPTION_CONSUMED');
            state.phase = 'observing'; // A throwing or late reader cannot be retried with this selection.
            try {
                const observed = readActual();
                state.lastReturned = observed; // Retain even an unsupported/late-returning port value.
                if (genuinePromise(observed)) {
                    const refusal = Error('LINUX_SEAL_INTERRUPTION_ASYNC_READER'),
                        task: NonNullable<InterruptionState['unsupportedPromise']> = {
                            joinSet: false,
                            settled: 'pending',
                            outcomeSet: false,
                            intrinsicFailureSet: false,
                        };
                    state.unsupportedPromise = task;
                    state.primarySet = true;
                    state.primary = refusal;
                    state.phase = 'retained-unknown';
                    try {
                        // Invoke the captured intrinsic on a genuine Promise; never consult
                        // an arbitrary returned.then getter or adopt its eventual value.
                        task.join = intrinsicApply(intrinsicThen, observed, [
                            (value: unknown) => {
                                task.outcome = value;
                                task.outcomeSet = true;
                                task.settled = 'resolved';
                            },
                            (error: unknown) => {
                                task.outcome = error;
                                task.outcomeSet = true;
                                task.settled = 'rejected';
                            },
                        ]);
                        task.joinSet = true;
                    } catch (error) {
                        task.intrinsicFailureSet = true;
                        task.intrinsicFailure = error;
                    }
                    throw refusal;
                }
                if (
                    observed &&
                    (typeof observed === 'object' || typeof observed === 'function') &&
                    Object.getOwnPropertyDescriptor(observed, 'then')
                )
                    throw Error('LINUX_SEAL_INTERRUPTION_THENABLE_READER');
                fields(observed, [
                    'view',
                    'cleanup',
                    'staged',
                    'fileDescriptors',
                    'directories',
                    'pending',
                ]);
                const cleanup = observed.cleanup,
                    snapshot = cleanup.snapshot,
                    snapshotRaw = cleanup.rawSnapshot,
                    intent = cleanup.seal?.intent;
                if (
                    observed.fileDescriptors !== 0 ||
                    observed.directories !== 0 ||
                    observed.pending !== null ||
                    cleanup.kind !== 'resume' ||
                    !snapshotRaw ||
                    !cleanup.rawState ||
                    cleanup.progress?.phase !== 'complete' ||
                    cleanup.progress.index !== snapshot.entries.length ||
                    cleanup.progress.leaf !== 'source' ||
                    cleanup.seal?.state !== 'preparing' ||
                    !intent ||
                    !Buffer.from(JSON.stringify(snapshot)).equals(snapshotRaw) ||
                    !Buffer.from(JSON.stringify(cleanup.progress)).equals(cleanup.rawState) ||
                    cleanup.progress.snapshotSHA256 !== hash(snapshotRaw) ||
                    snapshot.configuration.root !== plan.root ||
                    snapshot.configuration.transactionId !== plan.transactionId ||
                    snapshot.configuration.installationId !== plan.installationId ||
                    snapshot.configuration.host.uid !== plan.host.uid ||
                    linuxModelReviewSHA256(snapshot.initial) !== reviewSHA256 ||
                    hash(JSON.stringify(intent)) !== cleanup.seal.intentSHA256
                )
                    throw Error('LINUX_SEAL_INTERRUPTION_CHECKPOINT');
                checkedLinuxRetainedSealIntent(intent, snapshot, hash(snapshotRaw));
                fields(observed.staged, [
                    'path',
                    'kind',
                    'dev',
                    'ino',
                    'uid',
                    'mode',
                    'bytes',
                    'sha256',
                ]);
                const wantedStage = { ...intent.staged, bytes: 0, sha256: hash(Buffer.alloc(0)) };
                if (
                    Object.entries(wantedStage).some(
                        ([key, value]) =>
                            observed.staged[key as keyof LinuxRetainedCleanupEntry] !== value,
                    )
                )
                    throw Error('LINUX_SEAL_INTERRUPTION_STAGE');
                const view = observed.view,
                    normalized = {
                        ...clone(view),
                        activity: {
                            root: 'inactive',
                            stage: 'inactive',
                            previous: 'inactive',
                        } as const,
                    };
                checkedLinuxModelView(normalized, plan);
                if (
                    view.activity.root !== 'active' ||
                    view.activity.stage !== 'inactive' ||
                    view.activity.previous !== 'inactive' ||
                    view.stage ||
                    view.previous ||
                    JSON.stringify(view.root) !== JSON.stringify(snapshot.initial.root) ||
                    JSON.stringify(view.source) !== JSON.stringify(plan.review.source) ||
                    JSON.stringify(view.journal) !== JSON.stringify(snapshot.initial.journal) ||
                    view.history?.cleanup?.snapshotSHA256 !== hash(snapshotRaw) ||
                    view.history.cleanup.progress.phase !== 'complete' ||
                    view.history.cleanup.seal?.state !== 'preparing' ||
                    view.history.cleanup.seal.intentSHA256 !== cleanup.seal.intentSHA256
                )
                    throw Error('LINUX_SEAL_INTERRUPTION_VIEW');
                const result = Object.freeze({}) as LinuxSealInterruption,
                    observation: LinuxSealInterruptionObservation = {
                        view: clone(view),
                        cleanup,
                        staged: clone(observed.staged),
                        kind: 'cooperative-seal-preparing-pause',
                        nativeQualified: false,
                        releaseAcceptance: false,
                        abruptInterruptionObserved: false,
                    };
                interruptions.set(result, {
                    backend,
                    selection,
                    observation: copyInterruptionObservation(observation),
                });
                state.phase = 'paused';
                return result;
            } catch (error) {
                return failed(error);
            }
        },
        observation(value: LinuxSealInterruption) {
            const record =
                value && typeof value === 'object' ? interruptions.get(value) : undefined;
            if (
                !record ||
                record.backend !== backend ||
                record.selection !== selection ||
                state.phase !== 'paused'
            )
                throw Error('LINUX_SEAL_INTERRUPTION_OWNER');
            return copyInterruptionObservation(record.observation);
        },
        diagnostics: () =>
            Object.freeze({
                phase: state.phase,
                primarySet: state.primarySet,
                readerPromise: state.unsupportedPromise
                    ? Object.freeze({
                          joinSet: state.unsupportedPromise.joinSet,
                          settled: state.unsupportedPromise.settled,
                          outcomeSet: state.unsupportedPromise.outcomeSet,
                          intrinsicFailureSet: state.unsupportedPromise.intrinsicFailureSet,
                      })
                    : null,
            }),
    });
}

/** Durable predecessor disposal under the caller's already-owned lease/live successor.
 * Only the selected previous payload moves. Profiles, current payload and all original journals
 * remain untouched. An uncertain call retains this owner and is never retried by this instance. */
export function createLinuxRetainedCleanup(io: LinuxRetainedCleanupIO) {
    const configuration = checkedLinuxModelConfiguration(clone(io.configuration())),
        root = configuration.root,
        work = path.posix.join(
            path.posix.dirname(root),
            '.DiagnosticHub-maintenance-' + hash(root).slice(0, 20),
        ),
        previous = work + '/previous-' + configuration.transactionId,
        ledger = work + '-finalize-' + configuration.transactionId,
        payload = ledger + '/payload',
        disposal = ledger + '/disposal',
        snapshotFile = ledger + '/snapshot.json',
        stateFile = ledger + '/state.json';
    let used = false,
        primarySet = false,
        primary: unknown,
        pending: string | null = null,
        lastReturn: unknown;
    const owner = Object.freeze({});
    owners.set(owner, { state: () => ({ io, primarySet, primary, pending, lastReturn }) });
    retained.add(owner);
    const adopt = async <T>(name: string, operation: () => T | Promise<T>) => {
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
    const names = (directory: string, limit: number) => {
        const result = io.names(directory, limit);
        if (
            !Array.isArray(result) ||
            result.length > limit ||
            new Set(result).size !== result.length ||
            result.some(
                (name) =>
                    typeof name !== 'string' ||
                    !name ||
                    name === '.' ||
                    name === '..' ||
                    /[\\/\x00-\x1f\x7f]/.test(name),
            )
        )
            throw Error('LINUX_FINALIZE_CLEANUP_NAMES');
        return result;
    };
    const check = (file: string, item: LinuxRetainedCleanupEntry, bytes = true) => {
        const stat = io.stat(file);
        if (
            !identity(stat, item) ||
            stat.uid !== configuration.host.uid ||
            (bytes && item.kind === 'file' && io.hash(file, item.bytes!) !== item.sha256)
        )
            throw Error('LINUX_FINALIZE_CLEANUP_CHANGED');
    };
    const privateDirectory = (file: string) => {
        const info = io.stat(file);
        entry('', info, 'directory');
        if (info.uid !== configuration.host.uid || (info.mode & 0o7777) !== 0o700)
            throw Error('LINUX_FINALIZE_CLEANUP_PRIVATE_DIRECTORY');
    };
    const parse = <T>(file: string, cap: number): { value: T; raw: Buffer } => {
        const info = io.stat(file);
        entry('', info, 'file', '');
        if (info.uid !== configuration.host.uid || info.size > cap)
            throw Error('LINUX_FINALIZE_CLEANUP_PRIVATE_FILE');
        const raw = io.read(file, cap, true),
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        if (
            !Buffer.from(JSON.stringify(value)).equals(raw) ||
            !identity(io.stat(file), entry('', info, 'file', ''))
        )
            throw Error('LINUX_FINALIZE_CLEANUP_PARTIAL_STATE');
        return { value, raw };
    };
    const snapshotCheck = (snapshot: LinuxRetainedCleanupSnapshot) => {
        fields(snapshot, [
            'schemaVersion',
            'configuration',
            'initial',
            'entries',
            'originals',
            ...(Object.hasOwn(snapshot, 'parent') ? ['parent'] : []),
        ]);
        const historical = checkedLinuxModelConfiguration(snapshot.configuration);
        if (
            snapshot.schemaVersion !== 1 ||
            historical.root !== root ||
            historical.transactionId !== configuration.transactionId ||
            historical.installationId !== configuration.installationId ||
            historical.host.uid !== configuration.host.uid ||
            historical.host.home !== configuration.host.home ||
            historical.host.appData !== configuration.host.appData ||
            !Array.isArray(snapshot.entries) ||
            !snapshot.entries.length ||
            snapshot.entries.length > MAX_ENTRIES ||
            !Array.isArray(snapshot.originals) ||
            snapshot.originals.length !== metadata.length
        )
            throw Error('LINUX_FINALIZE_CLEANUP_SNAPSHOT');
        initial(snapshot.initial, historical);
        if (Boolean(snapshot.initial.history?.cleanup) !== Object.hasOwn(snapshot, 'parent'))
            throw Error('LINUX_FINALIZE_CLEANUP_PARENT_REQUIRED');
        const originals = new Map<string, Buffer>();
        for (const original of snapshot.originals) {
            fields(original, ['path', 'base64', 'sha256']);
            if (typeof original.base64 !== 'string') throw Error('LINUX_FINALIZE_CLEANUP_ORIGINAL');
            const raw = Buffer.from(original.base64, 'base64');
            if (
                !metadata.includes(original.path) ||
                originals.has(original.path) ||
                !raw.length ||
                raw.toString('base64') !== original.base64 ||
                hash(raw) !== original.sha256
            )
                throw Error('LINUX_FINALIZE_CLEANUP_ORIGINAL');
            originals.set(original.path, raw);
        }
        const decode = (name: string) =>
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(originals.get(name)!)),
            manifest = validateInstallationManifest(decode(INSTALLATION_MANIFEST)),
            record = validateInstallationRecord(decode(INSTALLATION_RECORD)),
            owned = decode(SETUP_OWNER),
            old = snapshot.initial.previous!;
        fields(owned, [
            'schemaVersion',
            'product',
            'root',
            'installationId',
            'transactionId',
            'options',
            'integrations',
        ]);
        fields(owned.options, ['startMenu', 'desktop', 'launch']);
        if (
            JSON.stringify(manifest) !== JSON.stringify(old.manifest) ||
            hash(originals.get(INSTALLATION_MANIFEST)!) !== old.verifiedManifestSHA256 ||
            record.manifestSHA256 !== old.verifiedManifestSHA256 ||
            record.installationId !== old.installationId ||
            record.profile !== 'dedicated' ||
            owned.schemaVersion !== 1 ||
            owned.product !== INSTALLATION_PRODUCT ||
            owned.root !== root ||
            owned.installationId !== old.installationId ||
            owned.transactionId !== old.transactionId ||
            !Array.isArray(owned.integrations) ||
            owned.integrations.length ||
            Object.values(owned.options).some((value) => value !== false)
        )
            throw Error('LINUX_FINALIZE_CLEANUP_ORIGINAL_BINDING');
        const required = new Map(manifest.files.map((file) => [file.path, file])),
            dirs = new Set(['']),
            seen = new Set<string>();
        for (const name of [...required.keys(), ...metadata]) {
            let parent = path.posix.dirname(name);
            while (parent !== '.') {
                dirs.add(parent);
                parent = path.posix.dirname(parent);
            }
        }
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
                seen.has(item.path) ||
                item.uid !== configuration.host.uid ||
                !Number.isSafeInteger(item.dev) ||
                item.dev < 0 ||
                !Number.isSafeInteger(item.ino) ||
                item.ino < 1 ||
                !Number.isInteger(item.mode) ||
                (item.mode & 0o7022) !== 0
            )
                throw Error('LINUX_FINALIZE_CLEANUP_SNAPSHOT_ENTRY');
            seen.add(item.path);
            if (item.kind === 'directory') {
                if (!dirs.delete(item.path)) throw Error('LINUX_FINALIZE_CLEANUP_DIRECTORY_PLAN');
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
                    throw Error('LINUX_FINALIZE_CLEANUP_FILE_PLAN');
                required.delete(item.path);
            } else throw Error('LINUX_FINALIZE_CLEANUP_ENTRY_KIND');
        }
        if (dirs.size || required.size || !metadata.every((name) => seen.has(name)))
            throw Error('LINUX_FINALIZE_CLEANUP_INCOMPLETE_PLAN');
        const ordered = [...snapshot.entries].sort((a, b) =>
            a.kind !== b.kind
                ? a.kind === 'file'
                    ? -1
                    : 1
                : a.kind === 'file'
                  ? compare(a.path, b.path)
                  : b.path.split('/').length - a.path.split('/').length || compare(b.path, a.path),
        );
        const rootEntry = snapshot.entries.find((item) => item.path === '')!;
        if (
            JSON.stringify([...ordered.filter((item) => item.path !== ''), rootEntry]) !==
                JSON.stringify(snapshot.entries) ||
            rootEntry.dev !== old.identity.dev ||
            rootEntry.ino !== old.identity.ino ||
            rootEntry.uid !== old.identity.uid
        )
            throw Error('LINUX_FINALIZE_CLEANUP_ORDER');
        if (snapshot.parent) parentShape(snapshot);
    };
    const parentFiles = [
        'original-completed-journal.json',
        'original-journal.json',
        'seal-intent.json',
        'snapshot.json',
        'state.json',
        'unconfirmed-journal.json',
    ];
    const sameRecorded = (a: LinuxRetainedCleanupEntry, b: LinuxRetainedCleanupEntry) =>
        (['kind', 'dev', 'ino', 'uid', 'mode', 'bytes', 'sha256'] as const).every(
            (key) => a[key] === b[key],
        );
    const parentShape = (snapshot: LinuxRetainedCleanupSnapshot) => {
        const saved = snapshot.parent!,
            parent = snapshot.initial.history!.cleanup!,
            original = snapshot.initial.history!.completed!;
        fields(saved, ['entries', 'anchor']);
        if (!Array.isArray(saved.entries) || saved.entries.length !== parentFiles.length + 2)
            throw Error('LINUX_FINALIZE_PARENT_INVENTORY');
        const paths = [...parentFiles, 'disposal', ''],
            identities = new Set<string>();
        for (const [index, item] of saved.entries.entries()) {
            const file = index < parentFiles.length;
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
                item.path !== paths[index] ||
                item.kind !== (file ? 'file' : 'directory') ||
                !Number.isSafeInteger(item.dev) ||
                item.dev < 0 ||
                !Number.isSafeInteger(item.ino) ||
                item.ino <= 0 ||
                identities.has(key) ||
                item.uid !== configuration.host.uid ||
                item.mode !== (file ? 0o100600 : 0o40700) ||
                (file &&
                    (!Number.isSafeInteger(item.bytes) ||
                        item.bytes! < 1 ||
                        item.bytes! > (item.path === 'snapshot.json' ? CAP : 8192) ||
                        typeof item.sha256 !== 'string' ||
                        !/^[a-f0-9]{64}$/.test(item.sha256)))
            )
                throw Error('LINUX_FINALIZE_PARENT_ENTRY');
            identities.add(key);
        }
        const expected = new Map([
            ['snapshot.json', parent.snapshotSHA256],
            ['seal-intent.json', parent.seal!.intentSHA256],
            ['original-journal.json', parent.initial.history!.journalOriginal!.sha256],
            ['unconfirmed-journal.json', parent.initial.history!.journalOriginal!.sha256],
            ['original-completed-journal.json', parent.initial.history!.completed!.sha256],
        ]);
        for (const item of saved.entries)
            if (expected.has(item.path) && item.sha256 !== expected.get(item.path))
                throw Error('LINUX_FINALIZE_PARENT_ORIGINAL');
        const anchor = saved.anchor;
        fields(anchor, ['path', 'kind', 'dev', 'ino', 'uid', 'mode', 'bytes', 'sha256']);
        if (
            anchor.path !== 'completed-journal.json' ||
            anchor.kind !== 'file' ||
            anchor.mode !== 0o100600 ||
            anchor.uid !== configuration.host.uid ||
            !Number.isSafeInteger(anchor.dev) ||
            anchor.dev < 0 ||
            !Number.isSafeInteger(anchor.ino) ||
            anchor.ino <= 0 ||
            identities.has(anchor.dev + ':' + anchor.ino) ||
            !Number.isSafeInteger(anchor.bytes) ||
            anchor.bytes! < 1 ||
            anchor.bytes! > 8192 ||
            anchor.bytes !== Buffer.from(original.base64, 'base64').length ||
            anchor.sha256 !== original.sha256
        )
            throw Error('LINUX_FINALIZE_PARENT_ANCHOR');
    };
    const parentReadback = (
        snapshot: LinuxRetainedCleanupSnapshot,
        progress: LinuxRetainedCleanupProgress | null,
        ownSeal?: LinuxRetainedSeal,
    ) => {
        if (!snapshot.parent) return;
        parentShape(snapshot);
        const saved = snapshot.parent,
            parent = snapshot.initial.history!.cleanup!,
            parentLedger = work + '-finalize-' + parent.configuration.transactionId,
            allowed = [...parentFiles, 'disposal'].sort();
        if (
            JSON.stringify(names(parentLedger, allowed.length + 1).sort()) !==
                JSON.stringify(allowed) ||
            names(parentLedger + '/disposal', 1).length
        )
            throw Error('LINUX_FINALIZE_PARENT_FOREIGN_STATE');
        for (const item of saved.entries)
            check(parentLedger + (item.path ? '/' + item.path : ''), item);
        const readParent = (name: string, cap = 8192) => {
            const item = saved.entries.find((entry) => entry.path === name)!,
                raw = io.read(parentLedger + '/' + name, cap, true);
            if (raw.length !== item.bytes || hash(raw) !== item.sha256)
                throw Error('LINUX_FINALIZE_PARENT_ORIGINAL_CHANGED');
            check(parentLedger + '/' + name, item);
            return raw;
        };
        const decode = (raw: Buffer) => {
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
            if (!Buffer.from(JSON.stringify(value)).equals(raw))
                throw Error('LINUX_FINALIZE_PARENT_PARTIAL_STATE');
            return value;
        };
        const parentSnapshot = decode(
                readParent('snapshot.json', CAP),
            ) as LinuxRetainedCleanupSnapshot,
            parentState = decode(readParent('state.json')),
            intentRaw = readParent('seal-intent.json');
        fields(parentSnapshot, [
            'schemaVersion',
            'configuration',
            'initial',
            'entries',
            'originals',
        ]);
        if (
            parentSnapshot.schemaVersion !== 1 ||
            JSON.stringify(parentSnapshot.configuration) !== JSON.stringify(parent.configuration) ||
            linuxModelReviewSHA256(parentSnapshot.initial) !==
                linuxModelReviewSHA256(parent.initial) ||
            !Array.isArray(parentSnapshot.entries) ||
            parentSnapshot.entries.length !== parent.entries
        )
            throw Error('LINUX_FINALIZE_PARENT_SNAPSHOT_CHANGED');
        // A second seal preserves the actual first seal, never an arbitrarily recursive history.
        initial(
            parentSnapshot.initial,
            checkedLinuxModelConfiguration(parentSnapshot.configuration),
        );
        if (parentSnapshot.initial.history?.cleanup) throw Error('LINUX_FINALIZE_PARENT_DEPTH');
        fields(parentState, ['schemaVersion', 'snapshotSHA256', 'phase', 'index', 'leaf']);
        if (
            parentState.schemaVersion !== 1 ||
            parentState.snapshotSHA256 !== parent.snapshotSHA256 ||
            parentState.phase !== 'complete' ||
            parentState.index !== parent.entries ||
            parentState.leaf !== 'source'
        )
            throw Error('LINUX_FINALIZE_PARENT_INCOMPLETE');
        const intent = checkedLinuxRetainedSealIntent(
                decode(intentRaw),
                parentSnapshot,
                parent.snapshotSHA256,
            ),
            retired = saved.entries.find((item) => item.path === 'unconfirmed-journal.json')!;
        if (!sameRecorded(intent.original, retired) || !sameRecorded(intent.staged, saved.anchor))
            throw Error('LINUX_FINALIZE_PARENT_INTENT_ANCHOR');
        const before = parent.initial.history!;
        if (
            readParent('original-journal.json').toString('base64') !==
                before.journalOriginal!.base64 ||
            readParent('unconfirmed-journal.json').toString('base64') !==
                before.journalOriginal!.base64 ||
            readParent('original-completed-journal.json').toString('base64') !==
                before.completed!.base64
        )
            throw Error('LINUX_FINALIZE_PARENT_HISTORY_CHANGED');
        const liveAnchor = work + '/completed-journal.json',
            savedAnchor = ledger + '/original-completed-journal.json',
            live = io.maybe(liveAnchor),
            kept = io.maybe(savedAnchor);
        if ((!live && !kept) || (kept && progress?.phase !== 'complete'))
            throw Error('LINUX_FINALIZE_PARENT_ANCHOR_BOUNDARY');
        if (live && kept) {
            // A later update may reuse the completed slot for this seal's exact published inode.
            // It cannot introduce a second copy of the parent's retained anchor.
            if (ownSeal?.state !== 'published')
                throw Error('LINUX_FINALIZE_PARENT_ANCHOR_BOUNDARY');
            check(liveAnchor, ownSeal.intent.staged);
        }
        const anchorPath = kept ? savedAnchor : liveAnchor;
        check(anchorPath, saved.anchor);
        if (
            io.read(anchorPath, 8192, true).toString('base64') !==
            snapshot.initial.history!.completed!.base64
        )
            throw Error('LINUX_FINALIZE_PARENT_ANCHOR_CHANGED');
        check(anchorPath, saved.anchor);
        check(parentLedger, saved.entries.at(-1)!);
        check(parentLedger + '/disposal', saved.entries.at(-2)!);
        if (
            JSON.stringify(names(parentLedger, allowed.length + 1).sort()) !==
                JSON.stringify(allowed) ||
            names(parentLedger + '/disposal', 1).length
        )
            throw Error('LINUX_FINALIZE_PARENT_FOREIGN_STATE');
    };
    const captureParent = (view: LinuxModelView) => {
        const parent = view.history!.cleanup!,
            parentLedger = work + '-finalize-' + parent.configuration.transactionId,
            entries: LinuxRetainedCleanupEntry[] = parentFiles.map((name) => {
                const file = parentLedger + '/' + name,
                    info = io.stat(file);
                entry(name, info, 'file', '');
                if (
                    !Number.isSafeInteger(info.size) ||
                    info.size < 1 ||
                    info.size > (name === 'snapshot.json' ? CAP : 8192)
                )
                    throw Error('LINUX_FINALIZE_PARENT_FILE_BOUND');
                return entry(name, info, 'file', io.hash(file, info.size));
            });
        entries.push(entry('disposal', io.stat(parentLedger + '/disposal'), 'directory'));
        entries.push(entry('', io.stat(parentLedger), 'directory'));
        const file = work + '/completed-journal.json',
            info = io.stat(file);
        entry('completed-journal.json', info, 'file', '');
        if (!Number.isSafeInteger(info.size) || info.size < 1 || info.size > 8192)
            throw Error('LINUX_FINALIZE_PARENT_FILE_BOUND');
        return {
            entries,
            anchor: entry('completed-journal.json', info, 'file', io.hash(file, info.size)),
        };
    };
    const inventory = (
        base: string,
        entries: LinuxRetainedCleanupEntry[],
        missing?: LinuxRetainedCleanupEntry,
    ) => {
        const wanted = new Map(entries.map((item) => [item.path, item])),
            seen = new Set<string>();
        if (io.maybe(base)) {
            const visit = (relative: string) => {
                const file = base + (relative ? '/' + relative : ''),
                    item = wanted.get(relative);
                if (!item) throw Error('LINUX_FINALIZE_CLEANUP_FOREIGN_CONTENT');
                check(file, item);
                seen.add(relative);
                if (item.kind === 'directory')
                    for (const name of names(file, MAX_ENTRIES))
                        visit(relative ? relative + '/' + name : name);
            };
            visit('');
        }
        for (const item of entries)
            if (!seen.has(item.path) && item !== missing)
                throw Error('LINUX_FINALIZE_CLEANUP_MISSING_ENTRY');
        return seen;
    };
    const progressCheck = (
        progress: LinuxRetainedCleanupProgress,
        snapshot: LinuxRetainedCleanupSnapshot,
        raw: Buffer,
    ) => {
        fields(progress, ['schemaVersion', 'snapshotSHA256', 'phase', 'index', 'leaf']);
        if (
            progress.schemaVersion !== 1 ||
            progress.snapshotSHA256 !== hash(raw) ||
            !['prepared', 'previous-issued', 'previous-retained', 'deleting', 'complete'].includes(
                progress.phase,
            ) ||
            !['source', 'move-issued', 'staged', 'unlink-issued'].includes(progress.leaf) ||
            !Number.isInteger(progress.index) ||
            progress.index < 0 ||
            progress.index > snapshot.entries.length ||
            (progress.index === snapshot.entries.length && progress.leaf !== 'source') ||
            (!['deleting', 'complete'].includes(progress.phase) &&
                (progress.index !== 0 || progress.leaf !== 'source')) ||
            (progress.phase === 'complete' &&
                (progress.index !== snapshot.entries.length || progress.leaf !== 'source'))
        )
            throw Error('LINUX_FINALIZE_CLEANUP_PROGRESS');
    };
    const remaining = (
        snapshot: LinuxRetainedCleanupSnapshot,
        progress: LinuxRetainedCleanupProgress,
    ) => {
        const current = snapshot.entries[progress.index],
            staged = io.maybe(disposal + '/entry'),
            from = current ? io.maybe(payload + (current.path ? '/' + current.path : '')) : null;
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
            throw Error('LINUX_FINALIZE_CLEANUP_LEAF_BOUNDARY');
        if (staged && (!current || progress.leaf === 'source'))
            throw Error('LINUX_FINALIZE_CLEANUP_FOREIGN_DISPOSAL');
        if (staged) check(disposal + '/entry', current);
        const seen = inventory(
            payload,
            snapshot.entries.slice(progress.index),
            staged || progress.leaf === 'unlink-issued' ? current : undefined,
        );
        if (staged && seen.has(current.path)) throw Error('LINUX_FINALIZE_CLEANUP_DOUBLE_ENTRY');
        if (names(disposal, 2).some((name) => name !== 'entry'))
            throw Error('LINUX_FINALIZE_CLEANUP_FOREIGN_DISPOSAL');
    };
    const stored = (): LinuxRetainedCleanupReview => {
        privateDirectory(ledger);
        privateDirectory(disposal);
        if (
            names(ledger, 10).some(
                (name) =>
                    ![
                        'snapshot.json',
                        'state.json',
                        'payload',
                        'disposal',
                        'original-journal.json',
                        'original-completed-journal.json',
                        'seal-intent.json',
                        'confirmed-journal.json',
                        'unconfirmed-journal.json',
                    ].includes(name),
            )
        )
            throw Error('LINUX_FINALIZE_CLEANUP_FOREIGN_STATE');
        const saved = parse<LinuxRetainedCleanupSnapshot>(snapshotFile, CAP),
            state = parse<LinuxRetainedCleanupProgress>(stateFile, 8192);
        snapshotCheck(saved.value);
        progressCheck(state.value, saved.value, saved.raw);
        const phase = state.value.phase,
            from = io.maybe(previous),
            moved = io.maybe(payload),
            old = saved.value.entries.at(-1)!;
        for (const [name, original] of [
            ['original-journal.json', saved.value.initial.history!.journalOriginal!],
            ['original-completed-journal.json', saved.value.initial.history!.completed!],
        ] as const) {
            const file = ledger + '/' + name,
                info = io.maybe(file);
            if (info) {
                entry('', info, 'file', '');
                if (
                    phase !== 'complete' ||
                    info.uid !== configuration.host.uid ||
                    info.size > 8192 ||
                    io.read(file, 8192, true).toString('base64') !== original.base64
                )
                    throw Error('LINUX_FINALIZE_CLEANUP_ORIGINAL_JOURNAL_CHANGED');
            }
        }
        if (phase === 'prepared' || phase === 'previous-issued') {
            if (Boolean(from) === Boolean(moved) || (phase === 'prepared' && !from))
                throw Error('LINUX_FINALIZE_CLEANUP_PREVIOUS_BOUNDARY');
            inventory(from ? previous : payload, saved.value.entries);
        } else {
            if (from) throw Error('LINUX_FINALIZE_CLEANUP_FOREIGN_PREVIOUS');
            if (phase === 'previous-retained') {
                if (!moved) throw Error('LINUX_FINALIZE_CLEANUP_MISSING_PAYLOAD');
                check(payload, old, false);
                inventory(payload, saved.value.entries);
            } else if (phase === 'deleting') remaining(saved.value, state.value);
            else if (moved || names(disposal, 1).length)
                throw Error('LINUX_FINALIZE_CLEANUP_INCOMPLETE');
        }
        if (phase !== 'deleting' && names(disposal, 1).length)
            throw Error('LINUX_FINALIZE_CLEANUP_FOREIGN_DISPOSAL');
        let seal: LinuxRetainedSeal | undefined;
        const intentFile = ledger + '/seal-intent.json',
            stageFile = ledger + '/confirmed-journal.json',
            retiredFile = ledger + '/unconfirmed-journal.json';
        if (io.maybe(intentFile)) {
            if (phase !== 'complete') throw Error('LINUX_FINALIZE_SEAL_BEFORE_CLEANUP');
            const raw = parse<LinuxRetainedSealIntent>(intentFile, 8192),
                intent = checkedLinuxRetainedSealIntent(raw.value, saved.value, hash(saved.raw)),
                currentFile = work + '/journal.json',
                completedFile = work + '/completed-journal.json',
                current = io.maybe(currentFile),
                staged = io.maybe(stageFile),
                retired = io.maybe(retiredFile),
                confirmed = Buffer.from(
                    JSON.stringify({
                        ...saved.value.initial.journal!,
                        phase: 'candidate-confirmed',
                    }),
                );
            const exact = (file: string, wanted: LinuxRetainedCleanupEntry) => {
                const info = io.maybe(file);
                return Boolean(
                    info &&
                    identity(info, wanted) &&
                    io.hash(file, wanted.bytes!) === wanted.sha256 &&
                    identity(io.stat(file), wanted),
                );
            };
            if (staged) {
                if (
                    !Number.isSafeInteger(staged.size) ||
                    staged.size < 0 ||
                    !identity(staged, { ...intent.staged, bytes: staged.size }) ||
                    staged.size > confirmed.length ||
                    !io.read(stageFile, 8192, true).equals(confirmed.subarray(0, staged.size))
                )
                    throw Error('LINUX_FINALIZE_SEAL_STAGE_CHANGED');
                if (current && !retired && exact(currentFile, intent.original))
                    seal = {
                        intent,
                        intentSHA256: hash(raw.raw),
                        state: staged.size === confirmed.length ? 'ready' : 'preparing',
                    };
                else if (
                    !current &&
                    retired &&
                    exact(retiredFile, intent.original) &&
                    exact(stageFile, intent.staged)
                )
                    seal = { intent, intentSHA256: hash(raw.raw), state: 'gap' };
            } else if (
                retired &&
                exact(retiredFile, intent.original) &&
                (exact(currentFile, intent.staged) || exact(completedFile, intent.staged))
            )
                seal = { intent, intentSHA256: hash(raw.raw), state: 'published' };
            if (!seal) throw Error('LINUX_FINALIZE_SEAL_CONFLICT');
        } else if (io.maybe(stageFile) || io.maybe(retiredFile))
            throw Error('LINUX_FINALIZE_SEAL_INTENT_REQUIRED');
        parentReadback(saved.value, state.value, seal);
        return {
            kind: 'resume',
            snapshot: saved.value,
            progress: state.value,
            rawSnapshot: saved.raw,
            rawState: state.raw,
            ...(seal ? { seal } : {}),
        };
    };
    const inspect = async (): Promise<LinuxRetainedCleanupReview> => {
        if (io.maybe(ledger)) return stored();
        if (io.maybe(payload) || io.maybe(disposal))
            throw Error('LINUX_FINALIZE_CLEANUP_FOREIGN_STATE');
        const view = await io.initial();
        initial(view, configuration);
        const originals = metadata.map((name) => {
            const raw = io.read(previous + '/' + name, MAX_INSTALLATION_MANIFEST_BYTES, false);
            return { path: name, base64: raw.toString('base64'), sha256: hash(raw) };
        });
        const all = [...view.previous!.manifest.files.map((file) => file.path), ...metadata].sort(),
            dirs = new Set(['']);
        for (const file of all) {
            let p = path.posix.dirname(file);
            while (p !== '.') {
                dirs.add(p);
                p = path.posix.dirname(p);
            }
        }
        const entries: LinuxRetainedCleanupEntry[] = all.map((name) => {
            const file = previous + '/' + name,
                info = io.stat(file);
            return entry(name, info, 'file', io.hash(file, info.size));
        });
        for (const directory of [...dirs]
            .filter(Boolean)
            .sort((a, b) => b.split('/').length - a.split('/').length || compare(b, a)))
            entries.push(entry(directory, io.stat(previous + '/' + directory), 'directory'));
        entries.push(entry('', io.stat(previous), 'directory'));
        const snapshot: LinuxRetainedCleanupSnapshot = {
            schemaVersion: 1,
            configuration: clone(configuration),
            initial: clone(view),
            entries,
            originals,
            ...(view.history?.cleanup ? { parent: captureParent(view) } : {}),
        };
        snapshotCheck(snapshot);
        parentReadback(snapshot, null);
        inventory(previous, entries);
        const fresh = await io.initial();
        if (linuxModelReviewSHA256(fresh) !== linuxModelReviewSHA256(view))
            throw Error('LINUX_FINALIZE_CLEANUP_REVIEW_CHANGED');
        return { kind: 'fresh', snapshot, progress: null, rawSnapshot: null, rawState: null };
    };
    const reviewHash = (review: LinuxRetainedCleanupReview) =>
        hash(
            JSON.stringify({
                ...review,
                rawSnapshot: review.rawSnapshot?.toString('base64') ?? null,
                rawState: review.rawState?.toString('base64') ?? null,
            }),
        );
    return Object.freeze({
        stored,
        inspect: () => adopt('inspect', inspect),
        reviewHash,
        async run(review: LinuxRetainedCleanupReview): Promise<LinuxRetainedCleanupReview> {
            if (configuration.action !== 'finalize')
                throw Error('LINUX_FINALIZE_CLEANUP_SELECTION');
            if (used || primarySet || pending !== null)
                throw Error('LINUX_FINALIZE_CLEANUP_CONSUMED');
            used = true;
            return adopt('run', async () => {
                const actual = await inspect();
                if (reviewHash(actual) !== reviewHash(review))
                    throw Error('LINUX_FINALIZE_CLEANUP_REVIEW_CHANGED');
                const snapshot = actual.snapshot,
                    rawSnapshot = actual.rawSnapshot ?? Buffer.from(JSON.stringify(snapshot));
                if (rawSnapshot.length > CAP) throw Error('LINUX_FINALIZE_CLEANUP_SNAPSHOT_BOUND');
                let progress = actual.progress,
                    rawState = actual.rawState,
                    initialized = actual.kind === 'resume',
                    madeLedger = initialized,
                    madeDisposal = initialized,
                    madeSnapshot = initialized;
                const verify = () => {
                    if (initialized) {
                        const current = stored();
                        if (
                            !current.rawSnapshot!.equals(rawSnapshot) ||
                            !current.rawState!.equals(rawState!)
                        )
                            throw Error('LINUX_FINALIZE_CLEANUP_STATE_CHANGED');
                    } else {
                        parentReadback(snapshot, null);
                        inventory(previous, snapshot.entries);
                        if (madeLedger) {
                            privateDirectory(ledger);
                            const expected = [
                                ...(madeDisposal ? ['disposal'] : []),
                                ...(madeSnapshot ? ['snapshot.json'] : []),
                            ].sort();
                            if (
                                JSON.stringify(names(ledger, 4).sort()) !== JSON.stringify(expected)
                            )
                                throw Error('LINUX_FINALIZE_CLEANUP_INITIALIZATION_CHANGED');
                            if (madeDisposal) {
                                privateDirectory(disposal);
                                if (names(disposal, 1).length)
                                    throw Error('LINUX_FINALIZE_CLEANUP_FOREIGN_DISPOSAL');
                            }
                            if (
                                madeSnapshot &&
                                !parse<LinuxRetainedCleanupSnapshot>(snapshotFile, CAP).raw.equals(
                                    rawSnapshot,
                                )
                            )
                                throw Error('LINUX_FINALIZE_CLEANUP_STATE_CHANGED');
                        } else if (io.maybe(ledger))
                            throw Error('LINUX_FINALIZE_CLEANUP_FOREIGN_STATE');
                    }
                };
                const effect = async (name: string, operation: () => void) => {
                    await adopt('guard-' + name, () => io.guard(clone(snapshot)));
                    verify();
                    io.live();
                    await adopt(name, () => {
                        const value: unknown = operation();
                        lastReturn = value;
                        if (value !== undefined)
                            throw Error('LINUX_FINALIZE_CLEANUP_ASYNC_OR_VALUE');
                    });
                };
                if (!initialized) {
                    await effect('ledger-create', () => io.mkdir(ledger));
                    madeLedger = true;
                    await effect('disposal-create', () => io.mkdir(disposal));
                    madeDisposal = true;
                    await effect('snapshot-write', () => io.write(snapshotFile, rawSnapshot, true));
                    madeSnapshot = true;
                    progress = {
                        schemaVersion: 1,
                        snapshotSHA256: hash(rawSnapshot),
                        phase: 'prepared',
                        index: 0,
                        leaf: 'source',
                    };
                    const next = Buffer.from(JSON.stringify(progress));
                    await effect('state-create', () => io.write(stateFile, next, true));
                    rawState = next;
                    initialized = true;
                }
                const save = async (next: LinuxRetainedCleanupProgress) => {
                    const raw = Buffer.from(JSON.stringify(next));
                    await effect('state-write', () => io.write(stateFile, raw, false, rawState!));
                    progress = next;
                    rawState = raw;
                };
                if (progress!.phase === 'prepared' || progress!.phase === 'previous-issued') {
                    if (io.maybe(previous)) {
                        await save({ ...progress!, phase: 'previous-issued' });
                        await effect('previous-move', () =>
                            io.move(previous, payload, snapshot.entries.at(-1)!),
                        );
                    }
                    await save({ ...progress!, phase: 'previous-retained' });
                }
                if (progress!.phase === 'previous-retained')
                    await save({ ...progress!, phase: 'deleting' });
                while (
                    progress!.phase === 'deleting' &&
                    progress!.index < snapshot.entries.length
                ) {
                    const item = snapshot.entries[progress!.index],
                        from = payload + (item.path ? '/' + item.path : '');
                    if (io.maybe(from)) {
                        check(from, item);
                        if (item.kind === 'directory' && names(from, 1).length)
                            throw Error('LINUX_FINALIZE_CLEANUP_DIRECTORY_NOT_EMPTY');
                        await save({ ...progress!, leaf: 'move-issued' });
                        await effect('entry-move', () => io.move(from, disposal + '/entry', item));
                        await save({ ...progress!, leaf: 'staged' });
                    }
                    if (io.maybe(disposal + '/entry')) {
                        check(disposal + '/entry', item);
                        if (item.kind === 'directory' && names(disposal + '/entry', 1).length)
                            throw Error('LINUX_FINALIZE_CLEANUP_DIRECTORY_NOT_EMPTY');
                        await save({ ...progress!, leaf: 'unlink-issued' });
                        await effect('entry-remove', () => io.remove(disposal + '/entry', item));
                    } else if (progress!.leaf !== 'unlink-issued')
                        throw Error('LINUX_FINALIZE_CLEANUP_UNISSUED_ABSENCE');
                    await save({ ...progress!, index: progress!.index + 1, leaf: 'source' });
                }
                if (progress!.phase === 'deleting') await save({ ...progress!, phase: 'complete' });
                await adopt('guard-complete', () => io.guard(clone(snapshot)));
                verify();
                io.live();
                const complete = stored();
                if (complete.progress!.phase !== 'complete')
                    throw Error('LINUX_FINALIZE_CLEANUP_INCOMPLETE');
                return complete;
            });
        },
        diagnostics: () =>
            Object.freeze({
                owner,
                primarySet,
                pending,
                retained: primarySet || pending !== null,
                complete: false as const,
            }),
    });
}
