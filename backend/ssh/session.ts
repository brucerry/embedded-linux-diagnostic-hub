import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Client } from 'ssh2';
import { probes } from '../../shared/diagnostics/probes';
import type { ConnectOptions, ProbeResult, Snapshot } from '../../shared/types';

export const MAX_OUTPUT_BYTES = 256 * 1024;
export const PROBE_TIMEOUT_MS = 12_000;

export function validateConnection(input: unknown): ConnectOptions {
    if (!input || typeof input !== 'object') throw new Error('Invalid connection settings.');
    const value = input as ConnectOptions;
    const validHost =
        typeof value.host === 'string' &&
        value.host.length <= 253 &&
        (isIP(value.host) ||
            /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value.host));
    if (!validHost) throw new Error('Enter a hostname or IP address without a protocol or path.');
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
        throw new Error('Port must be between 1 and 65535.');
    if (typeof value.username !== 'string' || !/^[a-zA-Z0-9_.@-]{1,64}$/.test(value.username))
        throw new Error('Enter a valid SSH username.');
    if (value.auth !== 'password' && value.auth !== 'key')
        throw new Error('Select password or private key authentication.');
    for (const secret of [value.password, value.passphrase]) {
        if (secret !== undefined && (typeof secret !== 'string' || secret.length > 8192))
            throw new Error('Invalid credentials.');
    }
    return {
        host: value.host,
        port: value.port,
        username: value.username,
        auth: value.auth,
        password: value.password,
        passphrase: value.passphrase,
    };
}

export function fingerprint(key: Buffer): string {
    return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export function classifyExit(code: number | null): ProbeResult['status'] {
    return code === 0 ? 'collected' : code === 127 ? 'unavailable' : 'error';
}

export class SshSession {
    private client: Client | null = null;
    private options: ConnectOptions | null = null;
    private collecting = false;

    constructor(private readonly onDisconnected: () => void = () => {}) {}

    async connect(
        options: ConnectOptions,
        verify: (key: string) => Promise<boolean>,
        privateKey?: Buffer,
    ): Promise<void> {
        this.disconnect();
        const client = new Client();
        this.client = client;
        this.options = { ...options, password: undefined, passphrase: undefined };
        return new Promise((resolve, reject) => {
            let ready = false;
            let settled = false;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) {
                    client.destroy();
                    reject(error);
                } else resolve();
            };
            const timer = setTimeout(
                () =>
                    finish(
                        new Error(
                            'SSH connection timed out. Check the address, network and host-key dialog.',
                        ),
                    ),
                60_000,
            );
            client.on('ready', () => {
                ready = true;
                finish();
            });
            client.on('error', (error) => {
                if (!ready) finish(error);
            });
            client.on('close', () => {
                if (!ready)
                    finish(new Error('SSH connection closed before authentication completed.'));
                if (this.client === client) {
                    this.client = null;
                    this.options = null;
                    this.onDisconnected();
                }
            });
            try {
                client.connect({
                    host: options.host,
                    port: options.port,
                    username: options.username,
                    ...(options.auth === 'key'
                        ? { privateKey, passphrase: options.passphrase }
                        : { password: options.password ?? '' }),
                    readyTimeout: 60_000,
                    keepaliveInterval: 10_000,
                    keepaliveCountMax: 3,
                    hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
                        void verify(fingerprint(key)).then(callback, () => callback(false));
                    },
                });
            } catch (error) {
                finish(error instanceof Error ? error : new Error('SSH connection failed.'));
            }
        });
    }

    disconnect(): void {
        const client = this.client;
        this.client = null;
        this.options = null;
        client?.destroy();
    }

    get isConnected(): boolean {
        return this.client !== null && this.options !== null;
    }

    async collect(): Promise<Snapshot> {
        const client = this.client;
        const options = this.options;
        if (!client || !options) throw new Error('Connect to a device first.');
        if (this.collecting) throw new Error('A collection is already running.');
        this.collecting = true;
        try {
            const results: ProbeResult[] = [];
            for (let index = 0; index < probes.length; index += 3) {
                if (this.client !== client)
                    throw new Error(
                        'The device disconnected. Partial data was not saved as a complete report.',
                    );
                results.push(
                    ...(await Promise.all(
                        probes
                            .slice(index, index + 3)
                            .map((probe) => this.execute(client, probe.id, probe.command)),
                    )),
                );
            }
            if (this.client !== client)
                throw new Error('The device disconnected during collection.');
            return {
                schemaVersion: 1,
                mode: 'ssh',
                endpoint: `${options.host}:${options.port}`,
                username: options.username,
                capturedAt: new Date().toISOString(),
                results,
            };
        } finally {
            this.collecting = false;
        }
    }

    private execute(client: Client, id: string, command: string): Promise<ProbeResult> {
        const started = performance.now();
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let bytes = 0;
            let truncated = false;
            let settled = false;
            let channel: import('ssh2').ClientChannel | undefined;
            const finish = (code: number | null, error?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) stderr += `${stderr ? '\n' : ''}${error}`;
                resolve({
                    id,
                    command,
                    stdout,
                    stderr,
                    status: classifyExit(code),
                    exitCode: code,
                    durationMs: Math.round(performance.now() - started),
                    collectedAt: new Date().toISOString(),
                    truncated,
                });
            };
            const timer = setTimeout(() => {
                finish(null, 'Command timed out after 12 seconds.');
                channel?.close();
            }, PROBE_TIMEOUT_MS);
            // Non-interactive locale and known utility paths keep output predictable on minimal firmware.
            client.exec(
                `export LC_ALL=C; export PATH=/usr/sbin:/usr/bin:/sbin:/bin; ${command}`,
                (error, stream) => {
                    if (error) {
                        finish(null, error.message);
                        return;
                    }
                    channel = stream;
                    if (settled) {
                        stream.close();
                        return;
                    }
                    const append = (data: Buffer, isError: boolean) => {
                        const remaining = Math.max(0, MAX_OUTPUT_BYTES - bytes);
                        const part = data.subarray(0, remaining).toString('utf8');
                        bytes += Math.min(data.length, remaining);
                        if (isError) stderr += part;
                        else stdout += part;
                        if (data.length > remaining) truncated = true;
                    };
                    stream.on('data', (data: Buffer) => append(data, false));
                    stream.stderr.on('data', (data: Buffer) => append(data, true));
                    stream.on('error', (err: Error) => finish(null, err.message));
                    stream.on('close', (code: number | null, signal?: string) =>
                        finish(
                            typeof code === 'number' ? code : null,
                            signal ? `Command ended with signal ${signal}.` : undefined,
                        ),
                    );
                },
            );
        });
    }
}
