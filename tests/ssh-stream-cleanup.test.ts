import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Client, ClientChannel } from 'ssh2';
import { captureStreamingCommand } from '../backend/ssh/automation-stream';
import { SshStreamHost } from '../backend/ssh/stream-host';
import { SshStreamClient } from '../src/features/automation/capture/ssh-stream-client';

class Channel extends PassThrough {
    constructor() {
        super({ autoDestroy: false, emitClose: false });
    }
    stderr = new PassThrough({ autoDestroy: false, emitClose: false });
    closes = 0;
    close() {
        this.closes++;
        return this;
    }
}
class Connection extends EventEmitter {
    channel = new Channel();
    exec(_command: string, callback: (error: Error | null, channel: ClientChannel) => void) {
        callback(null, this.channel as unknown as ClientChannel);
    }
}
const tick = () => new Promise<void>((r) => setImmediate(r));
test('production cancellation cannot finish before pending sink work and actual owned channel close', async () => {
    const client = new Connection(),
        controller = new AbortController();
    let release!: () => void,
        entered = false,
        finished = false;
    const gate = new Promise<void>((r) => (release = r));
    const pending = captureStreamingCommand(
        client as unknown as Client,
        'fixture',
        1000,
        controller.signal,
        {
            append: async () => {
                entered = true;
                await gate;
            },
            rejectObservation: () => {},
        },
    ).then((value) => {
        finished = true;
        return value;
    });
    client.channel.write(Buffer.from('observed before cancel'));
    await tick();
    assert.equal(entered, true);
    controller.abort();
    await tick();
    assert.ok(client.channel.closes > 0);
    assert.equal(finished, false);
    client.channel.emit('close');
    await tick();
    assert.equal(finished, false, 'Close alone cannot skip pending persistence.');
    release();
    assert.equal((await pending).completion, 'cancelled');
    assert.equal(client.listenerCount('close'), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('production cancellation still owns an unacknowledged close after local IO has settled', async () => {
    const client = new Connection(),
        controller = new AbortController();
    let finished = false;
    const pending = captureStreamingCommand(
        client as unknown as Client,
        'fixture',
        1000,
        controller.signal,
        { append: async () => {}, rejectObservation: () => {} },
    ).then((value) => {
        finished = true;
        return value;
    });
    controller.abort();
    await tick();
    assert.equal(finished, false, 'Requesting close is not cleanup acknowledgement.');
    client.channel.emit('close');
    assert.equal((await pending).completion, 'cancelled');
});
test('fast production run/cancel teardown cycles return connection listeners and abort listeners to baseline', async (t) => {
    const baseline = process.memoryUsage(),
        resourceBaseline = process.getActiveResourcesInfo();
    for (let cycle = 0; cycle < 40; cycle++) {
        const client = new Connection(),
            controller = new AbortController();
        const before = client.listenerCount('close'),
            abortBefore = getEventListeners(controller.signal, 'abort').length;
        const pending = captureStreamingCommand(
            client as unknown as Client,
            'fixture',
            1000,
            controller.signal,
            { append: async () => {}, rejectObservation: () => {} },
        );
        client.channel.write(Buffer.alloc(16384, cycle));
        await tick();
        controller.abort();
        client.channel.emit('close');
        await pending;
        assert.equal(client.listenerCount('close'), before);
        assert.equal(getEventListeners(controller.signal, 'abort').length, abortBefore);
        assert.equal(client.channel.closes > 0, true);
        client.channel.destroy();
        client.channel.stderr.destroy();
    }
    await tick();
    const resourcesAfter = process.getActiveResourcesInfo();
    for (const kind of ['Timeout', 'TCPSocketWrap', 'TCPServerWrap'])
        assert.ok(
            resourcesAfter.filter((value) => value === kind).length <=
                resourceBaseline.filter((value) => value === kind).length,
            'Owned producer teardown left an additional referenced ' + kind,
        );
    t.diagnostic(
        JSON.stringify({
            scope: 'Fast deterministic producer lifecycle; no whole-app leak claim or memory budget yet',
            cycles: 40,
            before: baseline,
            after: process.memoryUsage(),
            resourceBaseline,
            resourcesAfter,
        }),
    );
});

test('timeout waits actual close and genuine signal/unknown close retain truthful status', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const client = new Connection(),
        controller = new AbortController();
    let finished = false;
    const pending = captureStreamingCommand(
        client as unknown as Client,
        'fixture',
        1000,
        controller.signal,
        { append: async () => {}, rejectObservation: () => {} },
    ).then((result) => {
        finished = true;
        return result;
    });
    t.mock.timers.tick(1000);
    await tick();
    assert.equal(finished, false);
    assert.ok(client.channel.closes > 0);
    client.channel.emit('close');
    assert.equal((await pending).completion, 'timeout');
    t.mock.timers.reset();
    for (const signal of [true, false]) {
        const connection = new Connection();
        const result = captureStreamingCommand(
            connection as unknown as Client,
            'fixture',
            1000,
            new AbortController().signal,
            { append: async () => {}, rejectObservation: () => {} },
        );
        connection.channel.end();
        connection.channel.stderr.end();
        await tick();
        if (signal) connection.channel.emit('exit', null, 'TERM', false, 'fixture signal');
        connection.channel.emit('close');
        const capture = await result;
        assert.equal(capture.completion, signal ? 'signalled' : 'uncertain-close');
        assert.equal(capture.exitCode, null);
        assert.equal(capture.termination?.signal, signal ? 'TERM' : undefined);
    }
});

test('queued stdout/stderr observations cannot reopen a stopped host sink or deadlock final cleanup', async () => {
    const connection = new Connection(),
        backendCancel = new AbortController(),
        cancel = new AbortController();
    let owned = false,
        release!: () => void,
        entered = false;
    const gate = new Promise<void>((r) => (release = r));
    const host = new SshStreamHost(
        async (request, sink, complete, finalized) => {
            owned = true;
            try {
                complete(
                    await captureStreamingCommand(
                        connection as unknown as Client,
                        request.command,
                        request.timeoutMs,
                        backendCancel.signal,
                        sink,
                    ),
                );
                await finalized;
            } finally {
                owned = false;
            }
        },
        () => backendCancel.abort(),
    );
    const client = new SshStreamClient((input) => host.dispatch(input), 'local-client');
    const pending = client.execute(
        {
            id: 'queued-producer-001',
            connection: 'queued-connection-01',
            command: 'fixture',
            timeoutMs: 1000,
        },
        {
            append: async () => {
                entered = true;
                await gate;
            },
            flush: async () => {},
            rejectObservation: () => {},
        },
        cancel.signal,
    );
    await tick();
    assert.ok(connection.channel.listenerCount('data') > 0);
    connection.channel.emit('data', Buffer.from('out'));
    connection.channel.stderr.emit('data', Buffer.from('err'));
    await tick();
    assert.equal(entered, true);
    cancel.abort();
    connection.channel.emit('close');
    await tick();
    assert.equal(owned, true);
    const final = client.finalize();
    release();
    assert.equal((await pending).completion, 'cancelled');
    await final;
    assert.equal(owned, false);
});
