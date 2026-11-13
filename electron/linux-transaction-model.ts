import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    validateInstallationManifest,
    installationActions,
    MAX_INSTALLATION_MANIFEST_BYTES,
    type InstallationManifest,
} from '../shared/installation.ts';
import type { LinuxReviewHost } from './linux-setup-review';
import {
    checkedLinuxMenuChoice,
    checkedLinuxMenuRecord,
    checkedLinuxMenuView,
    checkedLinuxMenuJournal,
    prepareLinuxMenuJournal,
    desiredLinuxMenu,
    sameLinuxMenu,
    assertLinuxMenuPhase,
    type LinuxMenuChoice,
    type LinuxMenuRecord,
    type LinuxMenuView,
    type LinuxMenuJournal,
    type LinuxMenuSlot,
    type LinuxMenuPhase,
} from './linux-menu-ownership.ts';

/** Source/model adapter only. No native filesystem, kernel socket, app or process implementation. */
export interface LinuxModelIdentity {
    dev: number;
    ino: number;
    uid: number;
}
export interface LinuxModelParent extends LinuxModelIdentity {
    path: string;
    mode: number;
}
export interface LinuxModelOwner {
    pid: number;
    startTicks: string;
    executable: string;
}
export interface LinuxModelSource {
    identity: LinuxModelIdentity;
    manifest: InstallationManifest;
    /** The injected observer must hash all declared bytes and reject unknown inventory first. */
    verifiedManifestSHA256: string;
}
export interface LinuxModelPayload extends LinuxModelSource {
    menu?: LinuxMenuRecord;
    installationId: string;
    transactionId: string;
    root: string;
    profile: string;
}
export type LinuxModelPhase =
    | 'copying'
    | 'prepared'
    | 'old-retained'
    | 'candidate-active'
    | 'candidate-confirmed'
    | 'rollback-started'
    | 'candidate-retained'
    | 'rolled-back';
export interface LinuxModelJournal {
    menu?: LinuxMenuJournal;
    schemaVersion: 1;
    root: string;
    uid: number;
    transactionId: string;
    installationId: string;
    profile: string;
    candidateSHA256: string;
    previousSHA256: string | null;
    owner: LinuxModelOwner;
    phase: LinuxModelPhase;
}
/** Private retained originals, not a new installation/journal wire format. */
export interface LinuxRetainedGeneration {
    archived: boolean;
    base64: string;
    sha256: string;
    journal: LinuxModelJournal;
    previous: LinuxModelPayload;
    activity: 'inactive' | 'active' | 'unknown';
}
export const MAX_LINUX_RETAINED_GENERATIONS = 8;
/** Historical recovery input plus the actual externally observed removal cursor.
 * The predecessor descriptor is not a currently present payload or a native-proof receipt. */
export interface LinuxModelCleanup {
    configuration: LinuxModelConfiguration;
    initial: LinuxModelView;
    snapshotSHA256: string;
    entries: number;
    progress: {
        phase: 'prepared' | 'previous-issued' | 'previous-retained' | 'deleting' | 'complete';
        index: number;
        leaf: 'source' | 'move-issued' | 'staged' | 'unlink-issued';
    };
    seal?: { intentSHA256: string; state: 'preparing' | 'ready' | 'gap' | 'published' };
}
export interface LinuxModelView {
    /** Fixed first-upgrade handoff. Original journal bytes remain part of every later guard. */
    history?: {
        journalOriginal: { base64: string; sha256: string } | null;
        completed: { base64: string; sha256: string; journal: LinuxModelJournal } | null;
        /** No-menu only. At most one final entry is the current, not-yet-archived journal. */
        lineage?: LinuxRetainedGeneration[];
        cleanup?: LinuxModelCleanup;
    };
    menu?: LinuxMenuView;
    /** Fresh independent activity observations for exactly the three guarded slots; unknown refuses. */
    activity: {
        root: 'inactive' | 'active' | 'unknown';
        stage: 'inactive' | 'active' | 'unknown';
        previous: 'inactive' | 'active' | 'unknown';
    };
    parents: LinuxModelParent[];
    source: LinuxModelSource;
    root: LinuxModelPayload | null;
    stage: LinuxModelPayload | null;
    previous: LinuxModelPayload | null;
    journal: LinuxModelJournal | null;
}
export interface LinuxModelPlan {
    menu?: LinuxMenuChoice;
    host: LinuxReviewHost;
    root: string;
    action:
        | 'install'
        | 'repair'
        | 'update'
        | 'rollback'
        | 'resume'
        | 'launch'
        | 'uninstall-current'
        | 'finalize';
    transactionId: string;
    installationId: string;
    owner: LinuxModelOwner;
    consent: boolean;
    review: LinuxModelView;
    reviewSHA256: string;
}
/** Fixed operation selection before original filesystem observations or consent.
 * It contains no review snapshot and cannot be passed to transaction.run. */
export type LinuxModelConfiguration = Omit<LinuxModelPlan, 'consent' | 'review' | 'reviewSHA256'>;
export interface LinuxReservationIdentity {
    root: string;
    uid: number;
    key: string;
    token: string;
    owner: LinuxModelOwner;
}
export interface LinuxModelLease {
    identity: LinuxReservationIdentity;
    handle: object;
}
export interface LinuxModelScope {
    root: string;
    stage: string;
    previous: string;
    source: string;
    key: string;
    uid: number;
}
export interface LinuxModelKernel {
    /** Atomic per-canonical-root/current-UID reservation, BEFORE observing stale disk ownership. */
    acquire(identity: Omit<LinuxReservationIdentity, 'token'>): Promise<LinuxModelLease | null>;
    current(handle: object): Promise<LinuxReservationIdentity>;
    /** Release only this exact lease; never unlink a foreign reservation or change host policy. */
    release(handle: object, expected: LinuxReservationIdentity): Promise<boolean>;
}
export interface LinuxMemoryEffects {
    kind: 'injected-memory-effects';
    handoff?(scope: LinuxModelScope, guard: LinuxModelView): Promise<LinuxModelView>;
    menuStage?(
        scope: LinuxModelScope,
        guard: LinuxModelView,
        record: LinuxMenuRecord,
        text: string,
    ): Promise<LinuxModelView>;
    menuMove?(
        scope: LinuxModelScope,
        guard: LinuxModelView,
        from: LinuxMenuSlot,
        to: LinuxMenuSlot,
    ): Promise<LinuxModelView>;
    /** Must inspect only fixed owned slots, reject aliases/foreign content, and verify exact bytes. */
    observe(scope: LinuxModelScope): Promise<LinuxModelView>;
    /** Each primitive rechecks the complete guard immediately before its sole modeled mutation. */
    journal(
        scope: LinuxModelScope,
        guard: LinuxModelView,
        next: LinuxModelJournal,
    ): Promise<LinuxModelView>;
    stage(
        scope: LinuxModelScope,
        guard: LinuxModelView,
        payload: Omit<LinuxModelPayload, 'identity'>,
    ): Promise<LinuxModelView>;
    move(
        scope: LinuxModelScope,
        guard: LinuxModelView,
        from: 'root' | 'stage' | 'previous',
        to: 'root' | 'stage' | 'previous',
    ): Promise<LinuxModelView>;
}
/** Native backend primitives keep their own unqualified tag; never relabel them as memory. */
export type LinuxNativeEffects = Omit<LinuxMemoryEffects, 'kind'> & {
    kind: 'native-unqualified';
};
type LinuxTransactionEffects = LinuxMemoryEffects | LinuxNativeEffects;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const canonical = (value: string) =>
    typeof value === 'string' &&
    value.length > 1 &&
    value.length <= 240 &&
    value.startsWith('/') &&
    path.posix.normalize(value) === value &&
    !/[\\\x00-\x1f\x7f]/.test(value);
