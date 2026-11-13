/** Explicit source-fixture entry. Importing it never installs, loads native code or launches.
 * Running it really installs A/updates B and, after actual terminal consent, runs Finalize
 * through the durable preparing checkpoint and ordinary owned quit. Never run as a build check.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    runLinuxOwnedInstallationFixture,
    getLinuxOwnedCurrentBFixtureContext,
    type LinuxOwnedCurrentBFixtureContext,
} from './linux-owned-installation-fixture.ts';
import {
    linuxPermanentArguments,
    runLinuxPermanentOwnedFixture,
    runLinuxPermanentSealRecoveryFixture,
    linuxPermanentSetupDiagnostics,
} from '../electron/linux-permanent-setup.ts';
import { linuxTerminalPrompt } from '../electron/linux-setup-prompts.ts';

const runs = new Set<object>();
const paused = new WeakMap<
    object,
    {
        context: LinuxOwnedCurrentBFixtureContext;
        productOwner: object;
        desktop: Readonly<Record<string, string>>;
        consumed: boolean;
    }
>();
const need = (value: unknown, reason: string) => {
    if (!value) throw Error(reason);
};
const closedBackend = (value: any) =>
    Boolean(
        value &&
        value.failed === false &&
        value.pending === null &&
        value.retainedFDs === 0 &&
        value.retainedDirs === 0 &&
        value.retainedServers === 0 &&
        value.retainedSockets === 0 &&
        value.retainedTimers === 0,
    );
const knownPause = (value: ReturnType<typeof linuxPermanentSetupDiagnostics>) => {
    const launch = value.launch;
    return Boolean(
        value.phase === 'fixture-paused' &&
        value.primarySet === false &&
        value.native?.failed === false &&
        value.native.retainedFDs === 0 &&
        closedBackend(value.backend?.backend) &&
        launch?.verdict === 'SEAL_PREPARATION_PAUSED' &&
        launch.code === 'SEAL_PREPARATION_PAUSED' &&
        launch.pending === null &&
        launch.reservation === 'none' &&
        launch.childOwned === false &&
        launch.timerOwned === false &&
        launch.spawned === true &&
        launch.exited === true &&
        launch.closed === true &&
        launch.initialConfirmed === false &&
        launch.retainedConfirmed === false &&
        launch.sealRecovered === false &&
        launch.sealInterrupted === true &&
        launch.pipes.stdout.end &&
        launch.pipes.stdout.close &&
        launch.pipes.stderr.end &&
        launch.pipes.stderr.close &&
        launch.readback?.closed === true &&
        launch.readback.failed === false &&
        launch.quitControl?.closed === true &&
        launch.quitControl.failed === false,
    );
};
const knownRecovery = (value: ReturnType<typeof linuxPermanentSetupDiagnostics>) => {
    const launch = value.launch;
    return Boolean(
        value.phase === 'finished' &&
        value.primarySet === false &&
        value.native?.failed === false &&
        value.native.retainedFDs === 0 &&
        closedBackend(value.backend?.backend) &&
        launch?.verdict === 'SEAL_RECOVERED_NO_LAUNCH' &&
        launch.code === 'SEAL_RECOVERED_NO_LAUNCH' &&
        launch.sealRecovered === true &&
        launch.spawned === false &&
        launch.childOwned === false &&
        launch.timerOwned === false &&
        launch.reservation === 'none' &&
        launch.pending === null &&
        launch.readback === null &&
        launch.quitControl === null &&
        launch.initialConfirmed === false &&
        launch.retainedConfirmed === false &&
        launch.sealInterrupted === false,
    );
};

/** Direct source-controller qualification, not coverage of the packaged Finalize CLI.
 * No record supplied by a caller can replace the actual current-B fixture result.
 * The deliberate cooperative pause is not abrupt-crash or successful-Finalize evidence. */
