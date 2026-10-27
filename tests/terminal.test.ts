import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Server, type Client, type ClientChannel } from 'ssh2';
import { SshSession } from '../backend/ssh/session';
import { SshTerminal } from '../backend/ssh/terminal';
import {
    terminalId,
    terminalData,
    terminalSize,
    terminalEvent,
    TERMINAL_QUEUE_BYTES,
    type TerminalEvent,
} from '../shared/terminal';
import { attachTerminalFixture, terminalFixtureState } from './fixtures/terminal';

test('terminal contracts reject invalid IDs, data, dimensions and output events', () => {
    for (const id of ['', '../device', 'x'.repeat(65), null]) assert.throws(() => terminalId(id));
    for (const data of ['', 'not base64!', 'YQ=', Buffer.alloc(16385).toString('base64')])
        assert.throws(() => terminalData(data));
    for (const size of [
        null,
        { cols: 0, rows: 24 },
        { cols: 80, rows: 301 },
        { cols: 2.5, rows: 1 },
    ])
        assert.throws(() => terminalSize(size));
    assert.throws(() =>
        terminalEvent({ id: 'a'.repeat(16), type: 'data', sequence: 0, data: 'YQ==' }),
    );
    assert.throws(() => terminalEvent({ id: 'a'.repeat(16), type: 'state', state: 'other' }));
    assert.equal(
        terminalData(Buffer.from('裝置').toString('base64')),
        Buffer.from('裝置').toString('base64'),
    );
});

async function eventually(check: () => boolean) {
    const end = Date.now() + 3000;
    while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check(), 'Expected terminal event did not arrive');
}