const inside = (parent: string, child: string) =>
    child === parent || child.startsWith(parent + '/');
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
function fields(value: object, allowed: readonly string[]) {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== allowed.length ||
        Object.keys(value).some((key) => !allowed.includes(key))
    )
        throw Error('closed model grammar');
}
function copy<T>(value: T): T {
    const bytes = JSON.stringify(value);
    // Current slots and bounded retained/cleanup history share this unchanged byte limit.
    if (
        !bytes ||
        Buffer.byteLength(bytes) >
            MAX_INSTALLATION_MANIFEST_BYTES * (7 + MAX_LINUX_RETAINED_GENERATIONS) + 262144
    )
        throw Error('model input bound');
    return JSON.parse(bytes) as T;
}
/** Canonical review binding, independent of object insertion order. */
function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, ordered(item)]),
        );
    return value;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
export const linuxModelReviewSHA256 = (view: LinuxModelView) =>
    digest(JSON.stringify(ordered(copy(view))));
function owner(value: LinuxModelOwner) {
    fields(value, ['pid', 'startTicks', 'executable']);
    if (
        !positive(value.pid) ||
        typeof value.startTicks !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(value.startTicks) ||
        !canonical(value.executable)
    )
        throw Error('model owner');
}
function identity(value: LinuxModelIdentity, uid: number) {
    fields(value, ['dev', 'ino', 'uid']);
    if (
        !Number.isSafeInteger(value.dev) ||
        value.dev < 0 ||
        !positive(value.ino) ||
        value.uid !== uid
    )
        throw Error('model inode owner');
}
function manifest(value: InstallationManifest) {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_INSTALLATION_MANIFEST_BYTES)
        throw Error('manifest bound');
    const parsed = validateInstallationManifest(value);
    if (
        parsed.layout !== 'linux-folder' ||
        parsed.platform !== 'linux' ||
        parsed.arch !== 'x64' ||
        parsed.files.some((file) => file.kind !== 'file')
    )
        throw Error('model Linux layout');
    return parsed;
}
function manifestDigest(value: InstallationManifest) {
    return digest(JSON.stringify(manifest(value)));
}
function source(value: LinuxModelSource, uid: number, payload = false) {
    fields(
        value,
        payload
            ? [
                  'identity',
                  'manifest',
                  'verifiedManifestSHA256',
                  'installationId',
                  'transactionId',
                  'root',
                  'profile',
                  ...(Object.hasOwn(value, 'menu') ? ['menu'] : []),
              ]
            : ['identity', 'manifest', 'verifiedManifestSHA256'],
    );
    identity(value.identity, uid);
    if (manifestDigest(value.manifest) !== value.verifiedManifestSHA256)
        throw Error('model unverified bytes');
}
function profile(plan: LinuxModelConfiguration) {
    return path.posix.join(plan.host.appData, 'DiagnosticHub', 'profiles', plan.installationId);
}
function validateView(
    view: LinuxModelView,
    plan: LinuxModelConfiguration,
    historicalConfirmed = false,
) {
    fields(view, [
        'activity',
        'parents',
        'source',
        'root',
        'stage',
        'previous',
        'journal',
        ...(Object.hasOwn(view, 'history') ? ['history'] : []),
        ...(Object.hasOwn(plan, 'menu') ? ['menu'] : []),
    ]);
    if (Object.hasOwn(plan, 'menu')) checkedLinuxMenuView(view.menu, plan.host.uid);
    fields(view.activity, ['root', 'stage', 'previous']);
    if (Object.values(view.activity).some((state) => state !== 'inactive'))
        throw Error('busy or uninspectable model slot');
    source(view.source, plan.host.uid);
    if (view.source.manifest.version !== plan.host.version) throw Error('source version');
    const expectedParents = new Set<string>(['/']);
    for (const target of [
        path.posix.dirname(plan.root),
        plan.host.sourceRoot,
        plan.host.appData,
        ...(plan.menu ? [path.posix.join(plan.menu.dataHome, 'applications')] : []),
    ]) {
        let cursor = target;
        for (;;) {
            expectedParents.add(cursor);
            if (cursor === '/') break;
            cursor = path.posix.dirname(cursor);
        }
    }
    if (!Array.isArray(view.parents) || view.parents.length !== expectedParents.size)
        throw Error('complete parent identities required');
    const seen = new Set<string>();
    for (const parent of view.parents) {
        fields(parent, ['path', 'dev', 'ino', 'uid', 'mode']);
        if (
            !expectedParents.has(parent.path) ||
            seen.has(parent.path) ||
            !positive(parent.ino) ||
            !Number.isSafeInteger(parent.dev) ||
            parent.dev < 0 ||
            !Number.isSafeInteger(parent.mode) ||
            (parent.mode & 0o170000) !== 0o40000 ||
            (parent.mode & 0o7022) !== 0 ||
            (inside(plan.host.home, parent.path)
                ? parent.uid !== plan.host.uid
                : parent.uid !== 0 && parent.uid !== plan.host.uid)
        )
            throw Error('unsafe model parent');
        seen.add(parent.path);
    }
    const sourceParent = view.parents.find((parent) => parent.path === plan.host.sourceRoot)!;
    if (
        !equal(view.source.identity, {
            dev: sourceParent.dev,
            ino: sourceParent.ino,
            uid: sourceParent.uid,
        })
    )
        throw Error('source parent binding differs');
    const inodeKeys = view.parents.map((item) => item.dev + ':' + item.ino);
    if (new Set(inodeKeys).size !== inodeKeys.length) throw Error('aliased model parents');
    for (const slot of [view.root, view.stage, view.previous])
        if (slot !== null) {
            source(slot, plan.host.uid, true);
            if (Object.hasOwn(slot, 'menu')) {
                if (!plan.menu) throw Error('menu ownership requires menu review');
                checkedLinuxMenuRecord(slot.menu, plan);
            }
            if (
                slot.root !== plan.root ||
                slot.installationId !== plan.installationId ||
                !uuid.test(slot.transactionId) ||
                slot.profile !== profile(plan)
            )
                throw Error('foreign model payload');
            const key = slot.identity.dev + ':' + slot.identity.ino;
            if (inodeKeys.includes(key)) throw Error('aliased model slots');
            inodeKeys.push(key);
        }
    if (plan.menu)
        for (const file of Object.values(view.menu!))
            if (file !== null) {
                const key = file.identity.dev + ':' + file.identity.ino;
                if (inodeKeys.includes(key)) throw Error('aliased model menu file');
                inodeKeys.push(key);
            }
    if (Object.hasOwn(view, 'history')) {
        if (!view.history) throw Error('model history required');
        fields(view.history, [
            'journalOriginal',
            'completed',
            ...(Object.hasOwn(view.history, 'lineage') ? ['lineage'] : []),
            ...(Object.hasOwn(view.history, 'cleanup') ? ['cleanup'] : []),
        ]);
        const original = (
            value: { base64: string; sha256: string; journal?: LinuxModelJournal },
            journal: LinuxModelJournal,
            completed = false,
        ) => {
            fields(value, ['base64', 'sha256', ...(completed ? ['journal'] : [])]);
            if (
                typeof value.base64 !== 'string' ||
                value.base64.length > 10924 ||
                !hash.test(value.sha256)
            )
                throw Error('journal original bound');
            const bytes = Buffer.from(value.base64, 'base64');
            if (
                !bytes.length ||
                bytes.length > 8192 ||
                bytes.toString('base64') !== value.base64 ||
                createHash('sha256').update(bytes).digest('hex') !== value.sha256 ||
                !equal(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), journal)
            )
                throw Error('journal original differs');
        };
        if (
            view.journal === null
                ? view.history.journalOriginal !== null
                : view.history.journalOriginal === null
        )
            throw Error('journal original missing');
        if (view.history.journalOriginal) original(view.history.journalOriginal, view.journal!);
        if (view.history.completed) {
            const prior = view.history.completed;
            original(prior, prior.journal, true);
            // Validate retained journal grammar under its own old transaction, without claiming it current.
            const { history: _history, ...withoutHistory } = copy(view);
            validateView(
                { ...withoutHistory, journal: prior.journal } as LinuxModelView,
                {
                    ...completedJournalContext(plan, prior.journal),
                    transactionId: prior.journal.transactionId,
                },
                true,
            );
            if (
                prior.journal.phase !== 'candidate-confirmed' &&
                (prior.journal.phase !== 'candidate-active' ||
                    prior.journal.previousSHA256 !== null)
            )
                throw Error('completed journal phase differs');
        }
        if (Object.hasOwn(view.history, 'cleanup')) {
            const cleanup = view.history.cleanup!;
            fields(cleanup, [
                'configuration',
                'initial',
                'snapshotSHA256',
                'entries',
                'progress',
                ...(Object.hasOwn(cleanup, 'seal') ? ['seal'] : []),
            ]);
            fields(cleanup.progress, ['phase', 'index', 'leaf']);
            if (Object.hasOwn(cleanup, 'seal')) {
                const seal = cleanup.seal!;
                fields(seal, ['intentSHA256', 'state']);
                if (
                    cleanup.progress.phase !== 'complete' ||
                    !hash.test(seal.intentSHA256) ||
                    !['preparing', 'ready', 'gap', 'published'].includes(seal.state)
                )
                    throw Error('unsupported confirmed seal');
            }
            validateConfiguration(cleanup.configuration);
            if (
                cleanup.initial.history?.cleanup?.initial.history?.cleanup ||
                cleanup.configuration.action !== 'finalize' ||
                cleanup.configuration.root !== plan.root ||
                cleanup.configuration.host.uid !== plan.host.uid ||
                cleanup.configuration.host.home !== plan.host.home ||
                cleanup.configuration.host.appData !== plan.host.appData ||
                cleanup.configuration.installationId !== plan.installationId ||
                !hash.test(cleanup.snapshotSHA256) ||
                !Number.isInteger(cleanup.entries) ||
                cleanup.entries < 1 ||
                cleanup.entries > 20010 ||
                !Number.isInteger(cleanup.progress.index) ||
                cleanup.progress.index < 0 ||
                cleanup.progress.index > cleanup.entries ||
                ![
                    'prepared',
                    'previous-issued',
                    'previous-retained',
                    'deleting',
                    'complete',
                ].includes(cleanup.progress.phase) ||
                !['source', 'move-issued', 'staged', 'unlink-issued'].includes(
                    cleanup.progress.leaf,
                ) ||
                (cleanup.progress.phase !== 'deleting' &&
                    (cleanup.progress.phase === 'complete'
                        ? cleanup.progress.index !== cleanup.entries ||
                          cleanup.progress.leaf !== 'source'
                        : cleanup.progress.index !== 0 || cleanup.progress.leaf !== 'source'))
            )
                throw Error('unsupported predecessor cleanup');
            validateView(cleanup.initial, cleanup.configuration);
            assertLinuxRetainedFinalizePreimages(cleanup.initial, cleanup.configuration);
            const original = cleanup.initial.journal!,
                confirmed = { ...copy(original), phase: 'candidate-confirmed' };
            if (cleanup.progress.phase !== 'complete') {
                if (
                    !equal(view.root, cleanup.initial.root) ||
                    view.stage ||
                    (view.previous !== null && !equal(view.previous, cleanup.initial.previous)) ||
                    !equal(view.journal, original) ||
                    !equal(view.history.completed, cleanup.initial.history!.completed) ||
                    view.history.lineage?.length ||
                    !equal(view.source.manifest, cleanup.initial.source.manifest)
                )
                    throw Error('pending predecessor cleanup differs');
            } else {
                const anchor =
                    view.journal?.transactionId === original.transactionId
                        ? view.journal
                        : view.history.completed?.journal;
                const gap =
                    cleanup.seal?.state === 'gap' &&
                    !view.journal &&
                    !view.history.completed &&
                    !view.previous &&
                    !view.stage &&
                    equal(view.root, cleanup.initial.root);
                if (
                    !gap &&
                    (!anchor ||
                        (!equal(anchor, original) && !equal(anchor, confirmed)) ||
                        (anchor.phase === 'candidate-active' &&
                            !equal(view.root, cleanup.initial.root)) ||
                        (cleanup.seal?.state === 'published' && !equal(anchor, confirmed)) ||
                        (cleanup.seal &&
                            cleanup.seal.state !== 'published' &&
                            !equal(anchor, original)))
                )
                    throw Error('completed predecessor cleanup anchor differs');
            }
        }
        if (Object.hasOwn(view.history, 'lineage')) {
            const lineage = view.history.lineage!;
            if (
                Object.hasOwn(plan, 'menu') ||
                !view.history.completed ||
                !Array.isArray(lineage) ||
                !lineage.length ||
                lineage.length > MAX_LINUX_RETAINED_GENERATIONS ||
                [view.root, view.stage, view.previous].some(
                    (slot) => slot && Object.hasOwn(slot, 'menu'),
                )
            )
                throw Error('unsupported retained lineage');
            let prior = view.history.completed.journal;
            const transactions = new Set([prior.transactionId]);
            for (let index = 0; index < lineage.length; index++) {
                const entry = lineage[index];
                fields(entry, ['archived', 'base64', 'sha256', 'journal', 'previous', 'activity']);
                if (
                    typeof entry.archived !== 'boolean' ||
                    entry.activity !== 'inactive' ||
                    (!entry.archived && index !== lineage.length - 1) ||
                    Object.hasOwn(entry.journal, 'menu') ||
                    Object.hasOwn(entry.previous, 'menu')
                )
                    throw Error('unsupported retained generation');
                original(
                    { base64: entry.base64, sha256: entry.sha256, journal: entry.journal },
                    entry.journal,
                    true,
                );
                const { history: _history, ...withoutHistory } = copy(view);
                validateView({ ...withoutHistory, journal: entry.journal } as LinuxModelView, {
                    ...plan,
                    transactionId: entry.journal.transactionId,
                });
                source(entry.previous, plan.host.uid, true);
                const previous = entry.previous;
                if (
                    entry.journal.phase !== 'candidate-active' ||
                    transactions.has(entry.journal.transactionId) ||
                    entry.journal.previousSHA256 !== prior.candidateSHA256 ||
                    previous.transactionId !== prior.transactionId ||
                    previous.verifiedManifestSHA256 !== prior.candidateSHA256 ||
                    previous.installationId !== plan.installationId ||
                    previous.root !== plan.root ||
                    previous.profile !== profile(plan)
                )
                    throw Error('retained generation chain differs');
                const key = previous.identity.dev + ':' + previous.identity.ino;
                if (inodeKeys.includes(key)) throw Error('aliased retained generation');
                inodeKeys.push(key);
                transactions.add(entry.journal.transactionId);
                prior = entry.journal;
                if (
                    !entry.archived &&
                    (!equal(view.journal, entry.journal) ||
                        !equal(view.history.journalOriginal, {
                            base64: entry.base64,
                            sha256: entry.sha256,
                        }))
                )
                    throw Error('current retained original differs');
            }
            const last = lineage[lineage.length - 1];
            if (
                last.archived &&
                view.journal &&
                (transactions.has(view.journal.transactionId) ||
                    view.journal.previousSHA256 !== last.journal.candidateSHA256)
            )
                throw Error('current generation does not follow retained history');
            if (last.archived && view.journal) {
                const predecessor = (slot: LinuxModelPayload | null) =>
                    slot !== null &&
                    slot.transactionId === last.journal.transactionId &&
                    slot.verifiedManifestSHA256 === last.journal.candidateSHA256;
                const restored = predecessor(view.root) && view.previous === null;
                const retained = predecessor(view.previous);
                const phase = view.journal.phase;
                const bound =
                    phase === 'copying' || phase === 'rolled-back'
                        ? restored
                        : phase === 'prepared' || phase === 'candidate-retained'
                          ? restored || (view.root === null && retained)
                          : ['old-retained', 'candidate-active', 'rollback-started'].includes(
                                phase,
                            ) && retained;
                if (!bound) throw Error('current predecessor differs from retained journal');
            }
        }
    }
    if (view.journal !== null) {
        const journal = view.journal;
        if (Buffer.byteLength(JSON.stringify(journal)) > 8192) throw Error('model journal bound');
        fields(journal, [
            'schemaVersion',
            'root',
            'uid',
            'transactionId',
            'installationId',
            'profile',
            'candidateSHA256',
            'previousSHA256',
            'owner',
            'phase',
            ...(plan.menu ? ['menu'] : []),
        ]);
        if (plan.menu)
            checkedLinuxMenuJournal(
                journal.menu,
                view.history && journal.transactionId !== plan.transactionId
                    ? completedJournalContext(plan, journal)
                    : plan,
            );
        owner(journal.owner);
        if (
            journal.schemaVersion !== 1 ||
            journal.root !== plan.root ||
            journal.uid !== plan.host.uid ||
            (journal.transactionId !== plan.transactionId &&
                !(
                    view.history &&
                    (view.history.completed === null ||
                        (view.history.lineage?.at(-1)?.archived === false &&
                            equal(view.history.lineage.at(-1)!.journal, journal))) &&
                    ['install', 'repair', 'update'].includes(plan.action) &&
                    completedRoot(view, journal)
                )) ||
            journal.installationId !== plan.installationId ||
            journal.profile !== profile(plan) ||
            !hash.test(journal.candidateSHA256) ||
            !(journal.previousSHA256 === null || hash.test(journal.previousSHA256)) ||
            ![
                'copying',
                'prepared',
                'old-retained',
                'candidate-active',
                'candidate-confirmed',
                'rollback-started',
                'candidate-retained',
                'rolled-back',
            ].includes(journal.phase)
        )
            throw Error('foreign model journal');
    }
    if (
        !historicalConfirmed &&
        (view.journal?.phase === 'candidate-confirmed' ||
            view.history?.completed?.journal.phase === 'candidate-confirmed') &&
        !view.history?.cleanup
    )
        throw Error('confirmed generation lacks cleanup history');
}
/** Exact first completed installation, with no retained predecessor or uncommitted candidate. */
function completedRoot(view: LinuxModelView, journal: LinuxModelJournal) {
    const retained = view.history?.lineage?.at(-1);
    return (
        ['candidate-active', 'candidate-confirmed'].includes(journal.phase) &&
        (journal.phase === 'candidate-confirmed' ||
            journal.previousSHA256 === null ||
            (retained && equal(retained.journal, journal))) &&
        view.stage === null &&
        view.previous === null &&
        view.root !== null &&
        view.root.transactionId === journal.transactionId &&
        view.root.verifiedManifestSHA256 === journal.candidateSHA256 &&
        (!journal.menu ||
            (journal.menu.phase === 'applied' &&
                view.menu?.candidate === null &&
                view.menu?.previous === null))
    );
}
/** An old journal keeps its old menu intent when a fresh upgrade selects a different menu choice. */
function completedJournalContext(
    plan: LinuxModelConfiguration,
    journal: LinuxModelJournal,
): LinuxModelConfiguration {
    return plan.menu && journal.menu
        ? { ...plan, menu: { ...plan.menu, selected: journal.menu.after !== null } }
        : plan;
}
/** Complete app preimage admission BEFORE any menu rollback write/move. No effects. */
function assertLinuxAppRollbackPreimages(view: LinuxModelView) {
    const journal = view.journal;
    if (
        !journal ||
        !['candidate-active', 'rollback-started', 'candidate-retained', 'rolled-back'].includes(
            journal.phase,
        )
    )
        throw Error('unsupported app rollback phase');
    const candidate = (slot: LinuxModelPayload | null) =>
        slot !== null &&
        slot.transactionId === journal.transactionId &&
        slot.verifiedManifestSHA256 === journal.candidateSHA256;
    const previous = (slot: LinuxModelPayload | null) =>
        slot !== null &&
        slot.transactionId !== journal.transactionId &&
        slot.verifiedManifestSHA256 === journal.previousSHA256;
    const priorRetained =
        journal.previousSHA256 === null ? view.previous === null : previous(view.previous);
    const candidateActive = candidate(view.root) && view.stage === null && priorRetained;
    const candidateMoved = view.root === null && candidate(view.stage) && priorRetained;
    const previousRestored =
        candidate(view.stage) &&
        (journal.previousSHA256 === null
            ? view.root === null && view.previous === null
            : previous(view.root) && view.previous === null);
    const valid =
        journal.phase === 'candidate-active'
            ? candidateActive
            : journal.phase === 'rollback-started'
              ? candidateActive || candidateMoved
              : journal.phase === 'candidate-retained'
                ? candidateMoved || previousRestored
                : previousRestored;
    if (!valid) throw Error('app rollback preimage differs');
    if (journal.menu && journal.phase !== 'candidate-active' && journal.menu.phase !== 'restored')
        throw Error('app and menu rollback phases differ');
}
/** Match only an acknowledged menu phase or the physical result of its single submitted primitive. */
function linuxMenuResumePhase(view: LinuxModelView, plan: LinuxModelPlan): LinuxMenuPhase {
    const journal = view.journal?.menu;
    if (!plan.menu || !journal || !view.menu || view.journal!.phase !== 'candidate-active')
        throw Error('menu recovery unavailable');
    const phases: LinuxMenuPhase[] =
        journal.phase === 'pending'
            ? [
                  'pending',
                  ...(['create', 'replace'].includes(journal.action)
                      ? ['staged' as const]
                      : journal.action === 'deselect'
                        ? ['retained' as const]
                        : []),
              ]
            : journal.phase === 'staged' && ['create', 'replace'].includes(journal.action)
              ? ['staged', journal.action === 'replace' ? 'retained' : 'applied']
              : journal.phase === 'retained' && ['replace', 'deselect'].includes(journal.action)
                ? ['retained', 'applied']
                : journal.phase === 'applied'
                  ? ['applied']
                  : [];
    for (const phase of phases) {
        try {
            assertLinuxMenuPhase(view.menu, { ...journal, phase }, plan);
            return phase;
        } catch {
            /* No IO: another exact preimage may describe the one unjournalled primitive. */
        }
    }
    throw Error('menu recovery preimage differs');
}
/** Explicit forward recovery of complete payloads/menu files only. No partial copy or stale lock removal. */
function assertLinuxResumePreimages(view: LinuxModelView, plan: LinuxModelPlan) {
    const journal = view.journal;
    if (!journal || !['prepared', 'old-retained', 'candidate-active'].includes(journal.phase))
        throw Error('unsupported app resume phase');
    if (journal.candidateSHA256 !== view.source.verifiedManifestSHA256)
        throw Error('resume source differs');
    const expectedCandidate = {
        manifest: view.source.manifest,
        verifiedManifestSHA256: journal.candidateSHA256,
        installationId: plan.installationId,
        transactionId: journal.transactionId,
        root: plan.root,
        profile: profile(plan),
        ...(journal.menu?.after ? { menu: journal.menu.after } : {}),
    };
    const candidate = (slot: LinuxModelPayload | null) =>
        slot !== null &&
        equal({ ...slot, identity: undefined }, { ...expectedCandidate, identity: undefined });
    const previous = (slot: LinuxModelPayload | null) =>
        slot !== null &&
        slot.transactionId !== journal.transactionId &&
        slot.verifiedManifestSHA256 === journal.previousSHA256;
    const priorRetained =
        journal.previousSHA256 === null ? view.previous === null : previous(view.previous);
    const beforeRetention =
        candidate(view.stage) &&
        view.previous === null &&
        (journal.previousSHA256 === null ? view.root === null : previous(view.root));
    const beforeActivation = candidate(view.stage) && view.root === null && priorRetained;
    const afterActivation = candidate(view.root) && view.stage === null && priorRetained;
    if (
        !(journal.phase === 'prepared'
            ? beforeRetention || beforeActivation
            : journal.phase === 'old-retained'
              ? beforeActivation || afterActivation
              : afterActivation)
    )
        throw Error('app resume preimage differs');
    const prior = journal.phase === 'prepared' && view.root !== null ? view.root : view.previous;
    const actions = installationActions(
        prior?.manifest.version ?? null,
        view.source.manifest.version,
    );
    if (!actions.some((action) => ['install', 'repair', 'update'].includes(action)))
        throw Error('resume version differs');
    if (journal.phase === 'candidate-active') {
        if (
            !plan.menu ||
            !journal.menu ||
            !sameLinuxMenu(
                { ...journal.menu, phase: 'pending' },
                prepareLinuxMenuJournal(plan, prior?.menu ?? null, journal.menu.beforeFile),
            )
        )
            throw Error('menu recovery ownership differs');
        linuxMenuResumePhase(view, plan);
        return;
    }
    if (plan.menu) {
        // Before app activation, no menu primitive could have been submitted. Keep its exact preimage.
        if (
            journal.menu?.phase !== 'pending' ||
            !sameLinuxMenu(
                journal.menu,
                prepareLinuxMenuJournal(plan, prior?.menu ?? null, view.menu!.current),
            )
        )
            throw Error('unsupported menu resume preimage');
        assertLinuxMenuPhase(view.menu!, journal.menu, plan);
    }
}
function assertLinuxLaunchPreimages(view: LinuxModelView, plan: LinuxModelConfiguration) {
    if (
        !view.root ||
        view.stage ||
        view.root.transactionId !== plan.transactionId ||
        view.root.verifiedManifestSHA256 !== view.source.verifiedManifestSHA256 ||
        !equal(view.root.manifest, view.source.manifest)
    )
        throw Error('launch payload differs');
    const cleanup = view.history?.cleanup;
    if (cleanup?.seal && cleanup.seal.state !== 'published' && plan.action !== 'finalize')
        throw Error('issued confirmed seal requires Finalize recovery');
    if (cleanup && cleanup.progress.phase !== 'complete' && plan.action !== 'finalize')
        throw Error('predecessor cleanup requires Finalize recovery');
    if (view.journal) {
        if (view.journal.phase === 'candidate-confirmed') {
            if (!cleanup || cleanup.progress.phase !== 'complete' || view.previous || plan.menu)
                throw Error('confirmed launch lacks complete predecessor cleanup');
        } else {
            if (view.journal.phase !== 'candidate-active') throw Error('launch phase differs');
            if (cleanup && cleanup.configuration.transactionId === view.journal.transactionId) {
                if (plan.action !== 'finalize') throw Error('predecessor cleanup seal pending');
            } else assertLinuxAppRollbackPreimages(view);
        }
        if (plan.menu && view.journal.menu!.phase !== 'applied')
            throw Error('launch menu incomplete');
    } else {
        if (view.previous) throw Error('launch retention lacks journal');
        if (
            plan.menu &&
            !['unchanged', 'retain-absent', 'retain-foreign'].includes(
                prepareLinuxMenuJournal(plan, view.root.menu ?? null, view.menu!.current).action,
            )
        )
            throw Error('launch menu differs');
    }
}
/** No-menu predecessor removal, initially or over one already published predecessor seal. */
export function assertLinuxRetainedFinalizePreimages(
    view: LinuxModelView,
    plan: LinuxModelConfiguration,
) {
    assertLinuxLaunchPreimages(view, plan);
    const journal = view.journal,
        completed = view.history?.completed,
        parent = view.history?.cleanup;
    const publishedParent = Boolean(
        parent &&
        completed &&
        parent.progress.phase === 'complete' &&
        parent.progress.index === parent.entries &&
        parent.progress.leaf === 'source' &&
        parent.seal?.state === 'published' &&
        !parent.initial.history?.cleanup &&
        !parent.initial.history?.lineage?.length &&
        parent.configuration.transactionId === completed.journal.transactionId &&
        parent.configuration.installationId === plan.installationId &&
        equal(parent.initial.root, view.previous) &&
        equal(completed.journal, { ...parent.initial.journal, phase: 'candidate-confirmed' }),
    );
    if (
        plan.menu ||
        view.root?.menu ||
        view.stage ||
        !view.previous ||
        view.history?.lineage?.length ||
        (parent && !publishedParent) ||
        !journal ||
        journal.phase !== 'candidate-active' ||
        journal.previousSHA256 === null ||
        !view.history?.journalOriginal ||
        !completed ||
        (!publishedParent &&
            (completed.journal.previousSHA256 !== null ||
                completed.journal.phase !== 'candidate-active')) ||
        journal.previousSHA256 !== completed.journal.candidateSHA256 ||
        view.previous.transactionId !== completed.journal.transactionId ||
        view.previous.verifiedManifestSHA256 !== journal.previousSHA256 ||
        journal.transactionId !== view.root!.transactionId ||
        journal.installationId !== view.root!.installationId ||
        Object.values(view.activity).some((value) => value !== 'inactive')
    )
        throw Error('LINUX_FINALIZE_FIRST_PREDECESSOR_NO_MENU_REQUIRED');
}
export function assertLinuxFinalizePreimages(view: LinuxModelView, plan: LinuxModelConfiguration) {
    if (
        view.history?.cleanup &&
        (view.history.cleanup.configuration.transactionId === view.journal?.transactionId ||
            (view.journal === null &&
                view.history.cleanup.configuration.transactionId === view.root?.transactionId))
    ) {
        assertLinuxLaunchPreimages(view, plan);
        if (
            plan.menu ||
            view.stage ||
            view.history.lineage?.length ||
            Object.values(view.activity).some((value) => value !== 'inactive')
        )
            throw Error('LINUX_FINALIZE_RECOVERY_SELECTION');
    } else if (view.journal?.previousSHA256 !== null && view.journal) {
        assertLinuxRetainedFinalizePreimages(view, plan);
    } else assertLinuxInitialFinalizePreimages(view, plan);
}
/** Initial-only completion has no retained payload to discard. Originals remain intact. */
export function assertLinuxInitialFinalizePreimages(
    view: LinuxModelView,
    plan: LinuxModelConfiguration,
) {
    assertLinuxLaunchPreimages(view, plan);
    const journal = view.journal ?? view.history?.completed?.journal;
    if (
        plan.menu ||
        view.root?.menu ||
        view.stage ||
        view.previous ||
        view.history?.lineage?.length ||
        Object.values(view.activity).some((value) => value !== 'inactive') ||
        !view.history ||
        !journal ||
        journal.phase !== 'candidate-active' ||
        journal.previousSHA256 !== null ||
        journal.transactionId !== view.root!.transactionId ||
        journal.installationId !== view.root!.installationId ||
        journal.candidateSHA256 !== view.root!.verifiedManifestSHA256 ||
        (view.journal
            ? Boolean(view.history.completed) || !view.history.journalOriginal
            : !view.history.completed)
    )
        throw Error('LINUX_FINALIZE_INITIAL_NO_MENU_REQUIRED');
}
function validatePlan(plan: LinuxModelPlan) {
    fields(plan, [
        'host',
        'root',
        'action',
        'transactionId',
        'installationId',
        'owner',
        'consent',
        'review',
        'reviewSHA256',
        ...(Object.hasOwn(plan, 'menu') ? ['menu'] : []),
    ]);
    validateConfiguration(plan);
    if (plan.consent !== true || !hash.test(plan.reviewSHA256)) throw Error('model plan admission');
    validateView(plan.review, plan);
    if (plan.action === 'rollback') assertLinuxAppRollbackPreimages(plan.review);
    if (plan.action === 'resume') assertLinuxResumePreimages(plan.review, plan);
    if (plan.action === 'launch') assertLinuxLaunchPreimages(plan.review, plan);
    if (plan.action === 'finalize') assertLinuxFinalizePreimages(plan.review, plan);
    const cleanup = plan.review.history?.cleanup;
    if (cleanup) {
        const current = cleanup.configuration.transactionId === plan.review.journal?.transactionId,
            pending =
                cleanup.progress.phase !== 'complete' ||
                (current && plan.review.journal?.phase === 'candidate-active') ||
                (cleanup.seal && cleanup.seal.state !== 'published');
        if (
            (plan.action === 'rollback' && current) ||
            (!['finalize', 'launch'].includes(plan.action) && pending)
        )
            throw Error('pending predecessor cleanup requires Finalize');
    }
    if (
        plan.menu &&
        plan.review.journal &&
        !(plan.action === 'resume' && plan.review.journal.phase === 'candidate-active')
    )
        assertLinuxMenuPhase(
            plan.review.menu!,
            plan.review.journal.menu!,
            plan.review.history && plan.review.journal.transactionId !== plan.transactionId
                ? completedJournalContext(plan, plan.review.journal)
                : plan,
        );
    if (plan.menu && plan.review.journal === null && plan.action !== 'rollback') {
        if (plan.review.menu!.candidate !== null || plan.review.menu!.previous !== null)
            throw Error('foreign menu retention slots');
        prepareLinuxMenuJournal(plan, plan.review.root?.menu ?? null, plan.review.menu!.current);
    }
    if (linuxModelReviewSHA256(plan.review) !== plan.reviewSHA256)
        throw Error('changed model review');
}
function validateConfiguration(plan: LinuxModelConfiguration) {
    fields(plan.host, [
        'platform',
        'arch',
        'uid',
        'euid',
        'home',
        'appData',
        'sourceRoot',
        'version',
    ]);
    const host = plan.host;
    if (
        host.platform !== 'linux' ||
        host.arch !== 'x64' ||
        !positive(host.uid) ||
        host.euid !== host.uid ||
        ![plan.root, host.home, host.sourceRoot, host.appData].every(canonical) ||
        ![plan.root, host.sourceRoot, host.appData].every(
            (item) => item !== host.home && inside(host.home, item),
        ) ||
        inside(plan.root, host.sourceRoot) ||
        inside(host.sourceRoot, plan.root) ||
        inside(plan.root, host.appData) ||
        inside(host.appData, plan.root) ||
        path.posix.basename(plan.root).startsWith('.DiagnosticHub-') ||
        !uuid.test(plan.transactionId) ||
        !uuid.test(plan.installationId) ||
        ![
            'install',
            'repair',
            'update',
            'rollback',
            'resume',
            'launch',
            'uninstall-current',
            'finalize',
        ].includes(plan.action)
    )
        throw Error('model plan admission');
    owner(plan.owner);
    if (plan.owner.executable !== path.posix.join(host.sourceRoot, 'app/diagnostic-hub'))
        throw Error('model runtime binding');
    if (Object.hasOwn(plan, 'menu')) checkedLinuxMenuChoice(plan);
}
export type LinuxModelVerdict =
    'REFUSED' | 'RETAINED_UNKNOWN' | 'ACTIVE_PREVIOUS_RETAINED' | 'ROLLED_BACK_RETAINED';
