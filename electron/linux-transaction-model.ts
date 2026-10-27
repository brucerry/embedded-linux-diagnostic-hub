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
    checkedLinuxMenuChoice, checkedLinuxMenuRecord, checkedLinuxMenuView,
    checkedLinuxMenuJournal, prepareLinuxMenuJournal, desiredLinuxMenu, sameLinuxMenu, assertLinuxMenuPhase,
    type LinuxMenuChoice, type LinuxMenuRecord, type LinuxMenuView, type LinuxMenuJournal,
    type LinuxMenuSlot, type LinuxMenuPhase,
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
export interface LinuxModelView {
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
    action: 'install' | 'repair' | 'update' | 'rollback';
    transactionId: string;
    installationId: string;
    owner: LinuxModelOwner;
    consent: boolean;
    review: LinuxModelView;
    reviewSHA256: string;
}
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
    menuStage?(scope: LinuxModelScope, guard: LinuxModelView, record: LinuxMenuRecord,
        text: string): Promise<LinuxModelView>;
    menuMove?(scope: LinuxModelScope, guard: LinuxModelView, from: LinuxMenuSlot,
        to: LinuxMenuSlot): Promise<LinuxModelView>;
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
    // Four separately bounded manifest slots plus fixed identity/journal metadata. No heap guarantee.
    if (!bytes || Buffer.byteLength(bytes) > MAX_INSTALLATION_MANIFEST_BYTES * 4 + 65536)
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
function profile(plan: LinuxModelPlan) {
    return path.posix.join(plan.host.appData, 'DiagnosticHub', 'profiles', plan.installationId);
}
function validateView(view: LinuxModelView, plan: LinuxModelPlan) {
    fields(view, ['activity', 'parents', 'source', 'root', 'stage', 'previous', 'journal',
        ...(Object.hasOwn(plan, 'menu') ? ['menu'] : [])]);
    if (Object.hasOwn(plan, 'menu')) checkedLinuxMenuView(view.menu, plan.host.uid);
    fields(view.activity, ['root', 'stage', 'previous']);
    if (Object.values(view.activity).some((state) => state !== 'inactive'))
        throw Error('busy or uninspectable model slot');
    source(view.source, plan.host.uid);
    if (view.source.manifest.version !== plan.host.version) throw Error('source version');
    const expectedParents = new Set<string>(['/']);
    for (const target of [path.posix.dirname(plan.root), plan.host.sourceRoot, plan.host.appData,
        ...(plan.menu ? [path.posix.join(plan.menu.dataHome, 'applications')] : [])]) {
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
    if (plan.menu) for (const file of Object.values(view.menu!)) if (file !== null) {
        const key = file.identity.dev + ':' + file.identity.ino;
        if (inodeKeys.includes(key)) throw Error('aliased model menu file');
        inodeKeys.push(key);
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
        if (plan.menu) checkedLinuxMenuJournal(journal.menu, plan);
        owner(journal.owner);
        if (
            journal.schemaVersion !== 1 ||
            journal.root !== plan.root ||
            journal.uid !== plan.host.uid ||
            journal.transactionId !== plan.transactionId ||
            journal.installationId !== plan.installationId ||
            journal.profile !== profile(plan) ||
            !hash.test(journal.candidateSHA256) ||
            !(journal.previousSHA256 === null || hash.test(journal.previousSHA256)) ||
            ![
                'copying',
                'prepared',
                'old-retained',
                'candidate-active',
                'rollback-started',
                'candidate-retained',
                'rolled-back',
            ].includes(journal.phase)
        )
            throw Error('foreign model journal');
    }
}
/** Complete app preimage admission BEFORE any menu rollback write/move. No effects. */
function assertLinuxAppRollbackPreimages(view: LinuxModelView) {
    const journal = view.journal;
    if (!journal || !['candidate-active', 'rollback-started', 'candidate-retained', 'rolled-back'].includes(journal.phase))
        throw Error('unsupported app rollback phase');
    const candidate = (slot: LinuxModelPayload | null) => slot !== null &&
        slot.transactionId === journal.transactionId && slot.verifiedManifestSHA256 === journal.candidateSHA256;
    const previous = (slot: LinuxModelPayload | null) => slot !== null &&
        slot.transactionId !== journal.transactionId && slot.verifiedManifestSHA256 === journal.previousSHA256;
    const priorRetained = journal.previousSHA256 === null ? view.previous === null : previous(view.previous);
    const candidateActive = candidate(view.root) && view.stage === null && priorRetained;
    const candidateMoved = view.root === null && candidate(view.stage) && priorRetained;
    const previousRestored = candidate(view.stage) && (journal.previousSHA256 === null
        ? view.root === null && view.previous === null
        : previous(view.root) && view.previous === null);
    const valid = journal.phase === 'candidate-active' ? candidateActive
        : journal.phase === 'rollback-started' ? candidateActive || candidateMoved
        : journal.phase === 'candidate-retained' ? candidateMoved || previousRestored
        : previousRestored;
    if (!valid) throw Error('app rollback preimage differs');
    if (journal.menu && journal.phase !== 'candidate-active' && journal.menu.phase !== 'restored')
        throw Error('app and menu rollback phases differ');
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
        plan.consent !== true ||
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
        !['install', 'repair', 'update', 'rollback'].includes(plan.action) ||
        !hash.test(plan.reviewSHA256)
    )
        throw Error('model plan admission');
    owner(plan.owner);
    if (plan.owner.executable !== path.posix.join(host.sourceRoot, 'app/diagnostic-hub'))
        throw Error('model runtime binding');
    if (Object.hasOwn(plan, 'menu')) checkedLinuxMenuChoice(plan);
    validateView(plan.review, plan);
    if (plan.action === 'rollback') assertLinuxAppRollbackPreimages(plan.review);
    if (plan.menu && plan.review.journal) assertLinuxMenuPhase(plan.review.menu!, plan.review.journal.menu!, plan);
    if (plan.menu && plan.review.journal === null && plan.action !== 'rollback') {
        if (plan.review.menu!.candidate !== null || plan.review.menu!.previous !== null) throw Error('foreign menu retention slots');
        prepareLinuxMenuJournal(plan, plan.review.root?.menu ?? null, plan.review.menu!.current);
    }
    if (linuxModelReviewSHA256(plan.review) !== plan.reviewSHA256)
        throw Error('changed model review');
}
export type LinuxModelVerdict =
    'REFUSED' | 'RETAINED_UNKNOWN' | 'ACTIVE_PREVIOUS_RETAINED' | 'ROLLED_BACK_RETAINED';
