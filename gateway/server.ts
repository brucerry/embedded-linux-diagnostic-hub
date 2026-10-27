import { automationRequest } from '../shared/automation';
import { streamRequest } from '../shared/ssh-stream-rpc';
import { consoleRpcRequest, consoleOwner, type ConsoleOwner } from '../shared/console-rpc';
import { collectOptions } from '../shared/diagnostics/network/evidence';
import { APP_VERSION } from '../shared/project';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { SshSession, validateConnection } from '../backend/ssh/session';
import { GatewayTerminal, TerminalHttpError } from './terminal';
import {
    ConnectionFailure,
    connectionAttemptId,
    connectionFailure,
    type ConnectionFailureCode,
} from '../shared/connection';

export interface GatewayTarget {
    host: string;
    port: number;
    fingerprint: string;
}
export interface GatewayConfig {
    token: string;
    origins: string[];
    targets: GatewayTarget[];
    maxSessions?: number;
    idleMs?: number;
}
class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
        public code: ConnectionFailureCode = status === 429 || status === 503
            ? 'network'
            : 'policy',
    ) {
        super(message);
    }
}

export function validateGatewayConfig(config: GatewayConfig) {
    if (!config.token || config.token.length < 32)
        throw new Error('HUB_GATEWAY_TOKEN must contain at least 32 characters.');
    if (
        !config.origins.length ||
        config.origins.some((origin) => {
            try {
                const url = new URL(origin);
                return url.origin !== origin || !['http:', 'https:'].includes(url.protocol);
            } catch {
                return true;
            }
        })
    )
        throw new Error('Configure exact browser origins in HUB_ALLOWED_ORIGINS.');
    if (!config.targets.length)
        throw new Error('Configure at least one allowed device in HUB_TARGETS_JSON.');
    for (const target of config.targets) {
        validateConnection({ ...target, username: 'validation', auth: 'password' });
        if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(target.fingerprint))
            throw new Error(
                'Every allowed device requires its trusted OpenSSH SHA256 fingerprint.',
            );
    }
}