export async function runLinuxOwnedSealPreparationFixture(args: string[]) {
    const desktop = Object.freeze(
        Object.fromEntries(
            ['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY']
                .filter((key) => Boolean(process.env[key]))
                .map((key) => [key, process.env[key]!]),
        ),
    );
    need(
        process.platform === 'linux' &&
            process.arch === 'x64' &&
            process.getuid?.() &&
            process.getuid() === process.geteuid?.() &&
            process.stdin.isTTY === true &&
            process.stdout.isTTY === true &&
            (desktop.DISPLAY || (desktop.WAYLAND_DISPLAY && desktop.XDG_RUNTIME_DIR)),
        'SEAL_FIXTURE_OWNED_TERMINAL_AND_GUI_REQUIRED',
    );
    const state = {
        phase: 'current-b',
        primarySet: false,
        primary: undefined as unknown,
        fixture: undefined as unknown,
        product: undefined as unknown,
        pending: null as Promise<unknown> | null,
        keeper: null as ReturnType<typeof setInterval> | null,
    };
    runs.add(state); // Before the first fixture/native effect; keep all returned owners.
    try {
        state.pending = runLinuxOwnedInstallationFixture([...args, '--scenario', 'current-b']);
        state.fixture = await state.pending;
        state.pending = null;
        const context = getLinuxOwnedCurrentBFixtureContext(state.fixture);
        context.revalidateCopies();
        state.phase = 'review-and-product-operation';
        const choices = linuxPermanentArguments([
            '--install-directory',
            context.root,
            '--version',
            context.host.version,
            '--operation',
            'finalize',
            '--terminal',
            '--no-menu',
        ]);
        const terminal = linuxTerminalPrompt();
        state.pending = runLinuxPermanentOwnedFixture(
            context.host,
            choices,
            context.dataHome,
            {
                terminal,
                gui: { review: async () => ({ status: 'unavailable' }), hasPending: () => false },
                now: () => performance.now(),
            },
            desktop,
            'seal-preparation',
        );
        const result = (await state.pending) as Awaited<
            ReturnType<typeof runLinuxPermanentOwnedFixture>
        >;
        state.product = result; // Adopt before checking status or doing any further readback.
        state.pending = null;
        const custody = linuxPermanentSetupDiagnostics(result.owner);
        const observed = custody.backend?.backend;
        if (
            result.status === 'cancelled' &&
            custody.phase === 'cancelled' &&
            !terminal.hasPending() &&
            custody.launch === undefined &&
            custody.native?.failed === false &&
            custody.native.retainedFDs === 0 &&
            observed?.failed === false &&
            observed.pending === null &&
            observed.retainedFDs === 0 &&
            observed.retainedDirs === 0 &&
            observed.retainedServers === 0 &&
            observed.retainedSockets === 0 &&
            observed.retainedTimers === 0
        ) {
            context.revalidateCopies();
            runs.delete(state);
            return Object.freeze({
                status: 'cancelled' as const,
                releaseAcceptance: false as const,
            });
        }
        need(
            result.status === 'fixture-seal-preparation-paused' &&
                knownPause(custody) &&
                !terminal.hasPending(),
            'SEAL_FIXTURE_PRODUCT_NONPASSING',
        );
        context.revalidateCopies();
        state.phase = 'record';
        const record = context.writeSealPreparationRecord(
            Buffer.from(
                JSON.stringify({
                    sourceCommit: context.sourceCommit,
                    runId: context.runId,
                    runAttempt: context.runAttempt,
                    scenario: 'cooperative-seal-preparing-pause',
                    copies: context.copies,
                    originals: context.records,
                    product: result,
                    custody,
                    releaseAcceptance: false,
                    abruptInterruptionObserved: false,
                }),
            ),
        );
        state.phase = 'complete';
        runs.delete(state); // Only after known operation closure and fixed record/copy readback.
        const returned = Object.freeze({
            status: 'cooperative-seal-preparing-paused' as const,
            record,
            sourceCommit: context.sourceCommit,
            releaseAcceptance: false as const,
            finalized: false as const,
            abruptInterruptionObserved: false as const,
        });
        paused.set(returned, { context, productOwner: result.owner, desktop, consumed: false });
        return returned;
    } catch (error) {
        state.primarySet = true;
        state.primary = error; // Preserve even thrown undefined; no retry, close or cleanup.
        state.keeper ??= setInterval(() => {}, 60000);
        return Object.freeze({
            status: 'retained-nonpassing' as const,
            phase: state.phase,
            releaseAcceptance: false as const,
        });
    }
}

/** Continue only the actual in-process pause. The ordinary product obtains fresh review/consent
 * and restricts its observed pending seal to the still-known original product owner. */
