import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionFailure } from '../shared/connection';
import type { ConnectOptions } from '../shared/types';
import {
    ConnectionOperation,
    type ConnectionProgress,
    type ConnectionTransport,
} from '../src/services/connection-operation';

function gate() {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
function observe<T>(promise: Promise<T>) {
    const outcome: { settled: boolean; result?: T; error?: unknown } = { settled: false };
    void promise.then(
        (result) => {
            outcome.result = result;
            outcome.settled = true;
        },
        (error: unknown) => {
            outcome.error = error;
            outcome.settled = true;
        },
    );
    return outcome;
}
async function until(check: () => boolean, label: string) {
    for (let turn = 0; turn < 64; turn++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.ok(check(), label + ' exceeded 64 memory-only microtask turns.');
}

test('connection retries retain submitted key options and release credential copies on success and cancellation', async () => {
    for (const ending of ['success', 'cancelled'] as const) {
        // Opaque placeholders are never parsed as keys or delivered to any SSH implementation.
        const draft: ConnectOptions = {
            host: 'submitted.invalid',
            port: 22,
            username: 'submitted-user',
            auth: 'key',
            privateKey: 'SYNTHETIC_NOT_A_PRIVATE_KEY_SUBMITTED',
            passphrase: 'SYNTHETIC_NOT_A_PASSPHRASE_SUBMITTED',
        };
        const submitted = { ...draft };
        const first = gate(),
            cleanup = gate(),
            second = gate();
        const timers = new Map<number, () => void>();
        let timerSets = 0,
            timerClears = 0,
            ids = 0;
        const clock = {
            set(callback: () => void, delay: number) {
                assert.equal(delay, 3000);
                assert.equal(++timerSets, 1);
                assert.equal(timers.size, 0);
                timers.set(1, callback);
                return 1;
            },
            clear(token: unknown) {
                assert.equal(token, 1);
                assert.equal(++timerClears, 1);
                assert.equal(timers.delete(1), true);
            },
        };
        const operation = new ConnectionOperation(clock, () => {
            assert.ok(++ids <= 2);
            return ids.toString(16).padStart(32, '0');
        });
        const references: ConnectOptions[] = [];
        const admissions: { id: string; options: ConnectOptions }[] = [];
        const cancellations: string[] = [];
        const states: ConnectionProgress[] = [];
        const transport: ConnectionTransport = {
            connect(options, attemptId) {
                assert.ok(admissions.length < 2);
                assert.ok(attemptId && /^[0-9a-f]{32}$/.test(attemptId));
                references.push(options);
                admissions.push({ id: attemptId, options: { ...options } });
                if (admissions.length === 1) return first.promise;
                assert.equal(ending, 'success');
                return second.promise;
            },
            cancelConnect(attemptId) {
                assert.ok(cancellations.length < 2);
                assert.ok(admissions.some((entry) => entry.id === attemptId));
                cancellations.push(attemptId);
                if (attemptId === admissions[0].id) return cleanup.promise;
                // Only failure unwind can cancel an admitted second memory handshake.
                second.resolve();
                return Promise.resolve();
            },
        };
        const work = observe(
            operation.connect(transport, draft, (progress) => {
                assert.ok(states.length < 12);
                states.push(progress);
            }),
        );
        try {
            await until(() => admissions.length === 1, 'first admission');
            assert.notStrictEqual(references[0], draft);
            assert.deepEqual(admissions[0].options, submitted);
            Object.assign(draft, {
                host: 'edited.invalid',
                port: 2222,
                username: 'edited-user',
                privateKey: 'SYNTHETIC_NOT_A_PRIVATE_KEY_EDITED',
                passphrase: 'SYNTHETIC_NOT_A_PASSPHRASE_EDITED',
            });
            first.reject(new ConnectionFailure('network', 'Synthetic temporary failure.'));
            await until(() => cancellations.length === 1, 'first cleanup admission');
            assert.equal(timers.size, 0, 'No retry owns a timer before cleanup settles.');
            assert.deepEqual(references[0], submitted);
            cleanup.resolve();
            await until(() => timers.size === 1, 'retry wait admission');
            // A second draft edit while the retry is pending must also stay outside this operation.
            draft.host = 'later-edit.invalid';
            draft.privateKey = 'SYNTHETIC_NOT_A_PRIVATE_KEY_LATER_EDIT';
            draft.passphrase = 'SYNTHETIC_NOT_A_PASSPHRASE_LATER_EDIT';
            const edited = { ...draft };
            assert.equal(operation.running, true);
            assert.equal(work.settled, false);
            assert.deepEqual(references[0], submitted);
            if (ending === 'success') {
                const callback = timers.get(1)!;
                assert.equal(timers.delete(1), true);
                callback();
                await until(() => admissions.length === 2, 'second admission');
                assert.notEqual(admissions[0].id, admissions[1].id);
                assert.deepEqual(admissions[1].options, submitted);
                second.resolve();
                await until(() => work.settled, 'successful settlement');
                assert.equal(work.error, undefined);
                assert.equal(work.result, true);
                assert.equal(timerClears, 0);
                assert.equal(states.at(-1)!.state, 'connected');
            } else {
                const cancelled = observe(operation.cancel());
                await until(() => work.settled && cancelled.settled, 'cancelled settlement');
                assert.equal(cancelled.error, undefined);
                assert.equal(work.error, undefined);
                assert.equal(work.result, false);
                assert.equal(admissions.length, 1);
                assert.equal(timerClears, 1);
                assert.equal(
                    states.some((state) => state.state === 'connected'),
                    false,
                );
                assert.equal(states.at(-1)!.state, 'cancelled');
            }
            assert.equal(timerSets, 1);
            assert.equal(timers.size, 0);
            assert.equal(
                cancellations.length,
                1,
                'Retry-wait cancellation must not duplicate cleanup.',
            );
            assert.equal(operation.running, false);
            assert.deepEqual(
                draft,
                edited,
                'Internal secret clearing must not erase caller edits.',
            );
            for (const reference of references) {
                assert.notStrictEqual(reference, draft);
                assert.deepEqual(reference, {
                    ...submitted,
                    password: undefined,
                    privateKey: undefined,
                    passphrase: undefined,
                });
            }
        } finally {
            // Settle every private fake gate on all paths, then let the actual operation disarm itself.
            first.resolve();
            cleanup.resolve();
            second.resolve();
            if (operation.running) {
                const cancelled = observe(operation.cancel());
                await until(() => cancelled.settled && work.settled, 'owned operation unwind');
                if (cancelled.error !== undefined) throw cancelled.error;
            }
            await until(() => work.settled, 'owned connect settlement');
            assert.equal(timers.size, 0);
            assert.equal(operation.running, false);
        }
    }
});
