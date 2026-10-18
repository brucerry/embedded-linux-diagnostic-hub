import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, type ClientChannel } from 'ssh2';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gatewayFixture } from './fixtures/gateway';
import { consoleFixture } from './fixtures/ssh-console';
import { SshSession, fingerprint } from '../backend/ssh/session';
import { consoleStep, sshInputBytes, requireConsoleCapabilities } from '../shared/ssh-console';
import { NativeCaptureStore } from '../electron/capture-store';
import { captureToRepository } from '../shared/automation-capture';
import {
    CaptureStorageError,
    type CaptureRepository,
    type CaptureHeader,
} from '../shared/capture-store';
import {
    CommandPreview,
    type CommandOutputSink,
    type StreamedCommandCapture,
} from '../shared/automation-stream';

async function until(check: () => boolean) {
    const end = Date.now() + 3000;
    while (!check()) {
        if (Date.now() > end) throw Error('Local SSH fixture condition did not settle.');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
async function connect(fixture: Awaited<ReturnType<typeof gatewayFixture>>) {
    const client = new Client();
    client.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        client.connect({
            host: '127.0.0.1',
            port: fixture.options.port,
            username: fixture.options.username,
            password: fixture.options.password,
            hostVerifier: (key: Buffer) => fingerprint(key) === fixture.pinned,
            readyTimeout: 3000,
        });
    });
    return client;
}
async function shell(client: Client) {
    return new Promise<{
        channel: ClientChannel;
        text(): string;
        exits(): number;
        send(bytes: Uint8Array, expected: string): Promise<string>;
    }>((resolve, reject) => {
        client.shell({ term: 'xterm-256color', rows: 24, cols: 80 }, (error, channel) => {
            if (error) return reject(error);
            let text = '',
                exits = 0;
            const decoder = new StringDecoder('utf8');
            channel.on('error', () => {});
            channel.on('data', (bytes: Buffer) => {
                text += decoder.write(bytes);
                if (text.length > 65536) {
                    channel.close();
                    throw Error('Fixture transcript exceeds its bound.');
                }
            });
            channel.on('exit', () => exits++);
            resolve({
                channel,
                text: () => text,
                exits: () => exits,
                async send(bytes, expected) {
                    const offset = text.length;
                    await new Promise<void>((done, failed) =>
                        channel.write(bytes, (e?: Error | null) => (e ? failed(e) : done())),
                    );
                    await until(() => text.slice(offset).endsWith(expected));
                    return text.slice(offset);
                },
            });
        });
    });
}

test('protocol fixture models normal same-shell cwd/aliases/functions, explicit intermediate input and consecutive CR without per-command exits', async () => {
    const model = consoleFixture({ fragment: 3 });
    const fixture = await gatewayFixture(undefined, model),
        client = await connect(fixture);
    const h = await shell(client);
    try {
        await until(() => h.text().endsWith('fixture:/root# '));
        const defaults = { role: 'shell-prompt', literals: ['fixture:/root# ', 'fixture:/# '] };
        const send = async (command: string, expected = 'fixture:/# ') => {
            const step = consoleStep({ intent: 'script', command }, defaults);
            return h.send(
                sshInputBytes('console', { intent: step.intent, command: step.command }),
                expected,
            );
        };
        await send('cd /');
        assert.match(await send('pwd'), /^\/\r\n/);
        assert.match(await send('ll'), /fixture listing from \/\r\n/);
        assert.match(await send('fixture_hi'), /normal fixture initialization/);
        await send('export FLAG=kept');
        assert.match(await send('printenv FLAG'), /^kept\r\n/);
        assert.match(await send('missing-command'), /ash: missing-command: not found/);
        await send('confirm-fixture', 'Proceed fixture [Enter]? ');
        assert.equal(model.state.confirmations, 0, 'Waiting is not automatic confirmation.');
        const enter = sshInputBytes('console', { intent: 'send-enter', command: '' });
        assert.match(await h.send(enter, 'fixture:/# '), /CONFIRMED/);
        await h.send(enter, 'fixture:/# ');
        assert.equal(model.state.opens, 1);
        assert.equal(model.state.confirmations, 1);
        assert.equal(model.state.enters, 1);
        assert.equal(h.exits(), 0, 'A prompt is not a genuine command exit.');
        assert.deepEqual(model.state.commands, [
            'cd /',
            'pwd',
            'll',
            'fixture_hi',
            'export FLAG=kept',
            'printenv FLAG',
            'missing-command',
            'confirm-fixture',
            '',
            '',
        ]);
        assert.deepEqual(
            Buffer.concat(model.state.inputs),
            Buffer.from(
                'cd /\rpwd\rll\rfixture_hi\rexport FLAG=kept\rprintenv FLAG\rmissing-command\rconfirm-fixture\r\r\r',
            ),
        );
    } finally {
        h.channel.close();
        client.end();
        await fixture.close();
    }
});

