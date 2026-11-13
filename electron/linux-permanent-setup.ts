import path from 'node:path';
import {
    validateInstallationManifest,
    MAX_INSTALLATION_MANIFEST_BYTES,
} from '../shared/installation.ts';
import { SETUP_PAYLOAD } from './installation-maintenance.ts';
import { linuxReviewDisk, type LinuxReviewHost } from './linux-setup-review.ts';
import {
    linuxReviewArguments,
    type LinuxReviewChoices,
    type LinuxPromptPort,
} from './linux-setup-ui.ts';
import { createLinuxNativeHost, linuxNativeHostFailureCustody } from './linux-native-host.ts';
import {
    prepareLinuxNativeDriver,
    prepareLinuxNativeUninstallDriver,
} from './linux-native-driver.ts';
import { linuxModelReviewSHA256, type LinuxModelView } from './linux-transaction-model.ts';
import { createLinuxOwnedQuitSelection } from './linux-setup-readback.ts';
import { createLinuxSealInterruptionSelection } from './linux-native-backend.ts';
import {
    createLinuxOwnedLaunch,
    createLinuxNativeLaunchProcessHost,
    type LinuxLaunchDesktop,
} from './linux-owned-launch.ts';

export interface LinuxPermanentPrompts {
    gui: LinuxPromptPort;
    terminal: LinuxPromptPort;
    now(): number;
}
export type LinuxPermanentChoices = Omit<LinuxReviewChoices, 'operation'> & {
    operation:
        | 'install'
        | 'repair'
        | 'update'
        | 'rollback'
        | 'resume'
        | 'launch'
        | 'uninstall-current'
        | 'finalize';
};
/** Keep the legacy read-only argument contract unchanged; resume belongs to this explicit entry. */
export function linuxPermanentArguments(args: string[]): LinuxPermanentChoices {
    const selected = args.slice();
    let special: 'resume' | 'uninstall-current' | 'finalize' | undefined;
    for (let at = 0; at < selected.length; at++) {
        if (
            selected[at] === '--operation' &&
            ['resume', 'uninstall-current', 'finalize'].includes(selected[at + 1])
        ) {
            special = selected[at + 1] as typeof special;
            selected[at + 1] = 'review';
        }
    }
    const choices = linuxReviewArguments(selected);
    if (
        (choices.operation === 'launch' || special === 'finalize') &&
        selected.includes('--no-launch')
    )
        throw Error('LINUX_PERMANENT_ARGUMENT_CONFLICT');
    if (choices.operation === 'review' && !special)
        throw Error('LINUX_PERMANENT_OPERATION_REQUIRED');
    return {
        ...choices,
        operation: special ?? (choices.operation as LinuxPermanentChoices['operation']),
    };
}
const retained = new Set<object>();
declare const ownedFixtureSelection: unique symbol;
type OwnedFixtureSelection = { readonly [ownedFixtureSelection]: never };
type OwnedFixtureMode = 'normal-quit' | 'seal-preparation' | 'seal-recovery';
const ownedFixtures = new WeakMap<object, OwnedFixtureMode>();
const recoveryRestrictions = new WeakMap<object, { owner: object; reviewSHA256: string }>();
const consumedRecoveryOwners = new WeakSet<object>();

/** A direct source-fixture caller, never an installer CLI switch or acceptance record.
 * The ordinary controller still obtains its real review and consent before minting
 * either operation selection. A supplied JSON record cannot enter this path. */
