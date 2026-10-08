import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateGatewayConfig } from '../gateway/server';
import { probes } from '../shared/diagnostics/probes';
import { gatewayFixture } from './fixtures/gateway';

test('gateway requires a strong token, exact origins and pinned allowlisted targets', () => {
    assert.throws(() => validateGatewayConfig({ token: 'short', origins: [], targets: [] }));
    assert.throws(() =>
        validateGatewayConfig({ token: 'x'.repeat(32), origins: ['*'], targets: [] }),
    );
    assert.throws(() =>
        validateGatewayConfig({
            token: 'x'.repeat(32),
            origins: ['https://brucerry.github.io'],
            targets: [{ host: 'device', port: 22, fingerprint: 'unknown' }],
        }),
    );
});

test('gateway rejects invalid tokens/origins and targets before opening device sessions', async () => {
    const fixture = await gatewayFixture();
    try {
        assert.equal(
            (
                await fixture.request('/api/health', 'GET', undefined, {
                    Authorization: 'Bearer wrong-token',
                })
            ).status,
            401,
        );
        assert.equal(
            (
                await fixture.request('/api/health', 'GET', undefined, {
                    Origin: 'https://untrusted.example',
                })
            ).status,
            403,
        );
        assert.equal(
            (
                await fixture.request('/api/sessions', 'POST', {
                    ...fixture.options,
                    host: 'unlisted-device',
                })
            ).status,
            403,
        );
        assert.equal(
            (
                await fixture.request('/api/sessions', 'POST', {
                    ...fixture.options,
                    expectedFingerprint: 'SHA256:wrong',
                })
            ).status,
            409,
        );
        assert.equal(fixture.authentications(), 0);
    } finally {
        await fixture.close();
    }
});

test('gateway fingerprint discovery sends no credentials, then real SSH collection and disconnect work', async () => {
    const fixture = await gatewayFixture();
    try {
        const discovery = await fixture.request('/api/fingerprint', 'POST', {
            host: fixture.options.host,
            port: fixture.options.port,
            username: fixture.options.username,
            auth: 'password',
        });
        assert.equal(discovery.status, 200);
        assert.equal((await discovery.json()).fingerprint, fixture.pinned);
        assert.equal(fixture.authentications(), 0);
        const connection = await fixture.request('/api/sessions', 'POST', fixture.options);
        assert.equal(connection.status, 201);
        const { sessionId } = await connection.json();
        const authenticated = fixture.authentications();
        assert.equal(
            (await fixture.request(`/api/sessions/${sessionId}/heartbeat`, 'POST')).status,
            200,
        );
        assert.equal(
            (
                await fixture.request(`/api/sessions/${sessionId}/heartbeat`, 'POST', undefined, {
                    Authorization: 'Bearer invalid',
                })
            ).status,
            401,
        );
        const collection = await fixture.request(`/api/sessions/${sessionId}/snapshot`, 'POST');
        assert.equal(collection.status, 200);
        const snapshot = await collection.json();
        assert.equal(snapshot.mode, 'ssh');
        assert.equal(snapshot.results.length, probes.length);
        assert.ok(!JSON.stringify(snapshot).includes(fixture.options.password));
        assert.equal(
            (await fixture.request(`/api/sessions/${sessionId}/snapshot`, 'POST')).status,
            200,
        );
        assert.equal(
            fixture.authentications(),
            authenticated,
            'Snapshots and heartbeats reuse the authenticated SSH connection.',
        );
        assert.equal((await fixture.request(`/api/sessions/${sessionId}`, 'DELETE')).status, 200);
        assert.equal(
            (await fixture.request(`/api/sessions/${sessionId}/snapshot`, 'POST')).status,
            404,
        );
    } finally {
        await fixture.close();
    }
});

test('gateway CORS preflight grants only the configured website origin', async () => {
    const fixture = await gatewayFixture();
    try {
        const response = await fixture.request('/api/sessions', 'OPTIONS');
        assert.equal(response.status, 204);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5173');
        assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
    } finally {
        await fixture.close();
    }
});

test('device-file routes are removed while fixed diagnostic collection still works', async () => {
    const fixture = await gatewayFixture();
    try {
        const connection = await fixture.request('/api/sessions', 'POST', fixture.options);
        assert.equal(connection.status, 201);
        const { sessionId } = await connection.json();
        for (const operation of ['read-file', 'write-file']) {
            const response = await fixture.request(
                `/api/sessions/${sessionId}/${operation}`,
                'POST',
                { path: '/etc/passwd', content: 'must not execute' },
            );
            assert.equal(response.status, 404);
            assert.equal((await response.json()).error, 'Unknown gateway route.');
        }
        const collection = await fixture.request(`/api/sessions/${sessionId}/snapshot`, 'POST');
        assert.equal(collection.status, 200);
        assert.equal((await collection.json()).results.length, probes.length);
    } finally {
        await fixture.close();
    }
});

test('gateway authenticates encrypted private keys, rejects bad credentials and never exports secrets', async () => {
    const fixture = await gatewayFixture();
    try {
        const options = {
            ...fixture.options,
            auth: 'key',
            password: undefined,
            privateKey: fixture.privateKey,
            passphrase: fixture.passphrase,
        };
        for (const privateKey of [undefined, '', 'x'.repeat(65537)]) {
            assert.equal(
                (await fixture.request('/api/sessions', 'POST', { ...options, privateKey })).status,
                400,
            );
        }
        assert.equal(fixture.authentications(), 0);
        assert.equal(
            (
                await fixture.request('/api/sessions', 'POST', {
                    ...options,
                    expectedFingerprint: 'wrong',
                })
            ).status,
            409,
        );
        assert.equal(fixture.authentications(), 0);
        assert.equal(
            (await fixture.request('/api/sessions', 'POST', { ...options, passphrase: 'wrong' }))
                .status,
            502,
        );
        const connection = await fixture.request('/api/sessions', 'POST', options);
        assert.equal(connection.status, 201);
        const { sessionId } = await connection.json();
        const snapshot = await (
            await fixture.request(`/api/sessions/${sessionId}/snapshot`, 'POST')
        ).json();
        assert.equal(snapshot.results.length, probes.length);
        assert.ok(!JSON.stringify(snapshot).includes(fixture.passphrase));
        assert.ok(!JSON.stringify(snapshot).includes('PRIVATE KEY'));
        assert.equal((await fixture.request(`/api/sessions/${sessionId}`, 'DELETE')).status, 200);
    } finally {
        await fixture.close();
    }
});
