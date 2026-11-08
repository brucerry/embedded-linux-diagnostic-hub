import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Socket } from 'node:net';
import { createLinuxInstallerReadback, type LinuxReadbackPort } from './linux-setup-readback.ts';
import { LINUX_SETUP_READBACK_ENV } from './linux-setup-readback-native.ts';
import { captureLinuxNativeHost } from './linux-native-driver.ts';
import {
    createLinuxNativeBackend,
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
}
export interface LinuxLaunchProcessHost {
    spawn(request: Readonly<LaunchRequest>): ChildProcess;
}
/** Explicit, inert-until-called Node adapter. Creating it never launches a process. */
export function createLinuxNativeLaunchProcessHost(): LinuxLaunchProcessHost {
    return Object.freeze({
        spawn: (request: Readonly<LaunchRequest>) => {
            const child = spawn(request.executable, [], {
                cwd: request.root,
                env: {
                    ...request.environment,
                    ...(request.readback ? { [LINUX_SETUP_READBACK_ENV]: '1' } : {}),
                },
                shell: false,
                detached: false,
                stdio: request.readback
                    ? ['ignore', 'pipe', 'pipe', 'pipe']
                    : ['ignore', 'pipe', 'pipe'],
                windowsHide: false,
            });
            const channel = child.stdio?.[3];
            if (request.readback && channel instanceof Socket) channel.allowHalfOpen = true;
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
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
        LD_LIBRARY_PATH: path.posix.join(plan.root, 'app/usr/lib'),
        ...extra,
    });
}

/** One unqualified folder launch, owned through direct-child and pipe closure. Never detaches,
 * signals, releases the maintenance reservation, retries, confirms a successor or permits Finalize.
 * Its caller retains this controller after any failure/timeout. No production entry imports it. */
export function createLinuxOwnedLaunch(
    input: LinuxModelPlan,
    window: LinuxNativeWindow,
    desktop: LinuxLaunchDesktop,
    operations?: LinuxNativeOps,
    processHost?: LinuxLaunchProcessHost,
    enableReadback = false,
) {
    if (typeof enableReadback !== 'boolean') throw Error('LINUX_LAUNCH_READBACK_MODE');
    if (!operations || !processHost) throw Error('LINUX_LAUNCH_HOST_UNADMITTED');
    const plan = checkedLinuxModelPlan(input);
    if (plan.action !== 'launch') throw Error('LINUX_LAUNCH_PLAN');
    const ops = captureLinuxNativeHost(operations),
        env = environment(desktop, plan);
    const spawnChild = field(processHost, 'spawn');
    if (typeof spawnChild !== 'function') throw Error('LINUX_LAUNCH_HOST_UNADMITTED');
    const bounded = {
        startedMs: field(window, 'startedMs') as number,
        deadlineMs: field(window, 'deadlineMs') as number,
    };
    const backend = createLinuxNativeBackend(plan, bounded, ops);
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
    let code = 'UNSTARTED',
        pending: string | null = null,
        identityObserved = false;
    const pipes = {
        stdout: { end: false, close: false, bytes: 0 },
        stderr: { end: false, close: false, bytes: 0 },
    };
    let ready: (ok: boolean) => void = () => {},
        finished: (ok: boolean) => void = () => {};
    const fail = (reason: string) => {
        if (!failed) code = reason;
        failed = true;
        completed = false;
        ready(false);
        finished(false);
        readback?.abort();
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
                ? 'DIRECT_CHILD_CLOSED_RETAINED'
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
        if (linuxModelReviewSHA256(normalized) !== plan.reviewSHA256)
            throw Error('LINUX_LAUNCH_CHANGED');
    };
    return Object.freeze({
        summary,
        diagnostics: () => backend.diagnostics(),
        readiness: () => (failed ? null : (readback?.readiness() ?? null)),
        async run(...args: never[]) {
            if (args.length) throw Error('LINUX_LAUNCH_ARGUMENTS');
            if (used) throw Error('Linux launch invocation is consumed; no retry.');
            used = true;
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
                    }),
                ]); // Any returned handle stays owned even if listener setup fails.
                if (!child || typeof child.on !== 'function') throw Error('LINUX_LAUNCH_CHILD');
                child.on('error', () => fail('CHILD_ERROR_RETAINED'));
                const output = { stdout: child.stdout, stderr: child.stderr };
                // Contain every returned error source before admitting the optional inherited pipe.
                for (const pipe of Object.values(output))
                    if (pipe && typeof pipe.on === 'function')
                        pipe.on('error', () => fail('PIPE_ERROR_RETAINED'));
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
                }
                pending = 'child-and-pipe-close';
                if (!(await finishedPromise)) return summary();
                gate();
                await guardView(false);
                gate();
                pending = 'cancel-deadline';
                ops.cancel(timer);
                timerOwned = false;
                gate();
                // No release/handoff primitive: direct closure cannot prove descendant retirement or GUI success.
                completed = true;
                pending = null;
                code = 'DIRECT_CLOSE_NO_SUCCESSOR_AUTHORITY';
            } catch {
                if (!failed) fail('GUARD_OR_HOST_UNCERTAIN');
            }
            return summary();
        },
    });
}
