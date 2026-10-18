import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex, PassThrough } from 'node:stream';
import type { Client, ClientChannel } from 'ssh2';
import { OwnedSshClient, SshConnectionOwners } from '../backend/ssh/owned-client';
import { SshTerminal } from '../backend/ssh/terminal';
import { SshSession } from '../backend/ssh/session';
import type { NetworkCollector } from '../backend/ssh/network';
import { gatewayFixture } from './fixtures/gateway';

test(
    'session cleanup joins the actual collection promise after transport closure',
    { timeout: 10000 },
    async (t) => {
        const fixture = await gatewayFixture(),
            session = new SshSession();
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const atBoundary = new Promise<void>((resolve) => {
            entered = resolve;
        });
        t.after(async () => {
            release();
            session.disconnect();
            await session.joinAutomationCleanup();
            await fixture.close();
        });
        await session.connect(fixture.options, async (key) => key === fixture.pinned);
        const collector = (session as unknown as { network: NetworkCollector }).network;
        const original = collector.collect.bind(collector);
        let held = false;
        collector.collect = async (...args) => {
            const result = await original(...args);
            if (!held) {
                held = true;
                entered();
                await gate;
            }
            return result;
        };
        const collection = assert.rejects(session.collect(), /disconnected/);
        await atBoundary;
        session.disconnect();
        let joined = false;
        const joining = session.joinAutomationCleanup().then(() => {
            joined = true;
        });
        await turn();
        await turn();
        assert.equal(joined, false);
        assert.equal(session.hasResources, true);
        assert.equal(session.ownershipSnapshot.pendingOperations, 1);
        release();
        await collection;
        await joining;
        assert.equal(session.ownershipSnapshot.pendingOperations, 0);
        assert.equal(session.hasResources, false);
    },
);

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
class HeldChannel extends Duplex {
    stderr = new PassThrough({ autoDestroy: false, emitClose: false });
    accepted?: (error?: Error | null) => void;
    destroyedRequested = false;
    constructor() {
        super({ autoDestroy: false, emitClose: false });
    }
    _read() {}
    _write(_bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
        this.accepted = done;
    }
    override destroy() {
        this.destroyedRequested = true;
        return this;
    }
    remoteClose() {
        this.push(null);
        this.stderr.end();
        this.emit('close');
    }
}
test('transport close cannot release a pending late channel callback or its actual channel', async () => {
    const owners = new SshConnectionOwners();
    let callback!: (...values: unknown[]) => void,
        joined = false;
    const channel = new HeldChannel();
    owners.open(
        (opened) => {
            callback = opened;
            return {} as Client;
        },
        () => {},
    );
    const join = owners.join().then(() => {
        joined = true;
    });
    owners.transportDidClose();
    await turn();
    assert.equal(joined, false);
    assert.equal(owners.snapshot.opening, 1);
    callback(undefined, channel);
    await turn();
    assert.equal(joined, false);
    assert.equal(owners.snapshot.channels, 1);
    channel.remoteClose();
    await join;
    assert.deepEqual(owners.snapshot, {
        transport: 0,
        channels: 0,
        opening: 0,
        cleanup: 0,
        unknownStart: 0,
    });
    assert.throws(
        () =>
            owners.open(
                () => ({}) as Client,
                () => {},
            ),
        /closed|unverified/,
    );
});
test('unverified failed start rejects an already waiting join and never reports closed ownership', async () => {
    const owners = new SshConnectionOwners();
    const waiting = assert.rejects(owners.join(), /unknown transport/);
    owners.startIsUnverified(Error('unknown transport'));
    owners.transportDidClose();
    await waiting;
    assert.equal(owners.snapshot.cleanup, 1);
    assert.equal(owners.snapshot.unknownStart, 1);
    await assert.rejects(owners.join(), /unknown transport/);
});
test('actual ssh2 synchronous invalid-key start creates no socket and the owned client cannot be reused', async () => {
    const client = new OwnedSshClient();
    assert.throws(() =>
        client.connect({ host: '127.0.0.1', username: 'synthetic', privateKey: 'invalid key' }),
    );
    await client.owners.join();
    assert.equal(client.owners.snapshot.transport, 0);
    assert.throws(() => client.connect({ host: '127.0.0.1' }), /already been started/);
});
test('manual terminal join retains accepted write callbacks after public close and actual channel close', async () => {
    const channel = new HeldChannel();
    const client = {
        shell(_size: unknown, opened: (error: undefined, channel: ClientChannel) => void) {
            opened(undefined, channel as unknown as ClientChannel);
        },
    } as unknown as Client;
    const terminal = new SshTerminal(
        { id: 'terminal-owned-0001', cols: 80, rows: 24 },
        () => {},
        () => {},
    );
    await terminal.open(client, { cols: 80, rows: 24 });
    const write = assert.rejects(
        terminal.write(Buffer.from('fixture\r').toString('base64')),
        /could not be delivered/,
    );
    let joined = false;
    const join = terminal.join().then(() => {
        joined = true;
    });
    terminal.close();
    await write;
    assert.equal(channel.destroyedRequested, true);
    assert.equal(terminal.hasPendingInput, true);
    assert.equal(terminal.ownershipSnapshot.writeCallbacks, 1);
    channel.remoteClose();
    await turn();
    assert.equal(joined, false);
    channel.accepted!();
    await join;
    assert.equal(terminal.hasPendingInput, false);
    assert.deepEqual(terminal.ownershipSnapshot, {
        opening: 0,
        channel: 0,
        writeCallbacks: 0,
        inputBytes: 0,
        pendingAcks: 0,
        pendingAckBytes: 0,
        timers: 0,
        listeners: 0,
        closing: 0,
        cleanupClosed: true,
    });
});
test('terminal cancelled before shell callback retains the late channel until its actual close', async () => {
    const channel = new HeldChannel();
    let opened!: (error: undefined, channel: ClientChannel) => void;
    const client = {
        shell(_size: unknown, callback: typeof opened) {
            opened = callback;
        },
    } as unknown as Client;
    const terminal = new SshTerminal(
        { id: 'terminal-owned-0002', cols: 80, rows: 24 },
        () => {},
        () => {},
    );
    const opening = assert.rejects(
        terminal.open(client, { cols: 80, rows: 24 }),
        /closed before opening/,
    );
    terminal.close();
    await opening;
    let joined = false;
    const join = terminal.join().then(() => {
        joined = true;
    });
    await turn();
    assert.equal(joined, false);
    assert.equal(terminal.ownershipSnapshot.opening, 1);
    opened(undefined, channel as unknown as ClientChannel);
    await turn();
    assert.equal(joined, false);
    assert.equal(channel.destroyedRequested, true);
    channel.remoteClose();
    await join;
    assert.equal(terminal.ownershipSnapshot.listeners, 0);
    assert.equal(terminal.ownershipSnapshot.cleanupClosed, true);
});
