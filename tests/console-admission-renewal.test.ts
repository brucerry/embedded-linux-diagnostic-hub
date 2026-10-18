import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeConsoleService } from '../electron/console-service';
import { NativeConsoleJournal } from '../electron/console-journal';
import { ConsoleOperationPort } from '../backend/ssh/console-port';
import { SshConsoleClient } from '../src/features/automation/capture/ssh-console-client';
import { CONSOLE_IDLE_RENEWAL_MS, type ConsoleRpc } from '../shared/console-rpc';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const id = '00000000-0000-4000-8000-000000000001';
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
for (const op of ['read', 'pin'] as const) {
    for (const mode of ['parallel', 'failure', 'reset'] as const) {
        test(`native ${op} admission reserves all four slots before awaiting (${mode})`, async (t) => {
            const held = gate();
            let created = 0,
                alive = 0,
                returned = 0,
                closed = false;
            const fake = {
                get resourceClosed() {
                    return closed;
                },
                read() {
                    const ordinal = ++created;
                    let released = false;
                    alive++;
                    return {
                        async next() {
                            await held.promise;
                            if (mode === 'failure' && ordinal === 1)
                                throw Error('injected prime failure');
                            return { done: false, value: { kind: 'fixture' } };
                        },
                        async return() {
                            if (!released) {
                                released = true;
                                alive--;
                                returned++;
                            }
                            return { done: true, value: undefined };
                        },
                    };
                },
                async pin() {
                    const ordinal = ++created;
                    await held.promise;
                    if (mode === 'failure' && ordinal === 1) throw Error('injected pin failure');
                    alive++;
                    let released = false;
                    return {
                        async release() {
                            if (!released) {
                                released = true;
                                alive--;
                                returned++;
                            }
                        },
                    };
                },
                async close() {
                    closed = true;
                },
            };
            t.mock.method(
                NativeConsoleJournal,
                'open',
                async () => fake as unknown as NativeConsoleJournal,
            );
            const service = new NativeConsoleService('unused mock profile');
            t.after(async () => {
                held.resolve();
                await service.shutdown();
            });
            const requests = Array.from({ length: 8 }, () =>
                service.dispatch(op === 'read' ? { op, id } : { op }),
            );
            const results = Promise.allSettled(requests);
            await tick();
            assert.equal(
                op === 'read' ? service.snapshot.pendingReaders : service.snapshot.pendingPins,
                4,
            );
            assert.equal(service.snapshot.references, 4);
            assert.equal(op === 'read' ? service.snapshot.readers : service.snapshot.pins, 0);
            let reset: Promise<void> | undefined;
            if (mode === 'reset') {
                reset = service.reset();
                await tick();
                assert.equal(
                    service.snapshot.references,
                    4,
                    'reset cannot erase a pending resource reservation',
                );
            }
            held.resolve();
            const settled = await results;
            await reset;
            assert.equal(
                settled.filter((result) => result.status === 'fulfilled').length,
                mode === 'parallel' ? 4 : mode === 'failure' ? 3 : 0,
            );
            assert.equal(
                settled.filter(
                    (result) => result.status === 'rejected' && result.reason?.code === 'busy',
                ).length,
                4,
            );
            assert.equal(service.snapshot.pendingReaders, 0);
            assert.equal(service.snapshot.pendingPins, 0);
            await service.reset();
            assert.equal(alive, 0);
            assert.equal(service.snapshot.references, 0);
            assert.equal(service.snapshot.readers, 0);
            assert.equal(service.snapshot.pins, 0);
            assert.equal(returned, op === 'read' || mode !== 'failure' ? 4 : 3);
            assert.equal(created, 4, 'rejected admissions must not open another resource');
        });
    }
}

test('quiet console renews the same owner through 600-second step and repetition waits without early input', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const owner = {
        id: 'quiet-flow-00000001',
        connection: 'quiet-connection-01',
        capability: 'a'.repeat(64),
    };
    let revision = 1,
        phase = 'ready',
        released = false,
        renewals = 0;
    const actions: string[] = [];
    const port = new ConsoleOperationPort(() => ({
        id: owner.id,
        revision,
        phase,
        error: null,
        snapshot: null,
        ownerHeld: phase !== 'closed',
        cleanup: {
            storageAdapterClosed: phase === 'closed',
            journalClosure: phase === 'closed' ? 'acknowledged' : 'pending',
        },
    }));
    const rpc: ConsoleRpc = async (request) => {
        actions.push(request.action);
        if (request.action === 'capabilities')
            return {
                protocol: 1,
                independentStream: 1,
                persistentConsole: 1,
                epoch: 'b'.repeat(32),
                receiveTimeSource: 'local-client',
                journal: 'native-v2',
                heartbeat: null,
            };
        if (request.action === 'open') return { protocol: 1, ...owner };
        if (request.action === 'read') {
            const event = await port.read(request.revision);
            if (event.type === 'idle') renewals++;
            return event;
        }
        if (request.action === 'finish') {
            phase = 'closed';
            revision++;
            port.notify();
            return { protocol: 1, ...portStatus() };
        }
        if (request.action === 'release') {
            released = true;
            return { ok: true };
        }
        throw Error('Unexpected early command or storage operation');
    };
    const portStatus = () => ({
        id: owner.id,
        revision,
        phase,
        error: null,
        snapshot: null,
        ownerHeld: false,
        cleanup: { storageAdapterClosed: true, journalClosure: 'acknowledged' },
    });
    const client = new SshConsoleClient(rpc, 'local-client');
    await client.open(
        owner.connection,
        owner.id,
        { role: 'shell-prompt', literals: ['fixture#'] },
        1000,
        () => {},
    );
    for (const delayKind of ['step delay', 'repetition delay']) {
        for (let elapsed = 0; elapsed < 600000; elapsed += CONSOLE_IDLE_RENEWAL_MS) {
            await tick();
            assert.equal(port.snapshot.reading, true);
            t.mock.timers.tick(CONSOLE_IDLE_RENEWAL_MS);
            await tick();
            assert.equal(client.resourceSnapshot.owner, true, delayKind + ' lost its owner');
            assert.equal(client.resourceSnapshot.phase, 'ready');
        }
        assert.equal(actions.includes('step'), false, delayKind + ' sent an input early');
        assert.equal(actions.includes('finish'), false, delayKind + ' disarmed a healthy console');
    }
    assert.equal(renewals, 60);
    await client.close('complete');
    assert.equal(released, true);
    assert.equal(client.resourceSnapshot.localCleanupClosed, true);
    assert.equal(port.snapshot.reading, false);
    t.diagnostic(
        'Controlled virtual-time protocol proof: 600-second step wait + 600-second repetition wait; not a 20-minute real product soak.',
    );
});
