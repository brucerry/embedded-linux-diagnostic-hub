// @ts-nocheck
import assert from 'node:assert/strict';
import { productClock } from '../../tests/fixtures/memory-product-owner.ts';
import { limits } from './product-collector-controller.mjs';
/** Actual OS child events, never parsed finish text. Remains attached after any deadline. */
export async function observeCollector(
    child,
    {
        clock = productClock,
        events = process,
        nonce,
        record = () => {},
        streams = [],
        startedAt = clock.now(),
    } = {},
) {
    const started = startedAt,
        state = {
            pid: child.pid ?? null,
            spawnObserved: false,
            exitObserved: false,
            closeObserved: false,
            code: null,
            signal: null,
            closeCode: null,
            closeSignal: null,
            errors: [],
            timedOut: false,
        };
    let cancelled = false;
    const cancel = (reason) => {
        if (cancelled) return;
        cancelled = true;
        try {
            assert(child.connected);
            child.send(
                { kind: 'cancel-product-collection', nonce, reason: String(reason) },
                (error) => {
                    if (error) state.errors.push('IPC: ' + String(error));
                },
            );
        } catch (error) {
            state.errors.push('IPC: ' + String(error));
        }
    };
    const persist = (name, value) => {
        try {
            record(name, value);
        } catch (error) {
            state.errors.push('record: ' + String(error));
            cancel(error);
        }
    };
    const interrupt = () => {
        state.errors.push('Outer observer interrupted/disconnected.');
        cancel('Outer observation interrupted.');
    };
    for (const event of ['SIGTERM', 'SIGINT', 'disconnect']) events.on(event, interrupt);
    let resolve;
    const closed = new Promise((done) => (resolve = done));
    child.once('spawn', () => {
        state.spawnObserved = true;
        persist('collector-spawn.json', { ...state });
    });
    child.on('error', (error) => {
        state.errors.push(String(error));
        cancel(error);
    });
    child.once('exit', (code, signal) =>
        Object.assign(state, { exitObserved: true, code, signal }),
    );
    child.once('close', (code, signal) => {
        Object.assign(state, { closeObserved: true, closeCode: code, closeSignal: signal });
        resolve();
    });
    for (const [i, name] of ['stdout', 'stderr'].entries())
        if (child[name]) {
            child[name].on('data', (b) => {
                try {
                    streams[i]?.write(b);
                } catch (error) {
                    state.errors.push(String(error));
                    cancel(error);
                }
            });
            child[name].on('error', (error) => {
                state.errors.push(String(error));
                cancel(error);
            });
        }
    let timer;
    try {
        timer = clock.set(
            () => {
                state.timedOut = true;
                cancel('Outer cohort observation deadline.');
                persist('collector-deadline.json', {
                    ...state,
                    errors: [...state.errors],
                    immutable: true,
                });
            },
            Math.max(0, started + limits.cohortMs - clock.now()),
        );
    } catch (error) {
        state.errors.push(String(error));
        cancel(error);
    }
    await closed;
    try {
        clock.clear(timer);
    } catch (error) {
        state.errors.push(String(error));
    }
    for (const event of ['SIGTERM', 'SIGINT', 'disconnect']) events.off(event, interrupt);
    return {
        ...state,
        elapsedMs: clock.now() - started,
        streams: streams.map((s) => s.snapshot()),
        middleOwnerKillAttempted: false,
    };
}