test('real current SshSession exec remains independent and preserves genuine alias failures', async () => {
    const model = consoleFixture(),
        fixture = await gatewayFixture(undefined, model),
        ssh = new SshSession();
    try {
        await ssh.connect(fixture.options, async () => true);
        for (const [index, command] of ['cd /', 'pwd', 'll', 'fixture_hi'].entries()) {
            const result = await ssh.runAutomation({
                id: 'fixture-independent-' + index,
                connection: ssh.automationConnection,
                command,
                timeoutMs: 1000,
            });
            assert.equal(result.completion, 'exit');
            assert.equal(result.exitCode, index < 2 ? 0 : 127);
            if (command === 'pwd') assert.equal(result.stdout, '/root\r\n');
            if (index >= 2) assert.match(result.stderr, /not found/);
        }
        assert.equal(model.state.opens, 0);
        assert.deepEqual(model.state.execs, ['cd /', 'pwd', 'll', 'fixture_hi']);
    } finally {
        ssh.disconnect();
        await fixture.close();
    }
});

test('existing execution ownership and cancellation preserve the separate manual shell', async () => {
    const model = consoleFixture(),
        fixture = await gatewayFixture(undefined, model),
        ssh = new SshSession();
    const output: string[] = [];
    try {
        await ssh.connect(fixture.options, async () => true);
        const terminalId = 'fixture-manual-terminal-001';
        await ssh.openTerminal({ id: terminalId, rows: 24, cols: 80 }, (event) => {
            if (event.type === 'data') output.push(Buffer.from(event.data, 'base64').toString());
        });
        await until(() => output.join('').endsWith('fixture:/root# '));
        const connection = ssh.automationConnection,
            id = 'fixture-owned-exec-001';
        const pending = ssh.runAutomation({
            id,
            connection,
            command: 'fixture-stall',
            timeoutMs: 1000,
        });
        await until(() => model.state.execs.length === 1);
        await assert.rejects(
            ssh.runAutomation({
                id: 'fixture-owned-exec-002',
                connection,
                command: 'pwd',
                timeoutMs: 1000,
            }),
            /finish/,
        );
        await assert.rejects(ssh.collect(), /paused/);
        await assert.rejects(
            ssh.getTerminal(terminalId).write(Buffer.from('pwd\r').toString('base64')),
            /paused/,
        );
        ssh.cancelAutomation(id, connection);
        assert.equal((await pending).completion, 'cancelled');
        assert.equal(ssh.isConnected, true);
        await ssh.getTerminal(terminalId).write(Buffer.from('pwd\r').toString('base64'));
        await until(() => model.state.commands.includes('pwd'));
        assert.equal(model.state.opens, 1);
        assert.deepEqual(model.state.execs, ['fixture-stall']);
    } finally {
        ssh.disconnect();
        await fixture.close();
    }
});

test('unsupported capability cannot start a fixture console or substitute an exec command', async () => {
    const model = consoleFixture(),
        fixture = await gatewayFixture(undefined, model);
    try {
        assert.throws(
            () => requireConsoleCapabilities({ protocol: 1, independentStream: 1 }),
            /capabilities/,
        );
        assert.equal(model.state.opens, 0);
        assert.equal(model.state.execs.length, 0);
    } finally {
        await fixture.close();
    }
});

