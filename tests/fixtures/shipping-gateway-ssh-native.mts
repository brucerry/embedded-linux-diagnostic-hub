import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { createShippingGatewaySshFixture } from './shipping-gateway-ssh.ts';

/** Definition-only on import. The caller must supply its already-admitted, owned SSH2 namespace;
 * this fixture never loads the package or resolves ancestor dependencies itself. Calling it creates
 * in-memory credentials and prepares unbound native ports, and remains held separately. */
export function prepareNativeShippingGatewayTarget(loaded: unknown) {
    if (process.platform !== 'linux' || !/^24\./.test(process.versions.node))
        throw Error('FIXTURE_RUNTIME_UNADMITTED');
    // SSH2 is CommonJS. Native Node guarantees the default namespace bridge; do not rely
    // on a bundler synthesizing named exports, as the older loopback runner once did.
    const { Server, utils } = ((loaded as any)?.default ?? loaded ?? {}) as typeof import('ssh2');
    if (typeof Server !== 'function' || typeof utils?.parseKey !== 'function')
        throw Error('FIXTURE_SSH2_MODULE');
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        format: 'pem',
        type: 'pkcs1',
    });
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error || Array.isArray(parsed)) throw Error('FIXTURE_HOST_KEY');
    const publicKey = parsed.getPublicSSH();
    const fingerprint =
        'SHA256:' + createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
    return createShippingGatewaySshFixture(
        {
            privateKey: key,
            fingerprint,
            username: 'engineer',
            password: 'fixture-' + randomBytes(24).toString('hex'),
        },
        {
            ssh: (options: any, client: any) => new Server(options, client),
            tcp: (socket: any) =>
                createServer({ pauseOnConnect: true, allowHalfOpen: false }, socket),
            now: () => performance.now(),
            setTimer: setTimeout,
            clearTimer: clearTimeout,
        },
    );
}
