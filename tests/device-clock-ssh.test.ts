import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SshSession } from '../backend/ssh/session';
import { createReport } from '../shared/report';
import { type TerminalEvent } from '../shared/terminal';
import { gatewayFixture } from './fixtures/gateway';
import { clockOutput } from './fixtures/device-clock';

async function eventually(check: () => boolean) {
    const until = Date.now() + 3000;
    while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 15));
    assert.ok(check());
}

test('clock, diagnostics and user PTY share authentication with isolated output and evidence', async () => {
    const fixture = await gatewayFixture();
    const ssh = new SshSession();
    const output: string[] = [];
    try {
        await ssh.connect({ ...fixture.options, auth: 'password' }, async () => true);
        const authenticated = fixture.authentications();
        const id = 'clock-terminal-0001';
        await ssh.openTerminal({ id, cols: 80, rows: 24 }, (event: TerminalEvent) => {
            if (event.type === 'data') {
                output.push(Buffer.from(event.data, 'base64').toString());
                ssh.getTerminal(id).acknowledge(event.sequence);
            }
        });
        const [clock, snapshot] = await Promise.all([
            ssh.readClock(),
            ssh.collect(),
            ssh.getTerminal(id).write(Buffer.from('echo USER_CLOCK_ISOLATED\r').toString('base64')),
        ]);
        assert.equal(clock.status, 'available');
        assert.equal(fixture.clock.calls, 1);
        assert.equal(fixture.probeExecutions(), 36);
        assert.equal(fixture.authentications(), authenticated);
        await eventually(() => output.join('').includes('USER_CLOCK_ISOLATED'));
        assert.doesNotMatch(output.join(''), /DIAGNOSTIC_HUB_CLOCK|16:35:42/);
        assert.doesNotMatch(
            JSON.stringify(createReport(snapshot)),
            /DIAGNOSTIC_HUB_CLOCK|utcOffsetMinutes|bootId/,
        );
        fixture.clock.output = clockOutput('2026-10-10', '00:01:00', '+0000', 'UTC');
        const second = await ssh.readClock();
        assert.equal(second.status === 'available' && second.sample.date, '2026-10-10');
    } finally {
        ssh.disconnect();
        await fixture.close();
    }
});

test('clock output, timeout, cancellation and replacement are bounded without disconnecting healthy SSH', async () => {
    const fixture = await gatewayFixture();
    const ssh = new SshSession();
    try {
        const connect = () =>
            ssh.connect({ ...fixture.options, auth: 'password' }, async () => true);
        await connect();
        fixture.clock.stderr = 'x'.repeat(8193);
        assert.deepEqual(await ssh.readClock(), { status: 'unavailable', reason: 'failed' });
        fixture.clock.stderr = '';
        fixture.clock.stall = true;
        const pending = ssh.readClock();
        await assert.rejects(ssh.readClock(), /already running/);
        assert.deepEqual(await pending, { status: 'unavailable', reason: 'failed' });
        assert.ok(ssh.isConnected);
        const abort = new AbortController();
        const cancelled = ssh.readClock(abort.signal);
        await eventually(() => fixture.clock.calls >= 3);
        abort.abort();
        assert.equal((await cancelled).status, 'unavailable');
        fixture.clock.stall = false;
        assert.equal((await ssh.readClock()).status, 'available');
        fixture.clock.delayMs = 300;
        const old = ssh.readClock();
        ssh.disconnect();
        await connect();
        assert.equal((await old).status, 'unavailable');
        assert.equal((await ssh.readClock()).status, 'available');
        assert.equal((await ssh.collect()).results.length, 36);
    } finally {
        ssh.disconnect();
        await fixture.close();
    }
});

test('gateway clock access is authenticated, fixed, concurrent and cancellation preserves the session', async () => {
    const fixture = await gatewayFixture();
    try {
        const { sessionId } = await (
            await fixture.request('/api/sessions', 'POST', fixture.options)
        ).json();
        const route = `/api/sessions/${sessionId}/clock`;
        assert.equal(
            (await fixture.request(route, 'POST', undefined, { Authorization: 'Bearer bad' }))
                .status,
            401,
        );
        assert.equal(
            (await fixture.request(route, 'POST', undefined, { Origin: 'https://bad.example' }))
                .status,
            403,
        );
        assert.equal(
            (await fixture.request(`/api/sessions/${'z'.repeat(32)}/clock`, 'POST')).status,
            404,
        );
        assert.equal(
            (await fixture.request(route, 'POST', { command: 'date -s tomorrow' })).status,
            400,
        );
        const [clock, snapshot] = await Promise.all([
            fixture.request(route, 'POST'),
            fixture.request(`/api/sessions/${sessionId}/snapshot`, 'POST'),
        ]);
        assert.equal((await clock.json()).status, 'available');
        assert.equal((await snapshot.json()).results.length, 36);
        fixture.clock.output = 'x'.repeat(8193);
        assert.equal((await (await fixture.request(route, 'POST')).json()).status, 'unavailable');
        fixture.clock.output = clockOutput();
        fixture.clock.stall = true;
        assert.equal((await (await fixture.request(route, 'POST')).json()).status, 'unavailable');
        const abort = new AbortController();
        const pending = fetch(`${fixture.url}${route}`, {
            method: 'POST',
            headers: {
                Origin: process.env.HUB_TEST_ORIGIN ?? 'http://127.0.0.1:5173',
                Authorization: `Bearer ${fixture.token}`,
            },
            signal: abort.signal,
        });
        const caught = pending.catch(() => null);
        await eventually(() => fixture.clock.calls >= 4);
        abort.abort();
        await caught;
        await eventually(() => fixture.clock.active === 0);
        assert.equal(
            (await fixture.request(`/api/sessions/${sessionId}/heartbeat`, 'POST')).status,
            200,
        );
        fixture.clock.stall = false;
        assert.equal((await (await fixture.request(route, 'POST')).json()).status, 'available');
    } finally {
        await fixture.close();
    }
});