export function runLinuxPermanentOwnedFixture(
    host: LinuxReviewHost,
    choices: LinuxPermanentChoices,
    dataHome: string,
    prompts: LinuxPermanentPrompts,
    desktop: LinuxLaunchDesktop,
    mode: Exclude<OwnedFixtureMode, 'seal-recovery'>,
) {
    choices = structuredClone(choices); // Validate and execute one private data snapshot.
    if (
        !['normal-quit', 'seal-preparation'].includes(mode) ||
        choices.operation !== (mode === 'normal-quit' ? 'launch' : 'finalize') ||
        choices.menu !== false ||
        choices.terminal !== true
    )
        throw Error('LINUX_OWNED_FIXTURE_SELECTION');
    const selection = Object.freeze({}) as OwnedFixtureSelection;
    ownedFixtures.set(selection, mode);
    return runLinuxPermanentSetup(host, choices, dataHome, prompts, desktop, selection);
}
const owners = new WeakMap<
    object,
    {
        phase: string;
        native?: Awaited<ReturnType<typeof createLinuxNativeHost>>;
        preparation?: ReturnType<typeof prepareLinuxNativeDriver>;
        uninstall?: ReturnType<typeof prepareLinuxNativeUninstallDriver>;
        launch?: ReturnType<typeof createLinuxOwnedLaunch>;
        candidate?: unknown;
        primarySet: boolean;
        primary?: unknown;
    }
>();

function closedPausedReview(owner: object): LinuxModelView {
    const state = owners.get(owner),
        launch = state?.launch;
    if (!state || state.phase !== 'fixture-paused' || state.primarySet || !launch)
        throw Error('LINUX_SEAL_RECOVERY_OWNER');
    const summary = launch.summary(),
        diagnostics = launch.diagnostics();
    const native = state.native?.diagnostics(),
        preparation = state.preparation?.diagnostics().backend;
    if (
        summary.verdict !== 'SEAL_PREPARATION_PAUSED' ||
        summary.sealInterrupted !== true ||
        summary.pending !== null ||
        summary.childOwned !== false ||
        summary.timerOwned !== false ||
        summary.reservation !== 'none' ||
        summary.spawned !== true ||
        summary.exited !== true ||
        summary.closed !== true ||
        summary.initialConfirmed !== false ||
        summary.retainedConfirmed !== false ||
        summary.sealRecovered !== false ||
        summary.readback?.closed !== true ||
        summary.readback.failed !== false ||
        summary.quitControl?.closed !== true ||
        summary.quitControl.failed !== false ||
        diagnostics.failed !== false ||
        diagnostics.launchPrimarySet !== false ||
        diagnostics.pending !== null ||
        diagnostics.retainedFDs !== 0 ||
        diagnostics.retainedDirs !== 0 ||
        diagnostics.retainedServers !== 0 ||
        diagnostics.retainedSockets !== 0 ||
        diagnostics.retainedTimers !== 0 ||
        native?.failed !== false ||
        native.retainedFDs !== 0 ||
        preparation?.failed !== false ||
        preparation.pending !== null ||
        preparation.retainedFDs !== 0 ||
        preparation.retainedDirs !== 0 ||
        preparation.retainedServers !== 0 ||
        preparation.retainedSockets !== 0 ||
        preparation.retainedTimers !== 0
    )
        throw Error('LINUX_SEAL_RECOVERY_OWNER');
    const observation = launch.sealInterruptionObservation();
    if (!observation || observation.view.history?.cleanup?.seal?.state !== 'preparing')
        throw Error('LINUX_SEAL_RECOVERY_OWNER');
    return {
        ...structuredClone(observation.view),
        activity: { root: 'inactive', stage: 'inactive', previous: 'inactive' },
    };
}

/** Restrict the existing operation to this actual paused owner's exact pending seal.
 * This does not admit a supplied record or add a normal installer mode. */
export function runLinuxPermanentSealRecoveryFixture(
    host: LinuxReviewHost,
    choices: LinuxPermanentChoices,
    dataHome: string,
    prompts: LinuxPermanentPrompts,
    desktop: LinuxLaunchDesktop,
    pausedOwner: object,
) {
    choices = structuredClone(choices);
    const expected = closedPausedReview(pausedOwner);
    if (
        consumedRecoveryOwners.has(pausedOwner) ||
        choices.operation !== 'finalize' ||
        choices.menu !== false ||
        choices.terminal !== true ||
        !expected.root ||
        choices.root !== expected.root.root ||
        choices.version !== expected.root.manifest.version
    )
        throw Error('LINUX_SEAL_RECOVERY_SELECTION');
    consumedRecoveryOwners.add(pausedOwner); // Before source, prompt or native effects; no retry.
    const selection = Object.freeze({}) as OwnedFixtureSelection;
    ownedFixtures.set(selection, 'seal-recovery');
    recoveryRestrictions.set(selection, {
        owner: pausedOwner,
        reviewSHA256: linuxModelReviewSHA256(expected),
    });
    return runLinuxPermanentSetup(host, choices, dataHome, prompts, desktop, selection);
}

