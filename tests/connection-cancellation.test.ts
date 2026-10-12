import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayFixture } from './fixtures/gateway';
import { SshSession } from '../backend/ssh/session';
import { ConnectionFailure } from '../shared/connection';

test('gateway cancellation releases an already-created session and cannot close an unrelated attempt', async () => {
    const fixture = await gatewayFixture();
    try {
        const id = 'a'.repeat(32);
        const response = await fixture.request('/api/sessions', 'POST', {
            ...fixture.options,
            attemptId: id,
        });
        assert.equal(response.status, 201);
        const { sessionId } = await response.json();
        assert.equal(
            (
                await fixture.request('/api/connection-attempts/cancel', 'POST', {
                    attemptId: 'b'.repeat(32),
                })
            ).status,
            200,
        );
        assert.equal((await (await fixture.request('/api/health')).json()).activeSessions, 1);
        assert.equal(
            (
                await fixture.request(
                    '/api/connection-attempts/cancel',
                    'POST',
                    { attemptId: id },
                    { Authorization: 'Bearer wrong' },
                )
            ).status,
            401,
        );
        assert.equal(
            (
                await fixture.request(
                    '/api/connection-attempts/cancel',
                    'POST',
                    { attemptId: id },
                    { Origin: 'https://untrusted.example' },
                )
            ).status,
            403,
        );
        assert.equal(
            (await fixture.request('/api/connection-attempts/cancel', 'POST', { attemptId: id }))
                .status,
            200,
        );
        assert.equal((await (await fixture.request('/api/health')).json()).activeSessions, 0);
        assert.equal(
            (await fixture.request(`/api/sessions/${sessionId}/snapshot`, 'POST')).status,
            404,
        );
        assert.equal(
            (await fixture.request('/api/connection-attempts/cancel', 'POST', { attemptId: id }))
                .status,
            200,
        );
    } finally {
        await fixture.close();
    }
});

test('Cancel arriving before a session POST prevents a late handshake and validates attempt identifiers', async () => {
    const fixture = await gatewayFixture();
    try {
        const id = 'c'.repeat(32);
        assert.equal(
            (await fixture.request('/api/connection-attempts/cancel', 'POST', { attemptId: id }))
                .status,
            200,
        );
        assert.equal(
            (await fixture.request('/api/sessions', 'POST', { ...fixture.options, attemptId: id }))
                .status,
            409,
        );
        assert.equal(
            (
                await fixture.request('/api/sessions', 'POST', {
                    ...fixture.options,
                    attemptId: '../invalid',
                })
            ).status,
            400,
        );
        assert.equal(fixture.authentications(), 0);
    } finally {
        await fixture.close();
    }
});

test('gateway Cancel terminates a pending authentication and leaves no session', async () => {
    const fixture = await gatewayFixture(undefined, { authenticationDelayMs: 10_000 });
    try {
        const id = 'd'.repeat(32);
        const pending = fixture.request('/api/sessions', 'POST', {
            ...fixture.options,
            attemptId: id,
        });
        const deadline = Date.now() + 3000;
        while (fixture.authentications() === 0 && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(fixture.authentications() > 0);
        assert.equal(
            (await fixture.request('/api/connection-attempts/cancel', 'POST', { attemptId: id }))
                .status,
            200,
        );
        assert.equal((await (await pending).json()).code, 'cancelled');
        assert.equal((await (await fixture.request('/api/health')).json()).activeSessions, 0);
    } finally {
        await fixture.close();
    }
});

test('gateway Cancel remains available when general rate limit or cancellation tombstone capacity is full', async () => {
    const fixture = await gatewayFixture();
    try {
        const id = 'e'.repeat(32);
        assert.equal(
            (await fixture.request('/api/sessions', 'POST', { ...fixture.options, attemptId: id }))
                .status,
            201,
        );
        for (let i = 0; i < 128; i++)
            assert.equal(
                (
                    await fixture.request('/api/connection-attempts/cancel', 'POST', {
                        attemptId: i.toString(16).padStart(32, '0'),
                    })
                ).status,
                200,
            );
        let limited = false;
        for (let i = 0; i < 121; i++)
            if ((await fixture.request('/api/health')).status === 429) {
                limited = true;
                break;
            }
        assert.equal(limited, true);
        assert.equal(
            (await fixture.request('/api/connection-attempts/cancel', 'POST', { attemptId: id }))
                .status,
            200,
        );
        const deadline = Date.now() + 3000;
        while (fixture.connectedSessions() && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(fixture.connectedSessions(), 0);
    } finally {
        await fixture.close();
    }
});

test('SSH cancellation invalidates pending host approval and late approval cannot authenticate', async () => {
    const fixture = await gatewayFixture();
    const session = new SshSession();
    try {
        const controller = new AbortController();
        let approve!: (value: boolean) => void;
        let reached!: () => void;
        const hostReached = new Promise<void>((resolve) => {
            reached = resolve;
        });
        const pending = session.connect(
            fixture.options,
            () => {
                reached();
                return new Promise<boolean>((resolve) => {
                    approve = resolve;
                });
            },
            undefined,
            controller.signal,
        );
        const rejected = assert.rejects(
            pending,
            (error: unknown) => error instanceof ConnectionFailure && error.code === 'cancelled',
        );
        await hostReached;
        controller.abort();
        await rejected;
        approve(true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(session.isConnected, false);
        assert.equal(fixture.authentications(), 0);
        await session.connect(fixture.options, async () => true);
        assert.equal(session.isConnected, true);
    } finally {
        session.disconnect();
        await fixture.close();
    }
});

test('SSH authentication and host rejection have permanent typed outcomes', async () => {
    const fixture = await gatewayFixture();
    const session = new SshSession();
    try {
        await assert.rejects(
            session.connect({ ...fixture.options, password: 'wrong' }, async () => true),
            (error: unknown) =>
                error instanceof ConnectionFailure && error.code === 'authentication',
        );
        await assert.rejects(
            session.connect(fixture.options, async () => false),
            (error: unknown) => error instanceof ConnectionFailure && error.code === 'host-key',
        );
        assert.equal(session.isConnected, false);
    } finally {
        session.disconnect();
        await fixture.close();
    }
});
