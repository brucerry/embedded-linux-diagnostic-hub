import { writeFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import type { gatewayFixture } from '../../fixtures/gateway';
import { generateKeyPairSync } from 'node:crypto';
import { Server, utils, type Session, type ServerChannel } from 'ssh2';
import { fingerprint } from '../../../backend/ssh/session';
import { createGateway } from '../../../gateway/server';
import { probes } from '../../../shared/diagnostics/probes';
import { demoSnapshot } from '../../fixtures/snapshots';
import { attachTerminalFixture, terminalFixtureState } from '../../fixtures/terminal';
import { DEVICE_CLOCK_COMMAND } from '../../../shared/diagnostics/device-clock';
import { clockOutput } from '../../fixtures/device-clock';


// Test-only owner is published before crypto, listeners or gateway acquisition.
// No fixture listener/key/journal is acquired on import; ssh2 initialization is reviewed separately.
type PublicGateway = Awaited<ReturnType<typeof gatewayFixture>>;
async function listenLoopback(server: Server | HttpServer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready);
        try { server.listen(0, '127.0.0.1'); }
        catch (error) { server.off('error', failed); server.off('listening', ready); reject(error); }
    });
}
export function allocateLoopbackGateway() {
    const scope = process.env.HUB_LOOPBACK_CONSOLE_SCOPE;
    const expected = path.join(process.env.RUNNER_TEMP ?? '', `lc-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
    if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux' ||
        !scope || !path.isAbsolute(scope) || scope !== expected || lstatSync(scope).isSymbolicLink() || realpathSync(scope) !== scope)
        throw Error('Missing fresh owned loopback CI scope.');
    const journal = path.join(scope, 'ownership.json');
    let sshServer: Server | undefined;
    let gateway: ReturnType<typeof createGateway> | undefined;
    let startTask: Promise<PublicGateway> | undefined;
    let closeTask: Promise<void> | undefined;
    let closing = false, journalFailed = false, journalCreated = false;
    const clients = new Set<unknown>();
    const state = { phase: 'allocated', sshCreated: false, sshBound: false,
        gatewayCreated: false, gatewayBound: false, listenerError: false,
        sshCloseAcknowledged: false, gatewayCloseAcknowledged: false,
        cleanupAcknowledged: false, fileHandles: 0, failedFileCloses: 0 };
    const snapshot = () => {
        const g = gateway?.ownershipSnapshot;
        return { ...state, closing, journalFailed, sshClients: clients.size,
            sshListening: sshServer?.listening ?? false,
            gateway: g ? { serverListening: g.serverListening, cleanupTimers: g.cleanupTimers,
                requestTasks: g.requestTasks, httpSockets: g.httpSockets, httpResponses: g.httpResponses,
                httpBodyReaders: g.httpBodyReaders, pendingConnections: g.pendingConnections,
                sessions: g.sessions, inFlight: g.inFlight, ownedSessions: g.ownedSessions,
                retiringSessions: g.retiringSessions, connectionAttempts: g.connectionAttempts } : null };
    };
    const record = () => {
        try {
            const text = JSON.stringify(snapshot());
            if (Buffer.byteLength(text) > 8192) throw Error('Ownership journal exceeds 8 KiB.');
            writeFileSync(journal, text, { flag: journalCreated ? 'w' : 'wx' });
            journalCreated = true;
        } catch { journalFailed = true; }
    };
    record();
    if (journalFailed) throw Error('Exclusive loopback ownership journal could not be created.');
    const fileOpened = () => { state.fileHandles++; record(); };
    const fileClosed = () => { state.fileHandles--; record(); };
    const fileCloseFailed = () => { state.failedFileCloses++; record(); };
    function closeOwned(): Promise<void> {
        if (closeTask) return closeTask;
        closing = true; state.phase = 'closing'; record();
        closeTask = (async () => {
            // start never awaits close; freezing admission prevents late HTTP acquisition.
            await startTask?.catch(() => undefined);
            const tasks: Promise<void>[] = [];
            if (gateway) tasks.push(Promise.resolve().then(() => gateway!.close()).then(() => {
                state.gatewayCloseAcknowledged = true; record();
            }));
            else state.gatewayCloseAcknowledged = true;
            if (sshServer) tasks.push(new Promise<void>((resolve, reject) => {
                sshServer!.close((error?: Error) => {
                    if (error && !(error instanceof Error && 'code' in error && error.code === 'ERR_SERVER_NOT_RUNNING' && clients.size === 0)) {
                        reject(error); return;
                    }
                    state.sshCloseAcknowledged = true; record(); resolve();
                });
            }));
            else state.sshCloseAcknowledged = true;
            // Start both retirements before joining either; rejection never skips the other owner.
            const results = await Promise.allSettled(tasks);
            const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason);
            if (clients.size || state.fileHandles || state.failedFileCloses || journalFailed)
                errors.push(Error('Loopback resource or evidence retirement remains unacknowledged.'));
            state.cleanupAcknowledged = errors.length === 0 && state.sshCloseAcknowledged && state.gatewayCloseAcknowledged;
            state.phase = state.cleanupAcknowledged ? 'closed' : 'blocked'; record();
            if (journalFailed && errors.length === 0) errors.push(Error('Final ownership journal was not acknowledged.'));
            if (errors.length) throw new AggregateError(errors, 'Loopback fixture cleanup failed; no retry or forced disposition.');
        })();
        void closeTask.catch(() => {});
        return closeTask;
    }
    const start = (idleMs?: number, options: Parameters<typeof gatewayFixture>[1] = {}): Promise<PublicGateway> => {
        if (startTask || closing) throw Error('Loopback fixture start admission refused.');
        const origin = new URL(options.origin ?? '');
        if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== options.origin)
            throw Error('Loopback origin must be exact HTTP localhost origin.');
        state.phase = 'starting'; record();
        startTask = (async (): Promise<PublicGateway> => {
            const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
                format: 'pem',
                type: 'pkcs1',
            });
            const parsed = utils.parseKey(key);
            if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid test key.');
            const pinned = fingerprint(parsed.getPublicSSH());
            const clientKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
            const allowedKey = utils.parseKey(clientKey.export({ format: 'pem', type: 'pkcs1' }));
            if (allowedKey instanceof Error || Array.isArray(allowedKey))
                throw new Error('Invalid client key.');
            const passphrase = 'fixture-key-passphrase';
            const privateKey = clientKey
                .export({ format: 'pem', type: 'pkcs1', cipher: 'aes-256-cbc', passphrase })
                .toString();
            const data = demoSnapshot();
            let authentications = 0;
            let connectedSessions = 0;
            let probeExecutions = 0;
            const clock = {
                output: clockOutput(),
                stderr: '',
                exitCode: 0,
                delayMs: 0,
                stall: false,
                calls: 0,
                active: 0,
                closed: 0,
            };
            const terminal = terminalFixtureState();
            const activeServer = new Server({ hostKeys: [key] }, (client) => {
                clients.add(client); record();
                client.once('close', () => { clients.delete(client); record(); });
                let connected = false;
                client.on('ready', () => {
                    connected = true;
                    connectedSessions++;
                });
                client.on('close', () => {
                    if (connected) connectedSessions--;
                });
                client.on('error', () => {});
                client.on('authentication', (auth) => {
                    authentications++;
                    const finish = () => {
                        if (
                            auth.method === 'password' &&
                            auth.username === 'engineer' &&
                            auth.password === 'device-test-password'
                        )
                            auth.accept();
                        else if (
                            auth.method === 'publickey' &&
                            auth.username === 'engineer' &&
                            auth.key.data.equals(allowedKey.getPublicSSH()) &&
                            (!auth.signature ||
                                (auth.blob && allowedKey.verify(auth.blob, auth.signature, auth.hashAlgo)))
                        )
                            auth.accept();
                        else auth.reject();
                    };
                    if (options.authenticationDelayMs) {
                        const timer = setTimeout(finish, options.authenticationDelayMs);
                        client.once('close', () => clearTimeout(timer));
                    } else finish();
                });
                client.on('ready', () =>
                    client.on('session', (accept) => {
                        const session = accept();
                        if (options.attachShell) options.attachShell(session);
                        else attachTerminalFixture(session, terminal);
                        session.on('exec', (acceptExec, _reject, info) => {
                            const channel = acceptExec();
                            if (options.exec?.(info.command, channel)) return;
                            if (info.command.endsWith(DEVICE_CLOCK_COMMAND)) {
                                channel.resume();
                                channel.on('end', () => channel.close());
                                clock.calls++;
                                clock.active++;
                                channel.on('close', () => {
                                    clock.active--;
                                    clock.closed++;
                                });
                                if (clock.stall) return;
                                const reply = {
                                    output: clock.output,
                                    stderr: clock.stderr,
                                    exitCode: clock.exitCode,
                                };
                                const respondClock = () => {
                                    if (channel.destroyed) return;
                                    channel.write(reply.output);
                                    channel.stderr.write(reply.stderr);
                                    channel.exit(reply.exitCode);
                                    channel.end();
                                    channel.close();
                                };
                                if (clock.delayMs) setTimeout(respondClock, clock.delayMs);
                                else respondClock();
                                return;
                            }
                            probeExecutions++;
                            const probe = probes.find((item) => info.command.endsWith(item.command));
                            const result = data.results.find((item) => item.id === probe?.id);
                            const respond = () => {
                                if (result) {
                                    channel.write(options.probeOutput?.stdout ?? result.stdout);
                                    channel.stderr.write(options.probeOutput?.stderr ?? result.stderr);
                                    channel.exit(result.exitCode ?? 1);
                                } else channel.exit(127);
                                channel.end();
                            };
                            if (options.probeDelayMs) setTimeout(respond, options.probeDelayMs);
                            else respond();
                        });
                    }),
                );
            });
            sshServer = activeServer; state.sshCreated = true;
            activeServer.on('error', () => { state.listenerError = true; record(); });
            record();
            await listenLoopback(activeServer);
            state.sshBound = true; record();
            if (closing) throw Error('Loopback admission frozen before activeGateway acquisition.');
            const sshPort = (activeServer.address() as { port: number }).port;
            const token = 'test-gateway-token-32-characters-minimum';
            const origins = [options.origin ?? process.env.HUB_TEST_ORIGIN ?? 'http://127.0.0.1:5173'];
            const targets = [{ host: '127.0.0.1', port: sshPort, fingerprint: pinned }];
            const activeGateway = createGateway({ token, origins, targets, idleMs });
            gateway = activeGateway; state.gatewayCreated = true; record();
            activeGateway.server.on('error', () => { state.listenerError = true; record(); });
            await listenLoopback(activeGateway.server);
            state.gatewayBound = true; record();
            if (closing) throw Error('Loopback admission frozen after gateway bind.');
            const url = `http://127.0.0.1:${(activeGateway.server.address() as { port: number }).port}`;
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
                get ownershipSnapshot() {
                    return activeGateway.ownershipSnapshot;
                },
                closeGateway: closeOwned,
                clock,
                terminal,
                token,
                privateKey,
                passphrase,
                pinned,
                url,
                options: {
                    host: '127.0.0.1',
                    port: sshPort,
                    username: 'engineer',
                    auth: 'password' as const,
                    password: 'device-test-password',
                    expectedFingerprint: pinned,
                },
                request,
                authentications: () => authentications,
                connectedSessions: () => connectedSessions,
                probeExecutions: () => probeExecutions,
                close: closeOwned,
            };
        })().then(value => { state.phase = closing ? 'closing' : 'ready'; record(); return value; }, error => {
            state.phase = 'start-failed'; record(); throw error;
        });
        void startTask.catch(() => {});
        return startTask;
    };
    return { start, close: closeOwned, snapshot, fileOpened, fileClosed, fileCloseFailed };
}