test('PTY refusal does not fall back to exec and the authenticated connection remains usable', async () => {
    const model = consoleFixture({ refusePty: true }),
        fixture = await gatewayFixture(undefined, model),
        client = await connect(fixture);
    try {
        await assert.rejects(shell(client), /Unable to request a pseudo-terminal/);
        assert.equal(model.state.opens, 0);
        assert.equal(model.state.execs.length, 0);
        assert.equal(await readIndependent(client), '/root\r\n');
        assert.deepEqual(model.state.execs, ['pwd']);
    } finally {
        client.end();
        await fixture.close();
    }
});

async function readIndependent(client: Client) {
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
        client.exec('pwd', (error, c) => (error ? reject(error) : resolve(c))),
    );
    try {
        const bytes: Buffer[] = [];
        for await (const chunk of channel) bytes.push(Buffer.from(chunk as Buffer));
        return Buffer.concat(bytes).toString();
    } finally {
        channel.close();
    }
}

function captureHeader(): CaptureHeader {
    return {
        transport: 'ssh',
        receiveTimeSource: 'local-client',
        runId: 'fixture-full-capture',
        stepId: 'one',
        name: 'Fixture only',
        command: 'fixture-large',
        startedAt: new Date().toISOString(),
        execution: { mode: 'independent-script', intent: 'script', timeoutMs: 1000 },
    };
}

/** Test-only stdout pump; shipping stream adapters must also merge both streams with bounded credit. */
async function captureFixtureExec(
    client: Client,
    sink: CommandOutputSink,
    signal: AbortSignal,
): Promise<StreamedCommandCapture> {
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
        client.exec('fixture-large', (error, c) => (error ? reject(error) : resolve(c))),
    );
    let code: number | null = null;
    const preview = new CommandPreview();
    channel.on('exit', (value: number) => {
        code = value;
    });
    channel.on('error', () => {});
    let pending = Promise.resolve();
    let settled = false;
    let onData: (bytes: Buffer) => void;
    let onEnd: () => void;
    let onError: (error: Error) => void;
    let cancel: () => void;
    const finished = new Promise<void>((resolve, reject) => {
        const settle = (error?: Error) => {
            if (settled) return;
            settled = true;
            void pending.then(() => (error ? reject(error) : resolve()), reject);
        };
        onData = (chunk) => {
            if (settled) return;
            // A data callback is the local observation boundary. Async iteration can coalesce
            // unread packets into an oversized observation, which this bounded writer rejects.
            channel.pause();
            const bytes = Uint8Array.from(chunk);
            const receivedAt = new Date().toISOString();
            pending = pending.then(async () => {
                await sink.append(bytes, receivedAt, 'stdout');
                preview.append(bytes, 'stdout');
            });
            void pending.then(
                () => {
                    if (!settled) channel.resume();
                },
                (error: Error) => settle(error),
            );
        };
        onEnd = () => settle();
        onError = (error) => settle(error);
        cancel = () => {
            channel.close();
            settle(Error('Fixture capture cancelled.'));
        };
        channel.on('data', onData);
        channel.once('end', onEnd);
        channel.once('close', onEnd);
        channel.once('error', onError);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
    });
    try {
        await finished;
        return {
            ...preview.finish(),
            exitCode: code,
            completion: code === null ? 'uncertain-close' : 'exit',
            chunks: [],
            truncated: false,
            previewClipped: preview.clipped,
        };
    } finally {
        signal.removeEventListener('abort', cancel!);
        channel.off('data', onData!);
        channel.off('end', onEnd!);
        channel.off('close', onEnd!);
        channel.off('error', onError!);
        await pending.catch(() => {});
        channel.close();
    }
}

