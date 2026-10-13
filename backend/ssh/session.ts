import { StringDecoder } from 'node:string_decoder';
import { ExecSlots } from './exec-budget';
import { NetworkCollector } from './network';
import { collectOptions, type CollectOptions } from '../../shared/diagnostics/network/evidence';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Client } from 'ssh2';
import { randomUUID } from 'node:crypto';
import { captureCommand } from './automation';
import { automationRequest, type AutomationRequest } from '../../shared/automation';
import { probes } from '../../shared/diagnostics/probes';
import type { ConnectOptions, ProbeResult, Snapshot } from '../../shared/types';
import {
    CLOCK_MAX_BYTES,
    CLOCK_TIMEOUT_MS,
    DEVICE_CLOCK_COMMAND,
    parseDeviceClock,
    type DeviceClockResponse,
} from '../../shared/diagnostics/device-clock';
import {
    terminalId,
    terminalSize,
    type TerminalEvent,
    type TerminalOpen,
} from '../../shared/terminal';
import { SshTerminal } from './terminal';
import { ConnectionFailure, connectionFailure } from '../../shared/connection';

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
    private connectionToken = '';
    private automation?: { id: string; controller: AbortController };
    private cancelledAutomation = new Map<string, number>();
    private ready = false;
    private terminal: SshTerminal | null = null;
    private cancelClock?: () => void;
    private slots = new ExecSlots();
    private network = new NetworkCollector();

    constructor(private readonly onDisconnected: () => void = () => {}) {}

    async connect(
        options: ConnectOptions,
        verify: (key: string) => Promise<boolean>,
        privateKey?: Buffer,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) throw new ConnectionFailure('cancelled', 'Connection cancelled.');
        this.disconnect();
        const client = new Client();
        this.client = client;
        this.options = { ...options, password: undefined, passphrase: undefined };
        return new Promise((resolve, reject) => {
            let ready = false;
            let settled = false;
            let hostRejected = false;
            const cancel = () =>
                finish(new ConnectionFailure('cancelled', 'Connection cancelled.'));
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                if (error) {
                    client.destroy();
                    if (this.client === client) {
                        this.client = null;
                        this.options = null;
                        this.ready = false;
                    }
                    reject(
                        hostRejected
                            ? new ConnectionFailure(
                                  'host-key',
                                  'SSH host identity was not approved. Verify the device and connect again.',
                              )
                            : connectionFailure(error),
                    );
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
            signal?.addEventListener('abort', cancel, { once: true });
            client.on('ready', () => {
                if (this.client !== client) {
                    finish(
                        new Error('SSH connection was replaced before authentication completed.'),
                    );
                    client.destroy();
                    return;
                }
                ready = true;
                this.ready = true;
                this.connectionToken = randomUUID().replaceAll('-', '');
                finish();
            });
            client.on('error', (error) => {
                if (!ready) finish(error);
            });
            client.on('close', () => {
                if (!ready)
                    finish(new Error('SSH connection closed before authentication completed.'));
                if (this.client === client) {
                    this.cancelClock?.();
                    this.terminal?.close();
                    this.ready = false;
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
                        void verify(fingerprint(key)).then(
                            (accepted) => {
                                hostRejected = !accepted;
                                callback(!signal?.aborted && accepted);
                            },
                            () => {
                                hostRejected = true;
                                callback(false);
                            },
                        );
                    },
                });
            } catch (error) {
                finish(
                    new ConnectionFailure(
                        options.auth === 'key' ? 'authentication' : 'policy',
                        options.auth === 'key'
                            ? 'SSH authentication failed. Correct the key/passphrase and connect again.'
                            : 'SSH connection settings are invalid. Correct them and connect again.',
                    ),
                );
            }
        });
    }

    clearNetworkCache(): void {
        this.network.clear();
    }

    disconnect(): void {
        this.automation?.controller.abort();
        this.connectionToken = '';
        this.cancelledAutomation.clear();
        this.network.clear();
        this.cancelClock?.();
        this.terminal?.close();
        this.ready = false;
        const client = this.client;
        this.client = null;
        this.options = null;
        client?.destroy();
    }

    get automationConnection() {
        return this.isConnected ? this.connectionToken : '';
    }
    cancelAutomation(id: string, connection: string) {
        if (connection !== this.automationConnection) throw Error('Automation connection changed.');
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw Error('Invalid automation ID.');
        for (const [key, expiry] of this.cancelledAutomation)
            if (expiry < Date.now()) this.cancelledAutomation.delete(key);
        if (this.cancelledAutomation.size >= 64)
            this.cancelledAutomation.delete(this.cancelledAutomation.keys().next().value!);
        this.cancelledAutomation.set(id, Date.now() + 60000);
        if (this.automation?.id === id) this.automation.controller.abort();
    }
    async runAutomation(input: AutomationRequest) {
        const request = automationRequest(input),
            client = this.client;
        if (!client || request.connection !== this.automationConnection)
            throw Error('Automation connection changed. Arm the flow again.');
        if (this.collecting || this.automation || this.terminal?.hasPendingInput)
            throw Error('Wait for current collection or automation to finish.');
        const controller = new AbortController(),
            owner = { id: request.id, controller };
        this.automation = owner;
        if ((this.cancelledAutomation.get(request.id) ?? 0) > Date.now()) controller.abort();
        const started = performance.now();
        try {
            return await this.slots.run(
                () => {
                    if (client !== this.client || request.connection !== this.automationConnection)
                        throw Error('Automation connection changed.');
                    return captureCommand(
                        client,
                        request.command,
                        Math.max(1, request.timeoutMs - (performance.now() - started)),
                        controller.signal,
                    );
                },
                { signal: controller.signal, timeoutMs: request.timeoutMs },
            );
        } finally {
            if (this.automation === owner) this.automation = undefined;
        }
    }
    get isConnected(): boolean {
        return this.ready && this.client !== null && this.options !== null;
    }

    async readClock(signal?: AbortSignal): Promise<DeviceClockResponse> {
        const client = this.client;
        if (!this.isConnected || !client) throw Error('Connect to a device first.');
        if (this.cancelClock) throw Error('A device clock read is already running.');
        const clockStarted = performance.now();
        const waiting = new AbortController();
        const queuedCancel = () => waiting.abort();
        signal = AbortSignal.any([waiting.signal, ...(signal ? [signal] : [])]);
        this.cancelClock = queuedCancel;
        return this.slots
            .run(
                () =>
                    new Promise<DeviceClockResponse>((resolve) => {
                        let channel: import('ssh2').ClientChannel | undefined;
                        let output = '';
                        let bytes = 0;
                        let settled = false;
                        const finish = (result: DeviceClockResponse) => {
                            if (settled) return;
                            settled = true;
                            clearTimeout(timer);
                            signal?.removeEventListener('abort', cancel);
                            if (this.cancelClock === cancel) this.cancelClock = undefined;
                            channel?.removeListener('data', append);
                            channel?.stderr.removeListener('data', countError);
                            resolve(
                                this.client === client
                                    ? result
                                    : { status: 'unavailable', reason: 'failed' },
                            );
                        };
                        const cancel = () => {
                            finish({ status: 'unavailable', reason: 'failed' });
                            channel?.close();
                        };
                        const append = (data: Buffer) => {
                            bytes += data.length;
                            if (bytes > CLOCK_MAX_BYTES) return cancel();
                            output += data.toString('utf8');
                        };
                        const countError = (data: Buffer) => {
                            bytes += data.length;
                            if (bytes > CLOCK_MAX_BYTES) cancel();
                        };
                        const timer = setTimeout(
                            cancel,
                            Math.max(1, CLOCK_TIMEOUT_MS - (performance.now() - clockStarted)),
                        );
                        this.cancelClock = cancel;
                        signal?.addEventListener('abort', cancel, { once: true });
                        if (signal?.aborted) return cancel();
                        try {
                            client.exec(
                                `export LC_ALL=C; export PATH=/usr/sbin:/usr/bin:/sbin:/bin; ${DEVICE_CLOCK_COMMAND}`,
                                (error, stream) => {
                                    if (error) return cancel();
                                    channel = stream;
                                    if (settled) return stream.close();
                                    stream.on('data', append);
                                    stream.stderr.on('data', countError);
                                    stream.on('error', cancel);
                                    stream.on('close', (code: number | null) => {
                                        if (settled) return;
                                        if (code !== 0)
                                            return finish({
                                                status: 'unavailable',
                                                reason: code === 127 ? 'unsupported' : 'failed',
                                            });
                                        try {
                                            finish({
                                                status: 'available',
                                                sample: parseDeviceClock(output),
                                            });
                                        } catch {
                                            finish({ status: 'unavailable', reason: 'failed' });
                                        }
                                    });
                                },
                            );
                        } catch {
                            cancel();
                        }
                    }),
                { signal, timeoutMs: CLOCK_TIMEOUT_MS },
            )
            .catch(() => ({ status: 'unavailable' as const, reason: 'failed' as const }))
            .finally(() => {
                if (this.cancelClock === queuedCancel) this.cancelClock = undefined;
            });
    }

    async openTerminal(input: TerminalOpen, emit: (event: TerminalEvent) => void): Promise<void> {
        const id = terminalId(input?.id);
        const size = terminalSize(input);
        if (!this.isConnected || !this.client) throw Error('Connect to a device first.');
        if (this.terminal) throw Error('A terminal is already active for this device.');
        const terminal = new SshTerminal(
            { id, ...size },
            emit,
            () => {
                if (this.terminal === terminal) this.terminal = null;
            },
            undefined,
            () => Boolean(this.automation),
        );
        this.terminal = terminal;
        await terminal.open(this.client, size);
    }

    getTerminal(id: unknown): SshTerminal {
        if (!this.terminal || this.terminal.id !== terminalId(id))
            throw Error('This terminal is closed or belongs to an earlier connection.');
        return this.terminal;
    }

    async collect(input?: CollectOptions): Promise<Snapshot> {
        if (this.automation) throw Error('Collection is paused for automation.');
        const collection = collectOptions(input);
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
                            .map((probe) =>
                                this.network.collect(
                                    probe,
                                    (id, command, limits) =>
                                        this.execute(
                                            client,
                                            id,
                                            command,
                                            limits.timeoutMs,
                                            limits.maxBytes,
                                        ),
                                    collection,
                                ),
                            ),
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

    private execute(
        client: Client,
        id: string,
        command: string,
        timeoutMs = PROBE_TIMEOUT_MS,
        maxBytes = MAX_OUTPUT_BYTES,
    ): Promise<ProbeResult> {
        const started = performance.now();
        return this.slots.run(
            () =>
                this.executeOwned(
                    client,
                    id,
                    command,
                    Math.max(1, timeoutMs - (performance.now() - started)),
                    maxBytes,
                ),
            { timeoutMs },
        );
    }

    private executeOwned(
        client: Client,
        id: string,
        command: string,
        timeoutMs: number,
        maxBytes: number,
    ): Promise<ProbeResult> {
        const started = performance.now();
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            const outputDecoder = new StringDecoder('utf8'),
                errorDecoder = new StringDecoder('utf8');
            let bytes = 0;
            let truncated = false;
            let settled = false;
            let channel: import('ssh2').ClientChannel | undefined;
            const finish = (code: number | null, error?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                stdout += outputDecoder.end();
                stderr += errorDecoder.end();
                if (error) stderr += (stderr ? '\n' : '') + error;
                const bound = (value: string, limit: number) =>
                    new StringDecoder('utf8').write(
                        Buffer.from(value).subarray(0, Math.max(0, limit)),
                    );
                const boundedOut = bound(stdout, maxBytes);
                const boundedError = bound(stderr, maxBytes - Buffer.byteLength(boundedOut));
                if (boundedOut !== stdout || boundedError !== stderr) truncated = true;
                stdout = boundedOut;
                stderr = boundedError;
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
                finish(null, 'Command timed out within its bounded collection deadline.');
                channel?.close();
            }, timeoutMs);
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
                        const remaining = Math.max(0, maxBytes - bytes);
                        const part = (isError ? errorDecoder : outputDecoder).write(
                            data.subarray(0, remaining),
                        );
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
