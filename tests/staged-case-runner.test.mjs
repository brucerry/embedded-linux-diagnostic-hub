import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createCaseLogLifecycle } from '../scripts/lib/case-log-lifecycle.mjs';

// Select the private function verbatim, never evaluate the runner's imports or mode dispatcher.
// The lexical wrapper supplies strict memory boundaries; this is not full-entry/native testing.
const moduleSource = readFileSync(path.resolve('scripts/staged-artifact-gate.mjs'), 'utf8');
const marker = 'async function runCase(';
const start = moduleSource.indexOf(marker);
const end = moduleSource.indexOf('\nasync function verifyProducers(', start);
assert(start >= 0 && end > start && start === moduleSource.lastIndexOf(marker));
const body = moduleSource.slice(start, end);
const instantiate = Function('dependencies', '"use strict";\n' +
    'const { assert, path, createWriteStream, createCaseLogLifecycle, spawn, repository, process, Date, hashFile } = dependencies;\n' +
    body + '\nreturn runCase;');

async function pumpUntil(predicate) {
    for (let i = 0; i < 32; i++) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert(predicate(), 'memory gate exceeded32microtask turns');
}
function fixture(mode) {
    const trace = [];
    const note = (event) => { assert(trace.length < 64); trace.push(event); };
    const operationError = Error('synthetic child admission/operation failure');
    class Writer extends EventEmitter {
        bytes = 0;
        endCalls = 0;
        finished = false;
        closed = false;
        callback = null;
        finalRecord = null;
        write(chunk) {
            assert.equal(this.closed, false);
            assert(typeof chunk === 'string' || Buffer.isBuffer(chunk));
            this.bytes += Buffer.byteLength(chunk);
            assert(this.bytes <= 4096);
            note('log-write');
            return true;
        }
        end(chunk, callback) {
            assert.equal(++this.endCalls, 1);
            if (chunk !== undefined) {
                this.write(chunk);
                this.finalRecord = JSON.parse(chunk);
            }
            this.callback = callback;
            note('log-end');
            return this;
        }
        finishAcknowledgement(error) {
            const callback = this.callback;
            this.callback = null;
            callback?.(error);
            if (!error) {
                assert.equal(this.finished, false);
                this.finished = true;
                note('log-finish');
                this.emit('finish');
            }
        }
        closeAcknowledgement() {
            assert.equal(this.closed, false);
            this.closed = true;
            note('log-close');
            this.emit('close');
        }
    }
    class Child extends EventEmitter {
        stdout = new EventEmitter();
        stderr = new EventEmitter();
        closed = false;
        closeAcknowledgement(code, signal) {
            assert.equal(this.closed, false);
            this.closed = true;
            note('child-close');
            this.emit('close', code, signal);
        }
    }
    class SyntheticDate {
        toISOString() { return '2026-10-30T00:00:00.000Z'; }
    }
    const writer = new Writer();
    const cases = [];
    const outcome = { state: 'pending', error: null };
    let owner = null;
    let child = null;
    let spawnCalls = 0;
    let hashCalls = 0;
    const runCase = instantiate({
        assert,
        path: path.posix,
        repository: '/synthetic/repository',
        process: { env: Object.freeze({ SYNTHETIC_BASE: 'memory-only' }) },
        Date: SyntheticDate,
        createCaseLogLifecycle(stream) {
            assert.equal(owner, null);
            assert.equal(stream, writer);
            owner = createCaseLogLifecycle(stream);
            return owner;
        },
        createWriteStream(file, options) {
            assert.equal(file, '/synthetic/evidence/cases/probe.log');
            assert.deepEqual(options, { flags: 'wx' });
            return writer;
        },
        spawn(executable, args, options) {
            assert.equal(++spawnCalls, 1);
            assert.equal(executable, 'synthetic-command');
            assert.deepEqual(args, ['--memory-only']);
            assert.deepEqual(options, {
                cwd: '/synthetic/repository',
                env: { SYNTHETIC_BASE: 'memory-only', SYNTHETIC_CASE: 'probe' },
                windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
            });
            if (mode === 'prehandle') {
                note('spawn-throw-before-return');
                throw operationError;
            }
            child = new Child();
            note('child-handle-returned');
            return child;
        },
        async hashFile(file, name) {
            hashCalls++;
            assert.equal(mode, 'normal', 'failed child must not create hashed success evidence');
            assert.equal(file, '/synthetic/evidence/cases/probe.log');
            assert.equal(name, 'cases/probe.log');
            assert.equal(writer.closed, true);
            assert.equal(writer.finished, true);
            note('hash');
            return { name, bytes: writer.bytes, sha256: 'c'.repeat(64) };
        },
    });
    const task = runCase('probe', ['synthetic-command', '--memory-only'],
        { SYNTHETIC_CASE: 'probe' }, '/synthetic/evidence/cases', '/synthetic/evidence', cases);
    task.then(
        () => { outcome.state = 'fulfilled'; note('fulfilled'); },
        (error) => { outcome.state = 'rejected'; outcome.error = error; note('rejected'); },
    );
    const settleMemoryEvents = async () => {
        if (child && !child.closed) child.closeAcknowledgement(0, null);
        await pumpUntil(() => writer.endCalls === 1 || outcome.state !== 'pending');
        if (!writer.closed) {
            if (writer.callback) writer.finishAcknowledgement();
            writer.closeAcknowledgement();
        }
        await pumpUntil(() => outcome.state !== 'pending');
    };
    return { writer, cases, outcome, operationError, trace, settleMemoryEvents,
        get owner() { return owner; }, get child() { return child; },
        get spawnCalls() { return spawnCalls; }, get hashCalls() { return hashCalls; } };
}

