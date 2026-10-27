import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { gatewayFixture } from './fixtures/gateway';
import { consoleFixture } from './fixtures/ssh-console';
import { SshSession } from '../backend/ssh/session';
import { CaptureStorageError, type CaptureRepository } from '../shared/capture-store';
import { NativeCaptureStore } from '../electron/capture-store';
import { captureToRepository } from '../shared/automation-capture';
import type { CaptureHeader } from '../shared/capture-store';
import { SshStreamClient } from '../src/features/automation/capture/ssh-stream-client';
import { GatewayClient } from '../src/services/GatewayClient';
import { sshCaptureBackend } from '../src/features/automation/capture/ssh-backend';
import { FlowRunner } from '../src/features/automation/runner';
import { outcomeOf } from '../shared/automation-result';
import type { AutomationPlan, AutomationRecord } from '../shared/automation';
import { streamObject, type SshStreamRpc, type SshStreamRequest } from '../shared/ssh-stream-rpc';

const header = (command = 'fixture-large'): CaptureHeader => ({
    transport: 'ssh',
    receiveTimeSource: 'local-client',
    runId: 'production-test',
    stepId: 'one',
    command,
    name: 'Loopback',
    startedAt: new Date().toISOString(),
    execution: { mode: 'independent-script', intent: 'script', timeoutMs: 10000 },
});
async function until(check: () => boolean) {
    const end = Date.now() + 3000;
    while (!check()) {
        if (Date.now() > end) throw Error('Fixture did not settle.');
        await new Promise((r) => setTimeout(r, 5));
    }
}
async function fixture(t: import('node:test').TestContext) {
    const model = consoleFixture(),
        server = await gatewayFixture(undefined, model),
        ssh = new SshSession();
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-production-stream-'));
    const store = await NativeCaptureStore.open(profile, { profileOwned: true });
    await ssh.connect(server.options, async () => true);
    t.after(async () => {
        ssh.disconnect();
        await store.close();
        await server.close();
        assert.ok(
            path.resolve(profile).startsWith(temp + path.sep) &&
                path.basename(profile).startsWith('hub-production-stream-'),
        );
        await fs.rm(profile, { recursive: true, force: true });
    });
    return { model, server, ssh, store, profile };
}
test('production SSH stream stores exact output beyond caps, then holds host ownership through client finalization', async (t) => {
    const { model, ssh, store } = await fixture(t),
        client = new SshStreamClient((input) => ssh.automationStream(input), 'local-client');
    const request = {
        id: 'production-large-0001',
        connection: ssh.automationConnection,
        command: 'fixture-large',
        timeoutMs: 10000,
    };
    const capture = await captureToRepository(
        store,
        header(),
        new AbortController().signal,
        (sink, signal) => client.execute(request, sink, signal),
    );
    assert.equal(capture.completion, 'exit');
    assert.equal(capture.exitCode, 0);
    assert.equal(capture.stored.state, 'complete');
    assert.equal(capture.stored.committedBytes, 2113536);
    const expected = crypto.createHash('sha256'),
        actual = crypto.createHash('sha256');
    for (let i = 0; i < 129; i++) expected.update(Buffer.alloc(16384, i % 251));
    for await (const item of store.read(capture.stored.id))
        if (item.type === 'frame') actual.update(item.frame.bytes);
    assert.equal(actual.digest('hex'), expected.digest('hex'));
    assert.equal(capture.previewClipped, true);
    assert.ok(capture.stdout.length <= 8192);
    await until(() => model.state.activeExecs === 0);
    await assert.rejects(ssh.collect(), /paused/);
    await assert.rejects(
        ssh.runAutomation({ ...request, id: 'production-after-0001', command: 'pwd' }),
        /finish/,
    );
    await client.finalize();
    assert.equal(
        (await ssh.runAutomation({ ...request, id: 'production-after-0002', command: 'pwd' }))
            .stdout,
        '/root\r\n',
    );
    assert.equal(ssh.isConnected, true);
});

