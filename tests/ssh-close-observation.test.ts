import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Client, ServerChannel } from 'ssh2';
import { SshCloseObservation } from './fixtures/ssh-close-observation';
class Channel extends EventEmitter {
    requests = 0;
    close() {
        this.requests++;
        return this;
    }
}
test('client close does not manufacture the separate server acknowledgement', async () => {
    const trace = new SshCloseObservation(),
        server = new Channel(),
        channel = new Channel();
    const client = {
        exec(_command: string, callback: (error: undefined, value: Channel) => void) {
            callback(undefined, channel);
            return this;
        },
    } as unknown as Client;
    trace.server(server as unknown as ServerChannel);
    trace.client(client);
    client.exec('synthetic', () => {});
    channel.emit('close');
    assert.equal(trace.snapshot().serverPending, 1);
    assert.equal(await trace.waitServerClose(1), false);
    server.emit('close');
    assert.equal(await trace.waitServerClose(), true);
    trace.dispose();
});
test('owned close request and callback identity are preserved and restored', async () => {
    const trace = new SshCloseObservation(),
        channel = new Channel();
    const original = channel.close;
    trace.server(channel as unknown as ServerChannel);
    assert.equal(channel.close(), channel);
    assert.equal(channel.requests, 1);
    assert.equal(
        await trace.waitServerClose(1),
        false,
        'A close request is not an acknowledgement.',
    );
    channel.emit('close');
    trace.dispose();
    assert.equal(channel.close, original);
    assert.deepEqual(
        trace.snapshot().rows.map((row) => row.event),
        ['server-close-request', 'server-close'],
    );
});
test('trace rejects arbitrary data and fails closed on its fixed row cap', () => {
    const trace = new SshCloseObservation();
    assert.throws(() => trace.record('arbitrary output'));
    assert.throws(() => trace.record('checkpoint', { serverActive: -1 }));
    for (let i = 0; i < 129; i++) trace.record('checkpoint');
    assert.equal(trace.snapshot().rows.length, 128);
    assert.equal(trace.snapshot().overflow, true);
    assert.ok(JSON.stringify(trace.snapshot()).length <= 16384);
});