export function createGateway(config: GatewayConfig) {
    validateGatewayConfig(config);
    const tokenHash = createHash('sha256').update(config.token).digest();
    const sessions = new Map<
        string,
        {
            ssh: SshSession;
            terminal: GatewayTerminal;
            touched: number;
            busy: boolean;
            consoleConnection?: string;
            consoleOwnerId?: string;
        }
    >();
    const attempts = new Map<
        string,
        {
            origin: string;
            ssh: SshSession;
            controller: AbortController;
            done: Promise<void>;
            finish(): void;
            sessionId?: string;
            expires?: number;
        }
    >();
    const cancelledAttempts = new Map<string, { origin: string; expires: number }>();
    const maxSessions = config.maxSessions ?? 8;
    let pending = 0;
    let stopping = false;
    let rateWindow = Date.now();
    let requests = 0;
    const inFlight = new Set<SshSession>();
    // Admission maps describe public sessions. This set retains actual transports through cleanup.
    const ownedSessions = new Set<SshSession>();
    const retiringSessions = new Map<SshSession, Promise<void>>();
    function retireSession(ssh: SshSession) {
        const existing = retiringSessions.get(ssh);
        if (existing) return existing;
        ssh.disconnect();
        const task = ssh.joinAutomationCleanup();
        retiringSessions.set(ssh, task);
        void task
            .then(() => {
                retiringSessions.delete(ssh);
                ownedSessions.delete(ssh);
            })
            .catch(() => {}); // Failed cleanup remains owned and is surfaced by close/probes.
        return task;
    }
    const httpSockets = new Set<Socket>();
    const httpSocketClosures = new Map<Socket, Promise<void>>();
    const httpResponses = new Set<ServerResponse>();
    const httpResponseClosures = new Map<ServerResponse, Promise<void>>();
    const httpBodyReaders = new Set<IncomingMessage>();
    const idleMs = config.idleMs ?? 10 * 60_000;
    let cleanupTimerOwned = true;
    const cleanup = setInterval(() => {
        for (const [id, entry] of cancelledAttempts)
            if (entry.expires <= Date.now()) cancelledAttempts.delete(id);
        for (const [id, entry] of attempts) {
            if (
                entry.expires
                    ? entry.expires <= Date.now()
                    : entry.sessionId && !sessions.has(entry.sessionId)
            )
                attempts.delete(id);
        }
        for (const [id, session] of sessions) {
            if (
                !session.busy &&
                !session.ssh.consoleBusy &&
                Date.now() - session.touched > idleMs
            ) {
                void retireSession(session.ssh).catch(() => {});
                sessions.delete(id);
            }
        }
    }, 30_000);
    cleanup.unref();

    const send = (res: ServerResponse, status: number, value: unknown) => {
        if (!res.destroyed && !res.writableEnded) {
            res.writeHead(status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            });
            res.end(JSON.stringify(value));
        }
    };
    const body = (req: IncomingMessage): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
            if (!req.headers['content-type']?.startsWith('application/json')) {
                reject(new ApiError(415, 'Use application/json.'));
                req.resume();
                return;
            }
            let size = 0;
            let failed = false;
            const chunks: Buffer[] = [];
            httpBodyReaders.add(req);
            const cleanup = () => {
                httpBodyReaders.delete(req);
                req.off('data', data);
                req.off('error', interrupted);
                req.off('aborted', interrupted);
                req.off('end', end);
                req.off('close', closed);
            };
            const data = (chunk: Buffer) => {
                if (failed) return;
                size += chunk.length;
                if (size > 512 * 1024) {
                    failed = true;
                    reject(new ApiError(413, 'Request exceeds 512 KiB.'));
                    return;
                }
                chunks.push(chunk);
            };
            const interrupted = () => {
                failed = true;
                reject(new ApiError(400, 'Request interrupted.'));
            };
            const closed = () => {
                if (!req.complete) interrupted();
                cleanup();
            };
            const end = () => {
                cleanup();
                if (failed) return;
                try {
                    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (!value || typeof value !== 'object' || Array.isArray(value))
                        throw new Error();
                    resolve(value as Record<string, unknown>);
                } catch {
                    reject(new ApiError(400, 'Invalid JSON request.'));
                }
            };
            req.on('data', data);
            req.on('error', interrupted);
            req.on('aborted', interrupted);
            req.on('end', end);
            req.once('close', closed);
        });

    const requestTasks = new Set<Promise<unknown>>();
    const server = http.createServer((req, res) => {
        httpResponses.add(res);
        httpResponseClosures.set(
            res,
            new Promise<void>((resolve) =>
                res.once('close', () => {
                    httpResponses.delete(res);
                    httpResponseClosures.delete(res);
                    resolve();
                }),
            ),
        );
        const task = handle(req, res).catch((error: unknown) =>
            send(
                res,
                error instanceof ApiError || error instanceof TerminalHttpError
                    ? error.status
                    : error instanceof ConnectionFailure && error.code === 'policy'
                      ? 400
                      : 502,
                {
                    error: error instanceof Error ? error.message : 'Gateway request failed.',
                    code: error instanceof ApiError ? error.code : connectionFailure(error).code,
                },
            ),
        );
        requestTasks.add(task);
        void task.finally(() => requestTasks.delete(task)).catch(() => {});
    });
    server.on('connection', (socket) => {
        httpSockets.add(socket);
        httpSocketClosures.set(
            socket,
            new Promise<void>((resolve) =>
                socket.once('close', () => {
                    httpSockets.delete(socket);
                    httpSocketClosures.delete(socket);
                    resolve();
                }),
            ),
        );
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 50;

    async function handle(req: IncomingMessage, res: ServerResponse) {
        const origin = req.headers.origin;
        if (typeof origin !== 'string' || !config.origins.includes(origin))
            throw new ApiError(403, 'This website origin is not allowed.');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('Access-Control-Max-Age', '600');
            send(res, 204, null);
            return;
        }
        const authorization = req.headers.authorization;
        if (
            typeof authorization !== 'string' ||
            !authorization.startsWith('Bearer ') ||
            !timingSafeEqual(
                createHash('sha256').update(authorization.slice(7)).digest(),
                tokenHash,
            )
        )
            throw new ApiError(401, 'Invalid gateway access token.');
        if (stopping) throw new ApiError(503, 'Gateway is shutting down.');
        if (Date.now() - rateWindow >= 60_000) {
            requests = 0;
            rateWindow = Date.now();
        }
        const url = new URL(req.url || '/', 'http://gateway.local');
        const terminalTraffic =
            req.method === 'POST' &&
            /^\/api\/sessions\/[A-Za-z0-9_-]{32}\/terminal\/[A-Za-z0-9_-]{16,64}\/(input|resize)$/.test(
                url.pathname,
            );
        const cancellationTraffic =
            req.method === 'POST' && url.pathname === '/api/connection-attempts/cancel';
        const streamCreditTraffic =
            req.method === 'POST' &&
            /^\/api\/sessions\/[A-Za-z0-9_-]{32}\/automation\/stream\/(read|ack|cancel|finalize)$/.test(
                url.pathname,
            );
        const consoleCreditTraffic =
            req.method === 'POST' &&
            /^\/api\/sessions\/[A-Za-z0-9_-]{32}\/automation\/console\/(read|ack|status|step|finish|release|heartbeat)$/.test(
                url.pathname,
            );
        if (
            !terminalTraffic &&
            !cancellationTraffic &&
            !streamCreditTraffic &&
            !consoleCreditTraffic &&
            ++requests > 120
        )
            throw new ApiError(429, 'Gateway request limit reached. Try again in a minute.');
        if (req.method === 'GET' && url.pathname === '/api/health') {
            send(res, 200, {
                version: APP_VERSION,
                activeSessions: sessions.size,
                connectionCancellation: true,
            });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/connection-attempts/cancel') {
            const payload = await body(req);
            const attemptId = connectionAttemptId(payload.attemptId);
            const attempt = attempts.get(attemptId);
            const old = cancelledAttempts.get(attemptId);
            if ((attempt && attempt.origin !== origin) || (old && old.origin !== origin))
                throw new ApiError(403, 'This connection attempt belongs to another origin.');
            const retainAttempt = !old && cancelledAttempts.size >= 128;
            if (retainAttempt && !attempt)
                throw new ApiError(429, 'Connection cancellation capacity is temporarily full.');
            if (retainAttempt && attempt) attempt.expires = Date.now() + 240_000;
            else cancelledAttempts.set(attemptId, { origin, expires: Date.now() + 240_000 });
            if (attempt) {
                attempt.controller.abort();
                const retired = retireSession(attempt.ssh);
                await attempt.done;
                await retired;
                if (attempt.sessionId) sessions.delete(attempt.sessionId);
                if (!retainAttempt) attempts.delete(attemptId);
            }
            send(res, 200, { cancelled: true });
            return;
        }

        if (
            req.method === 'POST' &&
            (url.pathname === '/api/fingerprint' || url.pathname === '/api/sessions')
        ) {
            const payload = await body(req);
            let options;
            try {
                options = validateConnection(payload);
            } catch (error) {
                throw new ApiError(400, (error as Error).message);
            }
            const target = config.targets.find(
                (item) => item.host === options.host && item.port === options.port,
            );
            if (!target)
                throw new ApiError(
                    403,
                    'This device address and port are not in the gateway allowlist.',
                );
            let privateKey: Buffer | undefined;
            if (url.pathname === '/api/sessions' && options.auth === 'key') {
                if (
                    typeof payload.privateKey !== 'string' ||
                    !payload.privateKey.trim() ||
                    Buffer.byteLength(payload.privateKey, 'utf8') > 65536
                )
                    throw new ApiError(400, 'Select an SSH private key of at most 64 KiB.');
                privateKey = Buffer.from(payload.privateKey, 'utf8');
            }
            delete payload.privateKey;
            if (
                url.pathname === '/api/sessions' &&
                payload.expectedFingerprint !== target.fingerprint
            )
                throw new ApiError(
                    409,
                    'Verify the configured device fingerprint before connecting.',
                );
            if (stopping) throw new ApiError(503, 'Gateway is shutting down.');
            if (sessions.size + pending + retiringSessions.size >= maxSessions)
                throw new ApiError(429, 'All gateway session slots are in use.');
            const attemptId =
                url.pathname === '/api/sessions' && payload.attemptId !== undefined
                    ? connectionAttemptId(payload.attemptId)
                    : undefined;
            if (attemptId && (attempts.has(attemptId) || cancelledAttempts.has(attemptId)))
                throw new ApiError(409, 'This connection attempt is no longer active.');
            if (attemptId && attempts.size >= 128)
                throw new ApiError(429, 'Connection attempt capacity is temporarily full.');
            pending++;
            const id = randomBytes(24).toString('base64url');
            const ssh = new SshSession(() => {
                if (!ssh.consoleBusy) {
                    sessions.delete(id);
                    void retireSession(ssh).catch(() => {});
                }
            });
            ownedSessions.add(ssh);
            let finishAttempt!: () => void;
            const attempt = attemptId
                ? {
                      origin,
                      ssh,
                      controller: new AbortController(),
                      done: new Promise<void>((resolve) => {
                          finishAttempt = resolve;
                      }),
                      finish: () => finishAttempt(),
                      sessionId: undefined as string | undefined,
                  }
                : undefined;
            if (attemptId && attempt) attempts.set(attemptId, attempt);
            inFlight.add(ssh);
            let accepted = false;
            let observed = '';
            const aborted = () => {
                if (!res.writableEnded) void retireSession(ssh).catch(() => {});
            };
            res.on('close', aborted);
            try {
                if (url.pathname === '/api/fingerprint') {
                    try {
                        await ssh.connect(
                            { ...options, auth: 'password', password: '', passphrase: undefined },
                            async (received) => {
                                observed = received;
                                return false;
                            },
                        );
                    } catch {
                        if (!observed)
                            throw new ApiError(
                                502,
                                'Could not read the device host key. Check address, port and gateway network access.',
                            );
                    }
                    if (observed !== target.fingerprint)
                        throw new ApiError(
                            409,
                            'SSH host key does not match the gateway configuration. Verify the device with the administrator.',
                        );
                    send(res, 200, { fingerprint: observed });
                } else {
                    await ssh.connect(
                        options,
                        async (received) => {
                            observed = received;
                            return received === target.fingerprint;
                        },
                        privateKey,
                        attempt?.controller.signal,
                    );
                    if (stopping || res.destroyed || attempt?.controller.signal.aborted) return;
                    sessions.set(id, {
                        ssh,
                        terminal: new GatewayTerminal(ssh),
                        touched: Date.now(),
                        busy: false,
                    });
                    accepted = true;
                    if (attempt) attempt.sessionId = id;
                    send(res, 201, { sessionId: id });
                }
            } catch (error) {
                if (observed && observed !== target.fingerprint)
                    throw new ApiError(409, 'SSH host key changed. The connection was rejected.');
                throw error;
            } finally {
                res.removeListener('close', aborted);
                pending--;
                inFlight.delete(ssh);
                options.password = undefined;
                options.passphrase = undefined;
                privateKey?.fill(0);
                try {
                    if (!accepted) {
                        await retireSession(ssh);
                        if (attemptId && !attempts.get(attemptId)?.expires)
                            attempts.delete(attemptId);
                    }
                } finally {
                    attempt?.finish();
                }
            }
            return;
        }

        const match = url.pathname.match(
            /^\/api\/sessions\/([A-Za-z0-9_-]{32})(\/(?:clock|network-cache|snapshot|heartbeat|automation(?:\/(?:cancel|stream\/(?:capabilities|start|read|ack|cancel|finalize)|console\/(?:capabilities|open|status|step|read|ack|finish|release|heartbeat)))?|terminal(?:\/[^/]+(?:\/(?:input|resize))?)?))?$/,
        );
        if (match) {
            const active = sessions.get(match[1]);
            if (!active)
                throw new ApiError(
                    404,
                    'Session expired or the device disconnected. Reconnect to collect.',
                );
            active.touched = Date.now();
            if (req.method === 'POST' && match[2]?.startsWith('/automation/console/')) {
                let request;
                try {
                    request = consoleRpcRequest(await body(req));
                } catch {
                    throw new ApiError(400, 'Invalid console request.');
                }
                if (match[2] !== '/automation/console/' + request.action)
                    throw new ApiError(400, 'Console action mismatch.');
                if (request.action !== 'capabilities') {
                    if (request.connection !== match[1])
                        throw new ApiError(409, 'Console connection changed.');
                    if (request.action === 'open') {
                        if (active.busy) throw new ApiError(409, 'Wait for the current operation.');
                    }
                    request = {
                        ...request,
                        connection:
                            request.action === 'open'
                                ? active.ssh.automationConnection
                                : (active.consoleConnection ?? active.ssh.automationConnection),
                    };
                }
                let owner: ConsoleOwner | undefined =
                    request.action !== 'capabilities' && request.action !== 'open'
                        ? consoleOwner({
                              id: request.id,
                              connection: request.connection,
                              capability: request.capability,
                          })
                        : undefined;
                let responseLost = false;
                const lost = () => {
                    if (!res.writableEnded) {
                        responseLost = true;
                        if (owner) active.ssh.consoleTransportLost(owner);
                    }
                };
                if (request.action !== 'capabilities') res.on('close', lost);
                try {
                    let result = await active.ssh.automationConsole(request, 'gateway');
                    if (request.action === 'open') {
                        const value = result as {
                            id: string;
                            connection: string;
                            capability: string;
                        };
                        owner = consoleOwner({
                            id: value.id,
                            connection: value.connection,
                            capability: value.capability,
                        });
                        active.consoleConnection = owner.connection;
                        active.consoleOwnerId = owner.id;
                        if (responseLost || res.destroyed) active.ssh.consoleTransportLost(owner);
                        result = { ...(result as object), connection: match[1] };
                    }
                    if (request.action === 'release') {
                        if (active.consoleOwnerId === request.id) {
                            active.consoleConnection = undefined;
                            active.consoleOwnerId = undefined;
                        }
                        if (!active.ssh.isConnected) sessions.delete(match[1]);
                    }
                    if (!res.destroyed) send(res, 200, result);
                } finally {
                    res.off('close', lost);
                    active.touched = Date.now();
                }
                return;
            }
            if (req.method === 'POST' && match[2]?.startsWith('/automation/stream/')) {
                let request;
                try {
                    request = streamRequest(await body(req));
                } catch {
                    throw new ApiError(400, 'Invalid SSH stream request.');
                }
                if (match[2] !== '/automation/stream/' + request.action)
                    throw new ApiError(400, 'SSH stream action mismatch.');
                if (request.action !== 'capabilities') {
                    const connection =
                        request.action === 'start'
                            ? request.request.connection
                            : request.connection;
                    if (connection !== match[1])
                        throw new ApiError(409, 'SSH stream connection changed.');
                    if (request.action === 'start') {
                        if (active.busy) throw new ApiError(409, 'Wait for the current operation.');
                        request = {
                            ...request,
                            request: {
                                ...request.request,
                                connection: active.ssh.automationConnection,
                            },
                        };
                    } else request = { ...request, connection: active.ssh.automationConnection };
                }
                const lost = () => {
                    if (!res.writableEnded) {
                        void retireSession(active.ssh).catch(() => {});
                        sessions.delete(match[1]);
                    }
                };
                if (request.action === 'read') res.on('close', lost);
                try {
                    const result = await active.ssh.automationStream(request, 'gateway');
                    if (!res.destroyed) send(res, 200, result);
                } finally {
                    res.off('close', lost);
                    active.touched = Date.now();
                }
                return;
            }
            if (
                match[2]?.startsWith('/terminal') &&
                (await active.terminal.handle(
                    req,
                    res,
                    match[2],
                    () => body(req),
                    (status, payload) => send(res, status, payload),
                ))
            )
                return;
            if (req.method === 'DELETE' && !match[2]) {
                if (active.busy || active.ssh.consoleBusy)
                    throw new ApiError(409, 'Wait for the current device operation to finish.');
                await retireSession(active.ssh);
                sessions.delete(match[1]);
                send(res, 200, { disconnected: true });
                return;
            }
            if (req.method === 'POST' && match[2] === '/automation/cancel') {
                const data = (await body(req)) as { id: string; connection: string };
                if (
                    !data ||
                    data.connection !== match[1] ||
                    Object.keys(data).some((k) => !['id', 'connection'].includes(k))
                )
                    throw new ApiError(400, 'Invalid automation cancellation.');
                active.ssh.cancelAutomation(data.id, active.ssh.automationConnection);
                send(res, 200, { ok: true });
                return;
            }
            if (req.method === 'POST' && match[2] === '/automation') {
                let request;
                try {
                    request = automationRequest(await body(req));
                } catch {
                    throw new ApiError(400, 'Invalid automation request.');
                }
                if (request.connection !== match[1])
                    throw new ApiError(409, 'Automation connection changed.');
                if (active.busy)
                    throw new ApiError(409, 'Wait for collection or automation to finish.');
                active.busy = true;
                const internalConnection = active.ssh.automationConnection;
                const aborted = () => {
                    if (!res.writableEnded) {
                        try {
                            active.ssh.cancelAutomation(request.id, internalConnection);
                        } catch {}
                    }
                };
                res.on('close', aborted);
                try {
                    const result = await active.ssh.runAutomation({
                        ...request,
                        connection: internalConnection,
                    });
                    if (!res.destroyed) send(res, 200, result);
                } finally {
                    active.busy = false;
                    active.touched = Date.now();
                    res.removeListener('close', aborted);
                }
                return;
            }
            if (req.method === 'POST' && match[2] === '/heartbeat') {
                send(res, 200, { connected: true });
                return;
            }
            if (req.method === 'POST' && match[2] === '/clock') {
                if (
                    req.headers['transfer-encoding'] ||
                    Number(req.headers['content-length'] ?? 0) > 0
                ) {
                    req.resume();
                    throw new ApiError(400, 'Device clock reads do not accept request data.');
                }
                const controller = new AbortController();
                const aborted = () => {
                    if (!res.writableEnded) controller.abort();
                };
                res.on('close', aborted);
                try {
                    const result = await active.ssh.readClock(controller.signal);
                    if (!controller.signal.aborted) send(res, 200, result);
                } finally {
                    active.touched = Date.now();
                    res.removeListener('close', aborted);
                }
                return;
            }
            if (req.method === 'POST' && match[2] === '/network-cache') {
                if (active.busy)
                    throw new ApiError(
                        409,
                        'Wait for collection before clearing capability cache.',
                    );
                if (
                    Number(req.headers['content-length'] ?? 0) > 0 ||
                    req.headers['transfer-encoding']
                ) {
                    req.resume();
                    throw new ApiError(400, 'Capability cache reset accepts no request data.');
                }
                active.ssh.clearNetworkCache();
                send(res, 200, { ok: true });
                return;
            }
            if (req.method === 'POST' && match[2] === '/snapshot') {
                if (active.busy)
                    throw new ApiError(409, 'Collection is paused while device work is running.');
                active.busy = true;
                const aborted = () => {
                    if (!res.writableEnded) {
                        void retireSession(active.ssh).catch(() => {});
                        sessions.delete(match[1]);
                    }
                };
                res.on('close', aborted);
                try {
                    const parseCollection = (value: unknown) => {
                        try {
                            return collectOptions(value);
                        } catch {
                            throw new ApiError(400, 'Invalid collection options.');
                        }
                    };
                    const options = parseCollection(
                        Number(req.headers['content-length'] ?? 0) > 0 ||
                            req.headers['transfer-encoding']
                            ? await body(req)
                            : undefined,
                    );
                    send(res, 200, await active.ssh.collect(options));
                } finally {
                    active.busy = false;
                    active.touched = Date.now();
                    res.removeListener('close', aborted);
                }
                return;
            }
        }
        throw new ApiError(404, 'Unknown gateway route.');
    }

    let closing: Promise<void> | undefined;
    function close(): Promise<void> {
        if (closing) return closing;
        const task = (async () => {
            stopping = true;
            clearInterval(cleanup);
            cleanupTimerOwned = false;
            const closingSessions = new Set(
                [...sessions.values()]
                    .map((active) => active.ssh)
                    .concat(
                        [...inFlight],
                        [...ownedSessions],
                        [...attempts.values()].map((attempt) => attempt.ssh),
                    ),
            );
            for (const attempt of attempts.values()) attempt.controller.abort();
            const serverClosed = server.listening
                ? new Promise<void>((resolve, reject) =>
                      server.close((error) => (error ? reject(error) : resolve())),
                  )
                : Promise.resolve();
            server.closeAllConnections();
            const cleanupResults = await Promise.allSettled(
                [...closingSessions].map((ssh) => ssh.shutdownConsole()),
            );
            const joinedResults = await Promise.allSettled(
                [...closingSessions].map((ssh) => retireSession(ssh)),
            );
            await Promise.all([...attempts.values()].map((attempt) => attempt.done));
            while (requestTasks.size) await Promise.allSettled([...requestTasks]);
            await serverClosed;
            while (httpSocketClosures.size || httpResponseClosures.size)
                await Promise.all([
                    ...httpSocketClosures.values(),
                    ...httpResponseClosures.values(),
                ]);
            const failures = [...cleanupResults, ...joinedResults]
                .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                .map((result) => result.reason);
            if (failures.length)
                throw new AggregateError(failures, 'Gateway console cleanup remains pending.');
            sessions.clear();
            attempts.clear();
            cancelledAttempts.clear();
        })();
        closing = task;
        void task.catch(() => {
            if (closing === task) closing = undefined;
        });
        return task;
    }
    return {
        server,
        close,
        get ownershipSnapshot() {
            return {
                stopping,
                serverListening: server.listening,
                cleanupTimers: cleanupTimerOwned ? 1 : 0,
                requestTasks: requestTasks.size,
                httpSockets: httpSockets.size,
                httpResponses: httpResponses.size,
                httpBodyReaders: httpBodyReaders.size,
                pendingConnections: pending,
                sessions: sessions.size,
                inFlight: inFlight.size,
                ownedSessions: ownedSessions.size,
                retiringSessions: retiringSessions.size,
                connectionAttempts: attempts.size,
                cancelledAttemptCache: cancelledAttempts.size,
                sessionOwners: [...sessions.values()].map((active) => active.ssh.ownershipSnapshot),
                allSessionOwners: [...ownedSessions].map((ssh) => ssh.ownershipSnapshot),
            };
        },
    };
}
