import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SshSession } from '../backend/ssh/session';
import { ConsoleOperationPort } from '../backend/ssh/console-port';
import { GatewayConsoleRepository } from '../backend/ssh/gateway-console-repository';
import { SshStreamHost } from '../backend/ssh/stream-host';
import { NativeConsoleJournal } from '../electron/console-journal';
import { SshConsoleClient } from '../src/features/automation/capture/ssh-console-client';
import { bytesBase64, CaptureStorageError } from '../shared/capture-store';
import { consoleOwner, type ConsoleOwner, type ConsoleRpc } from '../shared/console-rpc';
import type { ConsoleSegment } from '../shared/console-journal';
import { dispatchConsoleWrite, type ConsoleWrite } from '../shared/console-storage';
import { consoleFixture } from './fixtures/ssh-console';
import { gatewayFixture } from './fixtures/gateway';

const ready = { role: 'shell-prompt' as const, literals: ['fixture:/root# '] };
const id = () => randomUUID().replaceAll('-', '');
const command = (text: string): Extract<ConsoleSegment, { kind: 'command' }> => ({
    kind: 'command',
    runId: 'loss-regression',
    stepId: 'command-one',
    ordinal: 1,
    name: text,
    input: { intent: 'script', command: text },
    requestBase64: bytesBase64(Buffer.from(text + '\r')),
    criterion: { role: 'shell-prompt', literals: ['fixture:/root# '] },
});
async function until(predicate: () => boolean, message: string) {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
        assert.ok(performance.now() < deadline, message);
        await delay(10);
    }
}
async function fixture(t: TestContext) {
    const model = consoleFixture(),
        server = await gatewayFixture(undefined, model);
    const session = new SshSession();
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-console-loss-'));
    const stores: NativeConsoleJournal[] = [],
        clients: SshConsoleClient[] = [];
    t.after(async () => {
        for (const client of clients) await client.close().catch(() => {});
        session.disconnect();
        await session.joinAutomationCleanup();
        await server.close();
        for (const store of stores) await store.close();
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('hub-console-loss-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    await session.connect(server.options, async (key) => key === server.pinned);
    async function makeClient(
        intercept?: (
            request: Parameters<ConsoleRpc>[0],
            reply: unknown,
        ) => unknown | Promise<unknown>,
    ) {
        const directory = path.join(profile, String(stores.length));
        await fs.mkdir(directory);
        const store = await NativeConsoleJournal.open(directory, { profileOwned: true });
        stores.push(store);
        let owner: ConsoleOwner | undefined;
        const rpc: ConsoleRpc = async (request) => {
            const reply = await session.automationConsole(request, 'gateway');
            if (request.action === 'open') {
                const value = reply as ConsoleOwner;
                owner = consoleOwner({
                    id: value.id,
                    connection: value.connection,
                    capability: value.capability,
                });
            }
            return intercept ? intercept(request, reply) : reply;
        };
        const client = new SshConsoleClient(rpc, 'gateway', store);
        clients.push(client);
        return {
            client,
            store,
            owner: () => {
                assert.ok(owner);
                return owner;
            },
        };
    }
    return { model, server, session, makeClient };
}

test(
    'console transport loss leaves the distinct authenticated Terminal channel usable',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t),
            terminalId = id();
        let terminalBytes = '';
        await f.session.openTerminal({ id: terminalId, rows: 40, cols: 120 }, (event) => {
            if (event.type === 'data') {
                terminalBytes += Buffer.from(event.data, 'base64').toString();
                f.session.getTerminal(terminalId).acknowledge(event.sequence);
            }
        });
        const terminal = f.session.getTerminal(terminalId),
            first = await f.makeClient();
        await first.client.open(f.session.automationConnection, id(), ready, 2500, () => {});
        await assert.rejects(
            terminal.write(bytesBase64(Buffer.from('pwd\r'))),
            /paused during Automation/,
        );
        f.session.consoleTransportLost(first.owner());
        await assert.rejects(first.client.close(), /lost|unacknowledged/i);
        await until(() => !f.session.consoleBusy, 'console actor did not release');
        assert.equal(f.session.isConnected, true);
        assert.equal(f.session.getTerminal(terminalId), terminal);
        assert.equal(f.model.state.opens, 2);
        assert.equal(f.model.state.closes, 1);
        await terminal.write(bytesBase64(Buffer.from('pwd\r')));
        await until(
            () => terminalBytes.includes('/root\r\n'),
            'separate Terminal did not receive its command output',
        );
        assert.deepEqual(Buffer.concat(f.model.state.inputs), Buffer.from('pwd\r'));
        terminal.close();
    },
);

test(
    'actual aborted step HTTP response retires only Console and joins gateway close owners',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t),
            journal = await f.makeClient();
        const connected = await f.server.request('/api/sessions', 'POST', f.server.options);
        assert.equal(connected.status, 201);
        const { sessionId } = (await connected.json()) as { sessionId: string };
        const stepAbort = new AbortController();
        const rpc: ConsoleRpc = async (request, options) => {
            const signals = [
                options?.signal,
                request.action === 'step' ? stepAbort.signal : undefined,
            ].filter((signal): signal is AbortSignal => Boolean(signal));
            const response = await fetch(
                f.server.url +
                    '/api/sessions/' +
                    sessionId +
                    '/automation/console/' +
                    request.action,
                {
                    method: 'POST',
                    headers: {
                        Origin: 'http://127.0.0.1:5173',
                        Authorization: 'Bearer ' + f.server.token,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(request),
                    signal: AbortSignal.any(signals),
                },
            );
            const value = (await response.json()) as { error?: string };
            if (!response.ok) throw Error(value.error ?? 'Gateway console request failed');
            return value;
        };
        const client = new SshConsoleClient(rpc, 'gateway', journal.store);
        t.after(() => client.close().catch(() => {}));
        await client.open(sessionId, id(), ready, 2500, () => {});
        const pending = client.step(command('fixture-stall'), 2000, () => {});
        const rejected = assert.rejects(pending, /abort|lost|unacknowledged/i);
        await until(
            () => f.model.state.commands.includes('fixture-stall'),
            'actual step did not reach the owned synthetic shell',
        );
        stepAbort.abort();
        await rejected;
        await assert.rejects(client.close(), /abort|lost|unacknowledged/i);
        await until(
            () =>
                f.server.ownershipSnapshot.sessionOwners.every(
                    (owner) => !owner.consoleActor && !owner.console?.activeStates,
                ),
            'HTTP loss retained a local Console owner',
        );
        assert.equal(client.resourceSnapshot.localCleanupClosed, true);
        assert.equal(client.resourceSnapshot.requests, 0);
        assert.equal(client.resourceSnapshot.heartbeatTimers, 0);
        assert.equal(f.server.ownershipSnapshot.sessions, 1);
        assert.equal(f.server.ownershipSnapshot.sessionOwners[0].connected, true);
        assert.equal(journal.store.snapshot!.state, 'incomplete');
        assert.equal(journal.store.snapshot!.observedBytes, null);
        assert.deepEqual(Buffer.concat(f.model.state.inputs), Buffer.from('fixture-stall\r'));
        // The separate direct-session fixture is still alive; its after-hook owns target close.
        await f.server.closeGateway();
        assert.equal(f.server.ownershipSnapshot.sessions, 0);
        assert.equal(f.server.ownershipSnapshot.requestTasks, 0);
        assert.equal(f.server.ownershipSnapshot.cleanupTimers, 0);
        assert.equal(f.server.ownershipSnapshot.serverListening, false);
    },
);

