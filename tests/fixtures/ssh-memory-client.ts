import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

/** Compiler-only ssh2 alias: no installed SSH code or sockets are evaluated. */
export class Client extends EventEmitter {
    static instances: Client[] = [];
    fakeStarted = false;
    closed = false;
    destroyCalls = 0;
    constructor() {
        super();
        Client.instances.push(this);
        assert.ok(Client.instances.length <= 4, 'bounded fake clients');
    }
    connect(_config: unknown): this {
        assert.equal(this.fakeStarted, false);
        this.fakeStarted = true;
        return this;
    }
    destroy(): this {
        assert.ok(++this.destroyCalls <= 4);
        return this;
    }
    fail(error: Error) { this.emit('error', error); }
    ready() { this.emit('ready'); }
    closeOwned() {
        if (!this.closed) {
            this.closed = true;
            this.emit('close');
        }
    }
    exec(): never { throw Error('Forbidden memory-client exec'); }
    shell(): never { throw Error('Forbidden memory-client shell'); }
    end(): never { throw Error('Forbidden memory-client end'); }
}
export function observe<T>(promise: Promise<T>) {
    const state: { done: boolean; value?: T; error?: unknown } = { done: false };
    void promise.then(
        value => { state.value = value; state.done = true; },
        error => { state.error = error; state.done = true; },
    );
    return state;
}
export async function until(predicate: () => boolean, label: string) {
    for (let i = 0; i < 128; i++) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.ok(predicate(), label);
}
export async function turns() { for (let i = 0; i < 48; i++) await Promise.resolve(); }
export async function memoryClientScope(work: () => Promise<void>) {
    assert.equal(Client.instances.length, 0);
    const keys = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;
    const before = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)!] as const);
    const timers = new Set<number>();
    let next = 0;
    try {
        const install = (key: string, value: unknown) =>
            Object.defineProperty(globalThis, key, { ...Object.getOwnPropertyDescriptor(globalThis, key), value });
        install('setTimeout', (_callback: () => void, delay: number) => {
            assert.equal(delay, 60000);
            assert.ok(++next <= 4);
            timers.add(next);
            return next;
        });
        install('clearTimeout', (id: number) => assert.equal(timers.delete(id), true));
        install('setInterval', () => { throw Error('Unexpected interval'); });
        install('clearInterval', () => { throw Error('Unexpected interval release'); });
        await work();
    } finally {
        for (const client of Client.instances) client.closeOwned();
        await turns();
        for (const [key, descriptor] of before) Object.defineProperty(globalThis, key, descriptor);
        for (const [key, descriptor] of before)
            assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), descriptor);
        const pendingTimers = timers.size;
        for (const client of Client.instances) {
            assert.equal(client.closed, true);
            client.removeAllListeners();
            assert.equal(client.eventNames().length, 0);
        }
        Client.instances.length = 0;
        assert.equal(pendingTimers, 0, 'all owned handshake timers cleared');
    }
}
