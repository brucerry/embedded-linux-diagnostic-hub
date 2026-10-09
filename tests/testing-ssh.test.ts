import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayFixture } from './fixtures/gateway';
import { testingFixture } from './fixtures/testing';
import { SshSession } from '../backend/ssh/session';
import { sampleProfile } from '../shared/testing/simulation';
import { activeRun, type StartTests, type TestRun } from '../shared/testing/types';
import { createTestReport, validateTestReport } from '../shared/testing/report';
import { adapterCommand } from '../backend/testing/adapters';
import { shellQuote } from '../backend/testing/executor';
import type { TerminalEvent } from '../shared/terminal';
async function done(read: () => TestRun | null | Promise<TestRun | null>) {
    for (let n = 0; n < 200; n++) {
        const r = await read();
        if (r && !activeRun(r)) return r;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('Test run stalled');
}
function request(id: string): StartTests {
    const profile = sampleProfile();
    return {
        profile,
        inventoryId: id,
        testIds: profile.tests.map((t) => t.id),
        sequence: 'bench',
        readiness: {
            reviewed: true,
            fixtures: Object.fromEntries(
                profile.tests.map((t) => [t.id, { ready: true, identity: 'Software fixture' }]),
            ),
        },
    };
}
test('desktop SSH tests reuse authentication and isolate PTY output, collection and clock channels', async () => {
    const testing = testingFixture(),
        fixture = await gatewayFixture(undefined, { exec: testing.exec }),
        ssh = new SshSession();
    const events: TerminalEvent[] = [];
    try {
        await ssh.connect(fixture.options, async (key) => key === fixture.pinned);
        const authentications = fixture.authentications();
        await ssh.openTerminal({ id: 'testing-terminal-123', cols: 80, rows: 24 }, (e) => {
            events.push(e);
            if (e.type === 'data') ssh.getTerminal(e.id).acknowledge(e.sequence);
        });
        const terminal = ssh.getTerminal('testing-terminal-123');
        const inv = await ssh.discoverTests(),
            req = request(inv.id);
        testing.state.delayMs = 100;
        const started = await ssh.startTests(req);
        await assert.rejects(ssh.startTests(req), /active/);
        await assert.rejects(ssh.collect(), /paused/);
        await assert.rejects(
            terminal.write(Buffer.from('echo blocked\n').toString('base64')),
            /paused|testing/i,
        );
        terminal.resize({ cols: 90, rows: 25 });
        assert.equal((await ssh.readClock()).status, 'available');
        const finished = await done(() => ssh.readTestRun());
        assert.deepEqual(
            finished.cases.map((c) => c.verdict),
            ['Inconclusive', 'Pass', 'Pass'],
        );
        const reviewed = ssh.confirmTest({
            runId: started.id,
            testId: req.testIds[0],
            value: 'yes',
        });
        assert.equal(reviewed.verdict, 'Pass');
        await validateTestReport(createTestReport(reviewed));
        assert.equal(fixture.authentications(), authentications);
        const text = events
            .filter((e) => e.type === 'data')
            .map((e) => Buffer.from(e.data, 'base64').toString())
            .join('');
        assert.doesNotMatch(text, /HUB-LED|HUB-UART|0x44/);
        await terminal.write(Buffer.from('echo restored\n').toString('base64'));
        const inv2 = await ssh.discoverTests();
        testing.state.delayMs = 1000;
        const next = await ssh.startTests(request(inv2.id));
        const cancelled = await ssh.cancelTests(next.id);
        assert.equal(cancelled.phase, 'cancelled');
        assert.equal(cancelled.cases[0].evidence!.cleanup, 'verified');
        await assert.rejects(ssh.cancelTests(started.id), /stale/);
        const inv3 = await ssh.discoverTests();
        testing.state.ledCleanup = false;
        await ssh.startTests(request(inv3.id));
        const unsafe = await done(() => ssh.readTestRun());
        assert.equal(unsafe.cases[0].verdict, 'Inconclusive');
        assert.equal(unsafe.cases[1].verdict, 'Skipped');
        await assert.rejects(ssh.startTests(request(inv3.id)), /Cleanup/);
    } finally {
        ssh.disconnect();
        await fixture.close();
    }
});
test('gateway testing enforces auth, request/run/session ownership and restores resources on delete', async () => {
    const testing = testingFixture(),
        fixture = await gatewayFixture(1000, { exec: testing.exec });
    try {
        const connected = await fixture.request('/api/sessions', 'POST', fixture.options),
            session = await connected.json(),
            root = `/api/sessions/${session.sessionId}`;
        const discovery = await fixture.request(root + '/tests/inventory', 'POST');
        assert.equal(discovery.status, 200);
        assert.equal(discovery.headers.get('cache-control'), 'no-store');
        const inv = await discovery.json(),
            req = request(inv.id),
            before = testing.state.calls.length;
        assert.equal(
            (await fixture.request(root + '/tests/inventory', 'POST', { command: 'evil' })).status,
            400,
        );
        assert.equal(testing.state.calls.length, before);
        assert.equal(
            (
                await fixture.request(root + '/tests/prepare', 'POST', {
                    profile: req.profile,
                    password: 'bad',
                })
            ).status,
            502,
        );
        assert.equal(
            (
                await fixture.request(root + '/tests/run', 'GET', undefined, {
                    Authorization: 'Bearer invalid',
                })
            ).status,
            401,
        );
        testing.state.uartMismatch = true;
        testing.state.i2cValue = '0x45';
        const started = await fixture.request(root + '/tests/start', 'POST', req);
        assert.equal(started.status, 202);
        const run = await done(async () => {
            const r = await fixture.request(root + '/tests/run');
            return (await r.json()).run;
        });
        assert.deepEqual(
            run.cases.map((c) => c.verdict),
            ['Inconclusive', 'Fail', 'Fail'],
        );
        assert.equal(
            (await fixture.request(root + '/tests/cancel', 'POST', { id: 'stale-run' })).status,
            502,
        );
        assert.equal(
            (
                await fixture.request(root + '/tests/confirm', 'POST', {
                    runId: run.id,
                    testId: req.testIds[0],
                    value: 'unobserved',
                })
            ).status,
            200,
        );
        const inv2 = await (await fixture.request(root + '/tests/inventory', 'POST')).json();
        testing.state.delayMs = 2000;
        await fixture.request(root + '/tests/start', 'POST', request(inv2.id));
        assert.equal(
            (await fixture.request(root + '/tests/start', 'POST', request(inv2.id))).status,
            502,
        );
        assert.equal((await fixture.request(root + '/snapshot', 'POST')).status, 409);
        const recovered = await (await fixture.request(root + '/tests/run')).json();
        assert.equal(recovered.run.phase, 'running');
        await fixture.request(root, 'DELETE');
        assert.equal((await fixture.request(root + '/tests/run')).status, 404);
        for (let i = 0; testing.state.channels.size && i < 50; i++)
            await new Promise((r) => setTimeout(r, 10));
        assert.equal(testing.state.channels.size, 0);
    } finally {
        await fixture.close();
    }
});
test('typed adapter commands quote labels and cannot scan, force, write arbitrary registers or override paths', async () => {
    assert.equal(shellQuote("a'$(bad)"), "'a'\"'\"'$(bad)'");
    const testing = testingFixture(),
        fixture = await gatewayFixture(undefined, { exec: testing.exec }),
        ssh = new SshSession();
    try {
        await ssh.connect(fixture.options, async (key) => key === fixture.pinned);
        const inv = await ssh.discoverTests(),
            plan = await ssh.prepareTests(sampleProfile());
        const command = adapterCommand(plan.cases[2]).command;
        assert.equal(command, 'timeout -k 2 -s TERM 5 i2cget -y 4 72 0 b');
        assert.doesNotMatch(command, /i2cdetect| -f |i2cset|unbind/);
        assert.throws(
            () =>
                adapterCommand({
                    ...plan.cases[1],
                    resource: { ...inv.resources[1], path: '/etc/passwd' },
                }),
            /UART/,
        );
        assert.throws(() =>
            adapterCommand({
                ...plan.cases[2],
                test: {
                    ...plan.cases[2].test,
                    parameters: { register: 256, expected: 68, mask: 255 },
                },
            }),
        );
    } finally {
        ssh.disconnect();
        await fixture.close();
    }
});
test('transport loss seals interrupted evidence and old run ownership cannot affect a replacement connection', async () => {
    const testing = testingFixture(),
        fixture = await gatewayFixture(undefined, { exec: testing.exec }),
        ssh = new SshSession();
    try {
        await ssh.connect(fixture.options, async (key) => key === fixture.pinned);
        const inv = await ssh.discoverTests();
        testing.state.delayMs = 500;
        const first = await ssh.startTests(request(inv.id));
        ssh.disconnect();
        const ended = ssh.readTestRun()!;
        assert.equal(ended.phase, 'cancelled');
        assert.equal(ended.cases[0].verdict, 'Inconclusive');
        assert.equal(ended.cases[0].evidence!.cleanup, 'unverified');
        await ssh.connect(fixture.options, async (key) => key === fixture.pinned);
        assert.throws(
            () =>
                ssh.confirmTest({ runId: first.id, testId: first.cases[0].test.id, value: 'yes' }),
            /current run/,
        );
        assert.equal(ssh.readTestRun(), null);
    } finally {
        ssh.disconnect();
        await fixture.close();
    }
});
