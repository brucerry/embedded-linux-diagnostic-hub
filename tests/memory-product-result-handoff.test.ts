import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
    announceResult,
    verifyResultAnnouncement,
    sendResultAndAwaitAck,
} from './fixtures/memory-product-result-handoff';

const source = 'a'.repeat(64),
    bytes = JSON.stringify({ sourceSHA256: source, retainedEvidence: 'x'.repeat(200000) });
const announcement = announceResult(bytes, source);
const ack = { kind: 'result-ack', schema: 1, resultSHA256: announcement.resultSHA256 };
function model() {
    const events = new EventEmitter();
    const foreign = () => {};
    for (const event of ['message', 'disconnect', 'close', 'error']) events.on(event, foreign);
    let callback!: (error: Error | null) => void,
        sends = 0;
    const channel = {
        events,
        connected: () => true,
        send: (message: unknown, done: typeof callback) => {
            sends++;
            assert.equal(message, announcement);
            callback = done;
        },
    };
    return {
        events,
        channel,
        sends: () => sends,
        callback: (error: Error | null = null) => callback(error),
        clean: () => {
            for (const event of ['message', 'disconnect', 'close', 'error'])
                assert.deepEqual(events.listeners(event), [foreign]);
        },
    };
}
async function pending(promise: Promise<unknown>) {
    let settled = false;
    void promise.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
}
test('exact persisted bytes and source are required; the announcement stays small', () => {
    assert.ok(Buffer.byteLength(JSON.stringify(announcement)) < 256);
    assert.deepEqual(verifyResultAnnouncement(announcement, bytes, source), JSON.parse(bytes));
    assert.throws(
        () => verifyResultAnnouncement(announcement, bytes + '\n', source),
        /identity mismatch/,
    );
    assert.throws(
        () => verifyResultAnnouncement(announcement, bytes, 'b'.repeat(64)),
        /identity mismatch/,
    );
    assert.throws(
        () => verifyResultAnnouncement({ ...announcement, receipt: {} }, bytes, source),
        /identity mismatch/,
    );
    const wrongSourceBytes = JSON.stringify({ sourceSHA256: 'b'.repeat(64) });
    assert.throws(() =>
        verifyResultAnnouncement(
            announceResult(wrongSourceBytes, source),
            wrongSourceBytes,
            source,
        ),
    );
});
for (const acknowledgementFirst of [false, true])
    test(`delivery joins callback and exact ack in either order: ackFirst=${acknowledgementFirst}`, async () => {
        const m = model(),
            result = sendResultAndAwaitAck(m.channel, announcement);
        if (acknowledgementFirst) m.events.emit('message', ack);
        else m.callback();
        await pending(result);
        m.events.emit('message', { kind: 'unrelated' });
        if (acknowledgementFirst) m.callback();
        else m.events.emit('message', ack);
        assert.deepEqual(await result, {
            sendCallbackObserved: true,
            matchingAcknowledgementObserved: true,
        });
        m.clean();
    });
for (const event of ['disconnect', 'close', 'error'])
    test(`${event} before acknowledgement rejects and cleans only owned listeners`, async () => {
        const m = model(),
            result = sendResultAndAwaitAck(m.channel, announcement);
        const rejected = assert.rejects(result, /interrupted|disconnected|closed/);
        m.callback();
        m.events.emit(event, Error('interrupted channel'));
        await rejected;
        m.events.emit('message', ack);
        m.callback(); // Late activity cannot manufacture success.
        m.clean();
    });
test('mismatched acknowledgement rejects even after the send callback', async () => {
    const m = model(),
        result = sendResultAndAwaitAck(m.channel, announcement);
    const rejected = assert.rejects(result);
    m.callback();
    m.events.emit('message', { ...ack, resultSHA256: 'b'.repeat(64) });
    await rejected;
    m.clean();
});
for (const mode of ['callback', 'throw'])
    test(`send ${mode} failure rejects and removes owned subscriptions`, async () => {
        const m = model(),
            failure = Error('send rejected');
        if (mode === 'throw')
            m.channel.send = () => {
                throw failure;
            };
        const result = sendResultAndAwaitAck(m.channel, announcement);
        const rejected = assert.rejects(result, (error) => error === failure);
        if (mode === 'callback') {
            m.events.emit('message', ack);
            m.callback(failure);
        }
        await rejected;
        m.clean();
    });
for (const missing of ['ack', 'callback'])
    test(`the existing 10000 ms bound refuses missing ${missing}`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const m = model(),
            result = sendResultAndAwaitAck(m.channel, announcement);
        const rejected = assert.rejects(result, /exceeded10000ms/);
        if (missing === 'ack') m.callback();
        else m.events.emit('message', ack);
        t.mock.timers.tick(9999);
        await pending(result);
        t.mock.timers.tick(1);
        await rejected;
        m.callback();
        m.events.emit('message', ack);
        m.clean();
    });
for (const before of [false, true])
    test(`abort ${before ? 'before admission' : 'while awaiting receipt'} remains failure`, async () => {
        const m = model(),
            controller = new AbortController(),
            failure = Error('Explicit interruption');
        if (before) controller.abort(failure);
        const result = sendResultAndAwaitAck(m.channel, announcement, {
            signal: controller.signal,
        });
        const rejected = assert.rejects(result, (error) => error === failure);
        if (!before) {
            m.callback();
            controller.abort(failure);
        }
        await rejected;
        assert.equal(m.sends(), Number(!before));
        m.clean();
    });
