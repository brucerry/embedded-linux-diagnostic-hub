import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SshSession } from '../backend/ssh/session';
import { terminalId, terminalSize, terminalData, type TerminalOpen } from '../shared/terminal';

export class TerminalHttpError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

export class GatewayTerminal {
    private response?: ServerResponse;
    private id = '';
    private tokens = 120;
    private lastRefill = Date.now();
    private byteWindow = Date.now();
    private inputBytes = 0;

    constructor(private ssh: SshSession) {}

    private limit(bytes = 0) {
        const now = Date.now();
        this.tokens = Math.min(120, this.tokens + ((now - this.lastRefill) * 60) / 1000);
        this.lastRefill = now;
        if (now - this.byteWindow >= 1000) {
            this.byteWindow = now;
            this.inputBytes = 0;
        }
        if (this.tokens < 1 || this.inputBytes + bytes > 256 * 1024)
            throw new TerminalHttpError(
                429,
                'Terminal input limit reached. Wait before typing or pasting more.',
            );
        this.tokens--;
        this.inputBytes += bytes;
    }

    async handle(
        req: IncomingMessage,
        res: ServerResponse,
        suffix: string,
        readBody: () => Promise<Record<string, unknown>>,
        send: (status: number, payload: unknown) => void,
    ): Promise<boolean> {
        if (suffix === '/terminal' && req.method === 'POST') {
            const payload = await readBody();
            const request: TerminalOpen = { id: terminalId(payload.id), ...terminalSize(payload) };
            if (this.response)
                throw new TerminalHttpError(409, 'A terminal is already active for this device.');
            this.response = res;
            this.id = request.id;
            res.writeHead(200, {
                'Content-Type': 'application/x-ndjson',
                'Cache-Control': 'no-store, no-transform',
                'X-Content-Type-Options': 'nosniff',
                'X-Accel-Buffering': 'no',
            });
            res.flushHeaders();
            const cleanup = () => {
                clearInterval(keepalive);
                if (this.response !== res) return;
                this.response = undefined;
                this.id = '';
                try {
                    this.ssh.getTerminal(request.id).close();
                } catch {
                    /* Already released. */
                }
            };
            const keepalive = setInterval(() => {
                if (!res.destroyed && !res.writableEnded && res.writableLength === 0)
                    res.write('{}\n');
            }, 15_000);
            keepalive.unref();
            res.on('close', cleanup);
            try {
                await this.ssh.openTerminal(request, (event) => {
                    if (res.destroyed || res.writableEnded) return;
                    res.write(JSON.stringify(event) + '\n', () => {
                        if (event.type === 'data' && !res.destroyed) {
                            try {
                                this.ssh.getTerminal(request.id).acknowledge(event.sequence);
                            } catch {
                                /* Channel closed. */
                            }
                        }
                    });
                    if (event.type === 'state' && ['closed', 'error'].includes(event.state)) {
                        clearInterval(keepalive);
                        if (this.response === res) {
                            this.response = undefined;
                            this.id = '';
                        }
                        res.end();
                    }
                });
            } catch {
                if (!res.writableEnded && !res.destroyed) {
                    res.end(
                        JSON.stringify({
                            id: request.id,
                            type: 'state',
                            state: 'error',
                            message:
                                'The device could not open a terminal. Check PTY and shell permissions.',
                        }) + '\n',
                    );
                }
                cleanup();
            }
            return true;
        }
        const operation = suffix.match(/^\/terminal\/([A-Za-z0-9_-]{16,64})(?:\/(input|resize))?$/);
        if (!operation) return false;
        const id = terminalId(operation[1]);
        if (id !== this.id || !this.response)
            throw new TerminalHttpError(
                409,
                'This terminal is closed or belongs to an earlier connection.',
            );
        if (req.method === 'DELETE' && !operation[2]) {
            this.ssh.getTerminal(id).close();
            send(200, { closed: true });
            return true;
        }
        if (req.method === 'POST' && operation[2]) {
            const payload = await readBody();
            if (operation[2] === 'input') {
                const data = terminalData(payload.data);
                this.limit(Buffer.from(data, 'base64').length);
                await this.ssh.getTerminal(id).write(data);
            } else {
                const size = terminalSize(payload);
                this.limit();
                this.ssh.getTerminal(id).resize(size);
            }
            send(200, { delivered: true });
            return true;
        }
        return false;
    }
}