test('gateway adapter disposal joins its local reader without fabricating a journal close ACK', async () => {
    const port = new ConsoleOperationPort(() => ({ revision: 0 }));
    const store = new GatewayConsoleRepository(port);
    const reading = port.read(0);
    const rejected = assert.rejects(reading, /synthetic transport loss/);
    store.transportLost(Error('synthetic transport loss'));
    await store.close();
    await rejected;
    assert.equal(store.resourceClosed, false);
    assert.equal(store.snapshot, null);
    assert.deepEqual(store.localDisposal, {
        scope: 'gateway-operation-adapter',
        disposed: true,
        journalClosure: 'unacknowledged',
    });
    assert.deepEqual(port.snapshot, {
        pending: 0,
        reading: false,
        delivered: false,
        failed: true,
        closeWaiters: 0,
    });
});

test('stream shutdown retains the producer until actual settlement and fences new dispatch', async (t) => {
    let release!: () => void,
        finished = false;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    t.after(() => release());
    const host = new SshStreamHost(
        async (_request, _sink, complete, finalized) => {
            await gate;
            complete({
                stdout: '',
                stderr: '',
                exitCode: null,
                completion: 'cancelled',
                truncated: false,
                chunks: [],
                previewClipped: false,
            });
            await finalized;
        },
        () => {},
    );
    const capabilities = (await host.dispatch({ protocol: 1, action: 'capabilities' })) as {
        epoch: string;
    };
    const request = {
        id: 'held-stream-0000001',
        connection: 'held-connection-001',
        command: 'fixture',
        timeoutMs: 1000,
    };
    const owner = (await host.dispatch({
        protocol: 1,
        action: 'start',
        epoch: capabilities.epoch,
        request,
    })) as { capability: string };
    const reading = host.dispatch({
        protocol: 1,
        action: 'read',
        id: request.id,
        connection: request.connection,
        capability: owner.capability,
    });
    const rejected = assert.rejects(reading, /connection changed/);
    const closing = host.shutdown().then(() => {
        finished = true;
    });
    await rejected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(host.ownershipSnapshot.producers, 1);
    assert.equal(host.ownershipSnapshot.retiringStates, 1);
    await assert.rejects(
        host.dispatch({ protocol: 1, action: 'capabilities' }),
        /cleanup is still in progress/,
    );
    release();
    await closing;
    assert.deepEqual(host.ownershipSnapshot, {
        currentStates: 0,
        retiringStates: 0,
        producers: 0,
        readers: 0,
        pendingAcks: 0,
        pendingDataBytes: 0,
        shutdownWaiters: 0,
    });
});