/** Explicit complete-folder installer. Portable AppRun and the read-only review keep their own entries.
 * No supplied transcript or qualification bit enters this caller. Finalize is no-menu only. */
export async function runLinuxPermanentSetup(
    host: LinuxReviewHost,
    choices: LinuxPermanentChoices,
    dataHome: string,
    prompts: LinuxPermanentPrompts,
    desktop: LinuxLaunchDesktop,
    fixtureSelection?: OwnedFixtureSelection,
) {
    let fixtureMode: OwnedFixtureMode | undefined;
    let recovery: { owner: object; reviewSHA256: string } | undefined;
    if (fixtureSelection !== undefined) {
        fixtureMode = ownedFixtures.get(fixtureSelection);
        if (!fixtureMode) throw Error('LINUX_OWNED_FIXTURE_SELECTION');
        recovery = recoveryRestrictions.get(fixtureSelection);
        if (fixtureMode === 'seal-recovery' && !recovery)
            throw Error('LINUX_SEAL_RECOVERY_SELECTION');
        ownedFixtures.delete(fixtureSelection); // Consume before source/native/prompt effects.
        recoveryRestrictions.delete(fixtureSelection);
    }
    host = structuredClone(host);
    choices = structuredClone(choices);
    if (
        ![
            'install',
            'repair',
            'update',
            'rollback',
            'resume',
            'launch',
            'uninstall-current',
            'finalize',
        ].includes(choices.operation)
    )
        throw Error('LINUX_PERMANENT_OPERATION_REQUIRED');
    const startedMs = prompts.now(),
        deadlineMs = startedMs + 120000;
    if (!Number.isFinite(startedMs)) throw Error('LINUX_PERMANENT_CLOCK');
    const owner = Object.freeze({});
    const state: NonNullable<ReturnType<typeof owners.get>> = {
        phase: 'source',
        primarySet: false,
    };
    owners.set(owner, state);
    retained.add(owner); // Before original-byte reads, native load or backend acquisition.
    const gate = () => {
        const now = prompts.now();
        if (!Number.isFinite(now) || now < startedMs || now >= deadlineMs)
            throw Error('LINUX_PERMANENT_DEADLINE');
    };
    const requireRecovery = (view?: LinuxModelView) => {
        if (!recovery) return;
        if (
            linuxModelReviewSHA256(closedPausedReview(recovery.owner)) !== recovery.reviewSHA256 ||
            (view &&
                (view.history?.cleanup?.seal?.state !== 'preparing' ||
                    linuxModelReviewSHA256(view) !== recovery.reviewSHA256))
        )
            throw Error('LINUX_SEAL_RECOVERY_CHANGED');
    };
    try {
        requireRecovery();
        const bytes = await linuxReviewDisk.bytes(
            path.posix.join(host.sourceRoot, SETUP_PAYLOAD),
            MAX_INSTALLATION_MANIFEST_BYTES,
            host.uid,
        );
        gate();
        const manifest = validateInstallationManifest(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
        if (manifest.version !== host.version) throw Error('LINUX_PERMANENT_SOURCE_VERSION');
        state.candidate = createLinuxNativeHost(host.sourceRoot, manifest);
        state.native = (await state.candidate) as Awaited<ReturnType<typeof createLinuxNativeHost>>;
        gate();
        state.phase = 'preparing';
        if (choices.operation === 'uninstall-current') {
            if (choices.menu) throw Error('LINUX_UNINSTALL_INITIAL_NO_MENU_REQUIRED');
            state.uninstall = prepareLinuxNativeUninstallDriver(
                { host, root: choices.root },
                { startedMs, deadlineMs },
                state.native.operations,
                state.native.owner,
            );
            const review = await state.uninstall.inspect();
            gate();
            state.phase = 'prompt';
            const request = {
                detail: state.uninstall.describe(review),
                menu: false,
                deadlineMs,
                confirmation: 'apply' as const,
            };
            let reply = await (choices.terminal ? prompts.terminal : prompts.gui).review(request);
            gate();
            if (reply.status === 'unavailable' && !choices.terminal) {
                reply = await prompts.terminal.review(request);
                gate();
            }
            if (reply.status === 'cancelled') {
                state.phase = 'cancelled';
                return Object.freeze({ status: 'cancelled' as const, owner });
            }
            if (reply.status !== 'confirmed' || reply.menu !== false)
                throw Error('LINUX_PERMANENT_PROMPT_UNSETTLED');
            state.phase = 'fresh-review';
            const fresh = await state.uninstall.inspect();
            gate();
            if (state.uninstall.reviewHash(fresh) !== state.uninstall.reviewHash(review))
                throw Error('LINUX_PERMANENT_REVIEW_CHANGED');
            state.phase = 'uninstall-current';
            const result = await state.uninstall.run(fresh, true);
            state.phase = result.status === 'current-payload-removed' ? 'finished' : result.status;
            return Object.freeze({ status: result.status, owner, result });
        }
        state.preparation = prepareLinuxNativeDriver(
            { host, root: choices.root, action: choices.operation, dataHome, menu: choices.menu },
            { startedMs, deadlineMs },
            state.native.operations,
            state.native.owner,
        );
        const review = await state.preparation.inspect();
        gate();
        requireRecovery(review); // Reject app-launch/already-finalized fallthrough before consent.
        if (
            choices.operation === 'finalize' &&
            (review.journal === null || review.journal.phase === 'candidate-confirmed') &&
            (!review.history?.cleanup?.seal || review.history.cleanup.seal.state === 'published')
        ) {
            const fresh = await state.preparation.inspect();
            gate();
            if (linuxModelReviewSHA256(fresh) !== linuxModelReviewSHA256(review))
                throw Error('LINUX_PERMANENT_REVIEW_CHANGED');
            state.phase = 'finished';
            return Object.freeze({
                status: review.history?.cleanup
                    ? ('previous-generation-already-finalized' as const)
                    : ('initial-already-completed' as const),
                owner,
            });
        }
        state.phase = 'prompt';
        const request = {
            detail:
                state.preparation.describe(review) +
                (fixtureMode === 'seal-preparation'
                    ? '\nOwned fixture: pause after the durable seal intent, before confirmed-journal bytes or publication, then request ordinary app quit. This removes the previous application payload as described above, but the paused result is not completed Finalize. Original records and profile remain retained.'
                    : fixtureMode === 'normal-quit'
                      ? '\nOwned fixture: after verified startup, request ordinary app quit through its inherited control channel. No signal or cleanup is performed.'
                      : ''),
            menu:
                choices.menuExplicit === false
                    ? state.preparation.menuSelected(review)
                    : choices.menu,
            deadlineMs,
            confirmation: 'apply' as const,
        };
        const requestReview = recovery
            ? async (port: LinuxPromptPort) => {
                  requireRecovery();
                  const reply = await port.review(request);
                  requireRecovery();
                  return reply;
              }
            : (port: LinuxPromptPort) => port.review(request);
        let reply = await requestReview(choices.terminal ? prompts.terminal : prompts.gui);
        gate();
        if (reply.status === 'unavailable' && !choices.terminal) {
            reply = await requestReview(prompts.terminal);
            gate();
        }
        if (reply.status === 'cancelled') {
            state.phase = 'cancelled';
            return Object.freeze({ status: 'cancelled', owner });
        }
        if (reply.status !== 'confirmed' || typeof reply.menu !== 'boolean')
            throw Error('LINUX_PERMANENT_PROMPT_UNSETTLED');
        state.phase = 'fresh-review';
        const fresh = await state.preparation.inspect();
        gate();
        requireRecovery(fresh);
        if (linuxModelReviewSHA256(fresh) !== linuxModelReviewSHA256(review))
            throw Error('LINUX_PERMANENT_REVIEW_CHANGED');
        const plan = state.preparation.plan(fresh, reply.menu);
        if (choices.operation === 'launch' || choices.operation === 'finalize') {
            state.phase = 'launch';
            const quitSelection =
                fixtureMode === 'normal-quit' || fixtureMode === 'seal-preparation'
                    ? createLinuxOwnedQuitSelection({
                          root: plan.root,
                          installationId: plan.installationId,
                          transactionId: plan.transactionId,
                          manifestSHA256: plan.review.source.verifiedManifestSHA256,
                          version: plan.host.version,
                          profile: plan.review.root!.profile,
                          executable: path.posix.join(plan.root, 'app/diagnostic-hub'),
                          uid: plan.host.uid,
                      })
                    : undefined;
            const sealSelection =
                fixtureMode === 'seal-preparation'
                    ? createLinuxSealInterruptionSelection()
                    : undefined;
            state.launch = createLinuxOwnedLaunch(
                plan,
                { startedMs, deadlineMs },
                desktop,
                state.native.operations,
                createLinuxNativeLaunchProcessHost(),
                true,
                quitSelection,
                sealSelection,
            );
            const result = await state.launch.run();
            if (
                fixtureMode === 'seal-preparation' &&
                result.verdict === 'SEAL_PREPARATION_PAUSED'
            ) {
                state.phase = 'fixture-paused';
                return Object.freeze({
                    status: 'fixture-seal-preparation-paused' as const,
                    owner,
                    result,
                    interruption: state.launch.sealInterruptionObservation(),
                    releaseAcceptance: false as const,
                });
            }
            state.phase =
                result.verdict === 'RETAINED_UNKNOWN'
                    ? 'retained-unknown'
                    : ['DIRECT_CHILD_CLOSED_RETAINED', 'SEAL_RECOVERED_NO_LAUNCH'].includes(
                            result.verdict,
                        )
                      ? 'finished'
                      : 'refused';
            if (choices.operation === 'finalize')
                return Object.freeze({
                    status:
                        state.phase === 'finished'
                            ? result.sealRecovered === true
                                ? 'previous-generation-seal-recovered'
                                : result.retainedConfirmed === true
                                  ? 'previous-generation-finalized'
                                  : result.initialConfirmed === true
                                    ? 'initial-finalized'
                                    : state.phase
                            : state.phase,
                    owner,
                    result,
                });
            return Object.freeze({ status: 'launch', owner, result });
        }
        state.phase = 'transaction';
        const result = await state.preparation.run(plan);
        state.phase =
            result.verdict === 'RETAINED_UNKNOWN'
                ? 'retained-unknown'
                : ['ACTIVE_PREVIOUS_RETAINED', 'ROLLED_BACK_RETAINED'].includes(result.verdict)
                  ? 'finished'
                  : 'refused';
        return Object.freeze({ status: state.phase, owner, result });
    } catch (error) {
        state.primarySet = true;
        state.primary = error; // Preserve Error, undefined and any returned owner without a retry.
        state.candidate ??= linuxNativeHostFailureCustody(error);
        state.phase = 'retained-unknown';
        return Object.freeze({ status: 'retained-unknown', owner });
    }
}

/** Pure custody summary. Failure never requests rollback, release, unlink or process termination. */
export function linuxPermanentSetupDiagnostics(owner: object) {
    const state = owners.get(owner);
    if (!state) throw Error('LINUX_PERMANENT_OWNER');
    return Object.freeze({
        phase: state.phase,
        primarySet: state.primarySet,
        native: state.native?.diagnostics(),
        backend: state.preparation?.diagnostics(),
        uninstall: state.uninstall?.diagnostics(),
        launch: state.launch?.summary(),
    });
}
