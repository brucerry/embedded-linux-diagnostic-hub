import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { Server } from 'ssh2';
import { DeviceMonitor } from '../backend/ssh/monitor';

test('snapshot monitoring reuses one authenticated connection until explicit disconnect', async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        format: 'pem',
        type: 'pkcs1',
    });
    let open = 0,
        connections = 0,
        checks = 0;
    const server = new Server({ hostKeys: [key] }, (client) => {
        let ready = false;
        client.on('error', () => {});
        client.on('close', () => {
            if (ready) open--;
        });
        client.on('authentication', (auth) =>
            auth.method === 'password' && auth.password === 'fixture'
                ? auth.accept()
                : auth.reject(),
        );
        client.on('ready', () => {
            ready = true;
            open++;
            connections++;
            client.on('session', (accept) =>
                accept().on('exec', (acceptExec) => {
                    checks++;
                    const stream = acceptExec();
                    stream.write('fixture output');
                    stream.exit(0);
                    stream.end();
                }),
            );
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const monitor = new DeviceMonitor();
    let verifications = 0;
    try {
        await monitor.configure(
            {
                host: '127.0.0.1',
                port: (server.address() as { port: number }).port,
                username: 'root',
                auth: 'password',
                password: 'fixture',
            },
            async () => {
                verifications++;
                return true;
            },
        );
        for (let i = 0; i < 2; i++) {
            assert.equal((await monitor.collect()).results.length, 36);
            assert.equal(open, 1);
        }
        assert.equal(connections, 1);
        assert.equal(verifications, 1);
        assert.equal(checks, 72);
        monitor.clear();
        for (let attempt = 0; open && attempt < 100; attempt++)
            await new Promise((r) => setTimeout(r, 10));
        assert.equal(open, 0);
        await assert.rejects(monitor.collect(), /Connect to a target/);
    } finally {
        monitor.clear();
        await new Promise<void>((r) => server.close(() => r()));
    }
});
