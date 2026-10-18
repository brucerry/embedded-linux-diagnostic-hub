import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { ProcessSampler, type ProcessRow } from './memory-resource-processes';
export class NativePilotStartup {
    readonly operations = new Map<string, any>();
    readonly children = new Map<ChildProcess, any>();
    readonly unknown: string[] = [];
    readonly cleanupDeadline: number;
    private joining = false;
    private joinFailure: string | undefined;
    private joinTask: Promise<any> | undefined;
    constructor(
        readonly options: {
            signal: AbortSignal;
            deadline: number;
            cleanupDeadline?: number;
            readTable?: () => Promise<ProcessRow[]>;
            emit: (stage: string, data: any) => Promise<void>;
            hold: (reason: unknown) => void;
            identity?: (child: ChildProcess) => Promise<any>;
            proveDescendants?: (child: ChildProcess) => Promise<void>;
            timeoutMs?: number;
        },
    ) {
        this.cleanupDeadline = options.cleanupDeadline ?? options.deadline;
        Object.defineProperty(this, 'cleanupDeadline', { writable: false, configurable: false });
        assert(
            Number.isSafeInteger(this.cleanupDeadline) && this.cleanupDeadline >= options.deadline,
        );
        assert(
            options.timeoutMs === undefined ||
                (options.timeoutMs > 0 && options.timeoutMs <= 10000),
        );
        options.signal.addEventListener('abort', () => this.cancel(), { once: true });
    }
    admit() {
        assert(!this.joining && !this.joinFailure, 'Startup join has closed admission');
        this.options.signal.throwIfAborted();
        assert(Number(process.hrtime.bigint() / 1000000n) < this.options.deadline);
    }
    adopt(label: string, child: ChildProcess, stop: () => unknown) {
        assert(
            !this.joinFailure &&
                (!this.joining || [...this.operations.values()].some((r) => r.pending)),
            'Unregistered child after startup join admission closed',
        );
        const row: any = {
            label,
            pid: child.pid ?? null,
            spawn: Number.isSafeInteger(child.pid),
            spawnEvidence: 'ChildProcess.pid immediately after API return',
            exit: false,
            close: false,
            code: null,
            signal: null,
            identity: null,
            outputBytes: 0,
            streams: { stdout: 0, stderr: 0 },
            error: null,
            observations: new Set<Promise<unknown>>(),
            observationCount: 0,
            periodicStopped: this.joining,
        };
        let close!: () => void;
        row.closed = new Promise<void>((r) => (close = r));
        assert(!this.children.has(child), 'Child registered twice');
        assert(this.children.size < 32);
        this.children.set(child, row);
        row.stop = stop;
        child.once('spawn', () => (row.spawn = true));
        child.once('exit', (code, signal) => Object.assign(row, { exit: true, code, signal }));
        child.once('close', (code, signal) => {
            Object.assign(row, { close: true, closeCode: code, closeSignal: signal });
            close();
        });
        child.on('error', (e) => {
            row.error = String(e);
            this.options.hold(e);
        });
        for (const name of ['stdout', 'stderr'] as const)
            child[name]?.on('data', (b: Buffer) => {
                row.outputBytes += b.length;
                row.streams[name] += b.length;
                if (row.streams[name] > 1048576) {
                    row.error = 'Startup output threshold';
                    this.cancel();
                }
            });
        const sampler = new ProcessSampler(child.pid ? [child.pid] : [], this.options.readTable);
        row.identityTask = this.observe(row, async () => {
            const id = await (this.options.identity
                ? this.options.identity(child)
                : sampler.sample());
            assert(
                id &&
                    (!Array.isArray(id) ||
                        id.some((r) => r.pid === child.pid && r.created && r.state === 'running')),
                'Actual startup root identity missing',
            );
            row.identity = id;
        });
        row.descendants = () =>
            this.observe(row, () =>
                this.options.proveDescendants
                    ? this.options.proveDescendants(child)
                    : sampler.assertExited(),
            );
        let sampling = false;
        row.sampleTimer = setInterval(() => {
            if (
                !this.options.identity &&
                !sampling &&
                !row.periodicStopped &&
                !row.close &&
                !row.error
            ) {
                sampling = true;
                const observation = this.observe(row, () => sampler.sample());
                void observation.then(
                    () => (sampling = false),
                    () => (sampling = false),
                );
            }
        }, 250);
        child.once('close', () => this.stopObservations(row));
        if (this.options.signal.aborted) stop();
        return child;
    }
    spawn(label: string, factory: () => ChildProcess, stop: (child: ChildProcess) => unknown) {
        this.admit();
        const slot = this.operation(false);
        assert(!this.operations.has(label), 'No repeated startup operation');
        this.operations.set(label, slot);
        try {
            const child = factory();
            this.adopt(label, child, () => stop(child));
            slot.pending = false;
            return child;
        } catch (e) {
            slot.pending = false;
            slot.unknown = true;
            this.unknown.push(label);
            this.options.hold(e);
            throw e;
        } finally {
            slot.settled();
        }
    }
    async opaque<T>(
        label: string,
        factory: () => Promise<T>,
        adopt: (value: T) => void,
        cleanup: (value: T) => Promise<unknown>,
    ) {
        this.admit();
        const slot = this.operation(true);
        assert(!this.operations.has(label), 'No repeated startup operation');
        this.operations.set(label, slot);
        try {
            const value = await factory();
            adopt(value);
            if (this.options.signal.aborted) await cleanup(value);
            // Adoption alone cannot certify a cancelled launcher's owned cleanup.
            slot.closed = true;
            slot.pending = false;
            if (this.options.signal.aborted) throw this.options.signal.reason;
            return value;
        } catch (e) {
            slot.pending = false;
            slot.failure = String(e);
            if (!slot.closed) {
                slot.unknown = true;
                this.unknown.push(label);
                this.options.hold(e);
            }
            throw e;
        } finally {
            slot.settled();
        }
    }
    cancel() {
        for (const row of this.children.values())
            if (!row.close)
                try {
                    row.stop();
                } catch (e) {
                    row.error = String(e);
                    this.options.hold(e);
                }
    }
    private operation(opaque: boolean) {
        let settled!: () => void;
        const done = new Promise<void>((resolve) => (settled = resolve));
        return {
            pending: true,
            opaque,
            closed: false,
            unknown: false,
            failure: null as string | null,
            done,
            settled,
        };
    }
    private observe(row: any, read: () => Promise<unknown>) {
        assert(!row.joined, 'No observation after a completed child receipt');
        const task = Promise.resolve()
            .then(read)
            .catch((e) => {
                row.error ??= String(e);
                this.options.hold(e);
                throw e;
            });
        row.observationCount++;
        row.observations.add(task);
        // Keep the promise owned through its error/hold callback, not merely until child close.
        void task.then(
            () => row.observations.delete(task),
            () => row.observations.delete(task),
        );
        return task;
    }
    private stopObservations(row: any) {
        row.periodicStopped = true;
        clearInterval(row.sampleTimer);
    }
    private bound() {
        return Math.min(
            this.cleanupDeadline,
            Number(process.hrtime.bigint() / 1000000n) + (this.options.timeoutMs ?? 10000),
        );
    }
    private checkJoin(deadline: number) {
        assert(!this.joinFailure, this.joinFailure ?? 'Startup closure previously failed');
        assert(
            Number(process.hrtime.bigint() / 1000000n) < deadline,
            'Startup cleanup deadline exhausted; closure unknown',
        );
    }
    private async bounded<T>(deadline: number, work: () => Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            this.checkJoin(deadline);
            return await Promise.race([
                work(),
                new Promise<never>(
                    (_, reject) =>
                        (timer = setTimeout(
                            () =>
                                reject(
                                    Error('Startup cleanup deadline exhausted; closure unknown'),
                                ),
                            Math.max(0, deadline - Number(process.hrtime.bigint() / 1000000n)),
                        )),
                ),
            ]);
        } catch (e) {
            this.joinFailure ??= String(e);
            this.options.hold(e);
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }
    private childProof(row: any) {
        assert(
            row.spawn && row.exit && row.close && row.identity && !row.error,
            'Startup process identity/exit/pipe-close/observation incomplete',
        );
        assert.equal(row.code, row.closeCode);
        assert.equal(row.signal, row.closeSignal);
    }
    private snapshotChild(row: any) {
        const {
            closed,
            stop,
            identityTask,
            descendants,
            sampleTimer,
            observations,
            joinTask,
            ...receipt
        } = row;
        return receipt;
    }
    private finishChild(row: any, deadline: number): Promise<any> {
        this.stopObservations(row);
        return (row.joinTask ??= this.bounded(deadline, async () => {
            await row.closed;
            this.checkJoin(deadline);
            // Future periodic admission is stopped before this drain. Initial identity reads
            // and every already-running periodic query must settle before the final query.
            await Promise.all([...row.observations]);
            this.checkJoin(deadline);
            this.childProof(row);
            await row.descendants();
            this.checkJoin(deadline);
            assert.equal(row.observations.size, 0, 'Process observation still active');
            this.childProof(row);
            row.joined = true;
            row.observationsDrained = true;
            return { complete: true, child: this.snapshotChild(row) };
        }));
    }
    joinChild(child: ChildProcess) {
        const row = this.children.get(child);
        assert(row, 'Unregistered startup child');
        return this.finishChild(row, this.bound());
    }
    join() {
        if (this.joinTask) return this.joinTask;
        this.joining = true;
        for (const row of this.children.values()) this.stopObservations(row);
        const deadline = this.bound();
        return (this.joinTask = this.bounded(deadline, async () => {
            // A held launch/abort-cleanup may adopt a child before settling. Drain the
            // operation first, then take the complete child inventory. No new operation
            // is admitted once joining begins.
            await Promise.all([...this.operations.values()].map((r) => r.done));
            this.checkJoin(deadline);
            assert(
                [...this.operations.values()].every((r) => !r.pending && !r.unknown) &&
                    !this.unknown.length,
                'Opaque startup remains unknown',
            );
            for (const row of this.children.values()) await this.finishChild(row, deadline);
            this.checkJoin(deadline);
            for (const row of this.children.values()) {
                this.childProof(row);
                assert(
                    row.joined && row.observations.size === 0,
                    'Startup observation remains active',
                );
            }
            assert(
                [...this.operations.values()].every((r) => !r.pending && !r.unknown) &&
                    !this.unknown.length,
                'Opaque startup remains unknown',
            );
            return {
                complete: true,
                children: [...this.children.values()].map((row) => this.snapshotChild(row)),
            };
        }));
    }
}
