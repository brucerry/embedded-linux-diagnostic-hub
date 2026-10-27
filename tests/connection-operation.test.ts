import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionFailure, connectionFailure } from '../shared/connection';
import { ConnectionOperation } from '../src/services/connection-operation';
import type { ConnectOptions } from '../shared/types';

const options: ConnectOptions = {
    host: 'fixture',
    port: 22,
    username: 'engineer',
    auth: 'password',
    password: 'secret',
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
class Clock {
    now = 0;
    entries = new Map<number, { due: number; callback: () => void }>();
    id = 0;
    set = (callback: () => void, delay: number) => {
        const id = ++this.id;
        this.entries.set(id, { due: this.now + delay, callback });
        return id;
    };
    clear = (id: unknown) => {
        this.entries.delete(id as number);
    };
    advance(ms: number) {
        this.now += ms;
        for (const [id, timer] of this.entries)
            if (timer.due <= this.now) {
                this.entries.delete(id);
                timer.callback();
            }
    }
}
function owner(clock = new Clock()) {
    let id = 0;
    return {
        clock,
        operation: new ConnectionOperation(clock, () => (++id).toString(16).padStart(32, '0')),
    };
}

test('retry delay begins after cleanup, waits exactly 3000 ms and never overlaps attempts', async () => {
    const { clock, operation } = owner();
    const cleanup = deferred<void>();
    let attempts = 0;
    const work = operation.connect(
        {
            connect: async () => {
                if (++attempts === 1) throw new ConnectionFailure('network', 'temporary');
            },
            cancelConnect: () => cleanup.promise,
        },
        options,
        () => {},
    );
    await tick();
    clock.advance(6000);
    await tick();
    assert.equal(attempts, 1);
    assert.equal(clock.entries.size, 0);
    cleanup.resolve();
    await tick();
    clock.advance(2999);
    await tick();
    assert.equal(attempts, 1);
    clock.advance(1);
    await tick();
    assert.equal(await work, true);
    assert.equal(attempts, 2);
});

test('Cancel removes the retry timer and no suspended catch-up attempt starts', async () => {
    const { clock, operation } = owner();
    let attempts = 0;
    const work = operation.connect(
        {
            connect: async () => {
                attempts++;
                throw new ConnectionFailure('network', 'temporary');
            },
            cancelConnect: async () => {},
        },
        options,
        () => {},
    );
    await tick();
    assert.equal(clock.entries.size, 1);
    await operation.cancel();
    assert.equal(await work, false);
    clock.advance(60_000);
    await tick();
    assert.equal(attempts, 1);
    assert.equal(clock.entries.size, 0);
});

test('Cancel racing a late authentication closes the attempt and cannot connect a replacement run', async () => {
    const { operation } = owner();
    const ready = deferred<void>();
    const states: string[] = [];
    let cancelled = 0;
    const work = operation.connect(
        {
            connect: () => ready.promise,
            cancelConnect: async () => {
                cancelled++;
                ready.resolve();
            },
        },
        options,
        (state) => states.push(state.state),
    );
    await operation.cancel();
    assert.equal(await work, false);
    assert.equal(cancelled, 1);
    assert.equal(states.includes('connected'), false);
    assert.equal(
        await operation.connect(
            { connect: async () => {}, cancelConnect: async () => {} },
            { ...options, password: 'corrected' },
            () => {},
        ),
        true,
    );
    ready.resolve();
    await tick();
    assert.equal(operation.running, false);
});

for (const code of ['authentication', 'host-key', 'policy'] as const) {
    test(`${code} failure pauses without credential retries; explicit corrected connection can succeed`, async () => {
        const { clock, operation } = owner();
        let calls = 0;
        const passwords: string[] = [];
        const transport = {
            connect: async (input: ConnectOptions) => {
                calls++;
                passwords.push(input.password!);
                if (input.password === 'secret')
                    throw new ConnectionFailure(code, 'Correct this input.');
            },
            cancelConnect: async () => {},
        };
        await assert.rejects(
            operation.connect(transport, options, () => {}),
            (error: unknown) => error instanceof ConnectionFailure && error.code === code,
        );
        clock.advance(60_000);
        await tick();
        assert.equal(calls, 1);
        assert.equal(
            await operation.connect(transport, { ...options, password: 'corrected' }, () => {}),
            true,
        );
        assert.deepEqual(passwords, ['secret', 'corrected']);
        assert.equal(options.password, 'secret');
    });
}

test('duplicate Connect cannot overlap, and unconfirmed cleanup pauses rather than starting another SSH session', async () => {
    const { clock, operation } = owner();
    const ready = deferred<void>();
    const work = operation.connect(
        {
            connect: () => ready.promise,
            cancelConnect: async () => {
                throw Error('offline');
            },
        },
        options,
        () => {},
    );
    await assert.rejects(
        operation.connect(
            { connect: async () => {}, cancelConnect: async () => {} },
            options,
            () => {},
        ),
        /already in progress/,
    );
    ready.reject(new ConnectionFailure('network', 'temporary'));
    await assert.rejects(
        work,
        (error: unknown) => error instanceof ConnectionFailure && error.code === 'cleanup',
    );
    clock.advance(6000);
    assert.equal(clock.entries.size, 0);
});

test('contextBridge failure messages retain permanent classification without exposing arbitrary error text', () => {
    for (const code of [13, 14, 15])
        assert.equal(
            connectionFailure(Object.assign(new Error('SSH disconnect'), { code })).code,
            'authentication',
        );
    assert.equal(
        connectionFailure(new Error('HUB_CONNECTION_FAILURE:authentication')).code,
        'authentication',
    );
    assert.equal(connectionFailure(new Error('HUB_CONNECTION_FAILURE:host-key')).code, 'host-key');
    assert.equal(
        connectionFailure(new Error('remote output HUB_CONNECTION_FAILURE:authentication')).code,
        'network',
    );
    assert.equal(connectionFailure(new Error('HUB_CONNECTION_FAILURE:unknown')).code, 'network');
    assert.equal(connectionFailure(new Error('password=secret')).message.includes('secret'), false);
});

test('old transports without cancellation do not start a handshake', async () => {
    const { operation } = owner();
    let calls = 0;
    await assert.rejects(
        operation.connect(
            {
                connect: async () => {
                    calls++;
                },
            },
            options,
            () => {},
        ),
        /needs an update/,
    );
    assert.equal(calls, 0);
});
