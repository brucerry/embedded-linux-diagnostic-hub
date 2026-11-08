import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync('gateway/main.ts', 'utf8');
const start = source.indexOf('function main() {'),
    end = source.indexOf('\ntry {\n    main();', start);
assert.ok(start >= 0 && end > start);
const body = source.slice(start, end);
function fixture() {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    // Real gateway.close installs a rejection observer for its retained task; this is not CLI handling.
    void promise.catch(() => {});
    const callbacks = new Map<string, () => void>(),
        errors: unknown[][] = [],
        logs: unknown[][] = [];
    let closes = 0;
    const owner: {
        env: Record<string, string>;
        exitCode?: number;
        on(name: string, fn: () => void): void;
    } = {
        env: {
            HUB_GATEWAY_TOKEN: 'synthetic-placeholder-not-a-credential',
            HUB_TARGETS_JSON: '[]',
            HUB_ALLOWED_ORIGINS: 'https://synthetic.invalid',
        },
        on(name, fn) {
            assert.ok(['SIGINT', 'SIGTERM'].includes(name));
            assert.ok(!callbacks.has(name));
            callbacks.set(name, fn);
        },
    };
    const gateway = {
        server: {
            listen(port: number, host: string, ready: () => void) {
                assert.equal(port, 8787);
                assert.equal(host, '127.0.0.1');
                ready();
            },
            on(name: string, fn: () => void) {
                assert.equal(name, 'error');
                assert.ok(!callbacks.has('server:error'));
                callbacks.set('server:error', fn);
            },
        },
        close() {
            closes++;
            assert.ok(closes <= 1);
            return promise;
        },
    };
    new Function('createGateway', 'process', 'console', body + ';main();')(
        (config: { token: string }) => {
            assert.equal(config.token, owner.env.HUB_GATEWAY_TOKEN);
            return gateway;
        },
        owner,
        { log: (...v: unknown[]) => logs.push(v), error: (...v: unknown[]) => errors.push(v) },
    );
    assert.equal(callbacks.size, 3);
    return {
        owner,
        errors,
        logs,
        resolve,
        reject,
        promise,
        fire(name: string) {
            const fn = callbacks.get(name);
            assert.ok(fn);
            fn();
        },
        get closes() {
            return closes;
        },
    };
}
async function turns() {
    for (let n = 0; n < 16; n++) await Promise.resolve();
}
test('signal cleanup failure is reported with its original object and a failing exit outcome', async () => {
    for (const signal of ['SIGINT', 'SIGTERM']) {
        const f = fixture(),
            error = Error('Synthetic gateway cleanup failure');
        try {
            f.fire(signal);
            assert.equal(f.closes, 1);
            f.reject(error);
            await turns();
            assert.equal(f.errors.length, 1);
            assert.equal(f.errors[0][0], 'Gateway cleanup failed:');
            assert.equal(f.errors[0][1], error);
            assert.equal(f.owner.exitCode, 1);
            assert.equal(f.closes, 1);
        } finally {
            f.resolve();
            await f.promise.catch(() => {});
        }
    }
});
test('pending then successful close has no failure outcome or automatic retry', async () => {
    const f = fixture();
    try {
        f.fire('SIGTERM');
        await turns();
        assert.equal(f.closes, 1);
        assert.equal(f.errors.length, 0);
        assert.equal(f.owner.exitCode, undefined);
        f.resolve();
        await f.promise;
        await turns();
        assert.equal(f.errors.length, 0);
        assert.equal(f.owner.exitCode, undefined);
        assert.equal(f.closes, 1);
    } finally {
        f.resolve();
        await f.promise.catch(() => {});
    }
});
test('bind failure remains visible and a subsequent cleanup failure is separately retained', async () => {
    const f = fixture(),
        error = Error('Synthetic close after bind failure');
    try {
        f.fire('server:error');
        assert.equal(f.owner.exitCode, 1);
        assert.deepEqual(f.errors, [['Gateway could not bind its configured address.']]);
        f.reject(error);
        await turns();
        assert.equal(f.errors.length, 2);
        assert.equal(f.errors[1][0], 'Gateway cleanup failed:');
        assert.equal(f.errors[1][1], error);
        assert.equal(f.owner.exitCode, 1);
        assert.equal(f.closes, 1);
    } finally {
        f.resolve();
        await f.promise.catch(() => {});
    }
});
