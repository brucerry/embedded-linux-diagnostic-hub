import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gatewayFixture } from './fixtures/gateway';

async function until(check: () => boolean) {
    const end = performance.now() + 3000;
    while (!check()) {
        assert.ok(performance.now() < end, 'Expected actual gateway owner boundary.');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
test(
    'DELETE joins the actual SSH transport and gateway shutdown joins actual HTTP owners',
    { timeout: 10000 },
    async (t) => {
        const fixture = await gatewayFixture();
        t.after(() => fixture.close());
        const response = await fixture.request('/api/sessions', 'POST', fixture.options);
        assert.equal(response.status, 201);
        const { sessionId } = await response.json();
        const active = fixture.ownershipSnapshot;
        assert.equal(active.ownedSessions, 1);
        assert.equal(active.allSessionOwners[0].connections.length, 1);
        assert.equal(active.allSessionOwners[0].connections[0].transport, 1);
        const disconnected = await fixture.request('/api/sessions/' + sessionId, 'DELETE');
        assert.equal(disconnected.status, 200);
        await disconnected.arrayBuffer();
        assert.equal(fixture.ownershipSnapshot.ownedSessions, 0);
        assert.equal(fixture.ownershipSnapshot.retiringSessions, 0);
        assert.deepEqual(fixture.ownershipSnapshot.allSessionOwners, []);
        await fixture.closeGateway();
        const closed = fixture.ownershipSnapshot;
        assert.equal(closed.serverListening, false);
        for (const name of [
            'httpSockets',
            'httpResponses',
            'httpBodyReaders',
            'requestTasks',
            'ownedSessions',
            'retiringSessions',
            'pendingConnections',
            'inFlight',
            'sessions',
            'cleanupTimers',
        ] as const)
            assert.equal(closed[name], 0, name);
    },
);
test(
    'an actually interrupted HTTP body releases its real reader and response without SSH admission',
    { timeout: 10000 },
    async (t) => {
        const fixture = await gatewayFixture();
        t.after(() => fixture.close());
        const request = http.request(fixture.url + '/api/sessions', {
            method: 'POST',
            headers: {
                Origin: 'http://127.0.0.1:5173',
                Authorization: 'Bearer ' + fixture.token,
                'Content-Type': 'application/json',
                'Content-Length': '1000',
            },
        });
        const exited = new Promise<void>((resolve) => request.once('close', resolve));
        request.on('error', () => {});
        request.write('{"host":');
        await until(() => fixture.ownershipSnapshot.httpBodyReaders === 1);
        assert.equal(fixture.ownershipSnapshot.httpResponses, 1);
        request.destroy();
        await exited;
        await until(
            () =>
                fixture.ownershipSnapshot.httpBodyReaders === 0 &&
                fixture.ownershipSnapshot.httpResponses === 0,
        );
        assert.equal(fixture.ownershipSnapshot.requestTasks, 0);
        assert.equal(fixture.ownershipSnapshot.ownedSessions, 0);
        assert.equal(fixture.authentications(), 0);
    },
);
test(
    'failed authentication retains no actual SSH owner after the request cleanup joins',
    { timeout: 10000 },
    async (t) => {
        const fixture = await gatewayFixture();
        t.after(() => fixture.close());
        const response = await fixture.request('/api/sessions', 'POST', {
            ...fixture.options,
            password: 'incorrect fixture password',
        });
        assert.equal(response.status, 502);
        await response.arrayBuffer();
        await until(() => fixture.ownershipSnapshot.ownedSessions === 0);
        assert.equal(fixture.ownershipSnapshot.retiringSessions, 0);
        assert.equal(fixture.ownershipSnapshot.pendingConnections, 0);
        assert.equal(fixture.ownershipSnapshot.inFlight, 0);
        assert.deepEqual(fixture.ownershipSnapshot.allSessionOwners, []);
    },
);