type Pending =
    | 'reserve'
    | 'current'
    | 'observe'
    | 'journal'
    | 'handoff'
    | 'stage'
    | 'move'
    | 'menu-stage'
    | 'menu-move'
    | 'release'
    | null;
/** Shared guarded algorithm. Neither wrapper registers a production/native entry point. */
class LinuxTransactionCore {
    private used = false;
    private lastReturned: unknown = null; // Includes malformed/late resource returns; never exposed in summaries.
    private lease: LinuxModelLease | null = null;
    private leaseIdentity: LinuxReservationIdentity | null = null;
    private view: LinuxModelView | null = null;
    private state: {
        verdict: LinuxModelVerdict;
        phase: string;
        pending: Pending;
        reservation: 'none' | 'held' | 'released' | 'unknown';
        reason: string;
    } = {
        verdict: 'REFUSED',
        phase: 'unstarted',
        pending: null,
        reservation: 'none',
        reason: 'NOT_STARTED',
    };
    private kernel: LinuxModelKernel;
    private effects: LinuxTransactionEffects;
    constructor(
        kernel: LinuxModelKernel,
        effects: LinuxTransactionEffects,
        private readonly effectKind: LinuxTransactionEffects['kind'],
    ) {
        this.kernel = kernel;
        this.effects = effects;
    }
    summary() {
        if (this.effectKind === 'native-unqualified')
            return {
                modelOnly: false as const,
                nativeQualified: false as const,
                productionDispatch: false as const,
                ...this.state,
            };
        return { modelOnly: true as const, ...this.state };
    }
    private async call<T>(
        name: Pending,
        operation: () => Promise<T>,
        retain: (value: T) => void = () => {},
    ) {
        this.state.pending = name;
        const value = await operation();
        this.lastReturned = value;
        retain(value); // Keep returned handles/snapshots BEFORE validation or any later effect.
        this.state.pending = null;
        return value;
    }
    private async guard(plan: LinuxModelPlan, scope: LinuxModelScope) {
        if (!this.lease || !this.leaseIdentity || !this.view) throw Error('missing model custody');
        const current = copy(
            await this.call('current', () => this.kernel.current(this.lease!.handle)),
        );
        if (!equal(current, this.leaseIdentity)) throw Error('reservation identity changed');
        const observed = copy(await this.call('observe', () => this.effects.observe(copy(scope))));
        validateView(observed, plan);
        if (!equal(observed, this.view)) throw Error('guarded model state changed');
    }
    async run(input: LinuxModelPlan) {
        if (this.used) throw Error('This transaction invocation is consumed; no retry.');
        this.used = true;
        let plan: LinuxModelPlan;
        try {
            plan = copy(input);
            validatePlan(plan);
            if (
                plan.action === 'launch' ||
                plan.action === 'uninstall-current' ||
                plan.action === 'finalize'
            )
                throw Error('operation requires its separate owned controller');
            if (this.effects.kind !== this.effectKind)
                throw Error('transaction effects kind differs');
            if (
                plan.menu &&
                (typeof this.effects.menuStage !== 'function' ||
                    typeof this.effects.menuMove !== 'function')
            )
                throw Error('menu effects unavailable');
        } catch {
            this.state.reason = 'ADMISSION_REFUSED';
            return this.summary();
        }
        const key = 'dh-linux-' + digest(plan.host.uid + '\0' + plan.root);
        const work = path.posix.join(
            path.posix.dirname(plan.root),
            '.DiagnosticHub-maintenance-' + digest(plan.root).slice(0, 20),
        );
        const scope: LinuxModelScope = {
            root: plan.root,
            stage: work + '/stage-' + plan.transactionId,
            previous: work + '/previous-' + plan.transactionId,
            source: plan.host.sourceRoot,
            uid: plan.host.uid,
            key,
        };
        const wanted = { root: plan.root, uid: plan.host.uid, key, owner: copy(plan.owner) };
        try {
            this.state.phase = 'reservation';
            this.state.reservation = 'unknown';
            const lease = await this.call(
                'reserve',
                () => this.kernel.acquire(copy(wanted)),
                (value) => {
                    this.lease = value;
                    this.state.reservation = value === null ? 'none' : 'unknown';
                },
            );
            if (lease === null) {
                this.state.reason = 'RESERVATION_UNAVAILABLE';
                return this.summary();
            }
            fields(lease, ['identity', 'handle']);
            fields(lease.identity, ['root', 'uid', 'key', 'token', 'owner']);
            if (
                !lease.handle ||
                typeof lease.handle !== 'object' ||
                !uuid.test(lease.identity.token) ||
                !equal({ ...lease.identity, token: undefined }, { ...wanted, token: undefined })
            )
                throw Error('foreign reservation');
            this.leaseIdentity = copy(lease.identity);
            // Keep the opaque handle independently; mutation of the returned wrapper cannot redirect release.
            this.lease = { handle: lease.handle, identity: copy(lease.identity) };
            this.state.reservation = 'held';
            this.view = copy(plan.review);
            await this.guard(plan, scope); // Atomic reservation precedes ANY on-disk/state inspection.
            if (plan.action === 'rollback') await this.rollback(plan, scope);
            else if (plan.action === 'resume') await this.resume(plan, scope);
            else await this.install(plan, scope);
            await this.guard(plan, scope);
            this.state.phase = 'releasing';
            this.state.reservation = 'unknown'; // Submission is not proof that the lease was released.
            if (
                (await this.call('release', () =>
                    this.kernel.release(this.lease!.handle, copy(this.leaseIdentity!)),
                )) !== true
            )
                throw Error('lease release uncertain');
            this.state.reservation = 'released';
            this.lease = null;
            this.state.verdict =
                plan.action === 'rollback' ? 'ROLLED_BACK_RETAINED' : 'ACTIVE_PREVIOUS_RETAINED';
            this.state.phase = plan.action === 'rollback' ? 'rolled-back' : 'candidate-active';
            this.state.reason = 'MODEL_COMPLETE';
        } catch {
            this.state.verdict = 'RETAINED_UNKNOWN';
            this.state.reason = 'GUARD_OR_EFFECT_UNCERTAIN';
            if (this.state.pending === 'reserve' || this.state.pending === 'release')
                this.state.reservation = 'unknown';
            // No auto-rollback, release, further observation, diagnostic IO or destructive recovery.
        }
        return this.summary();
    }
    private async journal(plan: LinuxModelPlan, scope: LinuxModelScope, next: LinuxModelJournal) {
        await this.guard(plan, scope);
        const before = copy(this.view!),
            expected = { ...copy(before), journal: copy(next) };
        if (expected.history) {
            const bytes = Buffer.from(JSON.stringify(next));
            expected.history.journalOriginal = {
                base64: bytes.toString('base64'),
                sha256: createHash('sha256').update(bytes).digest('hex'),
            };
        }
        validateView(expected, plan); // Reject closed-grammar/size errors before submitting any write.
        const returned = await this.call(
            'journal',
            () => this.effects.journal(copy(scope), copy(before), copy(next)),
            (value) => {
                this.view = copy(value);
            },
        );
        validateView(returned, plan);
        if (!equal(returned, expected)) throw Error('journal mutation differs');
        this.state.phase = next.phase;
    }
    private async move(
        plan: LinuxModelPlan,
        scope: LinuxModelScope,
        from: 'root' | 'stage' | 'previous',
        to: 'root' | 'stage' | 'previous',
    ) {
        await this.guard(plan, scope);
        const before = copy(this.view!);
        if (!before[from] || before[to] || from === to) throw Error('exclusive owned move refused');
        const expected = { ...copy(before), [to]: copy(before[from]), [from]: null };
        const returned = await this.call(
            'move',
            () => this.effects.move(copy(scope), copy(before), from, to),
            (value) => {
                this.view = copy(value);
            },
        );
        validateView(returned, plan);
        if (!equal(returned, expected)) throw Error('move result differs');
    }
    private async menuPhase(plan: LinuxModelPlan, scope: LinuxModelScope, phase: LinuxMenuPhase) {
        const journal = copy(this.view!.journal!);
        if (!journal.menu) throw Error('menu journal required');
        const next = { ...journal.menu, phase };
        assertLinuxMenuPhase(this.view!.menu!, next, plan);
        await this.journal(plan, scope, { ...journal, menu: next });
    }
    private async menuMove(
        plan: LinuxModelPlan,
        scope: LinuxModelScope,
        from: LinuxMenuSlot,
        to: LinuxMenuSlot,
    ) {
        await this.guard(plan, scope);
        const before = copy(this.view!),
            menu = before.menu!;
        if (!menu[from] || menu[to] !== null || from === to)
            throw Error('exclusive menu move refused');
        const expected = {
            ...copy(before),
            menu: { ...copy(menu), [from]: null, [to]: copy(menu[from]) },
        };
        const returned = await this.call(
            'menu-move',
            () => this.effects.menuMove!(copy(scope), copy(before), from, to),
            (value) => {
                this.view = copy(value);
            },
        );
        validateView(returned, plan);
        if (!equal(returned, expected)) throw Error('menu move differs');
    }
    private async applyMenu(plan: LinuxModelPlan, scope: LinuxModelScope) {
        const menu = this.view!.journal!.menu!;
        if (menu.phase !== 'pending') throw Error('unsupported pending menu recovery');
        if (menu.action === 'create' || menu.action === 'replace') {
            await this.guard(plan, scope);
            const before = copy(this.view!),
                desired = desiredLinuxMenu(plan);
            if (before.menu!.candidate !== null || !sameLinuxMenu(menu.after, desired.record))
                throw Error('menu stage differs');
            const returned = await this.call(
                'menu-stage',
                () =>
                    this.effects.menuStage!(
                        copy(scope),
                        copy(before),
                        copy(desired.record),
                        desired.text,
                    ),
                (value) => {
                    this.view = copy(value);
                },
            );
            validateView(returned, plan);
            const file = returned.menu!.candidate;
            if (
                !file ||
                file.sha256 !== desired.record.sha256 ||
                file.bytes !== desired.record.bytes ||
                !equal({ ...returned, menu: { ...returned.menu!, candidate: null } }, before)
            )
                throw Error('staged menu differs');
            await this.menuPhase(plan, scope, 'staged');
        }
        if (menu.action === 'replace' || menu.action === 'deselect') {
            await this.menuMove(plan, scope, 'current', 'previous');
            await this.menuPhase(plan, scope, 'retained');
        }
        if (menu.action === 'create' || menu.action === 'replace')
            await this.menuMove(plan, scope, 'candidate', 'current');
        await this.menuPhase(plan, scope, 'applied');
    }
    private async resumeMenu(plan: LinuxModelPlan, scope: LinuxModelScope) {
        const physical = linuxMenuResumePhase(this.view!, plan);
        if (physical !== this.view!.journal!.menu!.phase)
            await this.menuPhase(plan, scope, physical);
        const menu = copy(this.view!.journal!.menu!);
        if (menu.phase === 'pending') {
            await this.applyMenu(plan, scope);
            return;
        }
        if (menu.phase === 'staged') {
            if (menu.action === 'replace') {
                await this.menuMove(plan, scope, 'current', 'previous');
                await this.menuPhase(plan, scope, 'retained');
            } else {
                await this.menuMove(plan, scope, 'candidate', 'current');
                await this.menuPhase(plan, scope, 'applied');
                return;
            }
        }
        if (this.view!.journal!.menu!.phase === 'retained') {
            if (menu.action === 'replace') await this.menuMove(plan, scope, 'candidate', 'current');
            await this.menuPhase(plan, scope, 'applied');
        }
    }
    private async rollbackMenu(plan: LinuxModelPlan, scope: LinuxModelScope) {
        const menu = copy(this.view!.journal!.menu!);
        if (menu.phase === 'restored') {
            if (
                !sameLinuxMenu(this.view!.menu!.current, menu.beforeFile) ||
                this.view!.menu!.previous !== null
            )
                throw Error('restored menu differs');
            return;
        }
        // Never guess through interrupted menu writes or lost acknowledgements.
        if (menu.phase !== 'applied') throw Error('unsupported menu recovery phase');
        if (menu.action === 'create' || menu.action === 'replace') {
            const current = this.view!.menu!.current;
            if (
                !current ||
                !menu.after ||
                current.sha256 !== menu.after.sha256 ||
                current.bytes !== menu.after.bytes ||
                this.view!.menu!.candidate !== null
            )
                throw Error('active menu differs');
        } else if (
            !sameLinuxMenu(
                this.view!.menu!.current,
                menu.action === 'deselect' ? null : menu.beforeFile,
            )
        )
            throw Error('unchanged menu differs');
        await this.menuPhase(plan, scope, 'rollback-pending');
        if (menu.action === 'create' || menu.action === 'replace')
            await this.menuMove(plan, scope, 'current', 'candidate');
        await this.menuPhase(plan, scope, 'rollback-candidate-retained');
        if (menu.action === 'replace' || menu.action === 'deselect')
            await this.menuMove(plan, scope, 'previous', 'current');
        if (
            !sameLinuxMenu(this.view!.menu!.current, menu.beforeFile) ||
            this.view!.menu!.previous !== null
        )
            throw Error('restored menu differs');
        await this.menuPhase(plan, scope, 'restored');
    }
    private async install(plan: LinuxModelPlan, scope: LinuxModelScope) {
        let before = copy(this.view!);
        if (
            before.stage ||
            before.previous ||
            !installationActions(
                before.root?.manifest.version ?? null,
                before.source.manifest.version,
            ).includes(plan.action as 'install' | 'repair' | 'update')
        )
            throw Error('unavailable model install');
        if (before.history && before.journal !== null) {
            const pending = before.history.lineage?.at(-1);
            if (
                (before.history.completed !== null && (!pending || pending.archived)) ||
                !completedRoot(before, before.journal) ||
                before.journal.transactionId === plan.transactionId ||
                !this.effects.handoff
            )
                throw Error('completed installation continuation unavailable');
            await this.guard(plan, scope);
            const expected = copy(before);
            if (pending) expected.history!.lineage!.at(-1)!.archived = true;
            else
                expected.history!.completed = {
                    ...expected.history!.journalOriginal!,
                    journal: copy(before.journal),
                };
            expected.history!.journalOriginal = null;
            expected.journal = null;
            validateView(expected, plan);
            const returned = copy(
                await this.call('handoff', () => this.effects.handoff!(copy(scope), copy(before))),
            );
            validateView(returned, plan);
            if (!equal(returned, expected)) throw Error('completed journal handoff differs');
            this.view = returned;
            before = copy(returned);
        }
        if (
            before.history?.completed &&
            !completedRoot(
                before,
                before.history.lineage?.at(-1)?.journal ?? before.history.completed.journal,
            )
        )
            throw Error('completed installation recovery differs');
        // Never guess/remove a stale lock, foreign stage, previous slot or unconfirmed journal.
        if (
            before.journal !== null ||
            before.stage !== null ||
            before.previous !== null ||
            !installationActions(
                before.root?.manifest.version ?? null,
                before.source.manifest.version,
            ).includes(plan.action as 'install' | 'repair' | 'update')
        )
            throw Error('unavailable model install');
        if (before.root?.transactionId === plan.transactionId) throw Error('reused transaction');
        const journal: LinuxModelJournal = {
            schemaVersion: 1,
            root: plan.root,
            uid: plan.host.uid,
            transactionId: plan.transactionId,
            installationId: plan.installationId,
            profile: profile(plan),
            candidateSHA256: before.source.verifiedManifestSHA256,
            previousSHA256: before.root?.verifiedManifestSHA256 ?? null,
            owner: copy(plan.owner),
            phase: 'copying',
            ...(plan.menu
                ? {
                      menu: prepareLinuxMenuJournal(
                          plan,
                          before.root?.menu ?? null,
                          before.menu!.current,
                      ),
                  }
                : {}),
        };
        if (plan.menu && (before.menu!.candidate !== null || before.menu!.previous !== null))
            throw Error('foreign retained menu slots');
        await this.journal(plan, scope, journal);
        await this.guard(plan, scope);
        const guard = copy(this.view!),
            payload = {
                manifest: copy(before.source.manifest),
                verifiedManifestSHA256: before.source.verifiedManifestSHA256,
                installationId: plan.installationId,
                transactionId: plan.transactionId,
                root: plan.root,
                profile: profile(plan),
                ...(journal.menu?.after ? { menu: copy(journal.menu.after) } : {}),
            };
        const returned = await this.call(
            'stage',
            () => this.effects.stage(copy(scope), copy(guard), copy(payload)),
            (value) => {
                this.view = copy(value);
            },
        );
        validateView(returned, plan);
        if (
            !returned.stage ||
            !equal(
                { ...returned.stage, identity: undefined },
                { ...payload, identity: undefined },
            ) ||
            !equal({ ...returned, stage: null }, guard)
        )
            throw Error('staged payload differs');
        await this.journal(plan, scope, { ...journal, phase: 'prepared' });
        if (before.root) await this.move(plan, scope, 'root', 'previous');
        await this.journal(plan, scope, { ...journal, phase: 'old-retained' });
        await this.move(plan, scope, 'stage', 'root');
        await this.journal(plan, scope, { ...journal, phase: 'candidate-active' });
        if (plan.menu) await this.applyMenu(plan, scope);
        // No launch, Finalize or removal capability: every previous payload/profile remains retained.
    }
    private async resume(plan: LinuxModelPlan, scope: LinuxModelScope) {
        // A new explicit invocation owns a new root reservation. The previous invocation is never retried
        // or released here, and its journal owner/transaction identity is deliberately preserved.
        assertLinuxResumePreimages(this.view!, plan);
        const journal = copy(this.view!.journal!);
        if (journal.phase === 'candidate-active') {
            await this.resumeMenu(plan, scope);
            return;
        }
        if (journal.phase === 'prepared') {
            if (this.view!.root !== null) await this.move(plan, scope, 'root', 'previous');
            await this.journal(plan, scope, { ...journal, phase: 'old-retained' });
        }
        if (this.view!.stage !== null) await this.move(plan, scope, 'stage', 'root');
        await this.journal(plan, scope, { ...journal, phase: 'candidate-active' });
        if (plan.menu) await this.applyMenu(plan, scope);
    }
    private async rollback(plan: LinuxModelPlan, scope: LinuxModelScope) {
        // run() just compared a fresh complete observation with this view; each subsequent
        // menuPhase/menuMove also guards the entire app+menu snapshot before its effect.
        assertLinuxAppRollbackPreimages(this.view!);
        const view = copy(this.view!),
            originalJournal = view.journal;
        if (
            !originalJournal ||
            !['candidate-active', 'rollback-started', 'candidate-retained', 'rolled-back'].includes(
                originalJournal.phase,
            )
        )
            throw Error('unsupported recovery phase');
        if (plan.menu) await this.rollbackMenu(plan, scope);
        const journal = plan.menu ? copy(this.view!.journal!) : originalJournal;
        const candidate = (slot: LinuxModelPayload | null) =>
            slot &&
            slot.transactionId === journal.transactionId &&
            slot.verifiedManifestSHA256 === journal.candidateSHA256;
        const previous = (slot: LinuxModelPayload | null) =>
            slot &&
            slot.transactionId !== journal.transactionId &&
            slot.verifiedManifestSHA256 === journal.previousSHA256;
        if (journal.phase === 'rolled-back') {
            if (
                !candidate(view.stage) ||
                view.previous ||
                (journal.previousSHA256 === null ? view.root !== null : !previous(view.root))
            )
                throw Error('rollback completion differs');
            return;
        }
        if (journal.phase === 'candidate-active' || journal.phase === 'rollback-started') {
            if (
                candidate(view.root) &&
                !view.stage &&
                (journal.previousSHA256 === null ? view.previous === null : previous(view.previous))
            ) {
                await this.journal(plan, scope, { ...journal, phase: 'rollback-started' });
                await this.move(plan, scope, 'root', 'stage');
            } else if (
                journal.phase !== 'rollback-started' ||
                view.root ||
                !candidate(view.stage) ||
                (journal.previousSHA256 === null
                    ? view.previous !== null
                    : !previous(view.previous))
            )
                throw Error('rollback slots differ');
            await this.journal(plan, scope, { ...journal, phase: 'candidate-retained' });
        }
        const latest = this.view!;
        if (
            !candidate(latest.stage) ||
            (journal.previousSHA256 === null
                ? latest.root !== null || latest.previous !== null
                : !(
                      (latest.root === null && previous(latest.previous)) ||
                      (previous(latest.root) && latest.previous === null)
                  ))
        )
            throw Error('retained candidate or previous differs');
        if (latest.previous) await this.move(plan, scope, 'previous', 'root');
        await this.journal(plan, scope, { ...journal, phase: 'rolled-back' });
    }
}

