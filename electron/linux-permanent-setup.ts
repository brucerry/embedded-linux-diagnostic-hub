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
import { linuxModelReviewSHA256 } from './linux-transaction-model.ts';
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
        'install' | 'repair' | 'update' | 'rollback' | 'resume' | 'launch' | 'uninstall-current';
};
/** Keep the legacy read-only argument contract unchanged; resume belongs to this explicit entry. */
export function linuxPermanentArguments(args: string[]): LinuxPermanentChoices {
    const selected = args.slice();
    let special: 'resume' | 'uninstall-current' | undefined;
    for (let at = 0; at < selected.length; at++) {
        if (
            selected[at] === '--operation' &&
            ['resume', 'uninstall-current'].includes(selected[at + 1])
        ) {
            special = selected[at + 1] as typeof special;
            selected[at + 1] = 'review';
        }
    }
    const choices = linuxReviewArguments(selected);
    if (choices.operation === 'launch' && selected.includes('--no-launch'))
        throw Error('LINUX_PERMANENT_ARGUMENT_CONFLICT');
    if (choices.operation === 'review' && !special)
        throw Error('LINUX_PERMANENT_OPERATION_REQUIRED');
    return {
        ...choices,
        operation: special ?? (choices.operation as LinuxPermanentChoices['operation']),
    };
}
const retained = new Set<object>();
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

/** Explicit complete-folder installer. Portable AppRun and the read-only review keep their own entries.
 * No supplied transcript, qualification bit or Finalize authority enters this caller. */
export async function runLinuxPermanentSetup(
    host: LinuxReviewHost,
    choices: LinuxPermanentChoices,
    dataHome: string,
    prompts: LinuxPermanentPrompts,
    desktop: LinuxLaunchDesktop,
) {
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
    try {
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
        state.phase = 'prompt';
        const request = {
            detail: state.preparation.describe(review),
            menu:
                choices.menuExplicit === false
                    ? state.preparation.menuSelected(review)
                    : choices.menu,
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
            return Object.freeze({ status: 'cancelled', owner });
        }
        if (reply.status !== 'confirmed' || typeof reply.menu !== 'boolean')
            throw Error('LINUX_PERMANENT_PROMPT_UNSETTLED');
        state.phase = 'fresh-review';
        const fresh = await state.preparation.inspect();
        gate();
        if (linuxModelReviewSHA256(fresh) !== linuxModelReviewSHA256(review))
            throw Error('LINUX_PERMANENT_REVIEW_CHANGED');
        const plan = state.preparation.plan(fresh, reply.menu);
        if (choices.operation === 'launch') {
            state.phase = 'launch';
            state.launch = createLinuxOwnedLaunch(
                plan,
                { startedMs, deadlineMs },
                desktop,
                state.native.operations,
                createLinuxNativeLaunchProcessHost(),
                true,
            );
            const result = await state.launch.run();
            state.phase =
                result.verdict === 'RETAINED_UNKNOWN'
                    ? 'retained-unknown'
                    : result.verdict === 'DIRECT_CHILD_CLOSED_RETAINED'
                      ? 'finished'
                      : 'refused';
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
