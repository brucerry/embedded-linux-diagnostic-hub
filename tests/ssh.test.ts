import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { Server, utils } from 'ssh2';
import { fingerprint, MAX_OUTPUT_BYTES, SshSession } from '../backend/ssh/session';
import { probes } from '../shared/diagnostics/probes';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    format: 'pem',
    type: 'pkcs1',
});
const options = {
    host: '127.0.0.1',
    port: 0,
    username: 'engineer',
    auth: 'password' as const,
    password: 'ephemeral-test-password',
};

const clientKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const allowedKey = (() => {
    const parsed = utils.parseKey(clientKey.export({ format: 'pem', type: 'pkcs1' }));
    if (parsed instanceof Error || Array.isArray(parsed))
        throw Error('Invalid fixture public key.');
    return parsed;
})();

async function fixture(mode: 'normal' | 'close' | 'key' = 'normal') {
    const commands: string[] = [];
    const server = new Server({ hostKeys: [key] }, (client) => {
        client.on('error', () => {});
        if (mode === 'close') {
            client.end();
            return;
        }
        client.on('authentication', (ctx) => {
            if (mode === 'key') {
                if (
                    ctx.method === 'publickey' &&
                    ctx.username === options.username &&
                    ctx.key.data.equals(allowedKey.getPublicSSH()) &&
                    (!ctx.signature ||
                        (ctx.blob && allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)))
                )
                    ctx.accept();
                else ctx.reject();
                return;
            }
            if (
                ctx.method === 'password' &&
                ctx.username === options.username &&
                ctx.password === options.password
            )
                ctx.accept();
            else ctx.reject();
        });
        client.on('ready', () =>
            client.on('session', (accept) => {
                const session = accept();
                session.on('exec', (acceptExec, _reject, info) => {
                    commands.push(info.command);
                    const stream = acceptExec();
                    if (
                        info.command.endsWith(
                            probes.find((probe) => probe.id === 'routes')!.command,
                        )
                    ) {
                        stream.exit(127);
                        stream.end();
                    } else if (
                        info.command.endsWith(probes.find((probe) => probe.id === 'logs')!.command)
                    ) {
                        stream.stderr.write(
                            'dmesg: read kernel buffer failed: Operation not permitted',
                        );
                        stream.exit(1);
                        stream.end();
                    } else if (
                        info.command.endsWith(probes.find((probe) => probe.id === 'cpu')!.command)
                    ) {
                        stream.write(Buffer.alloc(MAX_OUTPUT_BYTES + 4096, 'x'));
                        stream.exit(0);
                        stream.end();
                    } else {
                        stream.write('fixture evidence\n');
                        stream.exit(0);
                        stream.end();
                    }
                });
            }),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return {
        port: address.port,
        commands,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

test('real loopback SSH collects the allowlist, classifies errors and limits output', async () => {
    const server = await fixture();
    const session = new SshSession();
    let received = '';
    try {
        await session.connect({ ...options, port: server.port }, async (key) => {
            received = key;
            return true;
        });
        const snapshot = await session.collect();
        assert.match(received, /^SHA256:[A-Za-z0-9+/]+$/);
        assert.equal(snapshot.mode, 'ssh');
        assert.equal(snapshot.results.length, probes.length);
        assert.equal(snapshot.results.find((item) => item.id === 'routes')?.status, 'unavailable');
        assert.equal(snapshot.results.find((item) => item.id === 'logs')?.status, 'error');
        const cpu = snapshot.results.find((item) => item.id === 'cpu')!;
        assert.equal(cpu.truncated, true);
        assert.equal(Buffer.byteLength(cpu.stdout), MAX_OUTPUT_BYTES);
        assert.equal(server.commands.length, probes.length);
        assert.ok(
            server.commands.every((command, index) => command.endsWith(probes[index].command)),
        );
        assert.ok(!JSON.stringify(snapshot).includes(options.password));
        session.disconnect();
        await assert.rejects(session.collect(), /Connect to a device/);
    } finally {
        session.disconnect();
        await server.close();
    }
});

test('rejecting a host fingerprint prevents command execution', async () => {
    const server = await fixture();
    const session = new SshSession();
    try {
        await assert.rejects(session.connect({ ...options, port: server.port }, async () => false));
        assert.equal(server.commands.length, 0);
    } finally {
        session.disconnect();
        await server.close();
    }
});

test('closing before authentication rejects promptly', async () => {
    const server = await fixture('close');
    const session = new SshSession();
    try {
        await assert.rejects(session.connect({ ...options, port: server.port }, async () => true));
    } finally {
        session.disconnect();
        await server.close();
    }
});

test('SHA256 fingerprint follows OpenSSH encoding', () => {
    assert.equal(
        fingerprint(Buffer.from('test')),
        'SHA256:n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg',
    );
});

test('encrypted private-key authentication verifies signatures and rejects a wrong passphrase', async () => {
    const server = await fixture('key');
    const session = new SshSession();
    const passphrase = 'ephemeral-key-fixture-passphrase';
    const encrypted = clientKey.export({
        type: 'pkcs1',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase,
    });
    try {
        await assert.rejects(
            session.connect(
                {
                    ...options,
                    port: server.port,
                    auth: 'key',
                    password: undefined,
                    passphrase: 'wrong',
                },
                async () => true,
                Buffer.from(encrypted),
            ),
        );
        assert.equal(server.commands.length, 0);
        await session.connect(
            { ...options, port: server.port, auth: 'key', password: undefined, passphrase },
            async () => true,
            Buffer.from(encrypted),
        );
        const snapshot = await session.collect();
        assert.equal(snapshot.results.length, probes.length);
        assert.ok(!JSON.stringify(snapshot).includes(passphrase));
        assert.ok(!JSON.stringify(snapshot).includes('PRIVATE KEY'));
    } finally {
        session.disconnect();
        await server.close();
    }
});
