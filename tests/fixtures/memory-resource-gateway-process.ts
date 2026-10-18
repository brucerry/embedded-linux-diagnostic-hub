import { productStartup } from './memory-product-startup';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ProcessSampler, readProcessTable } from './memory-resource-processes';
import type { QualificationDriver } from './memory-resource-core';
import type { ConnectOptions } from '../../shared/types';

type Role = 'gateway-node' | 'ssh-fixture-node';
export type GatewayHostMetrics = {
    memory: NodeJS.MemoryUsage;
    resources: Record<string, number>;
    productOwnership?:
        ReturnType<typeof import('../../gateway/server').createGateway>['ownershipSnapshot'] | null;
    activeResources: string[];
    fixtureOwnership?: unknown;
};
type Metrics = GatewayHostMetrics;
type Descriptor = { url: string; token: string; options: ConnectOptions };
export function validateHostReply(
    value: unknown,
    expected: { nonce: string; pid: number; role: string; id: number },
) {
    assert.ok(value && typeof value === 'object');
    const item = value as Record<string, unknown>;
    for (const key of ['nonce', 'pid', 'role', 'id'] as const)
        assert.equal(item[key], expected[key], 'Unbound host reply: ' + key);
    assert.equal(item.version, 1);
    assert.equal(
        item.ok,
        true,
        'Gateway host failed: ' +
            String(item.error) +
            (item.diagnostic ? '\n' + JSON.stringify(item.diagnostic) : ''),
    );
    return item.value;
}
export type HostTermination =
    | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null }
    | { kind: 'failed-start'; error: string }
    | { kind: 'unknown'; error: string };