test('production credit is sent only after durable sink flush; malformed owner/duplicate credits refuse', async (t) => {
    const { ssh } = await fixture(t);
    let acked = 0,
        flushed = 0,
        release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rpc: SshStreamRpc = async (input) => {
        if (input.action === 'ack') {
            assert.ok(flushed > acked);
            acked++;
        }
        return ssh.automationStream(input);
    };
    const client = new SshStreamClient(rpc, 'local-client'),
        controller = new AbortController();
    let entered = false;
    const pending = client.execute(
        {
            id: 'production-credit-01',
            connection: ssh.automationConnection,
            command: 'fixture-large',
            timeoutMs: 10000,
        },
        {
            append: async () => {
                entered = true;
            },
            flush: async () => {
                await gate;
                flushed++;
            },
            rejectObservation: () => {},
        },
        controller.signal,
    );
    await until(() => entered);
    assert.equal(acked, 0);
    await assert.rejects(ssh.collect(), /paused/);
    release();
    await pending;
    assert.ok(acked > 0);
    await client.finalize();
    const caps = (await ssh.automationStream({ protocol: 1, action: 'capabilities' })) as {
        epoch: string;
    };
    const start = streamObject(
        await ssh.automationStream({
            protocol: 1,
            action: 'start',
            epoch: caps.epoch,
            request: {
                id: 'production-credit-02',
                connection: ssh.automationConnection,
                command: 'pwd',
                timeoutMs: 1000,
            },
        }),
        ['protocol', 'capability'],
    );
    const owner = {
        protocol: 1 as const,
        id: 'production-credit-02',
        connection: ssh.automationConnection,
        capability: start.capability as string,
    };
    const event = (await ssh.automationStream({ ...owner, action: 'read' })) as {
        sequence: number;
    };
    await assert.rejects(
        ssh.automationStream({
            ...owner,
            capability: '0'.repeat(64),
            action: 'ack',
            sequence: event.sequence,
        }),
        /owner/,
    );
    await assert.rejects(
        ssh.automationStream({ ...owner, action: 'ack', sequence: event.sequence + 1 }),
        /acknowledgement/,
    );
    await ssh.automationStream({ ...owner, action: 'ack', sequence: event.sequence });
    await assert.rejects(
        ssh.automationStream({ ...owner, action: 'ack', sequence: event.sequence }),
        /acknowledgement/,
    );
    await ssh.automationStream({ ...owner, action: 'read' });
    await ssh.automationStream({ ...owner, action: 'finalize' });
});

test('production cancellation joins the owned exec close and pending sink before finalization permits another command', async (t) => {
    const { model, ssh } = await fixture(t),
        controller = new AbortController();
    const client = new SshStreamClient((input) => ssh.automationStream(input), 'local-client');
    let release!: () => void,
        entered = false;
    const gate = new Promise<void>((r) => (release = r));
    const pending = client.execute(
        {
            id: 'production-cancel-01',
            connection: ssh.automationConnection,
            command: 'fixture-large',
            timeoutMs: 10000,
        },
        {
            append: async () => {
                entered = true;
                await gate;
            },
            flush: async () => {},
            rejectObservation: () => {},
        },
        controller.signal,
    );
    await until(() => entered);
    controller.abort();
    let finalized = false;
    const final = client.finalize().then(() => (finalized = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
        finalized,
        false,
        'Pending local IO retains the execution owner even on concurrent finalize.',
    );
    await assert.rejects(ssh.collect(), /paused/);
    release();
    assert.equal((await pending).completion, 'cancelled');
    await final;
    await until(() => model.state.activeExecs === 0);
    assert.equal(ssh.isConnected, true);
});

test('actual GatewayClient HTTP adapter preserves gateway observation source, durable capture and authenticated scoped credit', async (t) => {
    const { server, store } = await fixture(t);
    const previousFetch = globalThis.fetch,
        previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'),
        previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { protocol: 'http:' },
    });
    globalThis.fetch = (url, init) => {
        const headers = new Headers(init?.headers);
        if (!headers.has('Origin')) headers.set('Origin', 'http://127.0.0.1:5173');
        return previousFetch(url, { ...init, headers });
    };
    const gateway = new GatewayClient({ url: server.url, token: server.token });
    try {
        await gateway.connect(server.options);
        const rpc: SshStreamRpc = (request) => gateway.automationStream(request),
            client = new SshStreamClient(rpc, 'gateway');
        const request = {
            id: 'production-gateway01',
            connection: gateway.automationConnection(),
            command: 'fixture-large',
            timeoutMs: 10000,
        };
        const capture = await captureToRepository(
            store,
            { ...header(), receiveTimeSource: 'gateway' },
            new AbortController().signal,
            (sink, signal) => client.execute(request, sink, signal),
        );
        assert.equal(capture.completion, 'exit');
        assert.equal(capture.stored.committedBytes, 2113536);
        assert.equal(capture.stored.header.receiveTimeSource, 'gateway');
        await client.finalize();
        const url =
                '/api/sessions/' +
                gateway.automationConnection() +
                '/automation/stream/capabilities',
            body = { protocol: 1, action: 'capabilities' };
        assert.equal(
            (await server.request(url, 'POST', body, { Authorization: 'Bearer ' + 'x'.repeat(32) }))
                .status,
            401,
        );
        assert.equal(
            (await server.request(url, 'POST', body, { Origin: 'https://untrusted.invalid' }))
                .status,
            403,
        );
        const stale = await server.request(
            '/api/sessions/' + gateway.automationConnection() + '/automation/stream/ack',
            'POST',
            {
                protocol: 1,
                action: 'ack',
                id: request.id,
                connection: request.connection,
                capability: '0'.repeat(64),
                sequence: 0,
            },
        );
        assert.equal(stale.ok, false);
    } finally {
        await gateway.disconnect();
        globalThis.fetch = previousFetch;
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
        if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
        else Reflect.deleteProperty(globalThis, 'location');
    }
});

