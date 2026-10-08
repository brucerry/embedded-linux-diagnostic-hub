import { APP_VERSION } from '../shared/project';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { SshSession, validateConnection } from '../backend/ssh/session';

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
    const sessions = new Map<string, { ssh: SshSession; touched: number; busy: boolean }>();
    const maxSessions = config.maxSessions ?? 8;
    let pending = 0;
    let stopping = false;
    let rateWindow = Date.now();
    let requests = 0;
    const inFlight = new Set<SshSession>();
    const idleMs = config.idleMs ?? 10 * 60_000;
    const cleanup = setInterval(() => {
        for (const [id, session] of sessions) {
            if (!session.busy && Date.now() - session.touched > idleMs) {
                session.ssh.disconnect();
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
            req.on('data', (chunk: Buffer) => {
                if (failed) return;
                size += chunk.length;
                if (size > 512 * 1024) {
                    failed = true;
                    reject(new ApiError(413, 'Request exceeds 512 KiB.'));
                    return;
                }
                chunks.push(chunk);
            });
            req.on('error', () => reject(new ApiError(400, 'Request interrupted.')));
            req.on('end', () => {
                if (failed) return;
                try {
                    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (!value || typeof value !== 'object' || Array.isArray(value))
                        throw new Error();
                    resolve(value as Record<string, unknown>);
                } catch {
                    reject(new ApiError(400, 'Invalid JSON request.'));
                }
            });
        });

    const server = http.createServer((req, res) => {
        void handle(req, res).catch((error: unknown) =>
            send(res, error instanceof ApiError ? error.status : 502, {
                error: error instanceof Error ? error.message : 'Gateway request failed.',
            }),
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
        if (++requests > 120)
            throw new ApiError(429, 'Gateway request limit reached. Try again in a minute.');
        const url = new URL(req.url || '/', 'http://gateway.local');
        if (req.method === 'GET' && url.pathname === '/api/health') {
            send(res, 200, { version: APP_VERSION, activeSessions: sessions.size });
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
            if (sessions.size + pending >= maxSessions)
                throw new ApiError(429, 'All gateway session slots are in use.');
            pending++;
            const id = randomBytes(24).toString('base64url');
            const ssh = new SshSession(() => sessions.delete(id));
            inFlight.add(ssh);
            let accepted = false;
            let observed = '';
            const aborted = () => {
                if (!res.writableEnded) ssh.disconnect();
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
                    );
                    if (stopping || res.destroyed) return;
                    sessions.set(id, { ssh, touched: Date.now(), busy: false });
                    accepted = true;
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
                if (!accepted) ssh.disconnect();
            }
            return;
        }

        const match = url.pathname.match(
            /^\/api\/sessions\/([A-Za-z0-9_-]{32})(\/(?:snapshot|heartbeat))?$/,
        );
        if (match) {
            const active = sessions.get(match[1]);
            if (!active)
                throw new ApiError(
                    404,
                    'Session expired or the device disconnected. Reconnect to collect.',
                );
            active.touched = Date.now();
            if (req.method === 'DELETE' && !match[2]) {
                if (active.busy)
                    throw new ApiError(409, 'Wait for the current device operation to finish.');
                active.ssh.disconnect();
                sessions.delete(match[1]);
                send(res, 200, { disconnected: true });
                return;
            }
            if (req.method === 'POST' && match[2] === '/heartbeat') {
                send(res, 200, { connected: true });
                return;
            }
            if (req.method === 'POST' && match[2] === '/snapshot') {
                if (active.busy) throw new ApiError(409, 'A collection is already running.');
                active.busy = true;
                const aborted = () => {
                    if (!res.writableEnded) {
                        active.ssh.disconnect();
                        sessions.delete(match[1]);
                    }
                };
                res.on('close', aborted);
                try {
                    send(res, 200, await active.ssh.collect());
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

    async function close() {
        stopping = true;
        clearInterval(cleanup);
        for (const active of sessions.values()) active.ssh.disconnect();
        for (const ssh of inFlight) ssh.disconnect();
        sessions.clear();
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return { server, close };
}