test('fixture SSH observations spool beyond legacy caps into the accepted native repository with exact bytes and genuine exit', async () => {
    const model = consoleFixture(),
        fixture = await gatewayFixture(undefined, model),
        client = await connect(fixture);
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-ssh-console-fixture-'));
    const store = await NativeCaptureStore.open(profile, { profileOwned: true });
    try {
        const capture = await captureToRepository(
            store,
            captureHeader(),
            new AbortController().signal,
            (sink, signal) => captureFixtureExec(client, sink, signal),
        );
        const expected = crypto.createHash('sha256'),
            actual = crypto.createHash('sha256');
        for (let index = 0; index < 129; index++) expected.update(Buffer.alloc(16384, index % 251));
        let bytes = 0;
        for await (const event of store.read(capture.stored.id))
            if (event.type === 'frame') {
                actual.update(event.frame.bytes);
                bytes += event.frame.bytes.length;
            }
        assert.equal(bytes, 2113536);
        assert.equal(capture.stored.committedBytes, bytes);
        assert.equal(actual.digest('hex'), expected.digest('hex'));
        assert.equal(capture.stored.state, 'complete');
        assert.equal(capture.completion, 'exit');
        assert.equal(capture.exitCode, 0);
        assert.equal(capture.previewClipped, true);
        assert.ok(capture.stdout.length <= 8192);
        assert.equal(
            model.state.opens,
            0,
            'Independent full-capture feasibility is not a PTY implementation.',
        );
    } finally {
        client.end();
        await store.close();
        await fixture.close();
        assert.ok(
            path.resolve(profile).startsWith(temp + path.sep) &&
                path.basename(profile).startsWith('hub-ssh-console-fixture-'),
        );
        await fs.rm(profile, { recursive: true, force: true });
    }
});

test('fixture feasibility fails closed before exec on initialization failure and closes only its exec on later quota failure', async () => {
    const model = consoleFixture(),
        fixture = await gatewayFixture(undefined, model),
        client = await connect(fixture);
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-ssh-console-fixture-')),
        store = await NativeCaptureStore.open(profile, { profileOwned: true });
    let writes = 0;
    try {
        const denied = new Proxy(store, {
            get(target, key) {
                if (key === 'begin')
                    return async () => {
                        throw new CaptureStorageError(
                            'quota',
                            'Synthetic initialization quota failure.',
                        );
                    };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }) as CaptureRepository;
        await assert.rejects(
            captureToRepository(
                denied,
                captureHeader(),
                new AbortController().signal,
                (sink, signal) => captureFixtureExec(client, sink, signal),
            ),
            (error: unknown) => error instanceof CaptureStorageError && error.code === 'quota',
        );
        assert.equal(model.state.execs.length, 0, 'Storage initialization cannot send a command.');
        const failing = new Proxy(store, {
            get(target, key) {
                if (key === 'append')
                    return async (...args: Parameters<CaptureRepository['append']>) => {
                        if (++writes > 1)
                            throw new CaptureStorageError('quota', 'Synthetic disk-full failure.');
                        return target.append(...args);
                    };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }) as CaptureRepository;
        const capture = await captureToRepository(
            failing,
            captureHeader(),
            new AbortController().signal,
            (sink, signal) => captureFixtureExec(client, sink, signal),
        );
        assert.equal(capture.completion, 'storage-error');
        assert.equal(capture.stored.state, 'incomplete');
        assert.equal(capture.stored.failure?.code, 'quota');
        assert.ok(capture.stored.committedBytes > 0 && capture.stored.committedBytes < 2113536);
        await until(() => model.state.activeExecs === 0);
        assert.deepEqual(model.state.execs, ['fixture-large']);
        assert.equal(await readIndependent(client), '/root\r\n');
        assert.deepEqual(model.state.execs, ['fixture-large', 'pwd']);
        assert.equal(model.state.opens, 0);
        const recovered = (await store.page()).records;
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].state, 'incomplete');
        assert.equal(recovered[0].committedBytes, capture.stored.committedBytes);
    } finally {
        client.end();
        await store.close();
        await fixture.close();
        assert.ok(
            path.resolve(profile).startsWith(temp + path.sep) &&
                path.basename(profile).startsWith('hub-ssh-console-fixture-'),
        );
        await fs.rm(profile, { recursive: true, force: true });
    }
});
