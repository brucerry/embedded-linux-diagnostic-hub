import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import type { Client } from 'ssh2';
import { executeBounded } from '../backend/testing/executor';

function fakeExec(
    respond: (
        stream: PassThrough & { stderr: PassThrough; signal(name: string): void; close(): void },
    ) => void,
) {
    const stream = Object.assign(new PassThrough(), {
        stderr: new PassThrough(),
        signals: [] as string[],
        signal(name: string) {
            this.signals.push(name);
        },
        close(this: PassThrough) {
            this.emit('close', null);
        },
    });
    let calls = 0;
    const client = {
        exec(_command: string, callback: Function) {
            calls++;
            callback(null, stream);
            setImmediate(() => respond(stream));
        },
    } as unknown as Client;
    return { client, stream, calls: () => calls };
}
test('bounded executor preserves split UTF-8, caps evidence and sends TERM before channel cleanup', async () => {
    const utf8 = Buffer.from('裝置');
    const good = fakeExec((s) => {
        s.emit('data', utf8.subarray(0, 1));
        s.emit('data', utf8.subarray(1));
        s.stderr.emit('data', Buffer.from('note'));
        s.emit('close', 0);
    });
    const output = await executeBounded(good.client, 'fixed', undefined, 1, 64);
    assert.equal(output.stdout, '裝置');
    assert.equal(output.exitCode, 0);
    const excessive = fakeExec((s) => {
        s.emit('data', Buffer.alloc(200, 'a'));
        setImmediate(() => s.emit('close', 130));
    });
    const limited = await executeBounded(excessive.client, 'fixed', undefined, 1, 64);
    assert.equal(limited.stdout.length, 64);
    assert.equal(limited.truncated, true);
    assert.deepEqual(excessive.stream.signals, ['TERM']);
    const abort = new AbortController();
    abort.abort();
    const cancelled = fakeExec(() => {});
    const before = await executeBounded(cancelled.client, 'fixed', abort.signal, 1, 64);
    assert.equal(cancelled.calls(), 0);
    assert.equal(before.interrupted, true);
});
test('executor deadline returns incomplete evidence and closes a stalled remote channel', async () => {
    const stalled = fakeExec(() => {});
    const started = Date.now();
    const output = await executeBounded(stalled.client, 'fixed', undefined, 1, 64);
    assert.equal(output.exitCode, null);
    assert.equal(output.interrupted, true);
    assert.match(output.stderr, /unverified/);
    assert.ok(Date.now() - started < 6500);
});