test(
    'authenticated console loss releases actual local owners and requires a fresh explicit arm',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t),
            first = await f.makeClient();
        await first.client.open(f.session.automationConnection, id(), ready, 2500, () => {});
        await first.client.step(command('pwd'), 2000, () => {});
        const oldOwner = first.owner(),
            retained = first.store.snapshot!.bytes;
        f.session.consoleTransportLost(oldOwner);
        await assert.rejects(first.client.close(), /lost|unacknowledged/i);
        await until(
            () => !f.session.consoleBusy && f.session.consoleProtocolSnapshot === null,
            'actual gateway owner did not retire',
        );
        assert.equal(first.store.resourceClosed, true);
        assert.equal(first.store.snapshot!.state, 'incomplete');
        assert.equal(first.store.snapshot!.observedBytes, null);
        assert.equal(first.store.snapshot!.bytes, retained);
        assert.equal(first.client.resourceSnapshot.localCleanupClosed, true);
        assert.equal(first.client.resourceSnapshot.journalClosure, 'unacknowledged');
        assert.equal(f.model.state.closes, 1);
        const status = (await f.session.automationConsole(
            { protocol: 1, action: 'status', ...oldOwner },
            'gateway',
        )) as { ownerHeld: boolean; cleanup: unknown };
        assert.equal(status.ownerHeld, false);
        assert.deepEqual(status.cleanup, {
            storageAdapterClosed: true,
            journalClosure: 'unacknowledged',
        });
        const second = await f.makeClient();
        await second.client.open(f.session.automationConnection, id(), ready, 2500, () => {});
        f.session.consoleTransportLost(oldOwner);
        for (const action of ['step', 'ack', 'heartbeat'] as const) {
            const request =
                action === 'step'
                    ? { action, sequence: 0, segment: command('pwd'), timeoutMs: 1000 }
                    : action === 'ack'
                      ? {
                            action,
                            sequence: 0,
                            reply: { snapshot: null, value: null, closed: true },
                            error: null,
                        }
                      : { action };
            await assert.rejects(
                f.session.automationConsole({ protocol: 1, ...oldOwner, ...request }, 'gateway'),
                /retired/,
            );
        }
        assert.deepEqual(
            await f.session.automationConsole(
                { protocol: 1, action: 'release', ...oldOwner },
                'gateway',
            ),
            { ok: true },
        );
        assert.equal(f.session.consoleBusy, true);
        await second.client.step(command('pwd'), 2000, () => {});
        await second.client.close('complete');
        assert.equal(second.client.resourceSnapshot.localCleanupClosed, true);
        assert.equal(second.client.resourceSnapshot.journalClosure, 'acknowledged');
        assert.deepEqual(Buffer.concat(f.model.state.inputs), Buffer.from('pwd\rpwd\r'));
        assert.equal(f.model.state.opens, 2);
        assert.equal(f.model.state.closes, 2);
        assert.equal(f.session.ownershipSnapshot.console?.activeStates, 0);
        assert.equal(f.session.ownershipSnapshot.console?.heartbeatTimers, 0);
    },
);

