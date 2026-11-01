import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createCaseLogLifecycle } from '../scripts/lib/case-log-lifecycle.mjs';

async function turns() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}
function fixture({ writeError, endError } = {}) {
    class Writer extends EventEmitter {
        writes = [];
        endCalls = [];
        callback = null;
        closed = false;
        write(chunk) {
            if (writeError) throw writeError;
            assert(this.writes.length < 8);
            this.writes.push(chunk);
            return true;
        }
        end(chunk, callback) {
            this.endCalls.push(chunk);
            if (endError) throw endError;
            this.callback = callback;
            return this;
        }
        finish(error) {
            const callback = this.callback;
            this.callback = null;
            callback?.(error);
            if (!error) this.emit('finish');
        }
        close() {
            assert.equal(this.closed, false);
            this.closed = true;
            this.emit('close');
        }
    }
    const writer = new Writer();
    const owner = createCaseLogLifecycle(writer);
    const outcome = { state: 'pending', error: null, hashes: 0, passed: 0 };
    let task;
    const begin = (chunk = 'final record') => {
        assert.equal(task, undefined);
        task = owner.end(chunk);
        task.then(
            () => { outcome.state = 'fulfilled'; outcome.hashes++; outcome.passed++; },
            (error) => { outcome.state = 'rejected'; outcome.error = error; },
        );
        return task;
    };
    const settle = async () => {
        if (!task) begin();
        if (!writer.closed) writer.close(); // Only release this fixture's memory event gate.
        await turns();
        assert.notEqual(outcome.state, 'pending');
    };
    return { writer, owner, outcome, begin, settle };
}

test('end callback and finish before close remain pending without hashing or pass', async () => {
    const f = fixture();
    try {
        f.begin();
        f.writer.finish();
        await turns();
        assert.deepEqual(f.outcome, { state: 'pending', error: null, hashes: 0, passed: 0 });
        assert.deepEqual(f.owner.snapshot(), {
            finished: true, closed: false, failed: false, error: undefined, endRequested: true,
        });
        f.writer.close();
        await turns();
        assert.equal(f.outcome.state, 'fulfilled');
    } finally { await f.settle(); }
});

test('delayed error retains first failure and prevents hash/pass until acknowledged close rejects', async () => {
    const f = fixture();
    const first = Error('synthetic delayed close failure');
    try {
        f.begin();
        f.writer.finish();
        f.writer.emit('error', first);
        f.writer.emit('error', Error('secondary error'));
        await turns();
        assert.equal(f.outcome.state, 'pending');
        assert.equal(f.owner.snapshot().error, first);
        assert.equal(f.owner.snapshot().closed, false);
        f.writer.close();
        await turns();
        assert.equal(f.outcome.state, 'rejected');
        assert.equal(f.outcome.error, first);
        assert.equal(f.outcome.hashes, 0);
        assert.equal(f.outcome.passed, 0);
    } finally { await f.settle(); }
});

test('confirmed finish and close succeed once without retrying end or changing payload bytes', async () => {
    const f = fixture();
    const chunk = Buffer.from('synthetic payload');
    try {
        assert.equal(f.owner.write(chunk), true);
        const task = f.begin();
        assert.equal(f.owner.end('must not write twice'), task);
        f.writer.finish();
        f.writer.close();
        await turns();
        assert.deepEqual(f.outcome, { state: 'fulfilled', error: null, hashes: 1, passed: 1 });
        assert.equal(f.writer.endCalls.length, 1);
        assert.equal(f.writer.writes[0], chunk);
        assert.deepEqual(chunk, Buffer.from('synthetic payload'));
    } finally { await f.settle(); }
});

test('early error before end is retained without an early rejection or subsequent payload write', async () => {
    const f = fixture();
    const failure = Error('synthetic early error');
    try {
        assert.doesNotThrow(() => f.writer.emit('error', failure));
        await turns();
        assert.equal(f.owner.snapshot().failed, true);
        assert.equal(f.owner.write('must not write'), false);
        assert.equal(f.writer.writes.length, 0);
        f.begin();
        assert.deepEqual(f.writer.endCalls, [undefined]);
        f.writer.finish();
        f.writer.close();
        await turns();
        assert.equal(f.outcome.state, 'rejected');
        assert.equal(f.outcome.error, failure);
        assert.equal(f.outcome.hashes, 0);
    } finally { await f.settle(); }
});

test('close without finish rejects even after a successful end callback', async () => {
    const f = fixture();
    try {
        f.begin();
        const callback = f.writer.callback;
        f.writer.callback = null;
        callback();
        f.writer.close();
        await turns();
        assert.equal(f.outcome.state, 'rejected');
        assert.equal(f.outcome.error.message, 'Case log closed before finish.');
        assert.equal(f.owner.snapshot().finished, false);
        assert.equal(f.outcome.hashes, 0);
        assert.equal(f.outcome.passed, 0);
    } finally { await f.settle(); }
});

test('synchronous write exception remains original failure after normal owned closure', async () => {
    const failure = Error('synthetic write exception');
    const f = fixture({ writeError: failure });
    try {
        assert.equal(f.owner.write('start'), false);
        assert.equal(f.owner.snapshot().error, failure);
        f.begin();
        assert.deepEqual(f.writer.endCalls, [undefined]);
        f.writer.finish();
        f.writer.close();
        await turns();
        assert.equal(f.outcome.state, 'rejected');
        assert.equal(f.outcome.error, failure);
        assert.equal(f.outcome.hashes, 0);
    } finally { await f.settle(); }
});

test('synchronous end exception exposes failure while close is missing and rejects original after close', async () => {
    const failure = Error('synthetic end exception');
    const f = fixture({ endError: failure });
    try {
        assert.doesNotThrow(() => f.begin());
        await turns();
        assert.equal(f.outcome.state, 'pending');
        assert.equal(f.owner.snapshot().failed, true);
        assert.equal(f.owner.snapshot().closed, false);
        assert.equal(f.owner.snapshot().error, failure);
        f.writer.close();
        await turns();
        assert.equal(f.outcome.state, 'rejected');
        assert.equal(f.outcome.error, failure);
        assert.equal(f.writer.endCalls.length, 1);
        assert.equal(f.outcome.hashes, 0);
    } finally { await f.settle(); }
});

test('end callback failure is retained before close without becoming an unhandled rejection', async () => {
    const f = fixture();
    const failure = Error('synthetic callback failure');
    try {
        f.begin();
        f.writer.finish(failure);
        await turns();
        assert.equal(f.outcome.state, 'pending');
        f.writer.close();
        await turns();
        assert.equal(f.outcome.state, 'rejected');
        assert.equal(f.outcome.error, failure);
        assert.equal(f.outcome.passed, 0);
    } finally { await f.settle(); }
});

test('error and close before end retain original failure without another stream operation', async () => {
    const f = fixture();
    const failure = Error('synthetic early closed error');
    try {
        f.writer.emit('error', failure);
        f.writer.close();
        await turns();
        f.begin();
        await turns();
        assert.equal(f.outcome.state, 'rejected');
        assert.equal(f.outcome.error, failure);
        assert.equal(f.writer.endCalls.length, 0);
        assert.equal(f.outcome.hashes, 0);
    } finally { await f.settle(); }
});