type HostOptions = {
    signal?: AbortSignal;
    workDeadlineMs?: number;
    forkChild?: typeof fork;
    terminationMs?: number;
    /** Private test entry only; never changes production gateway resolution. */
    hostFiles?: Partial<Record<Role, string>>;
};
export class OwnedHost {
    readonly nonce = randomBytes(32).toString('hex');
    readonly child: ChildProcess;
    readonly exit: Promise<HostTermination>;
    private termination?: HostTermination;
    private actualExit?: Extract<HostTermination, { kind: 'exited' }>;
    private firstFailure?: Error;
    private started = false;
    private nextId = 0;
    private pending?: { reject(error: unknown): void; resolve(value: unknown): void; id: number };
    private terminationMs: number;
    runtime: unknown;
    constructor(
        readonly role: Role,
        gcMode: string,
        options: HostOptions = {},
    ) {
        productStartup(options)();
        this.terminationMs = options.terminationMs ?? 10000;
        assert.ok(this.terminationMs > 0 && this.terminationMs <= 10000);
        const execArgv = process.execArgv.filter((value) => value !== '--expose-gc');
        if (gcMode === 'forced') execArgv.push('--expose-gc');
        this.child = (options.forkChild ?? fork)(
            options.hostFiles?.[role] ??
                fileURLToPath(new URL('./memory-resource-gateway-host.ts', import.meta.url)),
            ['--role=' + role],
            {
                execArgv,
                windowsHide: true,
                stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
                env: {
                    ...process.env,
                    HUB_MEMORY_HOST_NONCE: this.nonce,
                    HUB_MEMORY_HOST_GC: gcMode,
                    HUB_MEMORY_HOST_WORK_DEADLINE_MS:
                        options.workDeadlineMs === undefined ? '' : String(options.workDeadlineMs),
                },
            },
        );
        const cancelStartup = () => {
            if (this.child.connected)
                this.child.send(
                    { version: 1, nonce: this.nonce, kind: 'cancel-startup' },
                    (error) => {
                        if (error) {
                            this.firstFailure ??= error;
                            this.pending?.reject(error);
                        }
                    },
                );
        };
        options.signal?.addEventListener('abort', cancelStartup);
        this.child.once('close', () => options.signal?.removeEventListener('abort', cancelStartup));
        if (options.signal?.aborted) cancelStartup();
        this.started = Number.isSafeInteger(this.child.pid) && Number(this.child.pid) > 0;
        let finish!: (value: HostTermination) => void;
        this.exit = new Promise((resolve) => {
            finish = (value) => {
                if (!this.termination) {
                    this.termination = value;
                    resolve(value);
                }
            };
        });
        this.child.once('spawn', () => {
            this.started = true;
        });
        this.child.once('exit', (code, signal) => {
            this.actualExit = { kind: 'exited', code, signal };
            this.pending?.reject(
                this.firstFailure ?? Error(`Premature ${role} exit: ${code}/${signal}`),
            );
            finish(this.actualExit);
        });
        this.child.on('error', (error) => {
            this.firstFailure ??= error;
            this.pending?.reject(this.firstFailure);
        });
        this.child.once('close', () => {
            if (this.actualExit) return;
            if (!this.started && !this.child.pid && this.firstFailure)
                finish({ kind: 'failed-start', error: String(this.firstFailure) });
            else
                finish({
                    kind: 'unknown',
                    error: `${role} closed without an exit event; process liveness is unverified.`,
                });
            this.pending?.reject(this.firstFailure ?? Error('Child closed without verified exit.'));
        });
        this.child.on('message', (value) => {
            const request = this.pending;
            if (!request) {
                this.firstFailure ??= Error('Unsolicited gateway host reply.');
                // The manager refreshes descendant history before deciding how to terminate.

                return;
            }
            try {
                request.resolve(
                    validateHostReply(value, {
                        nonce: this.nonce,
                        pid: this.child.pid!,
                        role,
                        id: request.id,
                    }),
                );
            } catch (error) {
                request.reject(error);
            }
        });
    }
    get terminalState() {
        return this.actualExit ?? this.termination;
    }
    async assignedPid() {
        if (Number.isSafeInteger(this.child.pid) && Number(this.child.pid) > 0)
            return this.child.pid!;
        if (this.started)
            throw Error(
                `${this.role} spawned without an assigned PID; startup history is incomplete.`,
            );
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onSpawn!: () => void;
        try {
            const result = await Promise.race([
                new Promise<'spawn'>((resolve) => {
                    onSpawn = () => resolve('spawn');
                    this.child.once('spawn', onSpawn);
                }),
                this.exit,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                this.firstFailure ??
                                    Error(
                                        `${this.role} did not expose startup identity within its existing deadline.`,
                                    ),
                            ),
                        this.terminationMs,
                    );
                }),
            ]);
            if (result !== 'spawn')
                throw (
                    this.firstFailure ??
                    Error(
                        `${this.role} terminated before its PID was observable: ${JSON.stringify(result)}`,
                    )
                );
            assert.ok(
                Number.isSafeInteger(this.child.pid) && Number(this.child.pid) > 0,
                `${this.role} spawn has no PID; startup history is incomplete.`,
            );
            return this.child.pid!;
        } finally {
            clearTimeout(timer);
            this.child.removeListener('spawn', onSpawn);
        }
    }
    async request(action: string, payload?: unknown): Promise<unknown> {
        if (this.firstFailure) throw this.firstFailure;
        assert.ok(!this.termination && !this.pending, 'Host RPC is bounded to one in flight.');
        const id = ++this.nextId;
        try {
            return await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.firstFailure ??= Error(
                        `${this.role} ${action} timed out; no qualification.`,
                    );
                    reject(this.firstFailure);
                }, 10000);
                const pending = {
                    id,
                    resolve: (value: unknown) => {
                        clearTimeout(timeout);
                        resolve(value);
                    },
                    reject: (error: unknown) => {
                        clearTimeout(timeout);
                        reject(error);
                    },
                };
                this.pending = pending;
                try {
                    this.child.send(
                        { version: 1, nonce: this.nonce, id, action, payload },
                        (error) => {
                            if (error) {
                                this.firstFailure ??= error;
                                pending.reject(error);
                            }
                        },
                    );
                } catch (error) {
                    this.firstFailure ??= error instanceof Error ? error : Error(String(error));
                    pending.reject(error);
                }
            });
        } finally {
            this.pending = undefined;
        }
    }
    async initialize(origin: string, target?: unknown) {
        const value = (await this.request('init', { origin, target })) as {
            runtime: unknown;
            descriptor: unknown;
        };
        this.runtime = value.runtime;
        return value.descriptor;
    }
    sample(forceGc: boolean) {
        return this.request('sample', { forceGc }) as Promise<Metrics>;
    }
    private async waitForTermination(stage: string) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                this.exit,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                Error(
                                    `${this.role} ${stage}: termination deadline exceeded; PID ${this.child.pid ?? 'unassigned'} liveness is unverified.`,
                                ),
                            ),
                        this.terminationMs,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
    async close(beforeRelease?: () => Promise<void>) {
        const final = (await this.request('shutdown')) as Metrics;
        await beforeRelease?.();
        const release = (await this.request('release')) as Metrics;
        assert.equal(release.resources.ipcMessageListeners, 0);
        assert.equal(release.resources.ipcDisconnectListeners, 0);
        assert.equal(release.resources.timers, 0);
        const outcome = await this.waitForTermination('IPC release');
        assert.deepEqual(
            outcome,
            { kind: 'exited', code: 0, signal: null },
            'Owned host exit must be normal zero.',
        );
        assert.equal(this.firstFailure, undefined);
        return { shutdown: final, release, termination: outcome };
    }
    async abort() {
        if (this.actualExit) return this.actualExit;
        if (this.termination?.kind === 'failed-start') return this.termination;
        let killFailure: string | null = null;
        try {
            if (!this.child.kill()) killFailure = 'kill returned false';
        } catch (error) {
            killFailure = String(error);
        }
        try {
            const outcome = await this.waitForTermination('abort');
            if (outcome.kind === 'unknown') throw Error(outcome.error);
            return outcome;
        } catch (error) {
            throw new Error(`${String(error)}${killFailure ? '; ' + killFailure : ''}`, {
                cause: error,
            });
        }
    }
}

