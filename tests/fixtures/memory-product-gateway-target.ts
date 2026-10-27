/** Private authenticated synthetic target. Receipts describe fixture events, never product coverage. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Server, utils, type Connection, type ServerChannel, type Session } from 'ssh2';
import { fingerprint } from '../../backend/ssh/session';
import { DEVICE_CLOCK_COMMAND } from '../../shared/diagnostics/device-clock';
import { clockOutput } from './device-clock';
import type { GatewayTargetExtension } from './memory-resource-gateway-host';

export type ProductTargetProgram = {
    command: string;
    stdoutBytes: number;
    stderrBytes?: number;
    chunkBytes?: number;
    delayMs?: number;
    exitCode?: number;
    stall?: boolean;
};
export type ProductTargetControl =
    | { action: 'program'; program: ProductTargetProgram }
    | { action: 'hold-open'; enabled: boolean }
    | { action: 'release-open'; reject?: boolean }
    | { action: 'pause-input'; enabled: boolean }
    | { action: 'release-output' }
    | { action: 'disconnect-clients' }
    | { action: 'close-channels' }
    | { action: 'snapshot' }
    | { action: 'reset-events' };
export type ProductTargetEvent = {
    sequence: number;
    at: number;
    type: string;
    channel?: number;
    command?: string;
    bytes?: number;
    detail?: string;
};
export type ProductTargetSnapshot = {
    owners: {
        clients: number;
        channels: number;
        pumps: number;
        pendingOpen: number;
        pendingWriteCallbacks: number;
        delays: number;
        outputGates: number;
    };
    services: { listening: boolean; holdOpen: boolean; inputPaused: boolean };
    cache: {
        programs: number;
        events: number;
        droppedEvents: number;
        eventLimit: 256;
        programLimit: 64;
    };
    totals: {
        stdoutBytes: number;
        stderrBytes: number;
        inputBytes: number;
        shellCommands: number;
        enters: number;
        openedChannels: number;
        closedChannels: number;
    };
    events: ProductTargetEvent[];
};

export function validateProductProgram(value: unknown): ProductTargetProgram {
    assert.ok(value && typeof value === 'object');
    const program = value as ProductTargetProgram;
    assert.equal(typeof program.command, 'string');
    assert.ok(program.command.length > 0 && Buffer.byteLength(program.command) <= 8192);
    for (const [key, fallback, maximum] of [
        ['stdoutBytes', 0, 128 * 1024 ** 2],
        ['stderrBytes', 0, 128 * 1024 ** 2],
        ['chunkBytes', 16384, 16384],
        ['delayMs', 0, 1000],
        ['exitCode', 0, 255],
    ] as const) {
        const number = program[key] ?? fallback;
        assert.ok(
            Number.isSafeInteger(number) &&
                number >= (key === 'chunkBytes' ? 1 : 0) &&
                number <= maximum,
            'Invalid target program ' + key,
        );
    }
    if (program.stall !== undefined) assert.equal(typeof program.stall, 'boolean');
    return { ...program };
}

export const createProductTarget = async ({
    assertAdmissible = () => {},
    clients,
    channels,
    pumps,
}: Parameters<GatewayTargetExtension['createTarget']>[0]) => {
    assertAdmissible();
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        format: 'pem',
        type: 'pkcs1',
    });
    const parsed = utils.parseKey(key);
    assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
    const programs = new Map<string, ProductTargetProgram>();
    const events: ProductTargetEvent[] = [];
    const pendingOpen = new Set<{ client: Connection; accept(): Session; reject?(): void }>();
    const writeCallbacks = new Set<object>();
    const delays = new Set<ReturnType<typeof setTimeout>>();
    const outputGates = new Set<() => void>();
    const ids = new WeakMap<ServerChannel, number>();
    const ended = new WeakSet<ServerChannel>();
    const lifetimes = new WeakMap<ServerChannel, AbortController>();
    const unavailable = (channel: ServerChannel) =>
        stopping || ended.has(channel) || channel.destroyed;
    let sequence = 0,
        droppedEvents = 0,
        holdOpen = false,
        inputPaused = false,
        stopping = false;
    const totals = {
        stdoutBytes: 0,
        stderrBytes: 0,
        inputBytes: 0,
        shellCommands: 0,
        enters: 0,
        openedChannels: 0,
        closedChannels: 0,
    };
    const event = (
        type: string,
        channel?: ServerChannel,
        extra: Partial<ProductTargetEvent> = {},
    ) => {
        if (events.length === 256) {
            events.shift();
            droppedEvents++;
        }
        events.push({
            sequence: ++sequence,
            at: Date.now(),
            type,
            ...(channel ? { channel: ids.get(channel) } : {}),
            ...extra,
        });
    };
    const track = (promise: Promise<void>) => {
        pumps.add(promise);
        void promise.then(
            () => pumps.delete(promise),
            () => pumps.delete(promise),
        );
        return promise;
    };
    const register = (channel: ServerChannel, kind: string, client: Connection) => {
        const lifetime = new AbortController();
        lifetimes.set(channel, lifetime);
        const transportClosed = () => {
            ended.add(channel);
            lifetime.abort();
        };
        client.once('close', transportClosed);
        ids.set(channel, ++totals.openedChannels);
        channels.add(channel);
        event(kind + '-open', channel);
        channel.on('error', () => {});
        channel.once('close', () => {
            ended.add(channel);
            lifetime.abort();
            client.off('close', transportClosed);
            channels.delete(channel);
            totals.closedChannels++;
            event('channel-close', channel);
        });
        channel.on('end', () => channel.close());
        if (inputPaused) channel.pause();
        else channel.resume();
    };
    const write = async (channel: ServerChannel, bytes: Buffer, stderr = false) => {
        if (unavailable(channel)) throw Error('Fixture channel or transport already closed.');
        const token = {};
        writeCallbacks.add(token);
        await new Promise<void>((resolve, reject) => {
            try {
                (stderr ? channel.stderr : channel).write(bytes, (error?: Error | null) => {
                    writeCallbacks.delete(token);
                    if (error) reject(error);
                    else {
                        totals[stderr ? 'stderrBytes' : 'stdoutBytes'] += bytes.length;
                        resolve();
                    }
                });
            } catch (error) {
                writeCallbacks.delete(token);
                reject(error);
            }
        });
    };
    const delay = (channel: ServerChannel, ms: number) =>
        new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer);
                delays.delete(timer);
                lifetimes.get(channel)!.signal.removeEventListener('abort', done);
                resolve();
            };
            const timer = setTimeout(done, ms);
            delays.add(timer);
            lifetimes.get(channel)!.signal.addEventListener('abort', done, { once: true });
            if (unavailable(channel)) done();
        });
    const gate = (channel: ServerChannel) =>
        new Promise<void>((resolve) => {
            const release = () => {
                outputGates.delete(release);
                lifetimes.get(channel)!.signal.removeEventListener('abort', release);
                resolve();
            };
            outputGates.add(release);
            lifetimes.get(channel)!.signal.addEventListener('abort', release, { once: true });
            if (unavailable(channel)) release();
        });
    const runProgram = async (channel: ServerChannel, program: ProductTargetProgram) => {
        event('program-start', channel, { command: program.command });
        if (program.stall) await gate(channel);
        for (const stderr of [false, true]) {
            const total = stderr ? (program.stderrBytes ?? 0) : program.stdoutBytes;
            for (let sent = 0; sent < total && !unavailable(channel);) {
                const length = Math.min(program.chunkBytes ?? 16384, total - sent);
                await write(channel, Buffer.alloc(length, stderr ? 66 : 65), stderr);
                sent += length;
                if (program.delayMs && sent < total) await delay(channel, program.delayMs);
            }
        }
        if (!unavailable(channel))
            event('program-complete', channel, {
                command: program.command,
                bytes: program.stdoutBytes + (program.stderrBytes ?? 0),
            });
    };
    const attach = (session: Session, client: Connection) => {
        session.on('pty', (accept) => {
            accept?.();
            event('pty-accepted');
        });
        session.on('exec', (accept, _reject, info) => {
            const channel = accept();
            register(channel, 'exec', client);
            event('exec-command', channel, { command: info.command.slice(0, 8192) });
            void track(
                (async () => {
                    try {
                        if (info.command.endsWith(DEVICE_CLOCK_COMMAND))
                            await write(channel, Buffer.from(clockOutput()));
                        else {
                            const program = programs.get(info.command);
                            if (!program) {
                                channel.exit(127);
                                channel.end();
                                return;
                            }
                            await runProgram(channel, program);
                        }
                        if (!unavailable(channel)) {
                            channel.exit(programs.get(info.command)?.exitCode ?? 0);
                            channel.end();
                        }
                    } catch (error) {
                        event('pump-error', channel, { detail: String(error).slice(0, 256) });
                        channel.close();
                    }
                })(),
            );
        });
        session.on('shell', (accept) => {
            const channel = accept();
            register(channel, 'shell', client);
            const decoder = new StringDecoder('utf8');
            let line = '',
                previousCr = false,
                confirmation = false;
            const prompt = () => write(channel, Buffer.from('fixture:/root# '));
            let chain = track(
                (async () => {
                    await write(channel, Buffer.from('Synthetic interactive initialization\r\n'));
                    await prompt();
                })(),
            );
            const execute = async (command: string) => {
                if (unavailable(channel)) return;
                totals.shellCommands++;
                if (!command) totals.enters++;
                event(command ? 'shell-command' : 'shell-enter', channel, { command });
                if (confirmation) {
                    confirmation = false;
                    await write(channel, Buffer.from('CONFIRMED\r\n'));
                } else if (command === 'confirm-fixture') {
                    confirmation = true;
                    await write(channel, Buffer.from('Proceed fixture [Enter]? '));
                    return;
                } else if (command === 'exit') {
                    channel.exit(0);
                    channel.end();
                    return;
                } else if (programs.has(command)) await runProgram(channel, programs.get(command)!);
                else if (command)
                    await write(channel, Buffer.from('fixture-output:' + command + '\r\n'));
                if (!unavailable(channel)) await prompt();
            };
            channel.on('data', (bytes: Buffer) => {
                totals.inputBytes += bytes.length;
                event('shell-input', channel, { bytes: bytes.length });
                for (const char of decoder.write(bytes)) {
                    if (char === '\n' && previousCr) {
                        previousCr = false;
                        continue;
                    }
                    previousCr = char === '\r';
                    if (char === '\r' || char === '\n') {
                        const command = line;
                        line = '';
                        chain = track(
                            chain
                                .then(() => execute(command))
                                .catch((error) => {
                                    event('pump-error', channel, {
                                        detail: String(error).slice(0, 256),
                                    });
                                    channel.close();
                                }),
                        );
                    } else {
                        line += char;
                        if (Buffer.byteLength(line) > 8192) {
                            event('input-limit', channel);
                            channel.close();
                            return;
                        }
                    }
                }
            });
            void chain.catch(() => channel.close());
        });
    };
    assertAdmissible();
    const server = new Server({ hostKeys: [key] }, (client) => {
        clients.add(client);
        event('client-connect');
        client.on('error', () => {});
        client.once('close', () => {
            clients.delete(client);
            for (const item of pendingOpen) if (item.client === client) pendingOpen.delete(item);
            event('client-close');
        });
        client.on('authentication', (auth) =>
            auth.method === 'password' &&
            auth.username === 'engineer' &&
            auth.password === 'device-test-password'
                ? auth.accept()
                : auth.reject(),
        );
        client.on('ready', () => {
            event('client-ready');
            client.on('session', (accept, reject) => {
                if (stopping) {
                    reject?.();
                    return;
                }
                if (holdOpen) {
                    pendingOpen.add({ client, accept, reject });
                    event('session-open-held');
                } else {
                    attach(accept(), client);
                    event('session-open-accepted');
                }
            });
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        assertAdmissible();
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const snapshot = (): ProductTargetSnapshot => ({
        owners: {
            clients: clients.size,
            channels: channels.size,
            pumps: pumps.size,
            pendingOpen: pendingOpen.size,
            pendingWriteCallbacks: writeCallbacks.size,
            delays: delays.size,
            outputGates: outputGates.size,
        },
        services: { listening: Boolean(server.address()), holdOpen, inputPaused },
        cache: {
            programs: programs.size,
            events: events.length,
            droppedEvents,
            eventLimit: 256,
            programLimit: 64,
        },
        totals: { ...totals },
        events: events.map((value) => ({ ...value })),
    });
    const control = (payload: unknown) => {
        assert.ok(payload && typeof payload === 'object');
        const input = payload as ProductTargetControl;
        switch (input.action) {
            case 'program': {
                const program = validateProductProgram(input.program);
                assert.ok(programs.has(program.command) || programs.size < 64);
                programs.set(program.command, program);
                break;
            }
            case 'hold-open':
                assert.equal(typeof input.enabled, 'boolean');
                holdOpen = input.enabled;
                break;
            case 'release-open':
                for (const item of pendingOpen) {
                    pendingOpen.delete(item);
                    if (input.reject) item.reject?.();
                    else {
                        attach(item.accept(), item.client);
                        event('session-open-released');
                    }
                }
                break;
            case 'pause-input':
                assert.equal(typeof input.enabled, 'boolean');
                inputPaused = input.enabled;
                for (const channel of channels)
                    if (inputPaused) channel.pause();
                    else channel.resume();
                break;
            case 'release-output':
                for (const release of [...outputGates]) release();
                break;
            case 'disconnect-clients':
                for (const client of clients) client.end();
                break;
            case 'close-channels':
                for (const channel of channels) channel.close();
                break;
            case 'reset-events':
                events.length = 0;
                droppedEvents = 0;
                break;
            case 'snapshot':
                break;
            default:
                throw Error('Unsupported private target control.');
        }
        event('control', undefined, { detail: input.action });
        return snapshot();
    };
    return {
        server,
        descriptor: {
            host: '127.0.0.1',
            port: (server.address() as { port: number }).port,
            fingerprint: fingerprint(parsed.getPublicSSH()),
        },
        control,
        snapshot,
        beforeStop() {
            stopping = true;
            for (const item of pendingOpen) {
                pendingOpen.delete(item);
                item.reject?.();
            }
            for (const channel of channels) lifetimes.get(channel)?.abort();
        },
    };
};
