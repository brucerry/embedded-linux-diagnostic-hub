import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { PassThrough } from 'node:stream';
import { Client as TransportClient, type ClientChannel } from 'ssh2';
import { SshSession } from '../../backend/ssh/session';
import { OwnedSshClient } from '../../backend/ssh/owned-client';
import { CLOCK_TIMEOUT_MS } from '../../shared/diagnostics/device-clock';
import type { ProbeResult } from '../../shared/types';
import { Client, observe, turns, until } from './ssh-memory-client';

// The committed wrapper must resolve every SSH2 import to the same memory client.
assert.equal(Object.is(TransportClient, Client), true, 'The scoped memory loader is required.');
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
class Channel extends PassThrough {
    stderr = new PassThrough({ autoDestroy: false, emitClose: false });
    closeRequests = 0;
    acknowledged = false;
    constructor() {
        super({ autoDestroy: false, emitClose: false });
        this.end('late stdout retained only in this fake readable');
        this.stderr.end('late stderr retained only in this fake readable');
    }
    close() {
        assert.ok(++this.closeRequests <= 4);
        return this;
    }
    acknowledgeClose() {
        if (this.acknowledged) return;
        this.acknowledged = true;
        this.emit('close');
    }
}
async function fixture(
    t: TestContext,
    body: (f: {
        session: SshSession;
        client: OwnedSshClient;
        channel: Channel;
        deliver(): void;
    }) => Promise<void>,
) {
    assert.equal(Client.instances.length, 0);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const channel = new Channel(),
        session = new SshSession();
    let callback: ((error: Error | null, stream: ClientChannel) => void) | undefined,
        delivered = false;
    const target = Client.prototype as unknown as {
        exec(command: string, done: (error: Error | null, stream: ClientChannel) => void): Client;
    };
    t.mock.method(
        target,
        'exec',
        function (
            this: Client,
            _command: string,
            done: (error: Error | null, stream: ClientChannel) => void,
        ) {
            assert.equal(callback, undefined, 'Only one synthetic exec may be admitted.');
            callback = done;
            return this;
        },
    );
    const deliver = () => {
        assert.ok(callback);
        assert.equal(delivered, false);
        delivered = true;
        callback(null, channel as unknown as ClientChannel);
    };
    try {
        const connecting = session.connect(
            { host: 'synthetic.invalid', port: 22, username: 'synthetic', auth: 'password' },
            async () => {
                throw Error('No host verification should run on the fake transport.');
            },
        );
        assert.equal(Client.instances.length, 1);
        const client = Client.instances[0] as unknown as OwnedSshClient;
        Client.instances[0].ready();
        await connecting;
        await body({ session, client, channel, deliver });
    } finally {
        // Only fake resources: also retire them when the pre-fix negative control fails.
        session.disconnect();
        for (const client of Client.instances) client.closeOwned();
        if (callback && !delivered) deliver();
        channel.resume();
        channel.stderr.resume();
        await turn();
        channel.acknowledgeClose();
        await session.joinAutomationCleanup();
        assert.equal(session.hasResources, false);
        Client.instances.forEach((client) => client.removeAllListeners());
        Client.instances.length = 0;
        t.mock.timers.reset();
    }
}
async function pendingRetirement(session: SshSession, client: OwnedSshClient) {
    session.disconnect();
    (client as unknown as Client).closeOwned();
    const joining = observe(session.joinAutomationCleanup());
    await turns();
    assert.equal(joining.done, false, 'Transport closure cannot skip the pending exec callback.');
    assert.equal(client.owners.snapshot.opening, 1);
    return joining;
}
async function acknowledge(
    session: SshSession,
    client: OwnedSshClient,
    channel: Channel,
    joining: ReturnType<typeof observe<void>>,
) {
    assert.ok(channel.closeRequests >= 1, 'Late channel close must be requested.');
    await turn();
    assert.equal(channel.readableEnded, true, 'Late stdout must be drained to readable end.');
    assert.equal(
        channel.stderr.readableEnded,
        true,
        'Late stderr must be drained to readable end.',
    );
    assert.equal(client.owners.snapshot.opening, 0);
    assert.equal(client.owners.snapshot.channels, 1);
    assert.equal(joining.done, false, 'Draining is not actual channel-close acknowledgement.');
    assert.doesNotThrow(() => channel.emit('error', Error('Synthetic late stdout failure')));
    assert.doesNotThrow(() => channel.stderr.emit('error', Error('Synthetic late stderr failure')));
    await turns();
    assert.equal(joining.done, false, 'Late errors cannot manufacture retirement.');
    channel.acknowledgeClose();
    await until(() => joining.done, 'actual channel close releases its original owner');
    assert.equal(joining.error, undefined);
    assert.equal(client.owners.snapshot.cleanup, 0);
    assert.equal(session.hasResources, false);
}