type Pending = 'reserve' | 'current' | 'observe' | 'journal' | 'stage' | 'move' | 'menu-stage' | 'menu-move' | 'release' | null;
/** Deliberately not imported by setup-worker or SetupTransaction. Native dispatch stays disabled. */
export class LinuxTransactionModel {
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
    private effects: LinuxMemoryEffects;
    constructor(kernel: LinuxModelKernel, effects: LinuxMemoryEffects) {
        this.kernel = kernel;
        this.effects = effects;
    }
    summary() {
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
        if (this.used) throw Error('This model invocation is consumed; no retry.');
        this.used = true;
        let plan: LinuxModelPlan;
        try {
            plan = copy(input);
            validatePlan(plan);
            if (this.effects.kind !== 'injected-memory-effects') throw Error('memory effects only');
            if (plan.menu && (typeof this.effects.menuStage !== 'function' || typeof this.effects.menuMove !== 'function'))
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
    private async menuMove(plan: LinuxModelPlan, scope: LinuxModelScope,
        from: LinuxMenuSlot, to: LinuxMenuSlot) {
        await this.guard(plan, scope);
        const before = copy(this.view!), menu = before.menu!;
        if (!menu[from] || menu[to] !== null || from === to) throw Error('exclusive menu move refused');
        const expected = { ...copy(before), menu: { ...copy(menu), [from]: null, [to]: copy(menu[from]) } };
        const returned = await this.call('menu-move', () => this.effects.menuMove!(copy(scope), copy(before), from, to),
            (value) => { this.view = copy(value); });
        validateView(returned, plan);
        if (!equal(returned, expected)) throw Error('menu move differs');
    }
    private async applyMenu(plan: LinuxModelPlan, scope: LinuxModelScope) {
        const menu = this.view!.journal!.menu!;
        if (menu.phase !== 'pending') throw Error('unsupported pending menu recovery');
        if (menu.action === 'create' || menu.action === 'replace') {
            await this.guard(plan, scope);
            const before = copy(this.view!), desired = desiredLinuxMenu(plan);
            if (before.menu!.candidate !== null || !sameLinuxMenu(menu.after, desired.record)) throw Error('menu stage differs');
            const returned = await this.call('menu-stage', () => this.effects.menuStage!(copy(scope), copy(before), copy(desired.record), desired.text),
                (value) => { this.view = copy(value); });
            validateView(returned, plan);
            const file = returned.menu!.candidate;
            if (!file || file.sha256 !== desired.record.sha256 || file.bytes !== desired.record.bytes ||
                !equal({ ...returned, menu: { ...returned.menu!, candidate: null } }, before)) throw Error('staged menu differs');
            await this.menuPhase(plan, scope, 'staged');
        }
        if (menu.action === 'replace' || menu.action === 'deselect') {
            await this.menuMove(plan, scope, 'current', 'previous');
            await this.menuPhase(plan, scope, 'retained');
        }
        if (menu.action === 'create' || menu.action === 'replace') await this.menuMove(plan, scope, 'candidate', 'current');
        await this.menuPhase(plan, scope, 'applied');
    }
    private async rollbackMenu(plan: LinuxModelPlan, scope: LinuxModelScope) {
        const menu = copy(this.view!.journal!.menu!);
        if (menu.phase === 'restored') {
            if (!sameLinuxMenu(this.view!.menu!.current, menu.beforeFile) || this.view!.menu!.previous !== null)
                throw Error('restored menu differs');
            return;
        }
        // Never guess through interrupted menu writes or lost acknowledgements.
        if (menu.phase !== 'applied') throw Error('unsupported menu recovery phase');
        if (menu.action === 'create' || menu.action === 'replace') {
            const current = this.view!.menu!.current;
            if (!current || !menu.after || current.sha256 !== menu.after.sha256 || current.bytes !== menu.after.bytes || this.view!.menu!.candidate !== null)
                throw Error('active menu differs');
        } else if (!sameLinuxMenu(this.view!.menu!.current,
            menu.action === 'deselect' ? null : menu.beforeFile)) throw Error('unchanged menu differs');
        await this.menuPhase(plan, scope, 'rollback-pending');
        if (menu.action === 'create' || menu.action === 'replace') await this.menuMove(plan, scope, 'current', 'candidate');
        await this.menuPhase(plan, scope, 'rollback-candidate-retained');
        if (menu.action === 'replace' || menu.action === 'deselect') await this.menuMove(plan, scope, 'previous', 'current');
        if (!sameLinuxMenu(this.view!.menu!.current, menu.beforeFile) || this.view!.menu!.previous !== null)
            throw Error('restored menu differs');
        await this.menuPhase(plan, scope, 'restored');
    }
    private async install(plan: LinuxModelPlan, scope: LinuxModelScope) {
        const before = copy(this.view!);
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
            ...(plan.menu ? { menu: prepareLinuxMenuJournal(plan, before.root?.menu ?? null, before.menu!.current) } : {}),
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
    private async rollback(plan: LinuxModelPlan, scope: LinuxModelScope) {
        // run() just compared a fresh complete observation with this view; each subsequent
        // menuPhase/menuMove also guards the entire app+menu snapshot before its effect.
        assertLinuxAppRollbackPreimages(this.view!);
        const view = copy(this.view!), originalJournal = view.journal;
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

/** Essential backend contract entry: returns an independent validated plan, never an execution grant. */
export function checkedLinuxModelPlan(input: LinuxModelPlan): LinuxModelPlan {
    const plan = copy(input);
    validatePlan(plan);
    return plan;
}
/** Native backend callers use the same closed snapshot grammar before accepting a mutation guard. */
export function checkedLinuxModelView(input: LinuxModelView, plan: LinuxModelPlan): LinuxModelView {
    const view = copy(input);
    validateView(view, plan);
    return view;
}
