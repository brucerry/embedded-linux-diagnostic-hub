import test from 'node:test';
import assert from 'node:assert/strict';
import { runNativeCleanup } from './memory-product-native-cleanup';

test('denied observation and detach do not skip actual close/exit/descendant steps', async () => {
    const calls: string[] = [],
        receipt: unknown[] = [];
    const denied = Error('synthetic observation denied'),
        detach = Error('synthetic detach failed');
    await assert.rejects(
        runNativeCleanup(
            [
                {
                    name: 'observe',
                    async run() {
                        calls.push('observe');
                        throw denied;
                    },
                },
                {
                    name: 'detach',
                    async run() {
                        calls.push('detach');
                        throw detach;
                    },
                },
                {
                    name: 'close',
                    async run() {
                        calls.push('close');
                    },
                },
                {
                    name: 'exit',
                    async run() {
                        calls.push('exit');
                    },
                },
                {
                    name: 'descendants',
                    async run() {
                        calls.push('descendants');
                    },
                },
            ],
            async (_stage, value) => {
                receipt.push(value);
            },
        ),
        (error) =>
            error instanceof AggregateError &&
            error.errors[0] === denied &&
            error.errors[1] === detach,
    );
    assert.deepEqual(calls, ['observe', 'detach', 'close', 'exit', 'descendants']);
    assert.equal(receipt.length, 5);
});
test('evidence write failure also preserves remaining real disposers and prevents success', async () => {
    let closed = false;
    await assert.rejects(
        runNativeCleanup(
            [
                { name: 'observe', async run() {} },
                {
                    name: 'close',
                    async run() {
                        closed = true;
                    },
                },
            ],
            async () => {
                throw Error('synthetic evidence write failure');
            },
        ),
        AggregateError,
    );
    assert.equal(closed, true);
});

test('a stuck SDK close expires the existing bound and invokes every later disposer', async () => {
    let now = 0;
    const scheduled = new Map<object, () => void>();
    const calls: string[] = [];
    const clock = {
        now: () => now,
        set(callback: () => void) {
            const token = {};
            scheduled.set(token, callback);
            return token;
        },
        clear(token: unknown) {
            scheduled.delete(token as object);
        },
    };
    const task = runNativeCleanup(
        [
            {
                name: 'stuck-sdk-close',
                run: async () => {
                    calls.push('sdk-close');
                    await new Promise(() => {});
                },
            },
            {
                name: 'actual-root-exit',
                run: async () => {
                    calls.push('root-exit');
                },
            },
            {
                name: 'actual-descendant-exit',
                run: async () => {
                    calls.push('descendant-exit');
                },
            },
        ],
        async () => {},
        { clock },
    );
    await Promise.resolve();
    assert.deepEqual(calls, ['sdk-close']);
    now = 10000;
    for (const callback of [...scheduled.values()]) callback();
    await assert.rejects(
        task,
        (error) =>
            error instanceof AggregateError &&
            error.errors.some((item) => /10-second join bound/.test(String(item))),
    );
    assert.deepEqual(calls, ['sdk-close', 'root-exit', 'descendant-exit']);
    assert.equal(scheduled.size, 0);
});

test('a stuck evidence write cannot prevent remaining real disposal', async () => {
    let now = 0;
    const scheduled = new Map<object, () => void>();
    const calls: string[] = [];
    const clock = {
        now: () => now,
        set(callback: () => void) {
            const token = {};
            scheduled.set(token, callback);
            return token;
        },
        clear(token: unknown) {
            scheduled.delete(token as object);
        },
    };
    const task = runNativeCleanup(
        [
            {
                name: 'first',
                run: async () => {
                    calls.push('first');
                },
            },
            {
                name: 'close-root',
                run: async () => {
                    calls.push('close-root');
                },
            },
        ],
        async () => {
            calls.push('receipt');
            await new Promise(() => {});
        },
        { clock },
    );
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.ok(calls.includes('receipt'));
    now = 10000;
    for (const callback of [...scheduled.values()]) callback();
    await assert.rejects(task, AggregateError);
    assert.ok(calls.includes('close-root'));
    assert.equal(scheduled.size, 0);
});
