/** Opt-in source fixture. Import is inert; invocation really installs/updates, launches,
 * Finalizes twice and removes only the selected current payload after real terminal consent.
 * Never invoke this as a syntax, build or source-control check. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types as utilTypes } from 'node:util';
import {
    linuxOwnedFixtureArguments,
    runLinuxOwnedInstallationFixture,
    getLinuxOwnedCurrentBWithCFixtureContext,
    getLinuxOwnedCurrentCFixtureContext,
} from './linux-owned-installation-fixture.ts';
import {
    linuxPermanentArguments,
    runLinuxPermanentOwnedFixture,
    runLinuxPermanentSetup,
    linuxPermanentSetupDiagnostics,
    type LinuxPermanentPrompts,
} from '../electron/linux-permanent-setup.ts';
import { linuxTerminalPrompt } from '../electron/linux-setup-prompts.ts';

const retained = new Set<object>();
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
const closedNative = (value: ReturnType<typeof linuxPermanentSetupDiagnostics>) =>
    Boolean(
        value.primarySet === false &&
        value.native?.failed === false &&
        value.native.retainedFDs === 0,
    );
const finalized = (value: ReturnType<typeof linuxPermanentSetupDiagnostics>) => {
    const launch = value.launch;
    return Boolean(
        value.phase === 'finished' &&
        closedNative(value) &&
        closedBackend(value.backend?.backend) &&
        launch?.verdict === 'DIRECT_CHILD_CLOSED_RETAINED' &&
        launch.code === 'DIRECT_CLOSE_NO_SUCCESSOR_AUTHORITY' &&
        launch.pending === null &&
        launch.reservation === 'none' &&
        launch.childOwned === false &&
        launch.timerOwned === false &&
        launch.spawned === true &&
        launch.identityObserved === true &&
        launch.exited === true &&
        launch.closed === true &&
        launch.retainedConfirmed === true &&
        launch.initialConfirmed === false &&
        launch.sealRecovered === false &&
        launch.sealInterrupted === false &&
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
type BContext = ReturnType<typeof getLinuxOwnedCurrentBWithCFixtureContext>;
type CContext = ReturnType<typeof getLinuxOwnedCurrentCFixtureContext>;
type Context = BContext | CContext;
type Product = Awaited<ReturnType<typeof runLinuxPermanentSetup>>;
type Issue = {
    stage: string;
    value?: unknown;
    promise?: Promise<unknown>;
    settled: boolean;
    errorSet: boolean;
    error?: unknown;
};

/** Finite argument selection; no arbitrary scenario, operation, command or consent flag. */
export function linuxOwnedSecondSealFixtureArguments(args: string[]) {
    need(Array.isArray(args) && !utilTypes.isProxy(args), 'SECOND_SEAL_ARGUMENT');
    const length = Object.getOwnPropertyDescriptor(args, 'length')?.value;
    need(
        Number.isSafeInteger(length) &&
            length === 14 &&
            Reflect.ownKeys(args).length === length + 1,
        'SECOND_SEAL_ARGUMENT',
    );
    const snapshot: string[] = [];
    for (let at = 0; at < length; at++) {
        const field = Object.getOwnPropertyDescriptor(args, String(at));
        need(
            field && Object.hasOwn(field, 'value') && typeof field.value === 'string',
            'SECOND_SEAL_ARGUMENT',
        );
        snapshot.push(field!.value);
    }
    need(!snapshot.includes('--scenario'), 'SECOND_SEAL_ARGUMENT');
    const selected = [...snapshot, '--scenario', 'current-b-with-c'];
    linuxOwnedFixtureArguments(selected);
    return Object.freeze(selected);
}

