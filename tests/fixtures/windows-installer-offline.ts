import { createHash } from 'node:crypto';
import path from 'node:path';
import { matchesSetupSuccessor, type NativeSetupWindow } from '../../electron/setup-successor';
import {
    assessWindowsWindowQuery,
    windowQueryEvidence,
    type WindowQueryCapture,
} from './windows-installer-window-query';
import {
    INSTALLATION_PRODUCT,
    validateInstallationManifest,
    validateInstallationRecord,
} from '../../shared/installation';

// Test-only fixed case. There is deliberately no native adapter in this preparation.
// Injected facts exercise orchestration; they cannot establish native provenance or consent.
export interface OfflineLaunchRequest {
    mode: 'synthetic-memory' | 'native';
    root: string;
    profile: string;
    version: string;
    sourceCommit: string;
    sourceTree: string;
    setupSHA256: string;
    setupBytes: number;
    payloadManifestSHA256: string;
    installEvidenceSHA256: string;
}
export interface InstallationSnapshot {
    prerequisite: {
        kind: 'synthetic-memory-installation' | 'real-nsis-installation';
        sha256: string;
        setupSHA256: string;
        setupBytes: number;
        sourceCommit: string;
        sourceTree: string;
        consentObserved: boolean;
        launchUnchecked: boolean;
        wizardFinishObserved: boolean;
        installerCloseObserved: boolean;
        installerExitCode: number | null;
        installerSignal: string | null;
        payloadVerified: boolean;
    };
    // Exact captured bytes, not reconstructed metadata written into an installation.
    recordBytes: Uint8Array;
    manifestBytes: Uint8Array;
    payloadManifestBytes: Uint8Array;
    ownerBytes: Uint8Array;
    journalBytes: Uint8Array;
    dedicatedProfile: string;
    bootAckAbsentBeforeLaunch: boolean;
}
export interface OfflineCondition {
    state: 'offline' | 'unknown';
    scope: 'machine' | 'renderer';
    observationId: string;
    method: 'external-condition-readback';
    evidenceSHA256: string;
    // Supplied by the external observer, never set by this driver or a policy change.
    source: 'synthetic-memory' | 'native-observer';
}
export interface OwnedClosure {
    ownerId: string;
    pid: number;
    creationTimeMs: number;
    processCloseObserved: boolean;
    exitCode: number | null;
    signal: string | null;
    stdoutEOF: boolean;
    stderrEOF: boolean;
    admittedOwnersClosed: boolean;
}
export interface DirectLaunchClosure {
    attemptId: string;
    processExitObserved: true;
    processCloseObserved: true;
    stdoutEOF: true;
    stdoutCloseObserved: true;
    stderrEOF: true;
    stderrCloseObserved: true;
    exitCode: number | null;
    signal: string | null;
}
export interface AttemptRetirement {
    attemptId: string;
    direct: DirectLaunchClosure;
    independentOwnersObserved: true;
}
export interface LaunchAttemptSnapshot {
    attemptId: string;
    invoked: boolean;
    handleReturned: boolean;
    identityAccepted: boolean;
    observerHistoryComplete: boolean;
    directClosureObserved: boolean;
    independentOwnersObserved: boolean;
    retired: boolean;
    errorCount: number;
}
export interface OfflineLaunchAttempt {
    readonly attemptId: string;
    readonly retainedCustody: unknown;
    readonly directClosed: Promise<DirectLaunchClosure>;
    readonly retired: Promise<AttemptRetirement>;
    snapshot(): LaunchAttemptSnapshot;
}
export interface OfflineRetirementProof {
    state: 'retired' | 'not-invoked';
    basis: 'adapter-attempt' | 'owned-closure-contract' | 'no-launch';
    attempt?: AttemptRetirement;
    ownerClosure?: OwnedClosure;
}
export interface OwnedLaunch {
    id: string;
    pid: number;
    creationTimeMs: number;
    // Installed by the adapter before returning a handle. No observer-created timeout.
    closed: Promise<OwnedClosure>;
}
export interface ReadyObservation {
    native: NativeSetupWindow;
    windowQuery?: WindowQueryCapture;
    bootAckBytes: Uint8Array;
    ui: { ownerId: string; interactionObserved: boolean; evidenceSHA256: string };
}
export interface EvidenceHandle {
    writeFile(bytes: Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
}
export interface OfflineLaunchIO {
    scope: 'synthetic-memory' | 'native';
    // The actual adapter exposes this before launch/identity, including failure paths.
    // Legacy memory doubles may retain their explicit OwnedLaunch.closed contract.
    launchAttempt?: OfflineLaunchAttempt;
    readInstallation(): Promise<InstallationSnapshot>;
    observeOffline(): Promise<OfflineCondition>;
    launchInstalled(executable: string): Promise<OwnedLaunch>;
    observeReady(owner: OwnedLaunch): Promise<ReadyObservation>;
    requestNormalClose(owner: OwnedLaunch): Promise<void>;
    openEvidence(
        name: 'stages.json' | 'observation.json',
        flags: 'wx',
        mode: number,
    ): Promise<EvidenceHandle>;
    readEvidence(name: 'stages.json' | 'observation.json'): Promise<Uint8Array>;
}
export class OfflineObservationError extends Error {
    constructor(public readonly code: string) {
        super(code);
    }
}
export function refuseNativeOfflineLaunch(argv: readonly string[]): never {
    if (
        argv.length !== 5 ||
        argv[0] !== '--run' ||
        argv[1] !== '--admission' ||
        argv[3] !== '--output'
    )
        throw new OfflineObservationError('USE_FIXED_RUN_ADMISSION_OUTPUT_INTERFACE');
    // Do not read an admission file or mistake supplied metadata for a native adapter.
    throw new OfflineObservationError('NATIVE_ADAPTER_UNAVAILABLE');
}
function requireFact(value: unknown, code: string): asserts value {
    if (!value) throw new OfflineObservationError(code);
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hashOK = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const samePath = (a: unknown, b: string) =>
    typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function json(bytes: Uint8Array, cap = 16384): Record<string, unknown> {
    requireFact(
        bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= cap,
        'METADATA_BOUND',
    );
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    requireFact(value && typeof value === 'object' && !Array.isArray(value), 'METADATA_SHAPE');
    return value;
}
function bounded(value: unknown, cap: number) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    requireFact(bytes.length <= cap, 'PUBLICATION_BOUND');
    return bytes;
}
function installation(
    request: OfflineLaunchRequest,
    snapshot: InstallationSnapshot,
    beforeLaunch = false,
) {
    const proof = snapshot.prerequisite;
    requireFact(proof?.kind === 'synthetic-memory-installation', 'INSTALL_PREREQUISITE_MISSING');
    requireFact(
        proof.sha256 === request.installEvidenceSHA256 &&
            proof.setupSHA256 === request.setupSHA256 &&
            proof.setupBytes === request.setupBytes &&
            proof.sourceCommit === request.sourceCommit &&
            proof.sourceTree === request.sourceTree,
        'INSTALL_PROVENANCE_MISMATCH',
    );
    requireFact(
        proof.consentObserved &&
            proof.launchUnchecked &&
            proof.wizardFinishObserved &&
            proof.installerCloseObserved &&
            proof.installerExitCode === 0 &&
            proof.installerSignal === null &&
            proof.payloadVerified,
        'INSTALL_PREREQUISITE_UNCONFIRMED',
    );
    if (beforeLaunch) requireFact(snapshot.bootAckAbsentBeforeLaunch, 'STALE_PRELAUNCH_ACK');
    requireFact(samePath(snapshot.dedicatedProfile, request.profile), 'PROFILE_MISMATCH');
    const record = validateInstallationRecord(json(snapshot.recordBytes));
    const manifest = validateInstallationManifest(json(snapshot.manifestBytes, 4 * 1024 * 1024));
    requireFact(
        record.profile === 'dedicated' && record.manifestSHA256 === hash(snapshot.manifestBytes),
        'INSTALL_MANIFEST_MISMATCH',
    );
    requireFact(
        manifest.layout === 'windows-nsis' &&
            manifest.platform === 'win32' &&
            manifest.arch === 'x64' &&
            manifest.version === request.version &&
            manifest.sourceCommit === request.sourceCommit,
        'INSTALL_IDENTITY_MISMATCH',
    );
    requireFact(
        snapshot.payloadManifestBytes.length > 0 &&
            snapshot.payloadManifestBytes.length <= 4 * 1024 * 1024 &&
            hash(snapshot.payloadManifestBytes) === request.payloadManifestSHA256,
        'PAYLOAD_MANIFEST_MISMATCH',
    );
    const owner = json(snapshot.ownerBytes),
        journal = json(snapshot.journalBytes);
    requireFact(
        owner.product === INSTALLATION_PRODUCT &&
            journal.product === INSTALLATION_PRODUCT &&
            owner.schemaVersion === 1 &&
            journal.schemaVersion === 1 &&
            owner.installationId === record.installationId &&
            journal.installationId === record.installationId &&
            samePath(owner.root, request.root) &&
            samePath(journal.root, request.root) &&
            typeof owner.transactionId === 'string' &&
            /^[a-f0-9-]{36}$/.test(owner.transactionId) &&
            owner.transactionId === journal.transactionId &&
            journal.phase === 'candidate-active' &&
            journal.oldDigest === null &&
            journal.candidateDigest === record.manifestSHA256 &&
            journal.candidateVersion === request.version &&
            typeof journal.candidateActivatedAt === 'number' &&
            Number.isFinite(journal.candidateActivatedAt),
        'TRANSACTION_MISMATCH',
    );
    return {
        installationId: record.installationId,
        transactionId: owner.transactionId,
        manifestSHA256: record.manifestSHA256,
        activatedAt: journal.candidateActivatedAt,
        snapshotSHA256: hash(
            bounded(
                {
                    proof,
                    profile: snapshot.dedicatedProfile,
                    metadata: [
                        snapshot.recordBytes,
                        snapshot.manifestBytes,
                        snapshot.payloadManifestBytes,
                        snapshot.ownerBytes,
                        snapshot.journalBytes,
                    ].map(hash),
                },
                16384,
            ),
        ),
    };
}
function offline(value: OfflineCondition) {
    requireFact(
        value.state === 'offline' &&
            value.scope === 'machine' &&
            value.method === 'external-condition-readback' &&
            value.source === 'synthetic-memory' &&
            value.observationId.length > 0 &&
            value.observationId.length <= 128 &&
            hashOK(value.evidenceSHA256),
        'OFFLINE_UNCONFIRMED',
    );
    return structuredClone(value);
}
export interface OfflineLaunchCustody {
    owner: OwnedLaunch | null;
    launchAttempt: OfflineLaunchAttempt | null;
    identity: { id: string; pid: number; creationTimeMs: number } | null;
    closeRequested: boolean;
    closure: OwnedClosure | null;
    handles: { name: string; handle: EvidenceHandle; closed: boolean }[];
}
export function resolveOfflineNativeWindow(
    request: Pick<OfflineLaunchRequest, 'root' | 'profile' | 'version'>,
    owner: Pick<OwnedLaunch, 'pid' | 'creationTimeMs'>,
    ready: Pick<ReadyObservation, 'native' | 'windowQuery'>,
): {
    native: NativeSetupWindow | undefined;
    matched: boolean;
    query?: ReturnType<typeof assessWindowsWindowQuery>;
} {
    const expected = {
        pid: owner.pid,
        creationTimeMs: owner.creationTimeMs,
        profile: request.profile,
    };
    if (ready.windowQuery === undefined)
        return {
            native: ready.native,
            matched: matchesSetupSuccessor(request.root, expected, request.version, ready.native),
        };
    const query = assessWindowsWindowQuery(
        request.root,
        expected,
        request.version,
        ready.windowQuery,
    );
    const projected = query.native;
    const agrees =
        projected &&
        (Object.keys(projected) as (keyof NativeSetupWindow)[]).every((key) =>
            Object.is(projected[key], ready.native[key]),
        );
    return {
        native: projected,
        matched: query.matched && Boolean(agrees),
        query:
            query.matched && !agrees
                ? { ...query, matched: false, reason: 'QUERY_PROJECTION_MISMATCH' }
                : query,
    };
}
export async function runWindowsOfflineLaunch(input: OfflineLaunchRequest, io: OfflineLaunchIO) {
    // A supplied JSON approval is not an installed/reviewed Windows adapter.
    // CLI and injected caller both stop here for native requests, before any boundary call.
    requireFact(
        input.mode === 'synthetic-memory' && io.scope === 'synthetic-memory',
        'NATIVE_ADAPTER_UNAVAILABLE',
    );
    const request = structuredClone(input);
    requireFact(
        path.isAbsolute(request.root) &&
            path.isAbsolute(request.profile) &&
            path.resolve(request.root) !== path.resolve(request.profile) &&
            !path
                .resolve(request.profile)
                .toLowerCase()
                .startsWith(path.resolve(request.root).toLowerCase() + path.sep) &&
            /^[a-f0-9]{40}$/.test(request.sourceCommit) &&
            /^[a-f0-9]{40}$/.test(request.sourceTree) &&
            [
                request.setupSHA256,
                request.payloadManifestSHA256,
                request.installEvidenceSHA256,
            ].every(hashOK) &&
            Number.isSafeInteger(request.setupBytes) &&
            request.setupBytes > 0,
        'REQUEST_IDENTITY_INVALID',
    );
    const custody: OfflineLaunchCustody = {
        owner: null,
        launchAttempt: io.launchAttempt ?? null,
        identity: null,
        closeRequested: false,
        closure: null,
        handles: [],
    };
    const failures: unknown[] = [],
        reasons: string[] = [];
    const stages: Record<string, unknown> = {
        caseId: 'windows-nsis:offline-launch',
        scope: 'synthetic-memory',
    };
    let identityVerified = false,
        launchInvoked = false,
        closed: Promise<void> | undefined;
    const fail = (error: unknown) => {
        failures.push(error);
        reasons.push(error instanceof OfflineObservationError ? error.code : 'BOUNDARY_FAILURE');
    };
    let adapterRetirementProof: OfflineRetirementProof | undefined;
    // Capture the actual attempt before invocation/identity awaits. Operation errors
    // do not settle this positive acknowledgement or substitute for owner closure.
    const attemptRetirement = custody.launchAttempt
        ? new Promise<OfflineRetirementProof>((resolve) => {
              void custody.launchAttempt!.retired.then((value) => {
                  try {
                      const attempt = custody.launchAttempt!,
                          direct = value.direct;
                      requireFact(
                          value.attemptId === attempt.attemptId &&
                              direct?.attemptId === attempt.attemptId &&
                              value.independentOwnersObserved === true &&
                              direct.processExitObserved === true &&
                              direct.processCloseObserved === true &&
                              direct.stdoutEOF === true &&
                              direct.stdoutCloseObserved === true &&
                              direct.stderrEOF === true &&
                              direct.stderrCloseObserved === true,
                          'ATTEMPT_RETIREMENT_UNCONFIRMED',
                      );
                      adapterRetirementProof = {
                          state: 'retired',
                          basis: 'adapter-attempt',
                          attempt: value,
                      };
                      resolve(adapterRetirementProof);
                  } catch (error) {
                      fail(error);
                  }
              }, fail);
          })
        : undefined;
    try {
        const before = installation(request, await io.readInstallation(), true);
        stages.installation = before;
        const beforeOffline = offline(await io.observeOffline());
        stages.offlineBefore = beforeOffline;
        // The adapter owns pending launch disposition if it cannot return a handle.
        // Such rejection is unknown launch custody, never evidence of process absence.
        stages.launch = 'invoked-outcome-unconfirmed';
        launchInvoked = true;
        const owner = await io.launchInstalled(path.join(request.root, 'Diagnostic Hub.exe'));
        custody.owner = owner; // Adopt before validation, callbacks or subsequent awaits.
        const captured = Object.freeze({
            id: owner.id,
            pid: owner.pid,
            creationTimeMs: owner.creationTimeMs,
        });
        custody.identity = captured;
        closed = owner.closed.then((value) => {
            custody.closure = structuredClone(value);
        }, fail);
        requireFact(
            owner.id.length > 0 &&
                owner.id.length <= 128 &&
                Number.isSafeInteger(owner.pid) &&
                owner.pid > 0 &&
                Number.isFinite(owner.creationTimeMs) &&
                owner.creationTimeMs >= before.activatedAt - 1,
            'LAUNCH_IDENTITY_MISMATCH',
        );
        stages.launch = { ownerId: owner.id, pid: owner.pid, creationTimeMs: owner.creationTimeMs };
        const ready = await io.observeReady(owner);
        requireFact(
            owner.id === captured.id &&
                owner.pid === captured.pid &&
                owner.creationTimeMs === captured.creationTimeMs,
            'OWNER_IDENTITY_CHANGED',
        );
        const window = resolveOfflineNativeWindow(request, captured, ready);
        if (window.query) stages.windowQuery = windowQueryEvidence(window.query);
        if (!window.matched) {
            const error = new OfflineObservationError(
                window.query ? 'WINDOW_QUERY_' + window.query.reason : 'NATIVE_WINDOW_MISMATCH',
            );
            error.cause = window.query; // Preserve raw capture/outcome, including failed or over-bound data.
            throw error;
        }
        identityVerified = true;
        const ack = json(ready.bootAckBytes);
        requireFact(
            ack.schemaVersion === 1 &&
                ack.product === INSTALLATION_PRODUCT &&
                ack.transactionId === before.transactionId &&
                ack.installationId === before.installationId &&
                ack.manifestSHA256 === before.manifestSHA256 &&
                ack.version === request.version &&
                samePath(ack.root, request.root) &&
                samePath(ack.profile, request.profile) &&
                samePath(ack.nativeExecutable, path.join(request.root, 'Diagnostic Hub.exe')) &&
                ack.pid === captured.pid &&
                ack.processCreationMs === captured.creationTimeMs,
            'BOOT_ACK_MISMATCH',
        );
        requireFact(
            ready.ui.ownerId === captured.id &&
                ready.ui.interactionObserved &&
                hashOK(ready.ui.evidenceSHA256),
            'UI_UNCONFIRMED',
        );
        stages.ready = {
            native: structuredClone(ready.native),
            bootAckSHA256: hash(ready.bootAckBytes),
            ui: structuredClone(ready.ui),
        };
        const afterOffline = offline(await io.observeOffline());
        requireFact(
            afterOffline.observationId === beforeOffline.observationId,
            'OFFLINE_IDENTITY_CHANGED',
        );
        stages.offlineAfter = afterOffline;
    } catch (error) {
        fail(error);
    }
    // Request once only after matching native identity. Otherwise retain ownership and
    // await the externally controlled close; never send a message to an unverified window.
    if (custody.owner && identityVerified) {
        const { owner, identity } = custody;
        if (
            owner.id === identity!.id &&
            owner.pid === identity!.pid &&
            owner.creationTimeMs === identity!.creationTimeMs
        ) {
            custody.closeRequested = true;
            try {
                await io.requestNormalClose(owner);
            } catch (error) {
                fail(error);
            }
        } else fail(new OfflineObservationError('OWNER_IDENTITY_CHANGED'));
    }
    if (closed) await closed;
    if (custody.owner) {
        try {
            const c = custody.closure,
                owner = custody.identity!;
            requireFact(
                c &&
                    c.ownerId === owner.id &&
                    c.pid === owner.pid &&
                    c.creationTimeMs === owner.creationTimeMs &&
                    c.processCloseObserved &&
                    c.exitCode === 0 &&
                    c.signal === null &&
                    c.stdoutEOF &&
                    c.stderrEOF &&
                    c.admittedOwnersClosed,
                'CLOSURE_UNCONFIRMED',
            );
            stages.closure = c;
            const after = installation(request, await io.readInstallation());
            requireFact(
                after.snapshotSHA256 ===
                    (stages.installation as ReturnType<typeof installation>).snapshotSHA256,
                'INSTALLATION_CHANGED',
            );
        } catch (error) {
            fail(error);
        }
    }
    let retirement: Promise<OfflineRetirementProof>;
    let ownershipState: 'pending' | 'retired' | 'not-invoked' = 'pending';
    if (!launchInvoked && (!custody.launchAttempt || !custody.launchAttempt.snapshot().invoked)) {
        ownershipState = 'not-invoked';
        retirement = Promise.resolve({ state: 'not-invoked', basis: 'no-launch' });
    } else if (attemptRetirement) {
        retirement = attemptRetirement;
        const snapshot = custody.launchAttempt!.snapshot();
        stages.launchAttempt = snapshot;
        if (adapterRetirementProof) ownershipState = 'retired';
    } else {
        // Existing injected adapters have an explicit identity-bound closure contract.
        // A nonzero outcome still proves retirement if every closure fact is positive;
        // it remains a blocked observation, never successful launch acceptance.
        const c = custody.closure,
            owner = custody.identity;
        if (
            c &&
            owner &&
            c.ownerId === owner.id &&
            c.pid === owner.pid &&
            c.creationTimeMs === owner.creationTimeMs &&
            c.processCloseObserved === true &&
            c.stdoutEOF === true &&
            c.stderrEOF === true &&
            c.admittedOwnersClosed === true
        ) {
            ownershipState = 'retired';
            retirement = Promise.resolve({
                state: 'retired',
                basis: 'owned-closure-contract',
                ownerClosure: c,
            });
        } else retirement = new Promise<OfflineRetirementProof>(() => {}); // Retain unproved custody; no retry or invented proof.
    }
    if (ownershipState === 'pending') fail(new OfflineObservationError('LAUNCH_CUSTODY_PENDING'));
    const observation = {
        schemaVersion: 1,
        kind: 'windows-offline-launch-observation',
        scope: 'synthetic-memory',
        nativeQualified: false,
        acceptance: 'not-a-nine-case-installer-receipt',
        status: failures.length ? 'blocked' : 'synthetic-complete',
        reasons,
        terminal: ownershipState !== 'pending',
        ownershipState,
        caseId: 'windows-nsis:offline-launch',
        sourceCommit: request.sourceCommit,
        sourceTree: request.sourceTree,
        setupSHA256: request.setupSHA256,
        installEvidenceSHA256: request.installEvidenceSHA256,
    };
    let publication: { bytes: number; sha256: string } | null = null;
    try {
        const stageBytes = bounded(stages, 65536);
        const observationBytes = bounded(
            {
                ...observation,
                evidence: {
                    path: 'stages.json',
                    bytes: stageBytes.length,
                    sha256: hash(stageBytes),
                },
            },
            8192,
        );
        // Both bounds checked before allocation. No Mac-specific status/IO assumptions.
        for (const [name, bytes] of [
            ['stages.json', stageBytes],
            ['observation.json', observationBytes],
        ] as const) {
            const handle = await io.openEvidence(name, 'wx', 0o600);
            const held = { name, handle, closed: false };
            custody.handles.push(held);
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close();
            held.closed = true;
            requireFact(
                hash(await io.readEvidence(name)) === hash(bytes),
                'PUBLICATION_READBACK_MISMATCH',
            );
        }
        publication = { bytes: observationBytes.length, sha256: hash(observationBytes) };
    } catch (error) {
        fail(error);
        observation.status = 'blocked';
    }
    // Original boundary errors/returned handles stay with the caller. A publication
    // failure cannot return successful completion, retry a write, or discard custody.
    const terminal = ownershipState !== 'pending' && custody.handles.every((held) => held.closed);
    return {
        status: failures.length ? ('blocked' as const) : ('synthetic-complete' as const),
        terminal,
        ownershipState,
        observation,
        publication,
        failures,
        reasons,
        custody,
        retirement,
    };
}

// The fixed caller separates a durable nonterminal diagnostic from completion.
// Awaiting diagnostic publication must not release a caller's admission fence.
// No native mode is enabled here; runWindowsOfflineLaunch still refuses it first.
export function runOfflineLaunchCase(request: OfflineLaunchRequest, io: OfflineLaunchIO) {
    const diagnostic = runWindowsOfflineLaunch(request, io);
    const retirement = diagnostic.then((result) => result.retirement);
    const completed = diagnostic.then(async (result) => {
        const proof = await result.retirement;
        // Failed/unacknowledged publication handles remain retained too. There is no
        // automatic close/retry or recovery interface fabricated by this preparation.
        if (result.custody.handles.some((held) => !held.closed)) await new Promise<never>(() => {});
        return { ...result, terminal: true as const, ownershipState: proof.state };
    });
    void diagnostic.catch(() => {});
    void retirement.catch(() => {});
    void completed.catch(() => {});
    return Object.freeze({ diagnostic, retirement, completed });
}
