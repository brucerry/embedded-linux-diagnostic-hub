import { generateKeyPairSync } from 'node:crypto';
import { Server, utils } from 'ssh2';
import { fingerprint } from '../../backend/ssh/session';
import { createGateway } from '../../gateway/server';
import { probes } from '../../shared/diagnostics/probes';
import { demoSnapshot } from './snapshots';

export async function gatewayFixture() {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        format: 'pem',
        type: 'pkcs1',
    });
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid test key.');
    const pinned = fingerprint(parsed.getPublicSSH());
    const data = demoSnapshot();
    let authentications = 0;
    const sshServer = new Server({ hostKeys: [key] }, (client) => {
        client.on('error', () => {});
        client.on('authentication', (auth) => {
            authentications++;
            if (
                auth.method === 'password' &&
                auth.username === 'engineer' &&
                auth.password === 'device-test-password'
            )
                auth.accept();
            else auth.reject();
        });
        client.on('ready', () =>
            client.on('session', (accept) => {
                accept().on('exec', (acceptExec, _reject, info) => {
                    const channel = acceptExec();
                    const probe = probes.find((item) => info.command.endsWith(item.command));
                    const result = data.results.find((item) => item.id === probe?.id);
                    if (result) {
                        channel.write(result.stdout);
                        channel.stderr.write(result.stderr);
                        channel.exit(result.exitCode ?? 1);
                    } else channel.exit(127);
                    channel.end();
                });
            }),
        );
    });
    await new Promise<void>((resolve) => sshServer.listen(0, '127.0.0.1', resolve));
    const sshPort = (sshServer.address() as { port: number }).port;
    const token = 'test-gateway-token-32-characters-minimum';
    const origins = ['http://127.0.0.1:5173'];
    const targets = [{ host: '127.0.0.1', port: sshPort, fingerprint: pinned }];
    const gateway = createGateway({ token, origins, targets });
    await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
    const request = async (
        route: string,
        method = 'GET',
        body?: unknown,
        extraHeaders: Record<string, string> = {},
    ) =>
        fetch(`${url}${route}`, {
            method,
            headers: {
                Origin: origins[0],
                Authorization: `Bearer ${token}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...extraHeaders,
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
    return {
        token,
        pinned,
        url,
        options: {
            host: '127.0.0.1',
            port: sshPort,
            username: 'engineer',
            auth: 'password',
            password: 'device-test-password',
            expectedFingerprint: pinned,
        },
        request,
        authentications: () => authentications,
        close: async () => {
            await gateway.close();
            await new Promise<void>((resolve) => sshServer.close(() => resolve()));
        },
    };
}