test('real SSH PTY reuses one authentication, retains shell state, resizes and closes independently', async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        type: 'pkcs1',
        format: 'pem',
    });
    const state = terminalFixtureState();
    let authentications = 0;
    const server = new Server({ hostKeys: [key] }, (client) => {
        client.on('error', () => {});
        client.on('authentication', (context) => {
            authentications++;
            context.accept();
        });
        client.on('ready', () =>
            client.on('session', (accept) => {
                const channel = accept();
                attachTerminalFixture(channel, state);
                channel.on('exec', (acceptExec) => {
                    const stream = acceptExec();
                    stream.write(
                        'COLLECTION_STDOUT_ONLY\n[123.4] kernel: COLLECTION_KERNEL_ONLY\n',
                    );
                    stream.stderr.write('COLLECTION_STDERR_ONLY\n');
                    stream.exit(0);
                    stream.end();
                });
            }),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const session = new SshSession();
    const events: TerminalEvent[] = [];
    const chunks: Buffer[] = [];
    const id = 'terminal-session-0001';
    const options = {
        host: '127.0.0.1',
        port: (server.address() as { port: number }).port,
        username: 'engineer',
        auth: 'password' as const,
    };
    try {
        await session.connect(options, async () => true);
        const emit = (event: TerminalEvent) => {
            events.push(event);
            if (event.type === 'data') {
                chunks.push(Buffer.from(event.data, 'base64'));
                session.getTerminal(event.id).acknowledge(event.sequence);
            }
        };
        await session.openTerminal({ id, cols: 80, rows: 24 }, emit);
        await eventually(() => Buffer.concat(chunks).toString().includes('/home/engineer $'));
        await assert.rejects(
            session.openTerminal({ id: 'terminal-session-0002', cols: 80, rows: 24 }, emit),
            /already active/,
        );
        await session
            .getTerminal(id)
            .write(Buffer.from('cd /tmp\rpwd\runicode\rwatch\r\x03').toString('base64'));
        await eventually(
            () =>
                Buffer.concat(chunks).toString().includes('裝置✓') &&
                Buffer.concat(chunks).toString().includes('^C'),
        );
        session.getTerminal(id).resize({ cols: 100, rows: 30 });
        await eventually(() => state.sizes.some((size) => size.cols === 100 && size.rows === 30));
        assert.match(Buffer.concat(chunks).toString(), /\/tmp/);
        const collecting = session.collect();
        await session
            .getTerminal(id)
            .write(Buffer.from('echo [123.4] kernel: USER_REQUESTED_LOG\r').toString('base64'));
        const snapshot = await collecting;
        assert.equal(snapshot.results.length, 36);
        assert.ok(
            snapshot.results.every(
                (result) =>
                    result.stdout.includes('COLLECTION_STDOUT_ONLY') &&
                    result.stdout.includes('COLLECTION_KERNEL_ONLY') &&
                    result.stderr.includes('COLLECTION_STDERR_ONLY'),
            ),
        );
        await eventually(() => Buffer.concat(chunks).toString().includes('USER_REQUESTED_LOG'));
        assert.doesNotMatch(
            Buffer.concat(chunks).toString(),
            /COLLECTION_(STDOUT|STDERR|KERNEL)_ONLY/,
        );
        const idleOutput = Buffer.concat(chunks).toString();
        await session.collect();
        assert.equal(
            Buffer.concat(chunks).toString(),
            idleOutput,
            'Idle collection must not write into the shell PTY',
        );
        assert.equal(authentications, 1);
        assert.throws(() => session.getTerminal('terminal-session-old1'), /earlier connection/);
        session.getTerminal(id).close();
        assert.equal(session.isConnected, true);
        assert.throws(() => session.getTerminal(id));
        state.refuse = true;
        await assert.rejects(session.openTerminal({ id, cols: 80, rows: 24 }, emit), /refused/);
        assert.equal(session.isConnected, true);
        state.refuse = false;
        await session.openTerminal({ id, cols: 80, rows: 24 }, emit);
        await session.getTerminal(id).write(Buffer.from('exit\r').toString('base64'));
        await eventually(
            () =>
                events.filter((event) => event.type === 'state' && event.state === 'closed')
                    .length === 2,
        );
        await session.openTerminal({ id, cols: 80, rows: 24 }, emit);
        await session.connect(options, async () => true);
        assert.throws(() => session.getTerminal(id), /earlier connection/);
        const replacement = 'terminal-session-0002';
        await session.openTerminal({ id: replacement, cols: 80, rows: 24 }, emit);
        await session.getTerminal(replacement).write(Buffer.from('pwd\r').toString('base64'));
        await eventually(() => state.opens === 4 && state.closes >= 3);
        assert.equal(authentications, 2);
        session.getTerminal(replacement).close();
        const opening = session.openTerminal(
            { id: 'terminal-session-0003', cols: 80, rows: 24 },
            emit,
        );
        session.disconnect();
        await assert.rejects(opening, /closed before opening/);
        assert.equal(session.isConnected, false);
    } finally {
        session.disconnect();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test('terminal bounds pending output and rejects invalid acknowledgments without ending SSH', async () => {
    const stream = new PassThrough() as unknown as ClientChannel;
    stream.stderr = new PassThrough();
    stream.setWindow = () => {};
    const client = {
        shell: (_size: unknown, callback: (error: null, stream: ClientChannel) => void) =>
            callback(null, stream),
    } as unknown as Client;
    const events: TerminalEvent[] = [];
    let closes = 0;
    const terminal = new SshTerminal(
        { id: 'terminal-output-0001', cols: 80, rows: 24 },
        (event) => events.push(event),
        () => closes++,
        30,
    );
    await terminal.open(client, { cols: 80, rows: 24 });
    stream.emit('data', Buffer.alloc(64 * 1024));
    assert.equal(stream.isPaused(), true);
    assert.throws(() => terminal.acknowledge(999), /acknowledgment/);
    terminal.acknowledge(4);
    assert.throws(() => terminal.acknowledge(4), /acknowledgment/);
    assert.equal(stream.isPaused(), false);
    stream.emit('data', Buffer.alloc(TERMINAL_QUEUE_BYTES + 1));
    assert.equal(closes, 1);
    assert.ok(events.some((event) => event.type === 'state' && event.state === 'error'));
    terminal.close();
    assert.equal(closes, 1);
    const stalled = new SshTerminal(
        { id: 'terminal-stalled-01', cols: 80, rows: 24 },
        (event) => events.push(event),
        () => closes++,
        30,
    );
    const nextStream = new PassThrough() as unknown as ClientChannel;
    nextStream.stderr = new PassThrough();
    const nextClient = {
        shell: (_size: unknown, cb: (error: null, stream: ClientChannel) => void) =>
            cb(null, nextStream),
    } as unknown as Client;
    await stalled.open(nextClient, { cols: 80, rows: 24 });
    nextStream.emit('data', Buffer.from('waiting'));
    await eventually(() => closes === 2);
});

test('a synchronous SSH shell failure releases terminal ownership immediately', async () => {
    let closes = 0;
    const terminal = new SshTerminal(
        { id: 'terminal-failed-0001', cols: 80, rows: 24 },
        () => {},
        () => closes++,
    );
    const client = {
        shell() {
            throw Error('Not connected');
        },
    } as unknown as Client;
    await assert.rejects(terminal.open(client, { cols: 80, rows: 24 }), /could not be opened/);
    assert.equal(closes, 1);
    terminal.close();
    assert.equal(closes, 1);
});
