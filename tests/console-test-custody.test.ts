import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
    consoleTestCallback,
    consoleTestGate,
    consoleTestChild,
} from './fixtures/console-test-custody';

test('ordinary test hooks release the held gate before the subsequently registered owner join', async (t) => {
    const order: string[] = [];
    await t.test('owned gate is released by teardown without a success-path release', (child) => {
        const held = consoleTestGate(child);
        child.after(async () => {
            await held.promise;
            order.push('owner joined');
        });
        order.push('body');
    });
    assert.deepEqual(order, ['body', 'owner joined']);
});

test('failed assertions still join the gate owner and retain the original failure', async () => {
    const hooks: (() => void | Promise<void>)[] = [];
    const context = {
        after(callback: () => void | Promise<void>) {
            hooks.push(callback);
        },
    } as Pick<TestContext, 'after'>;
    let joined = false;
    const original = Error('Synthetic assertion failure');
    await assert.rejects(
        async () => {
            const held = consoleTestGate(context);
            context.after(async () => {
                await held.promise;
                joined = true;
            });
            try {
                throw original;
            } finally {
                for (const hook of hooks) await hook();
            }
        },
        (error) => error === original,
    );
    assert.equal(joined, true);
});

test('late callback teardown delivers a missing callback once and never repeats a delivered one', () => {
    for (const deliveredInBody of [false, true]) {
        const actual: [undefined, object][] = [];
        const channel = {};
        const callback = consoleTestCallback((error: undefined, value: object) => {
            actual.push([error, value]);
        });
        if (deliveredInBody) callback(undefined, channel);
        callback(undefined, channel);
        callback(undefined, channel);
        assert.deepEqual(actual, [[undefined, channel]]);
    }
});

test('a throwing callback remains consumed and its error is not hidden', () => {
    let attempts = 0;
    const original = Error('Synthetic callback failure');
    const callback = consoleTestCallback(() => {
        attempts++;
        throw original;
    });
    assert.throws(callback, (error) => error === original);
    assert.doesNotThrow(callback);
    assert.equal(attempts, 1);
});

test('initialization teardown cancels before unblocking its held journal operation', async () => {
    const hooks: (() => void | Promise<void>)[] = [];
    const context = {
        after(callback: () => void | Promise<void>) {
            hooks.push(callback);
        },
    } as Pick<TestContext, 'after'>;
    const signal = new AbortController();
    const held = consoleTestGate(context, () => signal.abort());
    let opened = false;
    const initialization = held.promise.then(() => {
        if (!signal.signal.aborted) opened = true;
    });
    for (const hook of hooks) await hook();
    await initialization;
    assert.equal(signal.signal.aborted, true);
    assert.equal(opened, false);
});

class Child extends EventEmitter {
    stdout = {
        readableEnded: false,
        resumes: 0,
        resume() {
            this.resumes++;
        },
    };
    stderr = {
        readableEnded: false,
        resumes: 0,
        resume() {
            this.resumes++;
        },
    };
    signals: string[] = [];
    kill(signal: string) {
        this.signals.push(signal);
        return false;
    }
    owned() {
        return this as unknown as ChildProcessWithoutNullStreams;
    }
}
test('child exit and both EOFs do not release custody before actual close', async () => {
    const child = new Child(),
        owner = consoleTestChild(child.owned());
    let settled = false;
    const done = owner.done.then(() => {
        settled = true;
    });
    child.emit('spawn');
    child.emit('exit', 7, null);
    child.stdout.readableEnded = child.stderr.readableEnded = true;
    await Promise.resolve();
    assert.equal(settled, false);
    child.emit('close', 7, null);
    await done;
    owner.stop();
    assert.deepEqual(child.signals, []);
});
test('stop drains only the owned pipes and requests SIGTERM once without claiming closure', async () => {
    const child = new Child(),
        owner = consoleTestChild(child.owned());
    let settled = false;
    const done = owner.done.then(() => {
        settled = true;
    });
    child.emit('spawn');
    owner.stop();
    owner.stop();
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.equal(child.stdout.resumes, 2);
    assert.equal(child.stderr.resumes, 2);
    await Promise.resolve();
    assert.equal(settled, false);
    child.emit('exit', null, 'SIGTERM');
    child.stdout.readableEnded = child.stderr.readableEnded = true;
    child.emit('close', null, 'SIGTERM');
    await done;
});
test('close with missing spawn, exit or either pipe EOF cannot acknowledge child retirement', async () => {
    for (const fault of ['spawn', 'exit', 'stdout', 'stderr']) {
        const child = new Child(),
            owner = consoleTestChild(child.owned());
        if (fault !== 'spawn') child.emit('spawn');
        if (fault !== 'exit') child.emit('exit', 0, null);
        child.stdout.readableEnded = fault !== 'stdout';
        child.stderr.readableEnded = fault !== 'stderr';
        child.emit('close', 0, null);
        await assert.rejects(owner.done, /not acknowledged/);
        owner.stop();
        assert.deepEqual(child.signals, []);
    }
});