export function runLinuxOwnedSecondSealFixture(args: string[]) {
    const startedMs = performance.now();
    const owner = Object.freeze({});
    const state = {
        owner,
        phase: 'preflight',
        startedMs,
        deadlineMs: startedMs + 540000,
        expired: false,
        primarySet: false,
        primary: undefined as unknown,
        pending: null as Issue | null,
        issues: [] as Issue[],
        returned: [] as unknown[],
        contexts: [] as Context[],
        products: [] as {
            stage: string;
            result: Product;
            custody: ReturnType<typeof linuxPermanentSetupDiagnostics>;
        }[],
        terminals: [] as ReturnType<typeof linuxTerminalPrompt>[],
        execution: null as Promise<unknown> | null,
        timer: null as ReturnType<typeof setTimeout> | null,
        keeper: null as ReturnType<typeof setInterval> | null,
    };
    retained.add(state); // Before the first producer, prompt, native or filesystem effect.
    let expired!: (value: ReturnType<typeof nonpassing>) => void;
    const deadline = new Promise<ReturnType<typeof nonpassing>>((resolve) => {
        expired = resolve;
    });
    function nonpassing() {
        return Object.freeze({
            status: 'retained-nonpassing' as const,
            phase: state.phase,
            owner,
            releaseAcceptance: false as const,
        });
    }
    const fail = (error: unknown) => {
        if (!state.primarySet) {
            state.primarySet = true;
            state.primary = error;
        }
        state.keeper ??= setInterval(() => {}, 60000);
    };
    const expire = () => {
        state.expired = true;
        fail(Error('SECOND_SEAL_DEADLINE'));
        expired(nonpassing()); // Pending promises and every returned owner remain retained.
    };
    const gate = () => {
        const now = performance.now();
        if (state.expired || !Number.isFinite(now) || now < startedMs || now >= state.deadlineMs) {
            if (!state.expired) expire();
            throw Error('SECOND_SEAL_DEADLINE');
        }
    };
    const observe = <T>(stage: string, read: () => T): T => {
        gate();
        state.phase = stage;
        const issue: Issue = { stage, settled: false, errorSet: false };
        state.issues.push(issue);
        state.pending = issue;
        try {
            const value = read();
            issue.value = value;
            state.returned.push(value);
            need(!utilTypes.isPromise(value), 'SECOND_SEAL_UNEXPECTED_ASYNC_READ');
            issue.settled = true;
            state.pending = null;
            gate();
            return value;
        } catch (error) {
            issue.errorSet = true;
            issue.error = error;
            throw error;
        }
    };
    const issued = async <T>(stage: string, submit: () => Promise<T>): Promise<T> => {
        gate();
        state.phase = stage;
        const issue: Issue = { stage, settled: false, errorSet: false };
        state.issues.push(issue);
        state.pending = issue;
        try {
            const pending = submit();
            issue.value = pending; // Adopt even an unsupported return without touching then/getters.
            need(
                utilTypes.isPromise(pending) && !utilTypes.isProxy(pending),
                'SECOND_SEAL_OPERATION_PROMISE',
            );
            issue.promise = pending;
            const value = await pending;
            issue.value = value;
            state.returned.push(value);
            issue.settled = true;
            state.pending = null;
            gate();
            return value;
        } catch (error) {
            issue.errorSet = true;
            issue.error = error;
            throw error;
        }
    };
    const copies = (context: Context) => {
        gate();
        context.revalidateCopies();
        gate();
    };
    const adoptContext = <T extends Context>(context: T): T => {
        state.contexts.push(context);
        need(
            Number.isFinite(context.deadlineMs) && context.deadlineMs > startedMs,
            'SECOND_SEAL_CONTEXT_DEADLINE',
        );
        if (context.deadlineMs < state.deadlineMs) {
            state.deadlineMs = context.deadlineMs; // May tighten, never extend the original budget.
            if (state.timer !== null) clearTimeout(state.timer);
            gate();
            state.timer = setTimeout(expire, state.deadlineMs - performance.now());
        }
        copies(context);
        return context;
    };
    const execute = async () => {
        try {
            need(Number.isFinite(startedMs), 'SECOND_SEAL_CLOCK');
            const selected = linuxOwnedSecondSealFixtureArguments(args);
            const desktop = Object.freeze(
                Object.fromEntries(
                    ['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY']
                        .map((key) => [key, process.env[key]])
                        .filter((entry): entry is [string, string] => Boolean(entry[1])),
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
                'SECOND_SEAL_OWNED_TERMINAL_AND_GUI_REQUIRED',
            );
            gate();
            state.timer = setTimeout(expire, state.deadlineMs - performance.now());
            const producer = await issued('prepare-and-current-b', () =>
                runLinuxOwnedInstallationFixture([...selected]),
            );
            const b = adoptContext(
                observe('current-b-context', () =>
                    getLinuxOwnedCurrentBWithCFixtureContext(producer),
                ),
            );
            const product = async (
                context: Context,
                stage: string,
                operation: 'finalize' | 'uninstall-current',
            ) => {
                copies(context);
                const terminal = linuxTerminalPrompt();
                state.terminals.push(terminal);
                const prompts: LinuxPermanentPrompts = {
                    terminal: {
                        async review(request) {
                            copies(context);
                            const reply = await terminal.review(request);
                            copies(context);
                            return reply;
                        },
                        hasPending: () => terminal.hasPending(),
                    },
                    gui: {
                        review: async () => ({ status: 'unavailable' }),
                        hasPending: () => false,
                    },
                    now: () => performance.now(),
                };
                const choices = linuxPermanentArguments([
                    '--install-directory',
                    context.root,
                    '--version',
                    context.host.version,
                    '--operation',
                    operation,
                    '--terminal',
                    '--no-menu',
                ]);
                const result = await issued(stage, () =>
                    operation === 'finalize'
                        ? runLinuxPermanentOwnedFixture(
                              context.host,
                              choices,
                              context.dataHome,
                              prompts,
                              desktop,
                              'normal-finalize',
                          )
                        : runLinuxPermanentSetup(
                              context.host,
                              choices,
                              context.dataHome,
                              prompts,
                              desktop,
                          ),
                );
                const custody = linuxPermanentSetupDiagnostics(result.owner);
                state.products.push({ stage, result, custody });
                copies(context);
                if (
                    result.status === 'cancelled' &&
                    custody.phase === 'cancelled' &&
                    closedNative(custody) &&
                    custody.launch === undefined &&
                    (!custody.backend || closedBackend(custody.backend.backend)) &&
                    (!custody.uninstall ||
                        (custody.uninstall.primarySet === false &&
                            custody.uninstall.pending === null &&
                            custody.uninstall.reservation === 'none' &&
                            closedBackend(custody.uninstall.backend))) &&
                    !terminal.hasPending()
                )
                    return { cancelled: true as const, result, custody };
                need(!terminal.hasPending(), 'SECOND_SEAL_PROMPT_UNSETTLED');
                if (operation === 'finalize')
                    need(
                        result.status === 'previous-generation-finalized' && finalized(custody),
                        'SECOND_SEAL_FINALIZE_NONPASSING',
                    );
                else
                    need(
                        result.status === 'current-payload-removed' &&
                            custody.phase === 'finished' &&
                            closedNative(custody) &&
                            custody.uninstall?.primarySet === false &&
                            custody.uninstall.pending === null &&
                            custody.uninstall.reservation === 'none' &&
                            closedBackend(custody.uninstall.backend) &&
                            'result' in result &&
                            'profileRetained' in result.result &&
                            'originalRecordsRetained' in result.result &&
                            'priorRecoveryPayloadsRemoved' in result.result &&
                            result.result.profileRetained === true &&
                            result.result.originalRecordsRetained === true &&
                            result.result.priorRecoveryPayloadsRemoved === false,
                        'SECOND_SEAL_UNINSTALL_NONPASSING',
                    );
                return { cancelled: false as const, result, custody };
            };
            const cancel = () => {
                gate();
                if (state.timer !== null) clearTimeout(state.timer);
                state.timer = null;
                state.phase = 'cancelled';
                retained.delete(state);
                return Object.freeze({
                    status: 'cancelled' as const,
                    owner,
                    releaseAcceptance: false as const,
                });
            };
            if ((await product(b, 'b-finalize', 'finalize')).cancelled) return cancel();
            const updated = await issued('c-update', () => b.updateToCurrentC());
            const c = adoptContext(
                observe('current-c-context', () => getLinuxOwnedCurrentCFixtureContext(updated)),
            );
            need(
                c.deadlineMs === b.deadlineMs &&
                    c.root === b.root &&
                    c.appData === b.appData &&
                    c.dataHome === b.dataHome &&
                    c.sourceCommit === b.sourceCommit &&
                    c.runId === b.runId &&
                    c.runAttempt === b.runAttempt,
                'SECOND_SEAL_CONTINUATION_CHANGED',
            );
            if ((await product(c, 'c-finalize', 'finalize')).cancelled) return cancel();
            const published = observe('c-published-readback', () => c.capturePublishedC());
            if ((await product(c, 'c-uninstall', 'uninstall-current')).cancelled) return cancel();
            const removed = observe('c-removed-readback', () => c.revalidateAfterUninstall());
            copies(c);
            const raw = Buffer.from(
                JSON.stringify({
                    scenario: 'owned-b-to-c-normal-finalize-and-current-removal',
                    sourceCommit: c.sourceCommit,
                    runId: c.runId,
                    runAttempt: c.runAttempt,
                    copies: c.copies,
                    originals: c.records,
                    products: state.products,
                    published,
                    removed,
                    releaseAcceptance: false,
                    physicalLoadedByteProof: false,
                    wholeGroupRetirement: false,
                }),
            );
            const record = observe('final-record', () => c.writeSecondSealUninstallRecord(raw));
            gate();
            state.phase = 'complete';
            if (state.timer !== null) clearTimeout(state.timer);
            state.timer = null;
            retained.delete(state);
            return Object.freeze({
                status: 'completed-controlled-second-seal-uninstall' as const,
                sourceCommit: c.sourceCommit,
                record,
                owner,
                releaseAcceptance: false as const,
                wholeGroupRetirement: false as const,
            });
        } catch (error) {
            fail(error); // Preserve thrown undefined and every original promise/returned product owner.
            return nonpassing();
        }
    };
    const execution = execute();
    state.execution = execution;
    return Promise.race([execution, deadline]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void runLinuxOwnedSecondSealFixture(process.argv.slice(2)).then(
        (result) => {
            process.exitCode =
                result.status === 'completed-controlled-second-seal-uninstall' ? 0 : 1;
            process.stdout.write(
                result.status === 'completed-controlled-second-seal-uninstall'
                    ? '::notice title=Linux second seal fixture::outcome=complete releaseAcceptance=false\n'
                    : result.status === 'cancelled'
                      ? '::notice title=Linux second seal fixture::outcome=cancelled releaseAcceptance=false\n'
                      : '::error title=Linux second seal fixture::outcome=retained-nonpassing\n',
            );
        },
        () => {
            process.exitCode = 78;
            process.stderr.write('Linux second-seal fixture is nonpassing.\n');
        },
    );
}
