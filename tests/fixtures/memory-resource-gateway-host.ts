import { productStartup } from './memory-product-startup';
/** Private fixture IPC, never shipped in the gateway or exposed over HTTP. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { GatewayTimers, type RuntimeTimerClosure } from './memory-resource-gateway-timers';
import type { Socket } from 'node:net';
import { Server, utils, type Connection, type ServerChannel } from 'ssh2';
import { createGateway } from '../../gateway/server';
import { fingerprint } from '../../backend/ssh/session';
import { DEVICE_CLOCK_COMMAND } from '../../shared/diagnostics/device-clock';
import { clockOutput } from './device-clock';
import { nodeRuntimeIdentity } from './memory-resource-identity';
import { sshQualificationProfile } from './memory-resource-ssh-profile';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type GatewayTargetExtension = {
    createTarget(resources: {
        assertAdmissible?(): void;
        clients: Set<Connection>;
        channels: Set<ServerChannel>;
        pumps: Set<Promise<void>>;
    }): Promise<{
        server: Server;
        descriptor: { host: string; port: number; fingerprint: string };
        control(payload: unknown): unknown | Promise<unknown>;
        snapshot(): unknown;
        beforeStop(): void | Promise<void>;
    }>;
};

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
export function validHostRequest(
    value: unknown,
    nonce: string,
    controls = false,
): value is { version: 1; nonce: string; id: number; action: string; payload?: unknown } {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    return (
        item.version === 1 &&
        item.nonce === nonce &&
        Number.isSafeInteger(item.id) &&
        Number(item.id) > 0 &&
        ['init', 'sample', 'shutdown', 'release', ...(controls ? ['control'] : [])].includes(
            String(item.action),
        ) &&
        JSON.stringify(item).length <= (controls ? 16384 : 8192)
    );
}
export async function runGatewayHost(extension?: GatewayTargetExtension) {
    assert.ok(
        process.send && process.connected,
        'Only the owned IPC launcher may start this fixture.',
    );
    const nonce = process.env.HUB_MEMORY_HOST_NONCE!;
    assert.match(nonce, /^[a-f0-9]{64}$/);
    const startupController = new AbortController();
    const deadline = process.env.HUB_MEMORY_HOST_WORK_DEADLINE_MS;
    const admit = productStartup({
        signal: startupController.signal,
        workDeadlineMs: deadline ? Number(deadline) : undefined,
    });
    const role = process.argv.find((value) => value.startsWith('--role='))?.slice(7);
    assert.ok(role === 'gateway-node' || role === 'ssh-fixture-node');
    const timers = new GatewayTimers(process.env.HUB_MEMORY_HOST_TIMER_STACKS === '1');
    let runtimeTimerClosure: RuntimeTimerClosure[] = [];
    const clients = new Set<Connection>(),
        channels = new Set<ServerChannel>(),
        pumps = new Set<Promise<void>>();
    const sockets = new Set<Socket>(),
        requests = new Set<object>();
    let gateway: ReturnType<typeof createGateway> | undefined, target: Server | undefined;
    let extendedTarget: Awaited<ReturnType<GatewayTargetExtension['createTarget']>> | undefined;
    let initialized = false,
        stopped = false,
        busy = false,
        lastId = 0,
        timerBaseline = 0;
    const resources = () => ({
        clients: clients.size,
        channels: channels.size,
        pumps: pumps.size,
        httpRequests: requests.size,
        httpSockets: sockets.size,
        server: gateway?.server.listening || target?.address() ? 1 : 0,
        timers: timers.size,
        timerDelta: timers.size - timerBaseline,
        ipcMessageListeners: process.listenerCount('message'),
        ipcDisconnectListeners: process.listenerCount('disconnect'),
    });
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        await gateway?.close();
        await extendedTarget?.beforeStop();
        for (const channel of channels) channel.close();
        for (const client of clients) client.end();
        if (target?.address())
            await new Promise<void>((resolve, reject) =>
                target!.close((error) => (error ? reject(error) : resolve())),
            );
        await Promise.all([...pumps]);
        // Drain close/destroy notifications; no success receipt is emitted on a timeout.
        for (let i = 0; i < 8; i++) await turn();
        const counts = resources();
        const product = gateway?.ownershipSnapshot;
        if (product) {
            for (const name of [
                'requestTasks',
                'httpSockets',
                'httpResponses',
                'httpBodyReaders',
                'pendingConnections',
                'sessions',
                'inFlight',
                'ownedSessions',
                'retiringSessions',
                'connectionAttempts',
                'cancelledAttemptCache',
                'cleanupTimers',
            ] as const)
                assert.equal(product[name], 0, 'Actual gateway product shutdown: ' + name);
            assert.deepEqual(
                product.allSessionOwners,
                [],
                'Actual SSH sessions must join, not just disappear from the public session map.',
            );
        }
        for (const key of [
            'clients',
            'channels',
            'pumps',
            'httpRequests',
            'httpSockets',
            'server',
        ] as const)
            assert.equal(counts[key], 0, 'Gateway host teardown: ' + key);
        runtimeTimerClosure = await timers.joinHttpDateCache();
        assert.equal(timers.size, 0, 'Gateway host timers survived shutdown.');
    };
    const send = (value: unknown) =>
        new Promise<void>((resolve, reject) =>
            process.send!(value, (error) => (error ? reject(error) : resolve())),
        );
    const onDisconnect = () => {
        void stop()
            .catch((error) => {
                console.error(error);
                process.exitCode = 1;
            })
            .finally(() => {
                timers.disable();
                process.removeListener('message', onMessage);
            });
    };
    const onMessage = (input: unknown) => {
        const cancellation = input as { version?: unknown; nonce?: unknown; kind?: unknown };
        if (
            cancellation?.version === 1 &&
            cancellation.nonce === nonce &&
            cancellation.kind === 'cancel-startup'
        ) {
            startupController.abort(Error('Product supervisor cancelled host startup.'));
            return;
        }
        if (!validHostRequest(input, nonce, Boolean(extension)) || busy || input.id <= lastId) {
            process.exitCode = 1;
            onDisconnect();
            process.disconnect?.();
            return;
        }
        busy = true;
        lastId = input.id;
        void (async () => {
            let value: unknown;
            if (input.action === 'init') {
                admit();
                assert.ok(!initialized && !stopped);
                const payload = input.payload as {
                    origin: string;
                    target?: { host: string; port: number; fingerprint: string };
                };
                assert.ok(new URL(payload.origin).hostname === '127.0.0.1');
                await sshQualificationProfile();
                admit();
                if (role === 'ssh-fixture-node' && extension) {
                    extendedTarget = await extension.createTarget({
                        clients,
                        channels,
                        pumps,
                        assertAdmissible: admit,
                    });
                    target = extendedTarget.server;
                    admit();
                    value = extendedTarget.descriptor;
                } else if (role === 'ssh-fixture-node') {
                    const key = generateKeyPairSync('rsa', {
                        modulusLength: 2048,
                    }).privateKey.export({ format: 'pem', type: 'pkcs1' });
                    const parsed = utils.parseKey(key);
                    assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
                    admit();
                    target = new Server({ hostKeys: [key] }, (client) => {
                        clients.add(client);
                        client.once('close', () => clients.delete(client));
                        client.on('error', () => {});
                        client.on('authentication', (auth) => {
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
                                const session = accept();
                                session.on('exec', (acceptExec, _reject, info) => {
                                    const channel = acceptExec();
                                    channels.add(channel);
                                    channel.once('close', () => channels.delete(channel));
                                    channel.on('error', () => {});
                                    channel.on('end', () => channel.close());
                                    channel.resume();
                                    const clock = info.command.endsWith(DEVICE_CLOCK_COMMAND);
                                    if (!clock && info.command !== 'memory-soak') {
                                        channel.exit(127);
                                        channel.end();
                                        return;
                                    }
                                    const pump = (async () => {
                                        try {
                                            if (clock) channel.write(clockOutput());
                                            else
                                                for (let i = 0; i < 2112 && !channel.destroyed; i++)
                                                    await new Promise<void>((resolve, reject) =>
                                                        (i % 2 ? channel.stderr : channel).write(
                                                            Buffer.alloc(16384, 65),
                                                            (error) =>
                                                                error ? reject(error) : resolve(),
                                                        ),
                                                    );
                                            if (!channel.destroyed) {
                                                channel.exit(0);
                                                channel.end();
                                            }
                                        } catch {
                                            channel.close();
                                        }
                                    })();
                                    pumps.add(pump);
                                    void pump.finally(() => pumps.delete(pump));
                                });
                            }),
                        );
                    });
                    await new Promise<void>((resolve, reject) => {
                        target!.once('error', reject);
                        admit();
                        target!.listen(0, '127.0.0.1', () => {
                            target!.removeListener('error', reject);
                            resolve();
                        });
                    });
                    value = {
                        host: '127.0.0.1',
                        port: (target.address() as { port: number }).port,
                        fingerprint: fingerprint(parsed.getPublicSSH()),
                    };
                } else {
                    assert.equal(payload.target?.host, '127.0.0.1');
                    assert.ok(Number.isInteger(payload.target.port));
                    const token = 'test-gateway-token-32-characters-minimum';
                    admit();
                    gateway = createGateway({
                        token,
                        origins: [payload.origin],
                        targets: [payload.target],
                    });
                    gateway.server.on('connection', (socket) => {
                        sockets.add(socket);
                        socket.once('close', () => sockets.delete(socket));
                    });
                    gateway.server.prependListener('request', (_request, response) => {
                        requests.add(response);
                        response.once('close', () => requests.delete(response));
                    });
                    await new Promise<void>((resolve, reject) => {
                        gateway!.server.once('error', reject);
                        admit();
                        gateway!.server.listen(0, '127.0.0.1', () => {
                            gateway!.server.removeListener('error', reject);
                            resolve();
                        });
                    });
                    value = {
                        url: `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`,
                        token,
                        options: {
                            host: payload.target.host,
                            port: payload.target.port,
                            username: 'engineer',
                            auth: 'password',
                            password: 'device-test-password',
                            expectedFingerprint: payload.target.fingerprint,
                        },
                    };
                }
                admit();
                initialized = true;
                await turn();
                await turn();
                timerBaseline = timers.size;
                const runtime = await nodeRuntimeIdentity();
                value = {
                    descriptor: value,
                    runtime: {
                        ...runtime,
                        launch: {
                            argv: process.argv,
                            execArgv: process.execArgv,
                            sshProfile: process.env.HUB_MEMORY_SSH_PROFILE,
                            gcMode: process.env.HUB_MEMORY_HOST_GC,
                            timerStacks: process.env.HUB_MEMORY_HOST_TIMER_STACKS === '1',
                        },
                    },
                    profile: await sshQualificationProfile(),
                };
            } else if (input.action === 'control') {
                assert.ok(initialized && !stopped && extendedTarget);
                value = await extendedTarget.control(input.payload);
            } else {
                assert.ok(initialized);
                if (input.action === 'shutdown') await stop();
                else if (input.action === 'sample') {
                    if ((input.payload as { forceGc?: boolean })?.forceGc) {
                        assert.equal(process.env.HUB_MEMORY_HOST_GC, 'forced');
                        assert.ok(global.gc);
                        global.gc();
                        await turn();
                        global.gc();
                    }
                    await turn();
                    await turn();
                } else {
                    assert.ok(stopped, 'Shutdown must complete before IPC release.');
                    timers.disable();
                    process.removeListener('message', onMessage);
                    process.removeListener('disconnect', onDisconnect);
                }
                value = {
                    runtimeTimerClosure,
                    memory: process.memoryUsage(),
                    resources: resources(),
                    productOwnership: gateway?.ownershipSnapshot ?? null,
                    fixtureOwnership: extendedTarget?.snapshot() ?? null,
                    activeResources: process.getActiveResourcesInfo(),
                    ...(process.env.HUB_MEMORY_HOST_TIMER_STACKS === '1'
                        ? { timerOrigins: timers.origins() }
                        : {}),
                };
            }
            await send({
                version: 1,
                nonce,
                id: input.id,
                pid: process.pid,
                role,
                ok: true,
                value,
            });
            if (input.action === 'release') {
                process.disconnect!();
            }
        })()
            .catch(async (error) => {
                process.exitCode = 1;
                await send({
                    version: 1,
                    nonce,
                    id: input.id,
                    pid: process.pid,
                    role,
                    ok: false,
                    error: String(error).slice(0, 2048),
                    diagnostic: {
                        resources: resources(),
                        timerDetails: timers.snapshot(),
                        activeResources: process.getActiveResourcesInfo(),
                        timerOrigins: timers.origins(),
                    },
                }).catch(() => {});
                await stop().catch(() => {});
                timers.disable();
                process.removeListener('message', onMessage);
                process.removeListener('disconnect', onDisconnect);
                if (process.connected) process.disconnect!();
            })
            .finally(() => {
                busy = false;
            });
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
}
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
    process.argv.some((value) => value.startsWith('--role='))
)
    void runGatewayHost().catch((error) => {
        console.error(error);
        process.exitCode = 1;
        if (process.connected) process.disconnect!();
    });