test(
    'lost ACK after an actual durable commit retains the prefix and never replays console input',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t);
        let armLoss = false,
            operations = new Map<number, string>(),
            injected = 0;
        const first = await f.makeClient((request, reply) => {
            if (request.action === 'read') {
                const event = reply as { type: string; sequence: number; request: { op: string } };
                if (event.type === 'operation') operations.set(event.sequence, event.request.op);
            }
            if (
                armLoss &&
                request.action === 'ack' &&
                operations.get(request.sequence) === 'observe'
            ) {
                armLoss = false;
                injected++;
                // The real journal operation and host ACK already completed; only delivery is lost.
                f.session.consoleTransportLost(first.owner());
                throw Error('Injected ACK response loss after commit');
            }
            return reply;
        });
        await first.client.open(f.session.automationConnection, id(), ready, 2500, () => {});
        armLoss = true;
        await assert.rejects(
            first.client.step(command('pwd'), 2000, () => {}),
            /lost|unacknowledged|ACK response/i,
        );
        await assert.rejects(first.client.close(), /lost|unacknowledged|ACK response/i);
        await until(
            () => !f.session.consoleBusy && f.session.consoleProtocolSnapshot === null,
            'lost ACK left a gateway actor owned',
        );
        assert.equal(injected, 1);
        assert.equal(first.store.resourceClosed, true);
        assert.equal(first.store.snapshot!.state, 'incomplete');
        assert.equal(first.store.snapshot!.observedBytes, null);
        assert.equal(first.client.resourceSnapshot.localCleanupClosed, true);
        assert.ok(first.store.snapshot!.bytes > 0);
        assert.deepEqual(Buffer.concat(f.model.state.inputs), Buffer.from('pwd\r'));
        assert.equal(f.model.state.commands.length, 1);
        assert.equal(f.model.state.closes, 1);
    },
);

test(
    'a missing gateway heartbeat retires only that owner without a response-close signal',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t);
        const first = await f.makeClient();
        const rpc = (request: Parameters<ConsoleRpc>[0]) =>
            f.session.automationConsole(request, 'gateway');
        const capability = (await rpc({ protocol: 1, action: 'capabilities' })) as {
            epoch: string;
        };
        const opened = (await rpc({
            protocol: 1,
            action: 'open',
            epoch: capability.epoch,
            id: id(),
            connection: f.session.automationConnection,
            ready,
            timeoutMs: 2500,
        })) as ConsoleOwner;
        const owner = consoleOwner({
            id: opened.id,
            connection: opened.connection,
            capability: opened.capability,
        });
        let revision = 0;
        while (true) {
            const event = (await rpc({ protocol: 1, action: 'read', ...owner, revision })) as {
                type: string;
                sequence: number;
                request: ConsoleWrite;
                revision: number;
                phase: string;
            };
            if (event.type === 'operation') {
                const reply = await dispatchConsoleWrite(first.store, event.request);
                await rpc({
                    protocol: 1,
                    action: 'ack',
                    ...owner,
                    sequence: event.sequence,
                    reply,
                    error: null,
                });
            } else {
                revision = event.revision;
                if (event.phase === 'ready') break;
            }
        }
        const at = performance.now();
        // No close notification or heartbeat is sent after the real startup journal ACKs.
        await until(
            () => !f.session.consoleBusy && f.session.consoleProtocolSnapshot === null,
            'heartbeat lease did not retire the abandoned owner',
        );
        assert.ok(
            performance.now() - at >= 1500,
            'retirement happened without exercising the existing heartbeat lease',
        );
        const status = (await f.session.automationConsole(
            { protocol: 1, action: 'status', ...owner },
            'gateway',
        )) as { ownerHeld: boolean };
        assert.equal(status.ownerHeld, false);
        assert.equal(
            first.store.resourceClosed,
            false,
            'gateway cannot close the unreachable browser journal',
        );
        await first.store.fail(
            null,
            new CaptureStorageError(
                'io',
                'Renderer was absent; remote final byte count is unknown.',
            ),
        );
        await first.store.close();
        assert.equal(first.store.snapshot!.state, 'incomplete');
        assert.equal(first.store.snapshot!.observedBytes, null);
        assert.equal(f.model.state.inputs.length, 0);
        assert.equal(f.model.state.closes, 1);
    },
);