/** Real gateway and target have distinct process identities; observer allocations are excluded. */
export async function isolatedGateway(
    origin: string,
    gcMode: string,
    emit: (stage: string, data: unknown) => Promise<void>,
    options: HostOptions & {
        makeSampler?: (roots: number[]) => Pick<ProcessSampler, 'sample' | 'assertExited'>;
    } = {},
) {
    const admit = productStartup(options);
    admit();
    const hosts: OwnedHost[] = [];
    type Rows = Awaited<ReturnType<ProcessSampler['sample']>>;
    type History = {
        host: OwnedHost;
        pid?: number;
        created?: string;
        sampler?: Pick<ProcessSampler, 'sample' | 'assertExited'>;
        gaps: string[];
        mayExit: boolean;
    };
    const histories: History[] = [];
    const launchGaps: string[] = [];
    let closed = false;
    let tableInFlight: ReturnType<typeof readProcessTable> | undefined;
    const sharedTable = () =>
        (tableInFlight ??= readProcessTable().finally(() => {
            tableInFlight = undefined;
        }));
    const makeSampler = options.makeSampler ?? ((roots) => new ProcessSampler(roots, sharedTable));
    const gap = (entry: History, stage: string, error: unknown) => {
        if (entry.gaps.length < 8) entry.gaps.push(`${stage}: ${String(error).slice(0, 1024)}`);
    };
    const registerPid = (entry: History, spawned = false) => {
        const pid = entry.host.child.pid;
        if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
            if (spawned) gap(entry, 'spawn', 'Host started without an assigned PID.');
            return;
        }
        if (entry.pid && entry.pid !== pid) {
            gap(entry, 'pid-change', 'Assigned PID changed after registration.');
            return;
        }
        if (!entry.pid) {
            entry.pid = pid;
            try {
                entry.sampler = makeSampler([pid!]);
            } catch (error) {
                gap(entry, 'sampler-construction', error);
            }
        }
    };
    const createHost = (role: Role) => {
        admit();
        let host: OwnedHost;
        try {
            host = new OwnedHost(role, gcMode, options);
        } catch (error) {
            launchGaps.push(
                `${role}: fork returned no usable child handle; partial-start history is unverified.`,
            );
            throw error;
        }
        hosts.push(host);
        const entry: History = { host, gaps: [], mayExit: false };
        histories.push(entry);
        registerPid(entry);
        host.child.once('spawn', () => registerPid(entry, true));
        host.child.once('exit', () => {
            if (!entry.mayExit)
                gap(entry, 'premature-exit', 'Root exited before final ownership-history refresh.');
        });
        return host;
    };
    const observe = async (entry: History, stage: string, requireLive: boolean): Promise<Rows> => {
        registerPid(entry);
        if (!entry.pid) {
            if (entry.host.terminalState?.kind === 'failed-start') return [];
            const error = Error('No assigned root PID and no verified failed-start state.');
            gap(entry, stage, error);
            throw error;
        }
        try {
            assert.ok(entry.sampler, 'Assigned root has no process-history sampler.');
            const rows = await entry.sampler.sample();
            const root = rows.find(
                (row) => row.pid === entry.pid && (!entry.created || row.created === entry.created),
            );
            assert.ok(root?.created, 'Root creation identity is unavailable.');
            if (requireLive)
                assert.equal(
                    root.state,
                    'running',
                    'Root exited before its descendants could be refreshed.',
                );
            entry.created ??= root.created;
            await emit('gateway-process-history', {
                stage,
                role: entry.host.role,
                pid: entry.pid,
                created: entry.created,
                gaps: [...entry.gaps],
                processes: rows,
            });
            return rows;
        } catch (error) {
            gap(entry, stage, error);
            throw error;
        }
    };
    const observeAll = async (stage: string, requireLive = false) => {
        const results = await Promise.allSettled(
            histories.map((entry) => observe(entry, stage, requireLive && !entry.mayExit)),
        );
        const failures = results
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason);
        if (failures.length)
            throw new AggregateError(failures, `${stage}: process history is incomplete.`);
        const rows = results.flatMap((result) =>
            result.status === 'fulfilled' ? result.value : [],
        );
        const distinct = new Map<string, Rows[number]>();
        for (const row of rows) distinct.set(JSON.stringify([row.pid, row.created]), row);
        return [...distinct.values()];
    };
    const historyProblems = () => [
        ...launchGaps,
        ...histories.flatMap((entry) =>
            entry.gaps.map(
                (problem) => `${entry.host.role}/${entry.pid ?? 'unassigned'}: ${problem}`,
            ),
        ),
    ];
    const assertHistoryExited = async () => {
        const problems: unknown[] = [...historyProblems()];
        const results = await Promise.allSettled(
            histories.map(async (entry) => {
                if (!entry.pid) {
                    assert.equal(
                        entry.host.terminalState?.kind,
                        'failed-start',
                        'Unassigned root has unknown startup liveness.',
                    );
                    return;
                }
                const missing: unknown[] = [];
                if (!entry.created)
                    missing.push(Error('Root creation/descendant history was never established.'));
                if (!entry.sampler)
                    missing.push(Error('Assigned root has no process-history sampler.'));
                else {
                    try {
                        await entry.sampler.assertExited();
                    } catch (error) {
                        missing.push(error);
                    }
                }
                if (missing.length)
                    throw new AggregateError(missing, missing.map(String).join('; '));
            }),
        );
        for (const result of results)
            if (result.status === 'rejected') problems.push(result.reason);
        if (problems.length)
            throw new AggregateError(
                problems,
                'Gateway cleanup is unverified: ' + problems.map(String).join('; '),
            );
    };
    const beforeStop = async (stage: string) => {
        await observeAll(stage, true);
        const problems = historyProblems();
        if (problems.length) throw Error('Gateway cleanup is unverified: ' + problems.join('; '));
    };
    const abortAll = async (original: unknown): Promise<never> => {
        const problems: unknown[] = [];
        // Refresh each available root independently before any root is terminated.
        try {
            await observeAll('before-abort', true);
        } catch (error) {
            problems.push(error);
        }
        for (const entry of histories) entry.mayExit = true;
        const outcomes = await Promise.allSettled(hosts.map((host) => host.abort()));
        for (let i = 0; i < outcomes.length; i++) {
            const result = outcomes[i];
            if (result.status === 'rejected') problems.push(result.reason);
            try {
                await emit('gateway-host-abort', {
                    role: hosts[i].role,
                    pid: hosts[i].child.pid ?? null,
                    outcome:
                        result.status === 'fulfilled'
                            ? result.value
                            : { kind: 'unknown', error: String(result.reason) },
                });
            } catch (error) {
                problems.push(error);
            }
        }
        try {
            await assertHistoryExited();
        } catch (error) {
            problems.push(error);
        }
        if (problems.length)
            throw new AggregateError(
                [original, ...problems],
                `${String(original)}; gateway cleanup is unverified: ${problems.map(String).join('; ')}`,
                { cause: original },
            );
        throw original;
    };
    const prepare = async (host: OwnedHost) => {
        const entry = histories.find((value) => value.host === host)!;
        try {
            await host.assignedPid();
            admit();
            registerPid(entry);
            await beforeStop('before-initialize/' + host.role);
            admit();
        } catch (error) {
            if (entry.pid || host.child.pid || host.terminalState?.kind !== 'failed-start')
                gap(entry, 'startup-observation', error);
            throw error;
        }
    };
    try {
        const target = createHost('ssh-fixture-node');
        await prepare(target);
        admit();
        const targetDescriptor = await target.initialize(origin);
        admit();
        const gateway = createHost('gateway-node');
        await prepare(gateway);
        admit();
        const descriptor = (await gateway.initialize(origin, targetDescriptor)) as Descriptor;
        admit();
        const initial = await observeAll('after-initialize', true);
        const instances = new Map(initial.map((row) => [row.pid, row.created]));
        let tail = Promise.resolve();
        let queued = 0;
        const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
            assert.ok(queued < 4, 'Gateway observer queue bound exceeded.');
            queued++;
            const before = tail;
            let release!: () => void;
            tail = new Promise<void>((resolve) => {
                release = resolve;
            });
            try {
                await before;
                return await work();
            } finally {
                queued--;
                release();
            }
        };
        const sample = async (context?: { quiescent: boolean; forceGc: boolean }) =>
            exclusive(async () => {
                const allocations = new Map<number, Metrics>();
                if (!closed)
                    for (const host of hosts)
                        allocations.set(
                            host.child.pid!,
                            await host.sample(Boolean(context?.quiescent && context.forceGc)),
                        );
                const rows = await observeAll('sample');
                for (const row of rows) {
                    const host = hosts.find(
                        (host) =>
                            host.child.pid === row.pid && instances.get(row.pid) === row.created,
                    );
                    if (!host) continue;
                    row.role = host.role;
                    if (row.state === 'terminated') {
                        assert.ok(closed, 'Owned host exited before teardown.');
                        continue;
                    }
                    const value = allocations.get(row.pid);
                    assert.ok(value, 'Missing live host allocation sample.');
                    for (const key of ['heapUsed', 'external', 'arrayBuffers', 'rss'] as const)
                        assert.ok(Number.isFinite(value.memory[key]) && value.memory[key] >= 0);
                    Object.assign(row, {
                        heapUsedBytes: value.memory.heapUsed,
                        externalBytes: value.memory.external,
                        arrayBuffersBytes: value.memory.arrayBuffers,
                        unsupported: [],
                    });
                    await emit('gateway-node-memory', {
                        pid: row.pid,
                        created: row.created,
                        role: host.role,
                        gc: context?.quiescent && context.forceGc ? 'forced' : 'normal',
                        ...value,
                    });
                }
                return rows as Awaited<ReturnType<QualificationDriver['sampleProcesses']>>;
            });
        return {
            ...descriptor,
            roles: hosts.map((host) => host.role),
            runtimeIdentity: Object.fromEntries(hosts.map((host) => [host.role, host.runtime])),
            sample,
            async sampleProcessHistory() {
                const rows = await observeAll('shutdown-sample');
                for (const row of rows) {
                    const host = hosts.find(
                        (host) =>
                            host.child.pid === row.pid && instances.get(row.pid) === row.created,
                    );
                    if (host) row.role = host.role;
                }
                return rows;
            },
            async inspect() {
                return exclusive(async () => {
                    assert.ok(!closed, 'Cannot inspect a released host.');
                    return Object.fromEntries(
                        await Promise.all(
                            hosts.map(async (host) => [host.role, await host.sample(false)]),
                        ),
                    ) as Record<Role, Metrics>;
                });
            },
            async control(payload: unknown) {
                return exclusive(async () => {
                    assert.ok(!closed, 'Cannot control a released host.');
                    return target.request('control', payload);
                });
            },
            async snapshotOwners() {
                return exclusive(async () => {
                    if (closed) return { gatewayHost: 0, sshTargetHost: 0 };
                    const result: Record<string, number> = {};
                    for (const host of hosts) {
                        const value = await host.sample(false);
                        await emit('gateway-host-resources', {
                            role: host.role,
                            ...value.resources,
                            productOwnership: value.productOwnership,
                            activeResources: value.activeResources,
                        });
                        if (host.role === 'gateway-node') {
                            assert.ok(
                                value.productOwnership,
                                'Actual gateway product ownership probe is missing.',
                            );
                            for (const key of [
                                'requestTasks',
                                'httpResponses',
                                'httpBodyReaders',
                                'pendingConnections',
                                'sessions',
                                'inFlight',
                                'ownedSessions',
                                'retiringSessions',
                            ] as const)
                                result['gateway-node/product/' + key] = value.productOwnership[key];
                            assert.equal(
                                value.productOwnership.allSessionOwners.length,
                                value.productOwnership.ownedSessions,
                            );
                        }
                        // Listening servers, keep-alive sockets and the gateway cleanup timer are live fixture services.
                        for (const key of ['clients', 'channels', 'pumps', 'httpRequests']) {
                            if (host.role === 'gateway-node' && key === 'clients') continue;
                            result[host.role + '/' + key] = value.resources[key];
                        }
                        assert.equal(value.resources.ipcMessageListeners, 1);
                        assert.equal(value.resources.ipcDisconnectListeners, 1);
                    }
                    return result;
                });
            },
            async close() {
                return exclusive(async () => {
                    try {
                        // Stop the real gateway first so its SSH connections close before the target listener.
                        await beforeStop('before-close');
                        for (const host of [...hosts].reverse()) {
                            const entry = histories.find((value) => value.host === host)!;
                            const result = await host.close(async () => {
                                await beforeStop('before-release/' + host.role);
                                entry.mayExit = true;
                            });
                            await emit('gateway-host-teardown', {
                                role: host.role,
                                ...result,
                                childExit: 'normal-zero',
                            });
                        }
                        await assertHistoryExited();
                        closed = true;
                    } catch (error) {
                        return abortAll(error);
                    }
                });
            },
            assertExited: () => assertHistoryExited(),
        };
    } catch (error) {
        return abortAll(error);
    }
}
