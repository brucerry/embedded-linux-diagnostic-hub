import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gatewayFixture } from './fixtures/gateway';
import type { TerminalEvent } from '../shared/terminal';

async function streamReader(response: Response) {
    const reader = response.body!.getReader();
    let buffered = '';
    const decoder = new TextDecoder();
    return {
        async next(): Promise<TerminalEvent> {
            while (true) {
                const newline = buffered.indexOf('\n');
                if (newline >= 0) {
                    const line = buffered.slice(0, newline);
                    buffered = buffered.slice(newline + 1);
                    if (line && line !== '{}') return JSON.parse(line);
                } else {
                    const { value, done } = await reader.read();
                    if (done) throw Error('Stream ended');
                    buffered += decoder.decode(value, { stream: true });
                }
            }
        },
        cancel: () => reader.cancel(),
    };
}

test('gateway terminal streams prompt/Unicode, preserves auth and diagnostic/report isolation, validates operations', async () => {
    const fixture = await gatewayFixture();
    let reader: Awaited<ReturnType<typeof streamReader>> | undefined;
    try {
        const created = await fixture.request('/api/sessions', 'POST', fixture.options);
        const { sessionId } = await created.json();
        const authenticationAttempts = fixture.authentications();
        const route = `/api/sessions/${sessionId}/terminal`;
        const id = 'gateway-terminal-0001';
        assert.equal(
            (
                await fixture.request(
                    route,
                    'POST',
                    { id, cols: 80, rows: 24 },
                    { Authorization: 'Bearer invalid' },
                )
            ).status,
            401,
        );
        assert.equal(
            (
                await fixture.request(
                    route,
                    'POST',
                    { id, cols: 80, rows: 24 },
                    { Origin: 'https://untrusted.example' },
                )
            ).status,
            403,
        );
        assert.equal(fixture.terminal.opens, 0);
        const response = await fixture.request(route, 'POST', { id, cols: 80, rows: 24 });
        assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
        assert.match(response.headers.get('cache-control')!, /no-store/);
        reader = await streamReader(response);
        assert.equal((await reader.next()).type, 'state');
        let prompt = '';
        while (!prompt.includes('/home/engineer $')) {
            const event = await reader.next();
            if (event.type === 'data') prompt += Buffer.from(event.data, 'base64').toString();
        }
        assert.equal(fixture.authentications(), authenticationAttempts);
        assert.equal(
            (
                await fixture.request(route, 'POST', {
                    id: 'gateway-terminal-0002',
                    cols: 80,
                    rows: 24,
                })
            ).status,
            409,
        );
        const before = fixture.terminal.inputs.length;
        for (const [suffix, payload] of [
            ['input', { data: 'invalid!' }],
            ['input', { data: Buffer.alloc(16385).toString('base64') }],
            ['resize', { cols: 501, rows: 24 }],
        ] as const)
            assert.ok(
                (await fixture.request(`${route}/${id}/${suffix}`, 'POST', payload)).status >= 400,
            );
        assert.equal(fixture.terminal.inputs.length, before);
        assert.equal(
            (
                await fixture.request(`${route}/gateway-terminal-old1/input`, 'POST', {
                    data: 'YQ==',
                })
            ).status,
            409,
        );
        assert.equal(
            (
                await fixture.request(`${route}/${id}/input`, 'POST', {
                    data: Buffer.from('unicode\r').toString('base64'),
                })
            ).status,
            200,
        );
        const output: Buffer[] = [];
        while (!Buffer.concat(output).toString().includes('裝置✓')) {
            const event = await reader.next();
            if (event.type === 'data') output.push(Buffer.from(event.data, 'base64'));
        }
        assert.equal(
            (await fixture.request(`${route}/${id}/resize`, 'POST', { cols: 120, rows: 40 }))
                .status,
            200,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.ok(fixture.terminal.sizes.some((size) => size.cols === 120 && size.rows === 40));
        const snapshot = await fixture.request(`/api/sessions/${sessionId}/snapshot`, 'POST');
        assert.equal(snapshot.status, 200);
        assert.equal(JSON.stringify(await snapshot.json()).includes('裝置✓'), false);
        assert.equal(fixture.authentications(), authenticationAttempts);
        assert.equal((await fixture.request(`${route}/${id}`, 'DELETE')).status, 200);
        await reader.cancel();
        reader = undefined;
        assert.equal(
            (await fixture.request(`/api/sessions/${sessionId}/heartbeat`, 'POST')).status,
            200,
        );
        assert.equal((await fixture.request(`/api/sessions/${sessionId}`, 'DELETE')).status, 200);
        assert.equal(
            (await fixture.request(route, 'POST', { id, cols: 80, rows: 24 })).status,
            404,
        );
    } finally {
        await reader?.cancel().catch(() => {});
        await fixture.close();
    }
});

test('gateway typing has a per-session budget and aborted streams release only their shell', async () => {
    const fixture = await gatewayFixture();
    let reader: Awaited<ReturnType<typeof streamReader>> | undefined;
    try {
        const { sessionId } = await (
            await fixture.request('/api/sessions', 'POST', fixture.options)
        ).json();
        const route = `/api/sessions/${sessionId}/terminal`;
        const id = 'gateway-typing-00001';
        reader = await streamReader(
            await fixture.request(route, 'POST', { id, cols: 80, rows: 24 }),
        );
        const consume = (async () => {
            try {
                while (true) await reader!.next();
            } catch {
                /* Aborted on completion. */
            }
        })();
        for (let index = 0; index < 130; index++) {
            if (index % 40 === 0) await new Promise((resolve) => setTimeout(resolve, 700));
            assert.equal(
                (await fixture.request(`${route}/${id}/input`, 'POST', { data: 'YQ==' })).status,
                200,
            );
        }
        assert.equal(
            (await fixture.request(`/api/sessions/${sessionId}/heartbeat`, 'POST')).status,
            200,
        );
        const overload = await Promise.all(
            Array.from({ length: 180 }, () =>
                fixture.request(`${route}/${id}/resize`, 'POST', { cols: 80, rows: 24 }),
            ),
        );
        assert.ok(overload.some((response) => response.status === 429));
        await reader.cancel();
        await consume;
        reader = undefined;
        const end = Date.now() + 3000;
        while (!fixture.terminal.closes && Date.now() < end)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(fixture.terminal.closes, 1);
        assert.equal(
            (await fixture.request(`/api/sessions/${sessionId}/heartbeat`, 'POST')).status,
            200,
        );
        reader = await streamReader(
            await fixture.request(route, 'POST', { id, cols: 80, rows: 24 }),
        );
        while (fixture.terminal.opens < 2) await reader.next();
        await fixture.close();
        const endShutdown = Date.now() + 3000;
        while (fixture.terminal.closes < 2 && Date.now() < endShutdown)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(fixture.terminal.closes, 2);
    } finally {
        await reader?.cancel().catch(() => {});
        await fixture.close();
    }
});

test('idle gateway expiry closes an active terminal and rejects its old session', async () => {
    const fixture = await gatewayFixture(1000);
    let reader: Awaited<ReturnType<typeof streamReader>> | undefined;
    try {
        const { sessionId } = await (
            await fixture.request('/api/sessions', 'POST', fixture.options)
        ).json();
        const route = `/api/sessions/${sessionId}/terminal`;
        reader = await streamReader(
            await fixture.request(route, 'POST', {
                id: 'gateway-expiry-00001',
                cols: 80,
                rows: 24,
            }),
        );
        while (fixture.terminal.opens < 1) await reader.next();
        await new Promise((resolve) => setTimeout(resolve, 30_100));
        assert.equal(
            (
                await fixture.request(route, 'POST', {
                    id: 'gateway-expiry-00002',
                    cols: 80,
                    rows: 24,
                })
            ).status,
            404,
        );
        await reader.cancel();
        reader = undefined;
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(fixture.terminal.closes, 1);
    } finally {
        await reader?.cancel().catch(() => {});
        await fixture.close();
    }
});