/** Existing model semantics remain memory-only, including refusal of native-tagged effects. */
export class LinuxTransactionModel extends LinuxTransactionCore {
    constructor(kernel: LinuxModelKernel, effects: LinuxMemoryEffects) {
        super(kernel, effects, 'injected-memory-effects');
    }
}

/** Internal native-driver boundary, not an execution grant or production registration. */
export function createLinuxNativeTransaction(
    kernel: LinuxModelKernel,
    effects: LinuxNativeEffects,
) {
    const transaction = new LinuxTransactionCore(kernel, effects, 'native-unqualified');
    const summary = () => ({
        ...transaction.summary(),
        modelOnly: false as const,
        nativeQualified: false as const,
        productionDispatch: false as const,
    });
    return Object.freeze({
        run: async (plan: LinuxModelPlan) => {
            await transaction.run(plan);
            return summary();
        },
        summary,
    });
}

/** Essential backend contract entry: returns an independent validated plan, never an execution grant. */
export function checkedLinuxModelPlan(input: LinuxModelPlan): LinuxModelPlan {
    const plan = copy(input);
    validatePlan(plan);
    return plan;
}
/** Native backend callers use the same closed snapshot grammar before accepting a mutation guard. */
export function checkedLinuxModelView(
    input: LinuxModelView,
    plan: LinuxModelConfiguration,
): LinuxModelView {
    const view = copy(input);
    validateView(view, plan);
    return view;
}
export function checkedLinuxModelConfiguration(
    input: LinuxModelConfiguration,
): LinuxModelConfiguration {
    const selected = copy(input);
    fields(selected, [
        'host',
        'root',
        'action',
        'transactionId',
        'installationId',
        'owner',
        ...(Object.hasOwn(selected, 'menu') ? ['menu'] : []),
    ]);
    validateConfiguration(selected);
    return selected;
}