test('already disconnected IPC never sends a receipt', async () => {
    const m = model();
    m.channel.connected = () => false;
    await assert.rejects(sendResultAndAwaitAck(m.channel, announcement), /disconnected/);
    assert.equal(m.sends(), 0);
    m.clean();
});

// Real Node IPC controls only. No browser, native worker, gateway or product qualification.
for (const mode of ['delivered', 'file-mutated', 'interrupted'])
    test(`real process receipt and normal closure: ${mode}`, async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-result-handoff-'));
        const entry = path.join(directory, 'sender.mjs'),
            receiptPath = path.join(directory, 'result.json');
        const helper = new URL('./fixtures/memory-product-result-handoff.ts', import.meta.url).href;
        await fs.writeFile(
            entry,
            `import fs from 'node:fs/promises';
import { announceResult, sendResultAndAwaitAck } from ${JSON.stringify(helper)};
const bytes = ${JSON.stringify(bytes)};
const controller = new AbortController();
const interrupt = value => { if(value?.kind==='control-interrupt')controller.abort(Error('Control interruption')); };
process.on('message',interrupt);
await fs.writeFile(${JSON.stringify(receiptPath)}, bytes, { flag: 'wx' });
try {
 const joined = await sendResultAndAwaitAck({events:process, connected:()=>process.connected, send:(message,callback)=>process.send(message,callback)}, announceResult(bytes, ${JSON.stringify(source)}), {signal:controller.signal});
 await fs.writeFile(${JSON.stringify(path.join(directory, 'delivery.json'))}, JSON.stringify(joined), {flag:'wx'});
} catch (error) {
 await fs.writeFile(${JSON.stringify(path.join(directory, 'failure.txt'))}, String(error), {flag:'wx'}); process.exitCode=1;
} finally { process.removeListener('message',interrupt); if(process.connected)process.disconnect(); }
`,
        );
        const child = spawn(
            process.execPath,
            [
                '--import',
                new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href,
                entry,
            ],
            { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
        );
        let code: number | null = null,
            signal: NodeJS.Signals | null = null,
            exited = false,
            disconnected = false,
            acknowledgementSent = false,
            stderr = '',
            receiverFailure: unknown;
        child.stdout!.resume();
        child.stderr!.setEncoding('utf8');
        child.stderr!.on('data', (text) => (stderr += text));
        const messages: Promise<void>[] = [];
        const events: { event: string; at: number; value?: unknown }[] = [];
        for (const event of ['exit', 'close', 'disconnect', 'error'])
            child.on(event, (value) => {
                events.push({ event, at: performance.now(), value });
            });
        child.on('message', (message) => {
            const task = (async () => {
                if (mode === 'interrupted') {
                    await new Promise<void>((resolve, reject) =>
                        child.send({ kind: 'control-interrupt' }, (error) =>
                            error ? reject(error) : resolve(),
                        ),
                    );
                    return;
                }
                if (mode === 'file-mutated') await fs.appendFile(receiptPath, '\n');
                try {
                    verifyResultAnnouncement(
                        message,
                        await fs.readFile(receiptPath, 'utf8'),
                        source,
                    );
                } catch (error) {
                    receiverFailure = error;
                    await new Promise<void>((resolve, reject) =>
                        child.send({ kind: 'control-interrupt' }, (error) =>
                            error ? reject(error) : resolve(),
                        ),
                    );
                    return;
                }
                await new Promise<void>((resolve, reject) =>
                    child.send(ack, (error) => (error ? reject(error) : resolve())),
                );
                acknowledgementSent = true;
            })();
            void task.catch(() => {});
            messages.push(task);
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                void fs.writeFile(
                    path.join(directory, 'timeout-observation.json'),
                    JSON.stringify(
                        { events, code, signal, exited, disconnected, acknowledgementSent, stderr },
                        null,
                        2,
                    ),
                );
                reject(Error(`Real IPC control join expired; retain ${directory}`));
            }, 15000);
            child.once('error', reject);
            child.once('disconnect', () => {
                disconnected = true;
            });
            child.once('exit', (value, observedSignal) => {
                code = value;
                signal = observedSignal;
                exited = true;
            });
            child.once('close', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        await Promise.all(messages);
        assert.equal(exited && disconnected, true);
        assert.equal(signal, null);
        assert.equal(stderr, '');
        assert.equal(code, mode === 'delivered' ? 0 : 1);
        assert.equal(acknowledgementSent, mode === 'delivered');
        assert.equal(Boolean(receiverFailure), mode === 'file-mutated');
        if (mode === 'delivered')
            assert.deepEqual(
                JSON.parse(await fs.readFile(path.join(directory, 'delivery.json'), 'utf8')),
                { sendCallbackObserved: true, matchingAcknowledgementObserved: true },
            );
        else {
            await assert.rejects(fs.stat(path.join(directory, 'delivery.json')), {
                code: 'ENOENT',
            });
            assert.match(
                await fs.readFile(path.join(directory, 'failure.txt'), 'utf8'),
                /Control interruption/,
            );
        }
        await fs.rm(directory, { recursive: true }); // Only after real exit and close.
    });
