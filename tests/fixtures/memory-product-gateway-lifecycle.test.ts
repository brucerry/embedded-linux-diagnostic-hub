import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, type Connection, type ServerChannel } from 'ssh2';
import { createProductTarget } from './memory-product-gateway-target';
import { fingerprint } from '../../backend/ssh/session';

async function until(predicate: () => boolean) {
    const end = Date.now() + 2000;
    while (!predicate()) {
        assert.ok(Date.now() < end, 'Real target operation ownership did not join.');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
for (const cancellation of ['channel-close', 'transport-close', 'shutdown'] as const)
    test(
        'actual stalled target joins without a write after ' + cancellation,
        { timeout: 10000 },
        async (t) => {
            const clients = new Set<Connection>(),
                channels = new Set<ServerChannel>(),
                pumps = new Set<Promise<void>>();
            const target = await createProductTarget({ clients, channels, pumps }),
                client = new Client();
            client.on('error', () => {});
            t.after(async () => {
                await target.beforeStop();
                for (const channel of channels) channel.close();
                for (const peer of clients) peer.end();
                client.end();
                if (target.server.address())
                    await new Promise<void>((resolve, reject) =>
                        target.server.close((error) => (error ? reject(error) : resolve())),
                    );
            });
            target.control({
                action: 'program',
                program: { command: 'cancel-gated-output', stdoutBytes: 128, stall: true },
            });
            const ready = once(client, 'ready');
            client.connect({
                host: target.descriptor.host,
                port: target.descriptor.port,
                username: 'engineer',
                password: 'device-test-password',
                hostVerifier: (key: Buffer) => fingerprint(key) === target.descriptor.fingerprint,
            });
            await ready;
            const channel = await new Promise<ServerChannel>((resolve, reject) =>
                client.exec('cancel-gated-output', (error, value) =>
                    error ? reject(error) : resolve(value as unknown as ServerChannel),
                ),
            );
            channel.on('error', () => {});
            channel.resume();
            await until(() => target.snapshot().owners.outputGates === 1);
            const actual = [...channels][0];
            assert.ok(actual);
            let ended = false,
                postCloseWrites = 0;
            const original = actual.write.bind(actual);
            actual.write = ((...args: Parameters<ServerChannel['write']>) => {
                if (ended) postCloseWrites++;
                return original(...args);
            }) as ServerChannel['write'];
            actual.once('close', () => {
                ended = true;
            });
            if (cancellation === 'channel-close') channel.close();
            else if (cancellation === 'transport-close') client.end();
            else {
                await target.beforeStop();
                channel.close();
            }
            await until(
                () =>
                    target.snapshot().owners.pumps === 0 &&
                    target.snapshot().owners.outputGates === 0 &&
                    target.snapshot().owners.pendingWriteCallbacks === 0,
            );
            assert.equal(
                postCloseWrites,
                0,
                'Fixture called ServerChannel.write after actual protocol close.',
            );
            assert.equal(target.snapshot().totals.stdoutBytes, 0);
            assert.equal(target.snapshot().totals.stderrBytes, 0);
            client.end();
            await until(() => clients.size === 0 && channels.size === 0);
            assert.deepEqual(target.snapshot().owners, {
                clients: 0,
                channels: 0,
                pumps: 0,
                pendingOpen: 0,
                pendingWriteCallbacks: 0,
                delays: 0,
                outputGates: 0,
            });
        },
    );