test('production storage failure retains its committed prefix and joins SSH cleanup before permitting rearm', async (t) => {
    const { model, ssh, store } = await fixture(t),
        client = new SshStreamClient((input) => ssh.automationStream(input), 'local-client');
    let writes = 0;
    const failing = new Proxy(store, {
        get(target, key) {
            if (key === 'append')
                return async (...args: Parameters<CaptureRepository['append']>) => {
                    if (++writes === 3)
                        throw new CaptureStorageError('quota', 'Synthetic full storage.');
                    return target.append(...args);
                };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as CaptureRepository;
    const request = {
        id: 'production-quota-001',
        connection: ssh.automationConnection,
        command: 'fixture-large',
        timeoutMs: 10000,
    };
    const result = await captureToRepository(
        failing,
        header(),
        new AbortController().signal,
        (sink, signal) => client.execute(request, sink, signal),
    );
    assert.equal(result.completion, 'storage-error');
    assert.equal(result.stored.failure?.code, 'quota');
    assert.equal(result.stored.state, 'incomplete');
    assert.ok(result.stored.committedBytes > 0 && result.stored.committedBytes < 2113536);
    await client.finalize();
    assert.equal(model.state.activeExecs, 0, 'Finalization acknowledges remote channel cleanup.');
    assert.equal(
        (await ssh.runAutomation({ ...request, id: 'production-quota-002', command: 'pwd' }))
            .stdout,
        '/root\r\n',
    );
});

test('production connection replacement invalidates pending stream identity and cannot send into the replacement', async (t) => {
    const { server, ssh, store, model } = await fixture(t),
        client = new SshStreamClient((input) => ssh.automationStream(input), 'local-client');
    const before = ssh.automationConnection;
    const pending = captureToRepository(
        store,
        header(),
        new AbortController().signal,
        (sink, signal) =>
            client.execute(
                {
                    id: 'production-reconn-01',
                    connection: before,
                    command: 'fixture-stall',
                    timeoutMs: 10000,
                },
                sink,
                signal,
            ),
    );
    await until(() => model.state.execs.includes('fixture-stall'));
    await ssh.connect(server.options, async () => true);
    const result = await pending;
    assert.notEqual(result.completion, 'exit');
    assert.notEqual(ssh.automationConnection, before);
    await assert.rejects(client.finalize(), /owner|stale/);
    assert.equal(
        (
            await ssh.runAutomation({
                id: 'production-reconn-02',
                connection: ssh.automationConnection,
                command: 'pwd',
                timeoutMs: 1000,
            })
        ).stdout,
        '/root\r\n',
    );
});

test('production real loopback connect/run/cancel/rearm cycles release owned channels, connections and store locks', async (t) => {
    const { server, ssh, store, model, profile } = await fixture(t);
    const memory = [];
    for (let cycle = 0; cycle < 8; cycle++) {
        if (cycle) await ssh.connect(server.options, async () => true);
        const client = new SshStreamClient((input) => ssh.automationStream(input), 'local-client'),
            controller = new AbortController();
        const request = {
            id: 'production-cycle-' + String(cycle).padStart(3, '0'),
            connection: ssh.automationConnection,
            command: 'pwd',
            timeoutMs: 1000,
        };
        const result = await captureToRepository(
            store,
            header('pwd'),
            controller.signal,
            (sink, signal) => client.execute(request, sink, signal),
        );
        assert.equal(result.completion, 'exit');
        await client.finalize();
        assert.equal(model.state.activeExecs, 0);
        ssh.disconnect();
        await until(() => server.connectedSessions() === 0);
        memory.push({ stage: 'closed-connection-' + cycle, ...process.memoryUsage() });
    }
    assert.equal(
        (await store.page()).records.length,
        8,
        'Intentional disk retention is separate from leaked memory.',
    );
    await store.close();
    memory.push({ stage: 'store-closed', ...process.memoryUsage() });
    const reopened = await NativeCaptureStore.open(profile, { profileOwned: true });
    try {
        assert.equal((await reopened.page()).records.length, 8);
    } finally {
        await reopened.close();
    }
    t.diagnostic(
        JSON.stringify({
            scope: 'Source-specific ownership/connection/store teardown; memory samples are diagnostic, not a whole-app budget',
            memory,
            activeExecs: model.state.activeExecs,
            connectedSessions: server.connectedSessions(),
        }),
    );
});

function independentPlan(commands: string[]): AutomationPlan {
    return {
        transport: 'ssh',
        steps: commands.map((command, index) => ({
            id: 'step-' + index,
            name: 'Step ' + index,
            enabled: true,
            command,
            delaySeconds: 0,
        })),
        timeoutSeconds: 10,
        repeatSeconds: null,
        start: null,
        serial: { lineEnding: 'CR', prompt: '', timestampPrefix: '' },
    };
}
test('actual SSH backend and FlowRunner await immutable outcome before next exec and preserve independent cwd/nonzero behavior', async (t) => {
    const { model, ssh, store } = await fixture(t);
    let release!: () => void,
        committing = false;
    const gate = new Promise<void>((r) => (release = r)),
        rows: AutomationRecord[] = [],
        states: string[] = [];
    const backend = sshCaptureBackend(
        {
            automationConnection: () => ssh.automationConnection,
            automationStream: (input) => ssh.automationStream(input),
        },
        store,
        'local-client',
        { endpoint: 'local fixture', username: 'engineer' },
        () => ssh.isConnected,
    );
    const runner = new FlowRunner(
        (state) => states.push(state.state),
        async (record) => {
            rows.push(record);
            if (rows.length === 1) {
                committing = true;
                await gate;
            }
            await store.record(record.stored!.id, outcomeOf(record));
        },
    );
    const run = runner.start(independentPlan(['cd /', 'pwd', 'll', 'fixture_hi', 'pwd']), backend);
    await until(() => committing);
    assert.deepEqual(model.state.execs, ['cd /']);
    await assert.rejects(ssh.collect(), /paused/);
    assert.equal(await store.result(rows[0].stored!.id), null);
    release();
    await run;
    assert.deepEqual(model.state.execs, ['cd /', 'pwd', 'll', 'fixture_hi', 'pwd']);
    assert.deepEqual(
        rows.map((r) => r.exitCode),
        [0, 0, 127, 127, 0],
    );
    assert.equal(rows[1].stdout, '/root\r\n');
    assert.equal(states.at(-1), 'finished');
    assert.equal(runner.busy, false);
    for (const row of rows) assert.equal((await store.result(row.stored!.id))?.id, row.id);
    assert.equal(model.state.activeExecs, 0);
});
test('actual FlowRunner cancellation/outcome failure joins pending commit and stops every later SSH command', async (t) => {
    const { model, ssh, store } = await fixture(t);
    let release!: () => void,
        committing = false;
    const gate = new Promise<void>((r) => (release = r)),
        states: string[] = [];
    const backend = sshCaptureBackend(
        {
            automationConnection: () => ssh.automationConnection,
            automationStream: (input) => ssh.automationStream(input),
        },
        store,
        'local-client',
        { endpoint: 'local fixture' },
        () => ssh.isConnected,
    );
    const runner = new FlowRunner(
        (state) => states.push(state.state),
        async () => {
            committing = true;
            await gate;
            throw new CaptureStorageError('quota', 'Synthetic outcome quota failure.');
        },
    );
    const run = runner.start(independentPlan(['pwd', 'll']), backend);
    await until(() => committing);
    runner.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runner.busy, true);
    await assert.rejects(ssh.collect(), /paused/);
    assert.deepEqual(model.state.execs, ['pwd']);
    release();
    await run;
    assert.equal(states.at(-1), 'paused');
    assert.equal(runner.busy, false);
    assert.deepEqual(model.state.execs, ['pwd']);
    const rows = (await store.page()).records;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'complete');
    assert.equal(await store.result(rows[0].id), null);
    assert.equal(model.state.activeExecs, 0);
    assert.equal(
        (
            await ssh.runAutomation({
                id: 'production-rearm-001',
                connection: ssh.automationConnection,
                command: 'pwd',
                timeoutMs: 1000,
            })
        ).completion,
        'exit',
    );
});

test('production SSH exec captures an already installed real shell process with genuine stdout, stderr and nonzero exit', async (t) => {
    const executable =
        process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/bash.exe' : '/bin/sh';
    try {
        await fs.access(executable);
    } catch {
        t.skip('No existing supported local shell executable; none installed.');
        return;
    }
    const command = "printf 'real-stdout'; printf 'real-stderr' >&2; exit 7";
    let childClosed = false;
    const server = await gatewayFixture(undefined, {
        exec: (input, channel) => {
            if (input !== command) return false;
            const child = spawn(
                executable,
                process.platform === 'win32'
                    ? ['--noprofile', '--norc', '-c', command]
                    : ['-c', command],
                { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
            );
            channel.on('error', () => {});
            channel.on('end', () => channel.close());
            channel.resume();
            child.stdout.pipe(channel, { end: false });
            child.stderr.pipe(channel.stderr, { end: false });
            child.stdin.end();
            child.once('close', (code) => {
                childClosed = true;
                if (!channel.destroyed) {
                    if (code !== null) channel.exit(code);
                    channel.end();
                }
            });
            child.once('error', () => channel.close());
            channel.once('close', () => {
                if (!childClosed) child.kill();
            });
            return true;
        },
    });
    const ssh = new SshSession(),
        temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-production-shell-')),
        store = await NativeCaptureStore.open(profile, { profileOwned: true });
    try {
        await ssh.connect(server.options, async () => true);
        const client = new SshStreamClient((input) => ssh.automationStream(input), 'local-client');
        const capture = await captureToRepository(
            store,
            header(command),
            new AbortController().signal,
            (sink, signal) =>
                client.execute(
                    {
                        id: 'production-realsh-01',
                        connection: ssh.automationConnection,
                        command,
                        timeoutMs: 10000,
                    },
                    sink,
                    signal,
                ),
        );
        assert.equal(capture.completion, 'exit');
        assert.equal(capture.exitCode, 7);
        assert.equal(capture.stdout, 'real-stdout');
        assert.equal(capture.stderr, 'real-stderr');
        assert.equal(childClosed, true);
        await client.finalize();
        t.diagnostic(
            'Real process ' +
                executable +
                ' through authenticated loopback SSH; pipes are not PTY/ash/DUT qualification.',
        );
    } finally {
        ssh.disconnect();
        await store.close();
        await server.close();
        assert.ok(
            path.resolve(profile).startsWith(temp + path.sep) &&
                path.basename(profile).startsWith('hub-production-shell-'),
        );
        await fs.rm(profile, { recursive: true, force: true });
    }
});