for (const reason of ['abort', 'timeout'] as const)
    test(`late clock callback after ${reason} drains both sides and waits actual close`, async (t) => {
        await fixture(t, async ({ session, client, channel, deliver }) => {
            const controller = new AbortController(),
                operation = observe(session.readClock(controller.signal));
            await until(() => client.owners.snapshot.opening === 1, 'clock exec admitted');
            if (reason === 'abort') controller.abort();
            else t.mock.timers.tick(CLOCK_TIMEOUT_MS + 1);
            await until(() => operation.done, 'clock operation outcome settled');
            assert.equal(operation.error, undefined);
            assert.deepEqual(operation.value, { status: 'unavailable', reason: 'failed' });
            const original = structuredClone(operation.value),
                joining = await pendingRetirement(session, client);
            deliver();
            await acknowledge(session, client, channel, joining);
            assert.deepEqual(
                operation.value,
                original,
                'Late data/errors cannot replace the outcome.',
            );
        });
    });

test('late collection callback after timeout drains both sides without acknowledging close early', async (t) => {
    await fixture(t, async ({ session, client, channel, deliver }) => {
        // Exercise the actual low-level collection executor with its original OwnedSshClient.
        const execute = Reflect.get(session, 'executeOwned') as (
            client: OwnedSshClient,
            id: string,
            command: string,
            timeoutMs: number,
            maxBytes: number,
        ) => Promise<ProbeResult>;
        const operation = observe(execute.call(session, client, 'cpu', 'synthetic only', 50, 8192));
        await until(() => client.owners.snapshot.opening === 1, 'collection exec admitted');
        t.mock.timers.tick(51);
        await until(() => operation.done, 'collection timeout settled');
        assert.equal(operation.error, undefined);
        assert.equal(operation.value?.status, 'error');
        assert.equal(operation.value?.exitCode, null);
        assert.match(operation.value!.stderr, /Command timed out/);
        const original = structuredClone(operation.value),
            joining = await pendingRetirement(session, client);
        deliver();
        await acknowledge(session, client, channel, joining);
        assert.deepEqual(
            operation.value,
            original,
            'Late data/errors cannot replace the timeout diagnostic.',
        );
    });
});

test('late cancelled clock callback drains and retires only its channel while SSH remains open', async (t) => {
    await fixture(t, async ({ session, client, channel, deliver }) => {
        const controller = new AbortController(),
            operation = observe(session.readClock(controller.signal));
        await until(() => client.owners.snapshot.opening === 1, 'clock exec admitted');
        controller.abort();
        await until(() => operation.done, 'clock cancellation outcome settled');
        assert.equal(operation.error, undefined);
        assert.deepEqual(operation.value, { status: 'unavailable', reason: 'failed' });
        const original = structuredClone(operation.value),
            connectionJoin = observe(client.owners.join());
        assert.equal(session.isConnected, true);
        assert.equal((client as unknown as Client).destroyCalls, 0);
        deliver();
        await turn();
        assert.ok(channel.closeRequests >= 1);
        assert.equal(channel.readableEnded, true);
        assert.equal(channel.stderr.readableEnded, true);
        assert.equal(client.owners.snapshot.opening, 0);
        assert.equal(client.owners.snapshot.channels, 1);
        assert.equal(client.owners.snapshot.transport, 1);
        assert.equal(connectionJoin.done, false);
        assert.equal(session.isConnected, true);
        assert.doesNotThrow(() => channel.emit('error', Error('Late cancelled clock failure')));
        assert.doesNotThrow(() =>
            channel.stderr.emit('error', Error('Late cancelled stderr failure')),
        );
        await turns();
        assert.equal(
            client.owners.snapshot.channels,
            1,
            'Errors cannot acknowledge channel close.',
        );
        assert.equal(session.isConnected, true);
        channel.acknowledgeClose();
        await turns();
        assert.equal(client.owners.snapshot.channels, 0);
        assert.equal(client.owners.snapshot.transport, 1);
        assert.equal(client.owners.snapshot.cleanup, 1, 'The healthy connection remains owned.');
        assert.equal(connectionJoin.done, false);
        assert.equal(session.isConnected, true);
        assert.equal((client as unknown as Client).destroyCalls, 0);
        assert.deepEqual(operation.value, original);
    });
});
