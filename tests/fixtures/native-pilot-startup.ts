import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { ProcessSampler, readProcessTable, type ProcessRow } from './memory-resource-processes';
import {
    processQueryBatchLimit,
    validateProcessQueryBatch,
} from '../../scripts/lib/pilot-process-query.mjs';
export class NativePilotStartup {
    readonly operations = new Map<string, any>();
    readonly children = new Map<ChildProcess, any>();
    readonly unknown: string[] = [];
    readonly cleanupDeadline: number;
    private joining = false;
    private halted = false;
    private admissionClosed = false;
    private diagnosticTasks = new Set<Promise<unknown>>();
    private diagnosticFailure: unknown;
    private diagnosticBytes = 0;
    private diagnosticRows = 0;
    private joinFailure: string | undefined;
    private joinTask: Promise<any> | undefined;
    private queryClosures: any[] = [];
    private terminalTask: Promise<void> | undefined;
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
            diagnostics?: boolean;
            terminalEmit?: (stage: string, data: unknown) => Promise<void>;
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
        assert(
            !this.joining && !this.joinFailure && !this.admissionClosed && !this.halted,
            'Startup join has closed admission',
        );
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
        row.stopRequested = false;
        row.diagnosticStreams = { stdout: 0, stderr: 0 };
        this.note('child-adopted', { label, pid: row.pid, spawn: row.spawn });
        child.once('spawn', () => {
            row.spawn = true;
            this.note('child-spawn', { label, pid: row.pid });
        });
        child.once('exit', (code, signal) => {
            Object.assign(row, { exit: true, code, signal });
            this.note('child-exit', { label, pid: row.pid, code, signal });
        });
        child.once('close', (code, signal) => {
            Object.assign(row, { close: true, closeCode: code, closeSignal: signal });
            this.note('child-pipe-close', {
                label,
                pid: row.pid,
                code,
                signal,
                streams: row.streams,
                retained: row.diagnosticStreams,
            });
            close();
        });
        child.on('error', (e) => {
            row.error = String(e);
            this.note('child-error', { label, pid: row.pid, error: String(e).slice(0, 1024) });
            this.options.hold(e);
        });
        for (const name of ['stdout', 'stderr'] as const)
            child[name]?.on('data', (b: Buffer) => {
                row.outputBytes += b.length;
                row.streams[name] += b.length;
                if (this.options.diagnostics && !this.halted) {
                    const bytes = b.subarray(0, Math.max(0, 65536 - row.diagnosticStreams[name]));
                    for (let offset = 0; offset < bytes.length; offset += 4096)
                        this.note('child-output', {
                            label,
                            pid: row.pid,
                            stream: name,
                            offset: row.diagnosticStreams[name] + offset,
                            base64: bytes.subarray(offset, offset + 4096).toString('base64'),
                        });
                    row.diagnosticStreams[name] += bytes.length;
                }
                if (row.streams[name] > 1048576) {
                    row.error = 'Startup output threshold';
                    this.cancel();
                }
            });
        const sampler = new ProcessSampler(
            child.pid ? [child.pid] : [],
            this.options.readTable ??
                (() =>
                    readProcessTable(
                        this.options.diagnostics
                            ? (proof) => {
                                  assert(
                                      this.queryClosures.length < 256,
                                      'Pending query receipt bound',
                                  );
                                  this.queryClosures.push(proof);
                                  if (this.queryClosures.length === processQueryBatchLimit)
                                      this.flushQueryClosures();
                              }
                            : undefined,
                    )),
        );
        row.sampler = sampler;
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
            this.note('child-identity', { label, pid: row.pid, identity: id });
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
        if (this.options.signal.aborted) this.cancel();
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
        this.admissionClosed = true;
        for (const row of this.children.values()) {
            this.stopObservations(row);
            if (!row.close && !row.stopRequested) {
                row.stopRequested = true;
                this.note('cancel-request', { label: row.label, pid: row.pid });
                try {
                    const result = row.stop();
                    this.note('cancel-transport', {
                        label: row.label,
                        pid: row.pid,
                        returned: true,
                        value: typeof result === 'boolean' ? result : null,
                    });
                } catch (e) {
                    row.error = String(e);
                    this.options.hold(e);
                }
            }
        }
    }
    /** Terminal hold closes new queries/work; already admitted observations stay owned. */
    stopQueryAdmission() {
        this.halted = true;
        this.admissionClosed = true;
        for (const row of this.children.values()) this.stopObservations(row);
    }
    private flushQueryClosures() {
        if (this.halted || !this.queryClosures.length) return;
        const queries = this.queryClosures.splice(0);
        this.note('process-query-closed', { schema: 1, queries });
    }
    /** Drain observation promises only. Never opens a read or restores held admission. */
    terminalObservation(label: string) {
        if (!this.options.terminalEmit) return Promise.resolve();
        if (this.terminalTask) return this.terminalTask;
        const admitted = [...this.children.values()].flatMap((row) => [...row.observations]);
        const deadline = Math.min(
            this.cleanupDeadline,
            Number(process.hrtime.bigint() / 1000000n) + (this.options.timeoutMs ?? 10000),
        );
        this.terminalTask = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const outcomes = await Promise.race([
                    Promise.allSettled(admitted),
                    new Promise<undefined>(
                        (resolve) =>
                            (timer = setTimeout(
                                () => resolve(undefined),
                                Math.max(0, deadline - Number(process.hrtime.bigint() / 1000000n)),
                            )),
                    ),
                ]);
                const data = {
                    schema: 1,
                    label: label.slice(0, 128),
                    observedAt: Number(process.hrtime.bigint() / 1000000n),
                    clockDomain: 'node-hrtime-milliseconds',
                    deadline,
                    queryAdmissionClosed: this.halted || this.joining,
                    newQueryAdmitted: false,
                    releaseAuthorized: false,
                    pendingAtCapture: admitted.length,
                    admittedObservationsSettled: Boolean(outcomes),
                    outcomes:
                        outcomes?.map((r) =>
                            r.status === 'fulfilled'
                                ? { status: r.status }
                                : { status: r.status, error: String(r.reason).slice(0, 512) },
                        ) ?? null,
                    children: [...this.children.values()].map((row) => ({
                        label: row.label,
                        pid: row.pid,
                        ownedRootIdentity: Array.isArray(row.identity)
                            ? row.identity
                                  .filter((r: any) => r.pid === row.pid)
                                  .map((r: any) => ({ pid: r.pid, created: r.created }))
                            : null,
                        exit: row.exit,
                        close: row.close,
                        pendingObservations: row.observations.size,
                        census: row.sampler.observationFacts(),
                        history: row.sampler.historyProof(),
                    })),
                    unflushedClosedQueryReceipts: this.queryClosures.length,
                    inheritedWriterOwnership: {
                        available: false,
                        reason: 'No inherited-handle owner query is authorized or inferred.',
                    },
                    meaning:
                        'Last completed admitted census per child; timestamp may precede terminal closure. Not a fresh post-hold query or release proof.',
                };
                if (Buffer.byteLength(JSON.stringify(data)) > 60000) {
                    await this.options.terminalEmit!('startup-terminal-observation', {
                        schema: 1,
                        label: label.slice(0, 128),
                        available: false,
                        reason: 'Complete terminal census exceeds reserved frame.',
                        children: this.children.size,
                        pendingAtCapture: admitted.length,
                        releaseAuthorized: false,
                        newQueryAdmitted: false,
                    });
                    return;
                }
                await this.options.terminalEmit!('startup-terminal-observation', data);
            } finally {
                clearTimeout(timer);
            }
        })();
        return this.terminalTask;
    }
    /** The production parent receiver calls this only after bound durable append. */
    acceptQueryClosures(child: ChildProcess, batch: unknown, platform = process.platform) {
        if (this.halted) return;
        const row = this.children.get(child);
        assert(row && row.spawn && row.pid, 'Query closure from unowned stage');
        const proofs = validateProcessQueryBatch(batch);
        for (const proof of proofs) {
            assert.equal(proof.platform, platform, 'Query closure platform mismatch');
            row.sampler.acceptClosedQuery(proof, row.pid);
        }
    }
    halt(reason: unknown) {
        if (!this.halted)
            this.note('held', {
                reason: String(reason).slice(0, 1024),
                children: this.children.size,
            });
        this.stopQueryAdmission();
        this.cancel();
    }
    snapshot() {
        return {
            admissionClosed: this.admissionClosed,
            queryAdmissionClosed: this.halted,
            children: [...this.children.values()].map((row) => ({
                label: row.label,
                pid: row.pid,
                identity: row.identity,
                spawn: row.spawn,
                exit: row.exit,
                close: row.close,
                stopRequested: row.stopRequested,
                error: row.error,
                observations: row.observations.size,
                ...(row.sampler.historyProof().retiredCount ||
                row.sampler.historyProof().failure ||
                row.sampler.historyProof().pendingClosedQueries
                    ? { processHistory: row.sampler.historyProof() }
                    : {}),
            })),
            ...(this.queryClosures.length
                ? { closedQueriesAwaitingDiagnosticFlush: [...this.queryClosures] }
                : {}),
        };
    }
    terminateChild(child: ChildProcess, reason: unknown) {
        const row = this.children.get(child);
        assert(row, 'Unregistered termination target');
        if (row.close || row.exit) return false;
        assert(
            row.spawn && row.identity,
            'Creation identity required before owned root termination',
        );
        if (row.terminationRequested) return row.terminationResult;
        row.terminationRequested = true;
        this.note('termination-request', {
            label: row.label,
            pid: row.pid,
            reason: String(reason).slice(0, 1024),
            signal: 'SIGKILL',
        });
        row.terminationResult = child.kill('SIGKILL');
        this.note('termination-result', {
            label: row.label,
            pid: row.pid,
            returned: row.terminationResult,
            closureProven: false,
        });
        assert(row.terminationResult, 'Owned termination request unavailable');
        return row.terminationResult;
    }
    private note(stage: string, data: any) {
        if (!this.options.diagnostics || this.halted || this.diagnosticFailure) return;
        try {
            const bytes = Buffer.byteLength(JSON.stringify({ stage, data }));
            assert(
                bytes <= 65536 &&
                    ++this.diagnosticRows <= (this.options.terminalEmit ? 510 : 512) &&
                    this.diagnosticBytes + bytes <=
                        262144 - (this.options.terminalEmit ? 65536 : 0),
                'Startup diagnostic bound',
            );
            this.diagnosticBytes += bytes;
            const task = Promise.resolve().then(() => this.options.emit('startup-' + stage, data));
            this.diagnosticTasks.add(task);
            void task.then(
                () => this.diagnosticTasks.delete(task),
                (e) => {
                    this.diagnosticTasks.delete(task);
                    this.diagnosticFailure ??= e;
                    this.halt(e);
                    this.options.hold(e);
                },
            );
        } catch (e) {
            this.diagnosticFailure ??= e;
            this.halt(e);
            this.options.hold(e);
        }
    }
    async drainDiagnostics() {
        this.flushQueryClosures();
        if (this.diagnosticFailure) throw this.diagnosticFailure;
        await this.bounded(this.bound(), () => Promise.all([...this.diagnosticTasks]));
        if (this.diagnosticFailure) throw this.diagnosticFailure;
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
            .then(() => {
                assert(!this.halted, 'Held startup query admission closed');
                return read();
            })
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
        assert(!this.halted, 'Held startup query admission closed');
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
            sampler,
            ...receipt
        } = row;
        const history = sampler.historyProof();
        return {
            ...receipt,
            ...(history.retiredCount || history.failure || history.pendingClosedQueries
                ? { processHistory: history }
                : {}),
        };
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
            this.flushQueryClosures();
            this.checkJoin(deadline);
            assert.equal(row.observations.size, 0, 'Process observation still active');
            this.childProof(row);
            this.note('child-joined', { label: row.label, pid: row.pid });
            await Promise.all([...this.diagnosticTasks]);
            if (this.diagnosticFailure) throw this.diagnosticFailure;
            this.checkJoin(deadline);
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
            if (this.options.terminalEmit) {
                await this.terminalObservation('normal-final-join');
                this.checkJoin(deadline);
            }
            return {
                complete: true,
                children: [...this.children.values()].map((row) => this.snapshotChild(row)),
            };
        }));
    }
}
