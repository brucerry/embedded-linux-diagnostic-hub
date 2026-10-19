// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { productClock } from '../../tests/fixtures/memory-product-owner.ts';
import { limits } from './product-collector-controller.mjs';
import { closeEntries } from './product-collector-evidence.mjs';
const retained = new Set();
export function collectionCohort(raw, nonce, clock = productClock) {
    const now = clock.now();
    const value = raw
        ? JSON.parse(raw)
        : { schema: 1, nonce, startedAt: now, deadlineMs: now + limits.cohortMs };
    assert.deepEqual(Object.keys(value).sort(), ['deadlineMs', 'nonce', 'schema', 'startedAt']);
    assert.equal(value.schema, 1);
    assert.equal(value.nonce, nonce);
    assert.match(nonce, /^[a-f0-9-]{36}$/);
    assert(Number.isSafeInteger(value.startedAt) && Number.isSafeInteger(value.deadlineMs));
    assert(value.startedAt <= clock.now());
    assert.equal(value.deadlineMs - value.startedAt, limits.cohortMs);
    return Object.freeze(value);
}
/** Installed before verification/preparation; cancellation survives every handoff. */
export class CollectionEntry {
    constructor({
        nonce = randomUUID(),
        cohort,
        events = process,
        clock = productClock,
        requireIPC = false,
        requireCohort = false,
    } = {}) {
        this.events = events;
        this.clock = clock;
        this.nonce = nonce;
        this.cancelled = null;
        this.listeners = new Set();
        this.requireIPC = requireIPC;
        this.disposed = false;
        this.handlers = [
            ['SIGTERM', () => this.cancel('Entry received SIGTERM.')],
            ['SIGINT', () => this.cancel('Entry received SIGINT.')],
            ['disconnect', () => this.cancel('Entry supervisor disconnected.')],
            [
                'message',
                (value) =>
                    this.cancel(
                        value?.kind === 'cancel-product-collection' && value.nonce === nonce
                            ? (value.reason ?? 'Entry cancelled.')
                            : 'Invalid entry cancellation identity.',
                    ),
            ],
        ];
        for (const [name, fn] of this.handlers) events.on(name, fn);
        try {
            assert(
                !requireCohort || cohort,
                'Collector requires the existing outer cohort; it cannot restart the budget.',
            );
            this.cohort = collectionCohort(cohort, nonce, clock);
            this.timer = clock.set(
                () => this.cancel('Immutable cohort deadline expired.'),
                Math.max(0, this.cohort.deadlineMs - clock.now()),
            );
            if (events.connected === false || (requireIPC && events.connected !== true))
                this.cancel('Entry IPC was already disconnected.');
        } catch (error) {
            this.dispose({ closed: true });
            throw error;
        }
    }
    cancel(reason) {
        if (this.cancelled !== null) return;
        this.cancelled = String(reason).slice(0, 4096);
        for (const fn of this.listeners)
            try {
                fn(this.cancelled);
            } catch (error) {
                this.forwardError = String(error);
            }
    }
    assertAdmissible(job) {
        assert.equal(this.disposed, false);
        if (this.events.connected === false || (this.requireIPC && this.events.connected !== true))
            this.cancel('Entry IPC is not connected.');
        if (this.clock.now() >= this.cohort.deadlineMs)
            this.cancel('Immutable cohort deadline expired.');
        assert.equal(this.cancelled, null, this.cancelled ?? '');
        if (job)
            assert(
                this.clock.now() < Math.min(job.deadlineMs - job.reserveMs, this.cohort.deadlineMs),
                'Existing job work deadline exhausted before spawn.',
            );
    }
    async verify(work) {
        this.assertAdmissible();
        const result = await work();
        this.assertAdmissible();
        return result;
    }
    onCancel(fn) {
        this.listeners.add(fn);
        if (this.cancelled !== null) fn(this.cancelled);
        return () => this.listeners.delete(fn);
    }
    dispose(proof) {
        assert.equal(proof.closed, true, 'Actual custody must close before handler retirement.');
        if (this.disposed) return;
        this.disposed = true;
        this.clock.clear(this.timer);
        for (const [name, fn] of this.handlers) this.events.off(name, fn);
        this.listeners.clear();
    }
}
/** The refed hold exists before any persistence; an error cannot reject out of unknown custody. */
export function createOwnershipHold(
    state,
    record,
    { interval = setInterval, onRetained = () => {} } = {},
) {
    const row = { state, persistenceErrors: [], handle: null };
    row.handle = interval(() => {
        void row.state;
    }, 1000);
    row.handle?.ref?.();
    retained.add(row);
    const outcome = new Promise(() => {});
    const hold = {
        outcome,
        snapshot: () => ({
            attached: true,
            recordErrors: [...row.persistenceErrors],
            referencedHandleCreated: true,
        }),
    };
    // The caller latches the actual hold before persistence can reenter or fail.
    try {
        onRetained(hold);
    } catch (error) {
        row.persistenceErrors.push(String(error).slice(0, 4096));
    }
    try {
        record('ownership-held.json', state);
    } catch (error) {
        row.persistenceErrors.push(String(error).slice(0, 4096));
    }
    return hold;
}
/** Register each acquired log before the next open can fail. Partial failures carry custody. */
export function prepareProductLogs(guard, names, io = fs) {
    const logs = [];
    try {
        for (const name of names) {
            const file = path.join(guard.root, name);
            guard.check(file);
            const fd = io.openSync(file, 'wx', 0o600);
            logs.push({ fd, name, errors: [], attempted: false, synced: false, closed: false });
        }
        return logs;
    } catch (error) {
        error.preparedLogs = logs;
        error.fdClosure = closeEntries(logs, io);
        error.noChildStarted = true;
        throw error;
    }
}
/** Job identity allocated once; final admission is immediately adjacent to the actual spawn. */
export function prepareProductSpawn(spec, allocateJob, finalAdmission, ports) {
    let logs = [],
        job,
        child;
    try {
        job = allocateJob();
        const directory = ports.directory(spec);
        logs = ports.logs(spec);
        const command = ports.command(spec, job, directory),
            options = ports.options(spec, job, directory);
        const commit = () => {
            try {
                finalAdmission(job);
                child = ports.spawn(command, options);
                return { child, job, directory, logs, command, options };
            } catch (error) {
                error.noChildStarted = !child;
                error.preparedLogs = logs;
                error.fdClosure = closeEntries(logs, ports.io);
                throw error;
            }
        };
        return ports.deferSpawn ? { commit, job, logs } : commit();
    } catch (error) {
        if (!child) {
            error.noChildStarted = true;
            // A partial logs() failure owns descriptors even though assignment never completed.
            logs = error.preparedLogs ?? logs;
            error.preparedLogs = logs;
            const own = closeEntries(logs, ports.io);
            error.fdClosure = error.fdClosure ?? own;
            if (!own.complete) error.fdClosure = own;
        }
        throw error;
    }
}
