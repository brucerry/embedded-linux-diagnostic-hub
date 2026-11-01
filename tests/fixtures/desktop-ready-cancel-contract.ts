import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Client as TransportClient } from 'ssh2';
import { DeviceMonitor } from '../../backend/ssh/monitor';
import type { ConnectOptions } from '../../shared/types';
import type { ConnectionAttemptSnapshot } from '../../electron/connection-attempts';
import {
    ConnectionOperation,
    type ConnectionProgress,
    type ConnectionTransport,
} from '../../src/services/connection-operation';
import { Client, observe, until, turns, memoryClientScope } from './ssh-memory-client';

interface DesktopCallbacks extends ConnectionTransport {
    cancelConnect(id: string): Promise<void>;
    snapshot(): {
        attempt: ConnectionAttemptSnapshot | undefined;
        busy: boolean;
        hostClears: number;
    };
}
export type DesktopCallbackFactory = (monitor: DeviceMonitor) => DesktopCallbacks;

/** Register only this contract in the reviewed external entry with verbatim IPC callbacks. */
export async function verifyReadyCancelContract(factory: DesktopCallbackFactory) {
    assert.ok(Object.is(TransportClient, Client), 'Requires the reviewed ssh2 memory compiler alias');
    const observations: {
        successBeforeCancel: boolean;
        result: boolean;
        states: string[];
        closeWasHeld: boolean;
        noRetry: boolean;
    }[] = [];
    await memoryClientScope(async () => {
        for (const successBeforeCancel of [false, true]) {
            const monitor = new DeviceMonitor(), callbacks = factory(monitor);
            const before = Client.instances.length;
            let ids = 0, retryStarts = 0;
            const operation = new ConnectionOperation(
                {
                    set() { retryStarts++; throw Error('Unexpected retry timer'); },
                    clear() { throw Error('Unexpected retry timer release'); },
                },
                () => { assert.equal(++ids, 1); return '1'.padStart(32, '0'); },
            );
            const progress: ConnectionProgress[] = [];
            const options: ConnectOptions = {
                host: 'synthetic.invalid', port: 22, username: 'synthetic',
                auth: 'password', password: 'SYNTHETIC_PLACEHOLDER',
            };
            const work = observe(operation.connect(callbacks, options, state => {
                assert.ok(progress.length < 12);
                progress.push(state);
            }));
            try {
                await until(() => Client.instances.length === before + 1, 'ready-race client');
                const client = Client.instances[before], snapshot = callbacks.snapshot();
                const signal = snapshot.attempt!.controller.signal;
                assert.equal(operation.running, true);
                assert.equal(getEventListeners(signal, 'abort').length, 1);
                if (!successBeforeCancel) {
                    // Deliberately no await between ready and Cancel: renderer success is still pending.
                    client.ready();
                    const cancelled = observe(operation.cancel());
                    await turns();
                    assert.equal(cancelled.done, false);
                    assert.equal(work.done, false);
                    assert.equal(signal.aborted, true);
                    assert.equal(getEventListeners(signal, 'abort').length, 0);
                    assert.equal(monitor.isConnected, false);
                    assert.equal(callbacks.snapshot().busy, true);
                    assert.equal(callbacks.snapshot().attempt!.controller, snapshot.attempt!.controller);
                    assert.equal(monitor.ownershipSnapshot.connections.length, 1);
                    assert.equal(monitor.ownershipSnapshot.connections[0].transport, 1);
                    assert.equal(client.closed, false);
                    assert.equal(client.destroyCalls, 1);
                    assert.equal(progress.some(state => state.state === 'connected'), false);
                    const hostClears = callbacks.snapshot().hostClears;
                    const duplicate = observe(callbacks.connect(options, '2'.padStart(32, '0')));
                    await until(() => duplicate.done, 'admission held during cancellation');
                    assert.match(String(duplicate.error), /HUB_CONNECTION_FAILURE:policy/);
                    assert.equal(callbacks.snapshot().hostClears, hostClears);
                    assert.equal(Client.instances.length, before + 1);
                    assert.equal(cancelled.done, false);
                    assert.equal(work.done, false);
                    client.closeOwned();
                    await until(() => cancelled.done && work.done, 'Cancel joins owned close');
                    assert.equal(cancelled.error, undefined);
                    assert.equal(work.error, undefined);
                    assert.equal(work.value, false);
                    assert.equal(operation.running, false);
                    assert.equal(progress.at(-1)!.state, 'cancelled');
                    assert.equal(progress.some(state => state.state === 'connected'), false);
                    assert.equal(callbacks.snapshot().attempt, undefined);
                    assert.equal(callbacks.snapshot().busy, false);
                    assert.equal(monitor.hasResources, false);
                } else {
                    client.ready();
                    await until(() => work.done, 'success settled before later Cancel');
                    assert.equal(work.error, undefined);
                    assert.equal(work.value, true);
                    assert.equal(progress.at(-1)!.state, 'connected');
                    assert.equal(operation.running, false);
                    assert.equal(monitor.isConnected, true);
                    assert.equal(signal.aborted, false);
                    assert.equal(getEventListeners(signal, 'abort').length, 0);
                    const beforeCancel = callbacks.snapshot();
                    const cancelled = observe(operation.cancel());
                    await until(() => cancelled.done, 'late Cancel is a no-op');
                    assert.equal(cancelled.error, undefined);
                    assert.equal(work.value, true);
                    assert.deepEqual(callbacks.snapshot(), beforeCancel);
                    assert.equal(progress.filter(state => state.state === 'connected').length, 1);
                    assert.equal(progress.some(state => state.state === 'cancelled'), false);
                    assert.equal(monitor.isConnected, true);
                    assert.equal(client.destroyCalls, 0);
                    assert.equal(client.closed, false);
                    assert.equal(callbacks.snapshot().busy, false);
                }
                assert.equal(ids, 1);
                assert.equal(retryStarts, 0);
                observations.push({
                    successBeforeCancel, result: work.value!,
                    states: progress.map(state => state.state),
                    closeWasHeld: !successBeforeCancel, noRetry: retryStarts === 0,
                });
            } finally {
                for (const client of Client.instances.slice(before)) client.closeOwned();
                if (operation.running) {
                    const cancelled = observe(operation.cancel());
                    await until(() => cancelled.done && work.done, 'ready-race operation unwind');
                    if (cancelled.error) throw cancelled.error;
                }
                await until(() => work.done, 'ready-race work settled');
                const owned = callbacks.snapshot().attempt;
                if (owned) {
                    const retired = observe(callbacks.cancelConnect(owned.id));
                    await until(() => retired.done, 'fixture-only live owner release');
                    if (retired.error) throw retired.error;
                    assert.equal(getEventListeners(owned.controller.signal, 'abort').length, 0);
                }
                monitor.clear();
                const joined = observe(monitor.joinCleanup());
                await until(() => joined.done, 'ready-race owners joined');
                if (joined.error) throw joined.error;
                assert.equal(monitor.hasResources, false);
            }
        }
    });
    return observations;
}