export async function runLinuxOwnedSealRecoveryFixture(prepared: unknown) {
    need(
        prepared && typeof prepared === 'object' && paused.has(prepared),
        'SEAL_FIXTURE_PAUSED_RESULT_REQUIRED',
    );
    const continuation = paused.get(prepared as object)!;
    need(!continuation.consumed, 'SEAL_FIXTURE_RECOVERY_CONSUMED');
    continuation.consumed = true; // Before copy/record reads, prompt creation or product/native effects.
    const state = {
        phase: 'recovery-originals',
        primarySet: false,
        primary: undefined as unknown,
        product: undefined as unknown,
        pending: null as Promise<unknown> | null,
        keeper: null as ReturnType<typeof setInterval> | null,
    };
    runs.add(state);
    try {
        need(
            process.stdin.isTTY === true && process.stdout.isTTY === true,
            'SEAL_FIXTURE_RECOVERY_TERMINAL_REQUIRED',
        );
        const context = continuation.context;
        const revalidate = () => {
            need(
                knownPause(linuxPermanentSetupDiagnostics(continuation.productOwner)),
                'SEAL_FIXTURE_PAUSED_OWNER_CHANGED',
            );
            context.revalidateCopies();
            return context.revalidateSealPreparationRecord();
        };
        const original = revalidate(),
            choices = linuxPermanentArguments([
                '--install-directory',
                context.root,
                '--version',
                context.host.version,
                '--operation',
                'finalize',
                '--terminal',
                '--no-menu',
            ]),
            terminal = linuxTerminalPrompt();
        state.phase = 'recovery-review-and-operation';
        state.pending = runLinuxPermanentSealRecoveryFixture(
            context.host,
            choices,
            context.dataHome,
            {
                terminal: {
                    async review(request) {
                        revalidate();
                        const reply = await terminal.review(request);
                        revalidate();
                        return reply;
                    },
                    hasPending: () => terminal.hasPending(),
                },
                gui: { review: async () => ({ status: 'unavailable' }), hasPending: () => false },
                now: () => performance.now(),
            },
            continuation.desktop,
            continuation.productOwner,
        );
        const result = (await state.pending) as Awaited<
            ReturnType<typeof runLinuxPermanentSealRecoveryFixture>
        >;
        state.product = result;
        state.pending = null;
        const custody = linuxPermanentSetupDiagnostics(result.owner);
        if (
            result.status === 'cancelled' &&
            custody.phase === 'cancelled' &&
            custody.launch === undefined &&
            !terminal.hasPending() &&
            custody.primarySet === false &&
            custody.native?.failed === false &&
            custody.native.retainedFDs === 0 &&
            closedBackend(custody.backend?.backend)
        ) {
            revalidate();
            runs.delete(state);
            return Object.freeze({
                status: 'cancelled' as const,
                releaseAcceptance: false as const,
            });
        }
        need(
            result.status === 'previous-generation-seal-recovered' &&
                knownRecovery(custody) &&
                !terminal.hasPending(),
            'SEAL_FIXTURE_RECOVERY_NONPASSING',
        );
        revalidate();
        state.phase = 'recovery-record';
        const record = context.writeSealRecoveryRecord(
            Buffer.from(
                JSON.stringify({
                    sourceCommit: context.sourceCommit,
                    runId: context.runId,
                    runAttempt: context.runAttempt,
                    scenario: 'cooperative-seal-recovery-no-launch',
                    preparation: original,
                    copies: context.copies,
                    originals: context.records,
                    product: result,
                    custody,
                    applicationLaunched: false,
                    newBootObservation: false,
                    releaseAcceptance: false,
                    abruptInterruptionObserved: false,
                }),
            ),
        );
        state.phase = 'complete';
        runs.delete(state);
        return Object.freeze({
            status: 'cooperative-seal-recovered' as const,
            record,
            sourceCommit: context.sourceCommit,
            applicationLaunched: false as const,
            newBootObservation: false as const,
            releaseAcceptance: false as const,
            abruptInterruptionObserved: false as const,
        });
    } catch (error) {
        state.primarySet = true;
        state.primary = error;
        state.keeper ??= setInterval(() => {}, 60000);
        return Object.freeze({
            status: 'retained-nonpassing' as const,
            phase: state.phase,
            releaseAcceptance: false as const,
        });
    }
}

/** This opt-in belongs only to the source fixture. The product CLI remains unchanged. */
export function linuxOwnedSealFixtureArguments(args: string[]) {
    const selected: string[] = [];
    let recover = false;
    for (const value of args) {
        if (value === '--recover-seal') {
            need(!recover, 'SEAL_FIXTURE_RECOVERY_ARGUMENT');
            recover = true;
        } else selected.push(value);
    }
    return { args: selected, recover };
}
export async function runLinuxOwnedSealFixture(args: string[]) {
    const selected = linuxOwnedSealFixtureArguments(args),
        result = await runLinuxOwnedSealPreparationFixture(selected.args);
    return selected.recover && result.status === 'cooperative-seal-preparing-paused'
        ? runLinuxOwnedSealRecoveryFixture(result)
        : result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void runLinuxOwnedSealFixture(process.argv.slice(2)).then(
        (result) => {
            process.exitCode = [
                'cooperative-seal-preparing-paused',
                'cooperative-seal-recovered',
            ].includes(result.status)
                ? 0
                : 1;
            process.stdout.write(
                result.status === 'cooperative-seal-recovered'
                    ? '::notice title=Linux owned seal fixture::outcome=cooperative-seal-recovered noLaunch=true releaseAcceptance=false\n'
                    : result.status === 'cooperative-seal-preparing-paused'
                      ? '::notice title=Linux owned seal fixture::outcome=cooperative-preparing-pause finalized=false releaseAcceptance=false\n'
                      : result.status === 'cancelled'
                        ? '::notice title=Linux owned seal fixture::outcome=cancelled releaseAcceptance=false\n'
                        : '::error title=Linux owned seal fixture::outcome=retained-nonpassing\n',
            );
        },
        () => {
            process.exitCode = 78;
            process.stderr.write(
                'Linux seal fixture requires its eligible owned terminal and GUI.\n',
            );
        },
    );
}
