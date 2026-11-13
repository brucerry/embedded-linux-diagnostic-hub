import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Socket } from 'node:net';
import {
    createLinuxInstallerReadback,
    createLinuxInstallerQuit,
    consumeLinuxOwnedQuitSelection,
    type LinuxReadbackPort,
} from './linux-setup-readback.ts';
import { LINUX_SETUP_READBACK_ENV, LINUX_SETUP_QUIT_ENV } from './linux-setup-readback-native.ts';
import { captureLinuxNativeHost } from './linux-native-driver.ts';
import {
    createLinuxNativeBackend,
    isLinuxSealInterruption,
    type LinuxSealInterruptionSelection,
    type LinuxSealInterruption,
    type LinuxNativeOps,
    type LinuxNativeWindow,
} from './linux-native-backend.ts';
import {
    checkedLinuxModelPlan,
    checkedLinuxModelView,
    linuxModelReviewSHA256,
    type LinuxModelPlan,
    type LinuxModelLease,
    type LinuxModelView,
} from './linux-transaction-model.ts';

interface LaunchRequest {
    executable: string;
    root: string;
    environment: Readonly<Record<string, string>>;
    readback?: true;
    quitControl?: true;
}
export interface LinuxLaunchProcessHost {
    spawn(request: Readonly<LaunchRequest>): ChildProcess;
}
/** Explicit, inert-until-called Node adapter. Creating it never launches a process. */
export function createLinuxNativeLaunchProcessHost(): LinuxLaunchProcessHost {
    return Object.freeze({
        spawn: (request: Readonly<LaunchRequest>) => {
            if (request.quitControl && !request.readback)
                throw Error('LINUX_QUIT_READBACK_REQUIRED');
            const child = spawn(request.executable, [], {
                cwd: request.root,
                env: {
                    ...request.environment,
                    ...(request.readback ? { [LINUX_SETUP_READBACK_ENV]: '1' } : {}),
                    ...(request.quitControl ? { [LINUX_SETUP_QUIT_ENV]: '1' } : {}),
                },
                shell: false,
                detached: false,
                stdio: request.quitControl
                    ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
                    : request.readback
                      ? ['ignore', 'pipe', 'pipe', 'pipe']
                      : ['ignore', 'pipe', 'pipe'],
                windowsHide: false,
            });
            const channel = child.stdio?.[3];
            if (request.readback && channel instanceof Socket) channel.allowHalfOpen = true;
            const quitChannel = child.stdio?.[4];
            if (request.quitControl && quitChannel instanceof Socket)
                quitChannel.allowHalfOpen = true;
            return child;
        },
    });
}
/** Only explicitly selected local desktop variables; never inherit the calling process environment. */
export interface LinuxLaunchDesktop {
    DISPLAY?: string;
    XAUTHORITY?: string;
    XDG_RUNTIME_DIR?: string;
    WAYLAND_DISPLAY?: string;
}
function field(input: object, key: PropertyKey): unknown {
    const value = Object.getOwnPropertyDescriptor(input, key);
    if (!value || !Object.hasOwn(value, 'value') || value.get || value.set)
        throw Error('LINUX_LAUNCH_INPUT');
    return value.value;
}
function environment(input: LinuxLaunchDesktop, plan: LinuxModelPlan) {
    const extra: Record<string, string> = {};
    for (const key of Reflect.ownKeys(input)) {
        if (
            typeof key !== 'string' ||
            !['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY'].includes(key)
        )
            throw Error('LINUX_LAUNCH_ENVIRONMENT');
        const value = field(input, key);
        if (
            typeof value !== 'string' ||
            !value.length ||
            value.length > 240 ||
            /[\x00-\x1f\x7f\\]/.test(value)
        )
            throw Error('LINUX_LAUNCH_ENVIRONMENT');
        if (key === 'DISPLAY' && !/^:[0-9]{1,3}(?:\.[0-9]{1,2})?$/.test(value))
            throw Error('LINUX_LAUNCH_ENVIRONMENT');
        if (
            key === 'XAUTHORITY' &&
            (path.posix.normalize(value) !== value || !value.startsWith(plan.host.home + '/'))
        )
            throw Error('LINUX_LAUNCH_ENVIRONMENT');
        if (key === 'XDG_RUNTIME_DIR' && value !== '/run/user/' + plan.host.uid)
            throw Error('LINUX_LAUNCH_ENVIRONMENT');
        if (
            key === 'WAYLAND_DISPLAY' &&
            (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) || value === '..')
        )
            throw Error('LINUX_LAUNCH_ENVIRONMENT');
        extra[key] = value;
    }
    if (
        (!extra.DISPLAY && !extra.WAYLAND_DISPLAY) ||
        (extra.WAYLAND_DISPLAY && !extra.XDG_RUNTIME_DIR)
    )
        throw Error('LINUX_LAUNCH_ENVIRONMENT');
    return Object.freeze({
        HOME: plan.host.home,
        XDG_CONFIG_HOME: plan.host.appData,
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
        LD_LIBRARY_PATH: path.posix.join(plan.root, 'app/usr/lib'),
        ...extra,
    });
}