test('prehandle throw waits for log close and rethrows original without fabricated child result', async () => {
    const f = fixture('prehandle');
    try {
        await pumpUntil(() => f.writer.endCalls === 1);
        assert.equal(f.spawnCalls, 1);
        assert.equal(f.child, null);
        assert.equal(f.outcome.state, 'pending');
        assert.equal(f.hashCalls, 0);
        assert.equal(f.cases.length, 0);
        assert.equal(f.writer.finalRecord.spawnInvoked, true);
        assert.equal(f.writer.finalRecord.childHandleReturned, false);
        assert.equal(f.writer.finalRecord.childCloseObserved, false);
        assert.equal(Object.hasOwn(f.writer.finalRecord, 'code'), false);
        assert.equal(Object.hasOwn(f.writer.finalRecord, 'signal'), false);
        f.writer.finishAcknowledgement();
        await Promise.resolve();
        assert.equal(f.outcome.state, 'pending');
        f.writer.closeAcknowledgement();
        await pumpUntil(() => f.outcome.state !== 'pending');
        assert.equal(f.outcome.state, 'rejected');
        assert.equal(f.outcome.error, f.operationError);
        assert.equal(f.hashCalls, 0);
        assert.equal(f.cases.length, 0);
    } finally { await f.settleMemoryEvents(); }
});

test('primary spawn failure and log finalization failure retain both objects and primary cause', async () => {
    const f = fixture('prehandle');
    const logError = Error('synthetic log close failure');
    try {
        await pumpUntil(() => f.writer.endCalls === 1);
        f.writer.emit('error', logError);
        f.writer.finishAcknowledgement(logError);
        await Promise.resolve();
        assert.equal(f.outcome.state, 'pending');
        f.writer.closeAcknowledgement();
        await pumpUntil(() => f.outcome.state !== 'pending');
        assert.equal(f.outcome.state, 'rejected');
        assert(f.outcome.error instanceof AggregateError);
        assert.equal(f.outcome.error.cause, f.operationError);
        assert.equal(f.outcome.error.errors.length, 2);
        assert.equal(f.outcome.error.errors[0], f.operationError);
        assert.equal(f.outcome.error.errors[1], logError);
        assert(f.outcome.error.message.includes(f.operationError.message));
        assert.equal(f.hashCalls, 0);
        assert.equal(f.cases.length, 0);
    } finally { await f.settleMemoryEvents(); }
});

