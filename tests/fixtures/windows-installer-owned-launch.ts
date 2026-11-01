import path from 'node:path';
import { decodeWindowsWindowQuery, assessWindowsWindowQuery, type WindowQueryCapture } from './windows-installer-window-query';
import type { OfflineLaunchIO, OfflineLaunchRequest, OwnedClosure, OwnedLaunch, OfflineLaunchAttempt,
    DirectLaunchClosure, AttemptRetirement } from './windows-installer-offline';

// Event-shaped public boundaries only: no child_process, PowerShell or Win32 invoker.
type Listener = (...args: any[]) => void;
export interface EventSource {
    on(event: string, listener: Listener): unknown;
    off(event: string, listener: Listener): unknown;
}
export interface PipeSource extends EventSource {
    readonly readableEnded: boolean;
    readonly closed: boolean;
    readonly destroyed: boolean;
}
export interface ChildSource extends EventSource {
    readonly pid: number | undefined;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    readonly stdout: PipeSource | null;
    readonly stderr: PipeSource | null;
}
export interface IndependentOwners {
    source: 'independent-synthetic-owner-observer';
    ownerId: string;
    pid: number;
    creationTimeMs: number;
    inventoryComplete: boolean;
    owners: readonly { id: string; closeObserved: boolean }[];
}
export interface VerifiedCloseTarget {
    ownerId: string;
    pid: number;
    creationTimeMs: number;
    executable: string;
    windowHandle: number;
}
export interface OwnedLaunchDependencies {
    scope: 'synthetic-memory';
    ownerId: string;
    invoke(executable: string, options: { cwd: string; args: readonly []; shell: false;
        detached: false; stdio: readonly ['ignore', 'pipe', 'pipe'] }): {
            child: ChildSource;
            // Not an inferred native fact. An unreviewed source must report uncertainty.
            eventHistory: 'fresh-observation-window' | 'prehandle-or-unknown';
        };
    query(child: ChildSource): Promise<WindowQueryCapture>;
    independentOwners(child: ChildSource, owner: OwnedLaunch): Promise<IndependentOwners>;
    // A future native primitive MUST atomically revalidate the retained process/window
    // target before requesting normal close. A previous query is not atomic authority.
    delegateNormalClose(child: ChildSource, target: Readonly<VerifiedCloseTarget>): Promise<void>;
}
interface PipeCustody {
    source: PipeSource | null;
    endObserved: boolean;
    closeObserved: boolean;
    bytes: number;
    retained: Uint8Array[];
    overflow: boolean;
}
export interface LaunchCustody {
    invoked: boolean;
    returned: boolean;
    invocationResult: unknown;
    child: ChildSource | null;
    owner: OwnedLaunch | null;
    registrationComplete: boolean;
    historyUncertain: boolean;
    spawnObserved: boolean;
    exitObserved: boolean;
    exitCode: number | null;
    signal: string | null;
    closeObserved: boolean;
    closeCode: number | null;
    closeSignal: string | null;
    stdout: PipeCustody;
    stderr: PipeCustody;
    errors: unknown[];
    queryCaptures: WindowQueryCapture[];
    independentEvidence: IndependentOwners | null;
    independentAccepted: boolean;
    closeAttempted: boolean;
    closeDelegated: boolean;
    closeNoActionReason: string | null;
    directClosureObserved: boolean;
    listenersDetached: boolean;
    retiredObserved: boolean;
    settled: boolean;
    bindings: { source: EventSource; event: string; listener: Listener }[];
}
export class OwnedLaunchError extends Error {
    constructor(public readonly code: string, public readonly custody: LaunchCustody, cause?: unknown) {
        super(code, { cause });
    }
}
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
export function createOfflineOwnedLaunch(request: Pick<OfflineLaunchRequest, 'mode' | 'root' | 'profile' | 'version'>,
    dependencies: OwnedLaunchDependencies): {
        io: Pick<OfflineLaunchIO, 'launchInstalled' | 'requestNormalClose'> & { launchAttempt: OfflineLaunchAttempt };
        custody: LaunchCustody;
        closure: Promise<OwnedClosure>;
    } {
    if (request.mode !== 'synthetic-memory' || dependencies.scope !== 'synthetic-memory')
        throw Error('NATIVE_ADAPTER_UNAVAILABLE');
    const config = Object.freeze({ ...request }), expectedExecutable = path.join(config.root, 'Diagnostic Hub.exe');
    const ownerId = dependencies.ownerId;
    if (!path.isAbsolute(config.root) || !ownerId || ownerId.length > 128)
        throw Error('OWNED_LAUNCH_INPUT_INVALID');
    const pipe = (): PipeCustody => ({ source: null, endObserved: false, closeObserved: false,
        bytes: 0, retained: [], overflow: false });
    const state: LaunchCustody = { invoked: false, returned: false, invocationResult: null, child: null, owner: null,
        registrationComplete: false, historyUncertain: false, spawnObserved: false, exitObserved: false,
        exitCode: null, signal: null, closeObserved: false, closeCode: null, closeSignal: null, stdout: pipe(), stderr: pipe(), errors: [],
        queryCaptures: [], independentEvidence: null, independentAccepted: false,
        closeAttempted: false, closeDelegated: false, closeNoActionReason: null,
        directClosureObserved: false, listenersDetached: false, retiredObserved: false, settled: false, bindings: [] };
    let resolveClosed!: (value: OwnedClosure) => void, rejectClosed!: (error: unknown) => void;
    const closed = new Promise<OwnedClosure>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    void closed.catch(() => {}); // Early diagnostics never become unhandled promise rejection.
    let resolveDirect!: (value: DirectLaunchClosure) => void, resolveRetired!: (value: AttemptRetirement) => void;
    const directClosed = new Promise<DirectLaunchClosure>(resolve => { resolveDirect = resolve; });
    const retired = new Promise<AttemptRetirement>(resolve => { resolveRetired = resolve; });
    let directAcknowledgement: DirectLaunchClosure | null = null;
    let closeTask: Promise<void> | null = null;
    const retain = (error: unknown) => { if (!state.errors.includes(error)) state.errors.push(error); };
    const uncertain = (code: string, cause?: unknown) => {
        state.historyUncertain = true;
        const error = new OwnedLaunchError(code, state, cause); retain(error); return error;
    };
    function settle() {
        if (!state.directClosureObserved && state.registrationComplete && !state.historyUncertain &&
            state.spawnObserved && state.exitObserved && state.closeObserved &&
            state.stdout.endObserved && state.stdout.closeObserved && state.stderr.endObserved && state.stderr.closeObserved) {
            // Exact returned-handle events do not require invented accepted native identity.
            state.directClosureObserved = true;
            directAcknowledgement = Object.freeze({ attemptId: ownerId, processExitObserved: true, processCloseObserved: true,
                stdoutEOF: true, stdoutCloseObserved: true, stderrEOF: true, stderrCloseObserved: true,
                exitCode: state.exitCode, signal: state.signal });
            resolveDirect(directAcknowledgement);
            if (state.closeCode !== state.exitCode || state.closeSignal !== state.signal)
                retain(new OwnedLaunchError('EXIT_CLOSE_OUTCOME_MISMATCH', state));
            let detached = true;
            // Release only our observers of acknowledged closed local handles. Retain
            // the custody record while independent retirement is still unproved.
            for (const { source, event, listener } of state.bindings) {
                try { source.off(event, listener); } catch (error) { detached = false; retain(error); }
            }
            state.listenersDetached = detached;
        }
        if (!state.retiredObserved && state.owner && state.directClosureObserved && state.listenersDetached && state.independentAccepted) {
            state.retiredObserved = true;
            resolveRetired(Object.freeze({ attemptId: ownerId, direct: directAcknowledgement!, independentOwnersObserved: true }));
        }
        if (state.settled || !state.owner || !state.retiredObserved) return;
        state.settled = true;
        if (state.errors.length) {
            rejectClosed(state.errors.length === 1 ? state.errors[0] :
                new AggregateError(state.errors, 'Owned launch errors retained after acknowledged closure.', { cause: state.errors[0] }));
        } else resolveClosed({ ownerId: state.owner.id, pid: state.owner.pid, creationTimeMs: state.owner.creationTimeMs,
            processCloseObserved: true, exitCode: state.exitCode, signal: state.signal,
            stdoutEOF: true, stderrEOF: true, admittedOwnersClosed: true });
    }
    function attach(source: EventSource, event: string, listener: Listener) {
        state.bindings.push({ source, event, listener }); // Retain even an uncertain registration.
        try { source.on(event, listener); } catch (error) { retain(error); uncertain('OBSERVER_REGISTRATION_UNCERTAIN', error); }
    }
    function adoptPipe(source: PipeSource | null, owned: PipeCustody) {
        owned.source = source;
        if (!source) { uncertain('PIPE_HANDLE_UNAVAILABLE'); return; }
        try {
            if (source.readableEnded || source.closed || source.destroyed) uncertain('PIPE_PREOBSERVATION_HISTORY');
        } catch (error) { uncertain('PIPE_HISTORY_UNREADABLE', error); }
        attach(source, 'error', error => { retain(error); settle(); });
        attach(source, 'close', () => { owned.closeObserved = true; settle(); });
        attach(source, 'end', () => { owned.endObserved = true; settle(); });
        attach(source, 'data', chunk => {
            if (!(chunk instanceof Uint8Array)) { retain(new OwnedLaunchError('PIPE_CHUNK_INVALID', state)); return; }
            owned.bytes += chunk.length;
            // Fixed4096byte retained cap per pipe, from the retained real-Node probe.
            // Continue observing/draining; over-bound capture is explicit failure, not a successful prefix.
            if (owned.bytes <= 4096) owned.retained.push(chunk.slice());
            else if (!owned.overflow) { owned.overflow = true; retain(new OwnedLaunchError('PIPE_CAPTURE_OVER_BOUND', state)); }
        });
    }
    const attempt: OfflineLaunchAttempt = Object.freeze({ attemptId: ownerId, retainedCustody: state, directClosed, retired,
        snapshot: () => ({ attemptId: ownerId, invoked: state.invoked, handleReturned: state.returned,
            identityAccepted: state.owner !== null, observerHistoryComplete: state.registrationComplete && !state.historyUncertain,
            directClosureObserved: state.directClosureObserved, independentOwnersObserved: state.independentAccepted,
            retired: state.retiredObserved, errorCount: state.errors.length }) });
    const io: Pick<OfflineLaunchIO, 'launchInstalled' | 'requestNormalClose'> & { launchAttempt: OfflineLaunchAttempt } = {
        launchAttempt: attempt,
        async launchInstalled(executable) {
            if (state.invoked || !samePath(executable, expectedExecutable)) throw new OwnedLaunchError('FIXED_LAUNCH_REFUSED', state);
            state.invoked = true; // Custody exists before invoking any callback.
            let invocation: ReturnType<OwnedLaunchDependencies['invoke']>;
            try {
                invocation = dependencies.invoke(expectedExecutable, { cwd: config.root, args: [], shell: false,
                    detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
                state.invocationResult = invocation;
                state.child = invocation.child; // Adopt before any identity await or stream accessor.
                state.returned = true;
            } catch (error) {
                retain(error); state.historyUncertain = true; throw error; // No handle is not process-absence proof.
            }
            const child = state.child;
            try {
                if (invocation.eventHistory !== 'fresh-observation-window') uncertain('PREHANDLE_EVENTS_OR_HISTORY_UNKNOWN');
            } catch (error) { uncertain('INVOCATION_HISTORY_UNREADABLE', error); }
            try { if (child.exitCode !== null || child.signalCode !== null) uncertain('CHILD_PREOBSERVATION_HISTORY'); }
            catch (error) { uncertain('CHILD_HISTORY_UNREADABLE', error); }
            attach(child, 'error', error => { retain(error); settle(); });
            const outcomeValid = (code: unknown, signal: unknown) =>
                (code === null || (Number.isSafeInteger(code) && Number(code) >= 0 && Number(code) <= 0xffffffff)) &&
                (signal === null || (typeof signal === 'string' && signal.length > 0 && signal.length <= 32));
            attach(child, 'close', (code, signal) => {
                if (!outcomeValid(code, signal)) { uncertain('CLOSE_OUTCOME_UNCONFIRMED'); return; }
                state.closeObserved = true; state.closeCode = code; state.closeSignal = signal; settle();
            });
            attach(child, 'exit', (code, signal) => {
                if (!outcomeValid(code, signal)) { uncertain('EXIT_OUTCOME_UNCONFIRMED'); return; }
                state.exitObserved = true; state.exitCode = code; state.signal = signal; settle();
            });
            attach(child, 'spawn', () => { state.spawnObserved = true; settle(); });
            try { adoptPipe(child.stdout, state.stdout); } catch (error) { uncertain('STDOUT_ADOPTION_FAILED', error); }
            try { adoptPipe(child.stderr, state.stderr); } catch (error) { uncertain('STDERR_ADOPTION_FAILED', error); }
            try {
                if ((child.exitCode !== null || child.signalCode !== null) && !state.exitObserved)
                    uncertain('CHILD_EVENT_HISTORY_INCOMPLETE');
                for (const owned of [state.stdout, state.stderr]) {
                    if (owned.source && ((owned.source.readableEnded && !owned.endObserved) ||
                        (owned.source.closed && !owned.closeObserved))) uncertain('PIPE_EVENT_HISTORY_INCOMPLETE');
                }
            } catch (error) { uncertain('EVENT_HISTORY_UNREADABLE', error); }
            state.registrationComplete = !state.historyUncertain;
            if (!state.registrationComplete) throw new OwnedLaunchError('OWNED_LAUNCH_OBSERVATION_UNCERTAIN', state, state.errors[0]);
            settle(); // Registration may itself have synchronously delivered genuine events.
            let raw: WindowQueryCapture;
            try { raw = await dependencies.query(child); } // All observers already installed.
            catch (error) { retain(error); throw error; }
            state.queryCaptures.push(raw);
            const decoded = decodeWindowsWindowQuery(raw), native = decoded.native;
            if (decoded.state !== 'observed' || !native || child.pid !== native.pid ||
                !samePath(native.executable, expectedExecutable)) {
                const error = new OwnedLaunchError('INITIAL_PROCESS_IDENTITY_UNCONFIRMED', state, decoded);
                retain(error); throw error;
            }
            const owner: OwnedLaunch = Object.freeze({ id: ownerId, pid: native.pid,
                creationTimeMs: Date.parse(native.createdAt), closed });
            state.owner = owner;
            // Independent evidence is mandatory even if the parent and both pipes close.
            void Promise.resolve().then(() => dependencies.independentOwners(child, owner)).then(proof => {
                state.independentEvidence = structuredClone(proof);
                const ids = proof.owners?.map(item => item.id);
                if (proof.source !== 'independent-synthetic-owner-observer' || proof.ownerId !== owner.id ||
                    proof.pid !== owner.pid || proof.creationTimeMs !== owner.creationTimeMs || proof.inventoryComplete !== true ||
                    !Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !id || id.length > 128) ||
                    proof.owners.some(item => item.closeObserved !== true)) {
                    retain(new OwnedLaunchError('INDEPENDENT_OWNER_CLOSURE_UNCONFIRMED', state)); return;
                }
                state.independentAccepted = true; settle();
            }, retain).catch(retain);
            settle(); return owner;
        },
        requestNormalClose(owner) {
            if (owner !== state.owner) return Promise.reject(new OwnedLaunchError('FOREIGN_CLOSE_OWNER', state));
            if (closeTask) return closeTask;
            state.closeAttempted = true;
            // Install one task before callbacks; reentrant/repeated requests join it.
            closeTask = Promise.resolve().then(async () => {
                if (state.closeObserved) { state.closeNoActionReason = 'original-already-closed'; return; }
                const child = state.child!, raw = await dependencies.query(child);
                state.queryCaptures.push(raw);
                const fresh = assessWindowsWindowQuery(config.root, { pid: owner.pid,
                    creationTimeMs: owner.creationTimeMs, profile: config.profile }, config.version, raw);
                if (state.closeObserved && fresh.state === 'missing' && raw.requestedPID === owner.pid && child.pid === owner.pid) {
                    state.closeNoActionReason = 'original-closed-with-completed-missing'; return;
                }
                if (!fresh.matched || child.pid !== owner.pid) throw new OwnedLaunchError('FRESH_CLOSE_IDENTITY_UNCONFIRMED', state, fresh);
                if (state.closeObserved) { state.closeNoActionReason = 'original-closed-after-matching-query'; return; }
                state.closeDelegated = true;
                await dependencies.delegateNormalClose(child, Object.freeze({ ownerId: owner.id, pid: owner.pid,
                    creationTimeMs: owner.creationTimeMs, executable: expectedExecutable, windowHandle: fresh.native!.handle }));
            }).catch(error => { retain(error); throw error; });
            void closeTask.catch(() => {}); return closeTask;
        },
    };
    return { io, custody: state, closure: closed };
}
