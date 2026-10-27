import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import type { ClientChannel } from 'ssh2';
import { SshConsoleHost } from '../backend/ssh/console-host';
import { PersistentSshConsole } from '../backend/ssh/persistent-console';
import { SshSession } from '../backend/ssh/session';
import { NativeConsoleJournal } from '../electron/console-journal';
import { SshConsoleClient } from '../src/features/automation/capture/ssh-console-client';
import type { ConsoleOwner, ConsoleRpc } from '../shared/console-rpc';
import { FlowRunner, type FlowState } from '../src/features/automation/runner';
import { sshConsoleBackend } from '../src/features/automation/capture/console-backend';
import type { AutomationPlan } from '../shared/automation';
import { consoleFixture } from './fixtures/ssh-console';
import { gatewayFixture } from './fixtures/gateway';

async function until(check: () => boolean) {
    const end = performance.now() + 2500;
    while (!check()) {
        assert.ok(performance.now() < end, 'Expected actual cleanup boundary.');
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}
class Channel extends Duplex {
    stderr = new PassThrough({ autoDestroy: false, emitClose: false });
    writes = 0;
    closeRequested = false;
    constructor() {
        super({ autoDestroy: false, emitClose: false });
    }
    _read() {}
    _write(_bytes: Buffer, _encoding: BufferEncoding, done: () => void) {
        this.writes++;
        done();
    }
    close() {
        if (!this.closeRequested) {
            this.closeRequested = true;
            setImmediate(() => {
                this.push(null);
                this.stderr.end();
                this.emit('close');
            });
        }
        return this;
    }
}

test('actual retired receipt fails and closes the journal without an explicit client close', async (t) => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-retired-receipt-'));
    const journal = await NativeConsoleJournal.open(profile, { profileOwned: true });
    const channel = new Channel();
    const connection = 'actual-receipt-connection-01',
        flow = 'actual-receipt-flow-01';
    const ready = { role: 'shell-prompt' as const, literals: ['fixture# '] };
    let owned = false,
        owner!: ConsoleOwner,
        retireNextRead = false;
    let terminalReply: Record<string, unknown> | undefined;
    const session = {
        automationConnection: connection,
        createAutomationConsole(store, _connection, fresh, proof) {
            const actor = new PersistentSshConsole(
                {
                    acquire() {
                        assert.equal(owned, false);
                        owned = true;
                        return () => {
                            owned = false;
                        };
                    },
                    assertCurrent() {},
                    assertFresh: fresh,
                    open(callback) {
                        callback(undefined, channel as unknown as ClientChannel);
                        channel.push(Buffer.from(ready.literals[0]));
                    },
                },
                store,
                50,
                proof,
            );
            return {
                actor,
                signal: new AbortController().signal,
                target: { endpoint: 'synthetic local channel', username: 'synthetic' },
            };
        },
    } satisfies Pick<SshSession, 'automationConnection' | 'createAutomationConsole'>;
    const host = new SshConsoleHost(session as SshSession);
    const rpc: ConsoleRpc = async (request) => {
        if (request.action === 'read' && retireNextRead) {
            retireNextRead = false;
            host.transportLost(owner);
            await until(() => host.snapshot === null);
            terminalReply = (await host.dispatch(request, 'gateway')) as Record<string, unknown>;
            return terminalReply;
        }
        const reply = (await host.dispatch(request, 'gateway')) as Record<string, unknown>;
        if (request.action === 'open') owner = reply as unknown as ConsoleOwner;
        if (request.action === 'read' && reply.type === 'state' && reply.phase === 'ready')
            retireNextRead = true;
        return reply;
    };
    const client = new SshConsoleClient(rpc, 'gateway', journal);
    t.after(async () => {
        await client.close().catch(() => {});
        await host.shutdown();
        await journal.close();
        channel.destroy();
        channel.stderr.destroy();
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('hub-retired-receipt-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    await client.open(connection, flow, ready, 2000, () => {});
    await until(() => client.resourceSnapshot.pump === false);
    assert.equal(terminalReply?.phase, 'closed');
    assert.equal(
        (terminalReply?.cleanup as { journalClosure: string }).journalClosure,
        'unacknowledged',
    );
    assert.equal(owned, false);
    assert.equal(host.ownershipSnapshot.activeStates, 0);
    assert.equal(journal.resourceClosed, true);
    assert.equal(journal.snapshot!.state, 'incomplete');
    assert.equal(journal.snapshot!.observedBytes, null);
    assert.equal(journal.snapshot!.bytes, 9);
    assert.equal(channel.writes, 0);
    assert.equal(client.resourceSnapshot.localCleanupClosed, true);
    assert.equal(client.resourceSnapshot.journalClosure, 'unacknowledged');
    assert.equal(client.resourceSnapshot.requests, 0);
    assert.equal(client.resourceSnapshot.heartbeatTimers, 0);
    await assert.rejects(client.close(), /lost|unacknowledged/i);
    await assert.rejects(
        client.step({} as never, 1000, () => {}),
        /not ready/,
    );
});

for (const terminal of [
    { phase: 'closed', error: 'Unacknowledged terminal receipt.', closure: 'unacknowledged' },
    { phase: 'cleanup-pending', error: 'Cleanup remains pending.', closure: 'pending' },
    { phase: 'closed', error: 'Acknowledged failed flow.', closure: 'acknowledged' },
    { phase: 'closed', error: null, closure: 'acknowledged' },
])
    test(`gateway ${terminal.phase}/${terminal.closure}/${terminal.error ?? 'open journal'} never leaves an active local journal`, async (t) => {
        const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-terminal-receipt-'));
        const journal = await NativeConsoleJournal.open(profile, { profileOwned: true });
        const owner = {
            id: 'retired-flow-000001',
            connection: 'retired-connection-01',
            capability: 'a'.repeat(64),
        };
        const ready = { role: 'shell-prompt' as const, literals: ['fixture# '] };
        await journal.begin({
            flowId: owner.id,
            startedAt: new Date().toISOString(),
            receiveTimeSource: 'gateway',
            target: { endpoint: 'synthetic receipt' },
            ready,
        });
        let release!: () => void,
            reads = 0;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const rpc: ConsoleRpc = async (request) => {
            if (request.action === 'capabilities')
                return {
                    protocol: 1,
                    persistentConsole: 1,
                    independentStream: 1,
                    epoch: 'b'.repeat(32),
                    receiveTimeSource: 'gateway',
                    journal: 'browser-v2',
                    heartbeat: { intervalMs: 500, stallMs: 2500 },
                };
            if (request.action === 'open') return { protocol: 1, ...owner };
            if (request.action === 'read') {
                if (++reads === 1)
                    return {
                        protocol: 1,
                        type: 'state',
                        id: owner.id,
                        revision: 1,
                        phase: 'ready',
                        error: null,
                        snapshot: journal.snapshot,
                        ownerHeld: true,
                        cleanup: { storageAdapterClosed: false, journalClosure: 'pending' },
                    };
                await gate;
                return {
                    protocol: 1,
                    type: 'state',
                    id: owner.id,
                    revision: 2,
                    phase: terminal.phase,
                    error: terminal.error,
                    snapshot: journal.snapshot,
                    ownerHeld: false,
                    cleanup: { storageAdapterClosed: true, journalClosure: terminal.closure },
                };
            }
            if (request.action === 'heartbeat') return { ok: true };
            throw Error('Failure cleanup must not need a later finish/release RPC.');
        };
        const client = new SshConsoleClient(rpc, 'gateway', journal);
        t.after(async () => {
            release();
            await client.close().catch(() => {});
            await journal.close();
            assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
            assert.ok(path.basename(profile).startsWith('hub-terminal-receipt-'));
            await fs.rm(profile, { recursive: true, force: true });
        });
        await client.open(owner.connection, owner.id, ready, 1000, () => {});
        release();
        await until(() => !client.resourceSnapshot.pump);
        assert.equal(journal.resourceClosed, true);
        assert.equal(journal.snapshot!.state, 'incomplete');
        assert.equal(journal.snapshot!.observedBytes, null);
        assert.equal(client.resourceSnapshot.localCleanupClosed, true);
        assert.equal(client.resourceSnapshot.journalClosure, 'unacknowledged');
        await assert.rejects(client.close());
    });

test(
    'an actual gateway console loss stops the existing runner during a 600-second repeat delay',
    { timeout: 8000 },
    async (t) => {
        const model = consoleFixture(),
            server = await gatewayFixture(undefined, model),
            session = new SshSession();
        const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-receipt-flow-'));
        const journal = await NativeConsoleJournal.open(profile, { profileOwned: true });
        let owner!: ConsoleOwner,
            lossStarted = false,
            settled = false;
        const states: FlowState[] = [];
        const runner = new FlowRunner(
            (state) => {
                states.push(state);
                if (state.state === 'waiting' && !lossStarted) {
                    lossStarted = true;
                    setImmediate(() => session.consoleTransportLost(owner));
                }
            },
            () => {},
        );
        let running: Promise<void> | undefined;
        t.after(async () => {
            runner.cancel();
            await running;
            session.disconnect();
            await session.joinAutomationCleanup();
            await server.close();
            await journal.close();
            assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
            assert.ok(path.basename(profile).startsWith('hub-receipt-flow-'));
            await fs.rm(profile, { recursive: true, force: true });
        });
        await session.connect(server.options, async (key) => key === server.pinned);
        const transport = {
            automationConnection: () => session.automationConnection,
            automationConsole: async (request: Parameters<ConsoleRpc>[0]) => {
                const reply = await session.automationConsole(request, 'gateway');
                if (request.action === 'open') owner = reply as ConsoleOwner;
                return reply;
            },
        };
        const prompt = { role: 'shell-prompt' as const, literals: ['fixture:/root# '] };
        const plan: AutomationPlan = {
            transport: 'ssh',
            ssh: { mode: 'console', ready: prompt, completion: prompt },
            steps: [
                {
                    id: 'one',
                    name: 'One',
                    enabled: true,
                    command: 'pwd',
                    delaySeconds: 0,
                    ssh: { intent: 'script' },
                },
            ],
            timeoutSeconds: 3,
            repeatSeconds: 600,
            start: null,
            serial: { lineEnding: 'none', prompt: '', timestampPrefix: '' },
        };
        const backend = sshConsoleBackend(
            transport,
            'gateway',
            { endpoint: 'owned loopback' },
            () => session.isConnected,
            async () => journal,
        );
        running = runner.start(plan, backend).finally(() => {
            settled = true;
        });
        await until(() => lossStarted);
        await until(() => settled);
        assert.equal(states.at(-1)!.state, 'paused');
        assert.equal(backend.available(), false);
        assert.equal(session.isConnected, true);
        assert.equal(runner.busy, false);
        assert.equal(journal.resourceClosed, true);
        assert.equal(journal.snapshot!.state, 'incomplete');
        assert.equal(journal.snapshot!.observedBytes, null);
        assert.deepEqual(Buffer.concat(model.state.inputs), Buffer.from('pwd\r'));
    },
);