test('returned child error keeps closure pending and records only its observed failed result', async () => {
    const f = fixture('returned-error');
    try {
        assert(f.child);
        f.child.emit('error', f.operationError);
        await Promise.resolve();
        assert.equal(f.outcome.state, 'pending');
        assert.equal(f.writer.endCalls, 0);
        assert.equal(f.hashCalls, 0);
        f.child.closeAcknowledgement(7, null);
        await pumpUntil(() => f.writer.endCalls === 1);
        assert.equal(f.writer.finalRecord.childHandleReturned, true);
        assert.equal(f.writer.finalRecord.childCloseObserved, true);
        assert.equal(f.writer.finalRecord.code, 7);
        assert.equal(f.writer.finalRecord.signal, null);
        assert.equal(f.outcome.state, 'pending');
        f.writer.finishAcknowledgement();
        f.writer.closeAcknowledgement();
        await pumpUntil(() => f.outcome.state !== 'pending');
        assert.equal(f.outcome.state, 'rejected');
        assert.equal(f.outcome.error, f.operationError);
        assert.equal(f.hashCalls, 0);
        assert.equal(f.cases.length, 1);
        assert.equal(f.cases[0].status, 'failed');
        assert.equal(f.cases[0].exitCode, 7);
        assert.equal(f.cases[0].signal, null);
        assert.deepEqual(f.cases[0].evidence, []);
    } finally { await f.settleMemoryEvents(); }
});

test('normal caller control hashes and passes only after observed child and log closure', async () => {
    const f = fixture('normal');
    try {
        f.child.stdout.emit('data', Buffer.from('synthetic output\n'));
        assert.equal(f.writer.endCalls, 0);
        f.child.closeAcknowledgement(0, null);
        await pumpUntil(() => f.writer.endCalls === 1);
        f.writer.finishAcknowledgement();
        await Promise.resolve();
        assert.equal(f.outcome.state, 'pending');
        assert.equal(f.hashCalls, 0);
        f.writer.closeAcknowledgement();
        await pumpUntil(() => f.outcome.state !== 'pending');
        assert.equal(f.outcome.state, 'fulfilled');
        assert.equal(f.hashCalls, 1);
        assert.equal(f.cases.length, 1);
        assert.equal(f.cases[0].status, 'passed');
        assert.equal(f.cases[0].exitCode, 0);
        assert.equal(f.cases[0].signal, null);
        assert.equal(f.cases[0].evidence.length, 1);
        assert(f.trace.indexOf('child-close') < f.trace.indexOf('log-end'));
        assert(f.trace.indexOf('log-close') < f.trace.indexOf('hash'));
    } finally { await f.settleMemoryEvents(); }
});

test('actual caller wiring keeps finally ownership and observes close before further child setup', () => {
    assert(moduleSource.includes("import { createCaseLogLifecycle } from './lib/case-log-lifecycle.mjs';"));
    const observe = body.indexOf('const logLifecycle = createCaseLogLifecycle(stream);');
    const write = body.indexOf('logLifecycle.write(JSON.stringify({ command, startedAt:');
    const invoke = body.indexOf('spawnInvoked = true;');
    const returned = body.indexOf('childHandleReturned = true;');
    const closeObserver = body.indexOf("child.once('close', (code, signal) => {");
    const childData = body.indexOf("child.stdout.on('data', logChunk);");
    const finallyBlock = body.indexOf('} finally {');
    const join = body.indexOf('if (childHandleReturned) result = await childClosure;');
    const endLog = body.indexOf('await logLifecycle.end(finalRecord);');
    const failureGuard = body.indexOf('if (failures.length || !childCloseObserved || result.code !== 0 || result.signal !== null)');
    const hash = body.indexOf('const record = await hashFile(');
    const ordered = [observe, write, invoke, returned, closeObserver, childData, finallyBlock, join, endLog, failureGuard, hash];
    assert(ordered.every((at) => at >= 0));
    assert.deepEqual(ordered, ordered.toSorted((a, b) => a - b));
    assert(body.includes('...(childCloseObserved ? result : {})'));
    assert(body.includes('acknowledgeChildClose({ code, signal });'));
    assert(body.includes('16 * 1024 ** 2'));
    assert.equal(/\bstream\.(?:write|end|destroy|close)\(/.test(body), false);
});