const launchCustody = new WeakMap<
    object,
    {
        primarySet: boolean;
        primary: unknown;
        secondarySet: boolean;
        secondary: unknown;
        releaseCandidate?: Promise<boolean>;
        releaseReturn?: unknown;
    }
>();
const retainedLaunches = new Set<object>();

/** One folder launch, owned through direct-child/pipe/readback closure and its own reservation ACK.
 * Never detaches, signals, retries or claims independent successor/descendant observation.
 * Explicit Finalize uses live cooperative readiness before initial completion or predecessor cleanup;
 * uncertain returns retain this controller. Ordinary launch never finalizes. */
export function createLinuxOwnedLaunch(
    input: LinuxModelPlan,
    window: LinuxNativeWindow,
    desktop: LinuxLaunchDesktop,
    operations?: LinuxNativeOps,
    processHost?: LinuxLaunchProcessHost,
    enableReadback = false,
    quitSelection?: object,
    sealSelection?: LinuxSealInterruptionSelection,
) {
    if (typeof enableReadback !== 'boolean') throw Error('LINUX_LAUNCH_READBACK_MODE');
    if (!operations || !processHost) throw Error('LINUX_LAUNCH_HOST_UNADMITTED');
    const plan = checkedLinuxModelPlan(input);
    if (!['launch', 'finalize'].includes(plan.action)) throw Error('LINUX_LAUNCH_PLAN');
    if (plan.action === 'finalize' && !enableReadback)
        throw Error('LINUX_FINALIZE_READBACK_REQUIRED');
    if (quitSelection !== undefined && !enableReadback) throw Error('LINUX_QUIT_READBACK_REQUIRED');
    const binding = {
            root: plan.root,
            installationId: plan.installationId,
            transactionId: plan.transactionId,
            manifestSHA256: plan.review.source.verifiedManifestSHA256,
            version: plan.host.version,
            profile: plan.review.root!.profile,
            executable: path.posix.join(plan.root, 'app/diagnostic-hub'),
            uid: plan.host.uid,
        },
        cooperativeQuit = consumeLinuxOwnedQuitSelection(quitSelection, binding);
    if (sealSelection !== undefined && !cooperativeQuit) throw Error('LINUX_PAUSE_QUIT_REQUIRED');
    const ops = captureLinuxNativeHost(operations),
        env = environment(desktop, plan);
    const spawnChild = field(processHost, 'spawn');
    if (typeof spawnChild !== 'function') throw Error('LINUX_LAUNCH_HOST_UNADMITTED');
    const bounded = {
        startedMs: field(window, 'startedMs') as number,
        deadlineMs: field(window, 'deadlineMs') as number,
    };
    const backend = createLinuxNativeBackend(plan, bounded, ops, sealSelection);
    const custody = {
        primarySet: false,
        primary: undefined as unknown,
        secondarySet: false,
        secondary: undefined as unknown,
        releaseCandidate: undefined as Promise<boolean> | undefined,
        releaseReturn: undefined as unknown,
    };
    let used = false,
        failed = false,
        completed = false,
        spawned = false,
        exited = false,
        closed = false;
    let lease: LinuxModelLease | null = null,
        reservation: 'none' | 'unknown' | 'held' = 'none';
    let child: ChildProcess | null = null,
        timer: ReturnType<typeof setTimeout> | undefined,
        timerOwned = false;
    let readback: ReturnType<typeof createLinuxInstallerReadback> | null = null;
    let quitControl: ReturnType<typeof createLinuxInstallerQuit> | null = null,
        startupConfirmed = false,
        quitRequested = false,
        ownedProcess: Parameters<ReturnType<typeof createLinuxInstallerQuit>['prepare']>[0] | null =
            null,
        sealInterruption: LinuxSealInterruption | null = null;
    let expectedReview = structuredClone(plan.review),
        initialConfirmed = false,
        retainedConfirmed = false,
        recoveredSeal = false;
    let code = 'UNSTARTED',
        pending: string | null = null,
        identityObserved = false;
    const pipes = {
        stdout: { end: false, close: false, bytes: 0 },
        stderr: { end: false, close: false, bytes: 0 },
    };
    let ready: (ok: boolean) => void = () => {},
        finished: (ok: boolean) => void = () => {};
    const fail = (reason: string, cause?: unknown, hasCause = false) => {
        if (hasCause && !custody.primarySet) {
            custody.primarySet = true;
            custody.primary = cause;
        }
        if (!failed) code = reason;
        failed = true;
        completed = false;
        ready(false);
        finished(false);
        readback?.abort();
        quitControl?.abort();
    };
    const gate = () => {
        if (failed) throw Error('LINUX_LAUNCH_RETAINED');
        const now = ops.now();
        if (!Number.isFinite(now) || now < bounded.startedMs || now >= bounded.deadlineMs) {
            fail('DEADLINE_RETAINED');
            throw Error('LINUX_LAUNCH_DEADLINE');
        }
    };
    const summary = () =>
        Object.freeze({
            verdict: completed
                ? sealInterruption
                    ? 'SEAL_PREPARATION_PAUSED'
                    : recoveredSeal
                      ? 'SEAL_RECOVERED_NO_LAUNCH'
                      : 'DIRECT_CHILD_CLOSED_RETAINED'
                : failed
                  ? 'RETAINED_UNKNOWN'
                  : 'UNSTARTED',
            code,
            pending,
            reservation,
            childOwned:
                child !== null &&
                !(
                    closed &&
                    exited &&
                    pipes.stdout.end &&
                    pipes.stdout.close &&
                    pipes.stderr.end &&
                    pipes.stderr.close
                ),
            timerOwned,
            spawned,
            exited,
            closed,
            identityObserved,
            pipes: { stdout: { ...pipes.stdout }, stderr: { ...pipes.stderr } },
            nativeQualified: false as const,
            productionDispatch: false as const,
            successorVerified: false as const,
            wholeGroupRetirement: false as const,
            readback: readback?.summary() ?? null,
            quitControl: quitControl?.summary() ?? null,
            sealInterrupted: sealInterruption !== null,
            ...(plan.action === 'finalize'
                ? { initialConfirmed, retainedConfirmed, sealRecovered: recoveredSeal }
                : {}),
        });
    const guardView = async (running: boolean) => {
        gate();
        await backend.kernel.current(lease!.handle);
        gate();
        const observed = await backend.effects.observe(backend.scope);
        gate();
        if (
            observed.activity.root !== (running ? 'active' : 'inactive') ||
            observed.activity.stage !== 'inactive' ||
            observed.activity.previous !== 'inactive'
        )
            throw Error('LINUX_LAUNCH_ACTIVITY');
        const normalized: LinuxModelView = {
            ...observed,
            activity: { root: 'inactive', stage: 'inactive', previous: 'inactive' },
        };
        checkedLinuxModelView(normalized, plan);
        if (linuxModelReviewSHA256(normalized) !== linuxModelReviewSHA256(expectedReview))
            throw Error('LINUX_LAUNCH_CHANGED');
    };
    const releaseReservation = async () => {
        pending = 'reservation-release';
        reservation = 'unknown';
        try {
            custody.releaseCandidate = backend.kernel.release(lease!.handle, lease!.identity);
            const released = await custody.releaseCandidate;
            custody.releaseReturn = released; // Adopt ACK before any sticky late-error gate.
            if (released !== true) throw Error('LINUX_LAUNCH_RELEASE_ACK');
            lease = null;
            reservation = 'none';
        } catch (error) {
            if (!custody.primarySet) {
                custody.primarySet = true;
                custody.primary = error;
            }
            // The concrete backend removes this server from custody only after checking
            // its actual closure and every tracked socket. A thrown late gate may follow.
            try {
                const retired = backend.diagnostics();
                const handle = lease?.handle as
                    { listening?: boolean; address(): unknown } | undefined;
                if (
                    handle &&
                    retired.retainedServers === 0 &&
                    retired.retainedSockets === 0 &&
                    handle.listening === false &&
                    handle.address() === null
                ) {
                    lease = null;
                    reservation = 'none';
                }
            } catch (secondary) {
                custody.secondarySet = true;
                custody.secondary = secondary;
            }
            throw error;
        }
    };
    const requestNormalQuit = async () => {
        if (!cooperativeQuit || !quitControl || !startupConfirmed || !ownedProcess || quitRequested)
            throw Error('LINUX_QUIT_UNADMITTED');
        quitRequested = true;
        gate();
        await guardView(true);
        gate();
        const process = await backend.observeLaunchChild(ownedProcess.pid);
        gate();
        if (JSON.stringify(process) !== JSON.stringify(ownedProcess) || exited || closed)
            throw Error('LINUX_QUIT_PROCESS_CHANGED');
        const ready = await quitControl.prepare(ownedProcess);
        gate();
        if (!ready || exited || closed) throw Error('LINUX_QUIT_READINESS');
        await guardView(true);
        gate();
        const after = await backend.observeLaunchChild(ownedProcess.pid);
        gate();
        if (JSON.stringify(after) !== JSON.stringify(ownedProcess) || exited || closed)
            throw Error('LINUX_QUIT_PROCESS_CHANGED');
        if (!(await quitControl.commit())) throw Error('LINUX_QUIT_REQUEST_UNCERTAIN');
        gate();
    };
    const controller = Object.freeze({
        summary,
        diagnostics: () => ({ ...backend.diagnostics(), launchPrimarySet: custody.primarySet }),
        readiness: () => (failed ? null : (readback?.readiness() ?? null)),
        sealInterruptionObservation: () =>
            completed && !failed && sealInterruption
                ? backend.sealInterruptionObservation(sealInterruption)
                : null,
        async run(...args: never[]) {
            if (args.length) throw Error('LINUX_LAUNCH_ARGUMENTS');
            if (used) throw Error('Linux launch invocation is consumed; no retry.');
            used = true;
            retainedLaunches.add(controller); // Before reservation/child/resource effects.
            try {
                gate();
                pending = 'reservation';
                reservation = 'unknown';
                const returned = await backend.kernel.acquire({
                    root: plan.root,
                    uid: plan.host.uid,
                    key: backend.scope.key,
                    owner: { ...plan.owner },
                });
                lease = returned; // Capture before any validation/gate.
                reservation = lease === null ? 'none' : 'unknown';
                gate();
                if (!lease) {
                    fail('RESERVATION_UNAVAILABLE');
                    return summary();
                }
                const actual = await backend.kernel.current(lease.handle);
                gate();
                if (JSON.stringify(actual) !== JSON.stringify(lease.identity))
                    throw Error('LINUX_LAUNCH_LEASE');
                lease = { handle: lease.handle, identity: JSON.parse(JSON.stringify(actual)) };
                reservation = 'held';
                pending = 'prelaunch-review';
                await guardView(false);
                if (
                    plan.action === 'finalize' &&
                    plan.review.history?.cleanup?.seal &&
                    plan.review.history.cleanup.seal.state !== 'published'
                ) {
                    pending = 'retained-seal-recovery';
                    const returned = await backend.recoverRetainedSeal(
                        backend.scope,
                        expectedReview,
                        () => {
                            gate();
                            if (child || spawned || exited || closed)
                                throw Error('LINUX_SEAL_RECOVERY_PROCESS');
                        },
                    );
                    expectedReview = {
                        ...structuredClone(returned),
                        activity: { root: 'inactive', stage: 'inactive', previous: 'inactive' },
                    };
                    await guardView(false);
                    gate();
                    await releaseReservation();
                    gate();
                    recoveredSeal = true;
                    completed = true;
                    pending = null;
                    code = 'SEAL_RECOVERED_NO_LAUNCH';
                    retainedLaunches.delete(controller);
                    return summary();
                }
                const readyPromise = new Promise<boolean>((resolve) => {
                        ready = resolve;
                    }),
                    finishedPromise = new Promise<boolean>((resolve) => {
                        finished = resolve;
                    });
                pending = 'spawn';
                gate();
                child = Reflect.apply(spawnChild, processHost, [
                    Object.freeze({
                        executable: path.posix.join(plan.root, 'app/diagnostic-hub'),
                        root: plan.root,
                        environment: env,
                        ...(enableReadback ? { readback: true as const } : {}),
                        ...(cooperativeQuit ? { quitControl: true as const } : {}),
                    }),
                ]); // Any returned handle stays owned even if listener setup fails.
                if (!child || typeof child.on !== 'function') throw Error('LINUX_LAUNCH_CHILD');
                child.on('error', (error) => fail('CHILD_ERROR_RETAINED', error, true));
                const output = { stdout: child.stdout, stderr: child.stderr };
                // Contain every returned error source before admitting the optional inherited pipe.
                for (const pipe of Object.values(output))
                    if (pipe && typeof pipe.on === 'function')
                        pipe.on('error', (error) => fail('PIPE_ERROR_RETAINED', error, true));
                if (enableReadback) {
                    const channel = child.stdio?.[3];
                    if (!channel) throw Error('LINUX_LAUNCH_READBACK_PIPE');
                    readback = createLinuxInstallerReadback(
                        channel as LinuxReadbackPort,
                        {
                            root: plan.root,
                            installationId: plan.installationId,
                            transactionId: plan.transactionId,
                            manifestSHA256: plan.review.source.verifiedManifestSHA256,
                            version: plan.host.version,
                            profile: plan.review.root!.profile,
                            executable: path.posix.join(plan.root, 'app/diagnostic-hub'),
                            uid: plan.host.uid,
                        },
                        undefined,
                        () => fail('READBACK_RETAINED'),
                    );
                    if (cooperativeQuit) {
                        const control = child.stdio?.[4];
                        if (!control || control === channel) throw Error('LINUX_QUIT_PIPE_ALIAS');
                        quitControl = createLinuxInstallerQuit(
                            control as LinuxReadbackPort,
                            binding,
                            undefined,
                            () => {
                                if (completed) {
                                    completed = false;
                                    retainedLaunches.add(controller);
                                }
                                fail('QUIT_CONTROL_RETAINED');
                            },
                        );
                    }
                }
                const finishIfClosed = () => {
                    if (
                        !failed &&
                        spawned &&
                        exited &&
                        closed &&
                        pipes.stdout.end &&
                        pipes.stdout.close &&
                        pipes.stderr.end &&
                        pipes.stderr.close
                    )
                        finished(true);
                };
                child.on('spawn', () => {
                    if (spawned || exited || closed) return fail('CHILD_ORDER_RETAINED');
                    spawned = true;
                    ready(true);
                });
                child.on('exit', (status, signal) => {
                    if (exited || !spawned || status !== 0 || signal !== null)
                        return fail('CHILD_EXIT_RETAINED');
                    exited = true;
                    finishIfClosed();
                });
                child.on('close', (status, signal) => {
                    if (closed || !exited || status !== 0 || signal !== null)
                        return fail('CHILD_CLOSE_RETAINED');
                    closed = true;
                    finishIfClosed();
                });
                for (const name of ['stdout', 'stderr'] as const) {
                    const pipe = output[name];
                    if (!pipe || typeof pipe.on !== 'function') throw Error('LINUX_LAUNCH_PIPE');
                    pipe.on('data', (chunk: unknown) => {
                        if (!Buffer.isBuffer(chunk) || pipes[name].end || pipes[name].close)
                            return fail('PIPE_DATA_RETAINED');
                        pipes[name].bytes = Math.min(65537, pipes[name].bytes + chunk.byteLength);
                        if (pipes[name].bytes > 65536) fail('PIPE_BOUND_RETAINED'); // Count only; never retain output.
                    });
                    pipe.on('end', () => {
                        if (pipes[name].end) return fail('PIPE_ORDER_RETAINED');
                        pipes[name].end = true;
                        finishIfClosed();
                    });
                    pipe.on('close', () => {
                        if (pipes[name].close || !pipes[name].end)
                            return fail('PIPE_CLOSE_RETAINED');
                        pipes[name].close = true;
                        finishIfClosed();
                    });
                }
                gate();
                const remaining = bounded.deadlineMs - ops.now();
                if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 120000)
                    throw Error('LINUX_LAUNCH_TIMER');
                timerOwned = true;
                timer = ops.later(() => {
                    timerOwned = false;
                    if (!completed) fail('DEADLINE_RETAINED');
                }, remaining);
                gate();
                pending = 'spawn-event';
                if (!(await readyPromise)) return summary();
                gate();
                const pid = child.pid;
                if (!Number.isSafeInteger(pid) || !pid || exited || closed)
                    throw Error('LINUX_LAUNCH_PID');
                pending = 'child-identity';
                const initialProcess = await backend.observeLaunchChild(pid);
                ownedProcess = initialProcess;
                gate();
                if (exited || closed) throw Error('LINUX_LAUNCH_EARLY_CLOSE');
                identityObserved = true;
                await guardView(true);
                gate();
                if (readback) {
                    pending = 'setup-readback';
                    readback.admit(initialProcess);
                    if (!(await readback.wait())) throw Error('LINUX_LAUNCH_READBACK');
                    gate();
                    const currentProcess = await backend.observeLaunchChild(pid);
                    gate();
                    if (
                        JSON.stringify(currentProcess) !== JSON.stringify(initialProcess) ||
                        exited ||
                        closed
                    )
                        throw Error('LINUX_LAUNCH_PROCESS_CHANGED');
                    if (!readback.readiness()) throw Error('LINUX_LAUNCH_READBACK_STALE');
                    startupConfirmed = true;
                    if (plan.action === 'finalize') {
                        const retained = Boolean(
                            plan.review.history?.cleanup || plan.review.previous,
                        );
                        pending = retained ? 'retained-finalize' : 'initial-finalize';
                        const owned = () => {
                            gate();
                            if (!child || child.pid !== initialProcess.pid || exited || closed)
                                throw Error('LINUX_FINALIZE_LIVE_CHANGED');
                        };
                        const freshAdmission = () => {
                            owned();
                            if (!readback?.readiness()) throw Error('LINUX_FINALIZE_LIVE_CHANGED');
                        };
                        let admitted = false;
                        const continuing = () => {
                            if (!admitted) throw Error('LINUX_FINALIZE_NOT_ADMITTED');
                            owned();
                        };
                        const observeOwner = async () => {
                            continuing();
                            const current = await backend.observeLaunchChild(initialProcess.pid);
                            continuing();
                            if (JSON.stringify(current) !== JSON.stringify(initialProcess))
                                throw Error('LINUX_FINALIZE_LIVE_CHANGED');
                        };
                        // The one-shot channel closes before admission. Its original freshness
                        // is checked here, not misrepresented as recurring UI observation.
                        freshAdmission();
                        admitted = true; // Private to this actual owned launch, never a supplied flag.
                        const returned = retained
                            ? await backend.finalizeRetained(
                                  backend.scope,
                                  expectedReview,
                                  continuing,
                                  observeOwner,
                              )
                            : await backend.finalizeInitial(
                                  backend.scope,
                                  expectedReview,
                                  freshAdmission,
                              );
                        if (isLinuxSealInterruption(returned)) sealInterruption = returned;
                        const returnedView = sealInterruption
                            ? backend.sealInterruptionObservation(sealInterruption).view
                            : returned;
                        expectedReview = {
                            ...structuredClone(returnedView as LinuxModelView),
                            activity: { root: 'inactive', stage: 'inactive', previous: 'inactive' },
                        };
                        gate();
                        const after = await backend.observeLaunchChild(pid);
                        gate();
                        if (
                            JSON.stringify(after) !== JSON.stringify(initialProcess) ||
                            exited ||
                            closed ||
                            (!retained && !readback.readiness())
                        )
                            throw Error('LINUX_FINALIZE_LIVE_CHANGED');
                        await guardView(true);
                        gate();
                        initialConfirmed = !retained && !sealInterruption;
                        retainedConfirmed = retained && !sealInterruption;
                    }
                }
                pending = 'child-and-pipe-close';
                if (cooperativeQuit) {
                    pending = 'cooperative-quit';
                    await requestNormalQuit();
                    pending = 'child-and-pipe-close';
                }
                if (!(await finishedPromise)) return summary();
                gate();
                if (quitControl) {
                    await quitControl.joinClosure();
                    gate();
                }
                await guardView(false);
                gate();
                await releaseReservation();
                gate();
                pending = 'cancel-deadline';
                ops.cancel(timer);
                timerOwned = false;
                gate();
                completed = true;
                pending = null;
                code = sealInterruption
                    ? 'SEAL_PREPARATION_PAUSED'
                    : 'DIRECT_CLOSE_NO_SUCCESSOR_AUTHORITY';
                retainedLaunches.delete(controller);
            } catch (error) {
                if (!custody.primarySet) {
                    custody.primarySet = true;
                    custody.primary = error;
                }
                if (!failed) fail('GUARD_OR_HOST_UNCERTAIN');
            }
            return summary();
        },
    });
    launchCustody.set(controller, custody);
    return controller;
}
