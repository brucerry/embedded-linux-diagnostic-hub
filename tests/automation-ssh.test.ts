import assert from 'node:assert/strict';
import test from 'node:test';
import { SshSession } from '../backend/ssh/session';
import { gatewayFixture } from './fixtures/gateway';
const eventually = async (fn: () => boolean) => {
    const end = Date.now() + 3000;
    while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fn());
};
test('SSH automation preserves deliberate script, separate raw streams and real nonzero exit', async () => {
    const commands: string[] = [],
        fixture = await gatewayFixture(undefined, {
            exec(command, channel) {
                if (!command.startsWith('fixture automation')) return false;
                commands.push(command);
                channel.write(Buffer.from([0x65, 0x75, 0x72, 0x6f, 0x20, 0xe2, 0x82]));
                channel.write(Buffer.from([0xac]));
                channel.stderr.write('fixture error');
                channel.exit(7);
                channel.end();
                return true;
            },
        }),
        ssh = new SshSession();
    try {
        await ssh.connect(fixture.options, async () => true);
        const authenticated = fixture.authentications(),
            connection = ssh.automationConnection,
            id = 'automation-fixture-001',
            command = 'fixture automation\nsecond multiline line';
        const r = await ssh.runAutomation({ connection, id, command, timeoutMs: 1000 });
        assert.deepEqual(commands, [command]);
        assert.equal(r.stdout, 'euro €');
        assert.equal(r.stderr, 'fixture error');
        assert.equal(r.exitCode, 7);
        assert.equal(r.completion, 'exit');
        assert.equal(
            Buffer.concat(
                r.chunks
                    .filter((x) => x.stream === 'stdout')
                    .map((x) => Buffer.from(x.base64, 'base64')),
            ).toString(),
            'euro €',
        );
        assert.equal(fixture.authentications(), authenticated);
        assert.doesNotMatch(JSON.stringify(r), /device-test-password/);
        await ssh.connect(fixture.options, async () => true);
        assert.notEqual(ssh.automationConnection, connection);
        await assert.rejects(
            ssh.runAutomation({ connection, id, command, timeoutMs: 1000 }),
            /changed/,
        );
        assert.equal(commands.length, 1);
    } finally {
        ssh.disconnect();
        await fixture.close();
    }
});
test('owned SSH cancellation, output limit, terminal exclusion and pre-start tombstone preserve session', async () => {
    let calls = 0;
    const fixture = await gatewayFixture(undefined, {
            exec(command, channel) {
                if (!command.startsWith('fixture automation')) return false;
                calls++;
                channel.resume();
                channel.on('end', () => channel.close());
                if (command.endsWith('huge')) channel.write(Buffer.alloc(65537, 0x78));
                return true;
            },
        }),
        ssh = new SshSession();
    try {
        await ssh.connect(fixture.options, async () => true);
        const connection = ssh.automationConnection;
        const id = 'automation-fixture-cancel';
        const pending = ssh.runAutomation({
            connection,
            id,
            command: 'fixture automation stall',
            timeoutMs: 1000,
        });
        await eventually(() => calls === 1);
        await assert.rejects(ssh.collect(), /paused/);
        ssh.cancelAutomation(id, connection);
        assert.equal((await pending).completion, 'cancelled');
        assert.ok(ssh.isConnected);
        const limit = await ssh.runAutomation({
            connection,
            id: 'automation-fixture-huge',
            command: 'fixture automation huge',
            timeoutMs: 1000,
        });
        assert.equal(limit.completion, 'output-limit');
        assert.ok(limit.truncated);
        assert.equal(limit.stdout.length, 65536);
        ssh.cancelAutomation('automation-before-start', connection);
        await assert.rejects(
            ssh.runAutomation({
                connection,
                id: 'automation-before-start',
                command: 'fixture automation never',
                timeoutMs: 1000,
            }),
            /cancel|abort/i,
        );
        assert.equal(calls, 2);
        const timeout = await ssh.runAutomation({
            connection,
            id: 'automation-fixture-timeout',
            command: 'fixture automation stall',
            timeoutMs: 1000,
        });
        assert.equal(timeout.completion, 'timeout');
        assert.ok(ssh.isConnected);
    } finally {
        ssh.disconnect();
        await fixture.close();
    }
});
test('gateway automation is origin/token/connection fenced and rejects malformed commands before exec', async () => {
    let executions = 0;
    const fixture = await gatewayFixture(undefined, {
        exec(command, channel) {
            if (command !== 'fixture automation gateway') return false;
            executions++;
            channel.write('gateway synthetic result');
            channel.exit(0);
            channel.end();
            return true;
        },
    });
    try {
        const { sessionId } = await (
            await fixture.request('/api/sessions', 'POST', fixture.options)
        ).json();
        const path = '/api/sessions/' + sessionId + '/automation',
            data = {
                id: 'automation-gateway-001',
                connection: sessionId,
                command: 'fixture automation gateway',
                timeoutMs: 1000,
            };
        assert.equal(
            (await fixture.request(path, 'POST', data, { Authorization: 'Bearer invalid' })).status,
            401,
        );
        assert.equal(
            (await fixture.request(path, 'POST', data, { Origin: 'https://other.example' })).status,
            403,
        );
        assert.equal((await fixture.request(path, 'POST', { ...data, command: '\0' })).status, 400);
        assert.equal(
            (await fixture.request(path, 'POST', { ...data, connection: 'other-connection-001' }))
                .status,
            409,
        );
        assert.equal(executions, 0);
        const response = await fixture.request(path, 'POST', data);
        assert.equal(response.status, 200);
        const r = await response.json();
        assert.equal(r.stdout, 'gateway synthetic result');
        assert.equal(r.exitCode, 0);
        assert.equal(executions, 1);
    } finally {
        await fixture.close();
    }
});
