import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SshSession } from '../backend/ssh/session';
import { ConsoleOperationPort } from '../backend/ssh/console-port';
import { NativeConsoleJournal } from '../electron/console-journal';
import { SshConsoleClient } from '../src/features/automation/capture/ssh-console-client';
import { GatewayClient } from '../src/services/GatewayClient';
import { bytesBase64 } from '../shared/capture-store';
import { consoleRpcRequest, type ConsoleRpc } from '../shared/console-rpc';
import type { ConsoleSegment } from '../shared/console-journal';
import { gatewayFixture } from './fixtures/gateway';
import { consoleFixture } from './fixtures/ssh-console';
const ready = { role: 'shell-prompt' as const, literals: ['fixture:/root# '] };
const id = () => randomUUID().replaceAll('-', '');
const segment = (
    command: string,
    ordinal = 1,
    enter = false,
    intermediate = false,
): Extract<ConsoleSegment, { kind: 'command' }> => ({
    kind: 'command',
    runId: 'first-run',
    stepId: 'step-' + ordinal,
    ordinal,
    name: 'Fixture',
    input: { intent: enter ? 'send-enter' : 'script', command },
    requestBase64: bytesBase64(Buffer.from(enter ? '\r' : command + '\r')),
    criterion: {
        role: intermediate ? 'intermediate-input-prompt' : 'shell-prompt',
        literals: [intermediate ? 'Proceed fixture [Enter]? ' : 'fixture:/# '],
    },
});
async function fixture(t: import('node:test').TestContext) {
    const model = consoleFixture({ fragment: 3 }),
        server = await gatewayFixture(undefined, model);
    const session = new SshSession(),
        profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-console-protocol-'));
    const store = await NativeConsoleJournal.open(profile, { profileOwned: true });
    let client: SshConsoleClient | undefined;
    t.after(async () => {
        await client?.close('cancelled').catch(() => {});
        session.disconnect();
        await server.close();
        await store.close();
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('hub-console-protocol-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    return {
        model,
        server,
        session,
        store,
        profile,
        adopt: (value: SshConsoleClient) => (client = value),
    };
}
test('legacy capabilities and malformed owner operations refuse before opening or sending input', async () => {
    let opens = 0;
    const client = new SshConsoleClient(async (request) => {
        if (request.action !== 'capabilities') opens++;
        return { protocol: 1, independentStream: 1 };
    }, 'local-client');
    await assert.rejects(
        client.open('a'.repeat(32), id(), ready, 2000, () => {}),
        /Update the desktop app or gateway/,
    );
    assert.equal(opens, 0);
    for (const request of [
        { protocol: 1, action: 'capabilities', path: 'C:/outside' },
        {
            protocol: 1,
            action: 'step',
            id: id(),
            connection: 'a'.repeat(32),
            capability: 'b'.repeat(64),
            sequence: 0,
            segment: { kind: 'context', phase: 'idle' },
            timeoutMs: 1000,
        },
        {
            protocol: 1,
            action: 'open',
            epoch: 'a'.repeat(32),
            id: id(),
            connection: 'b'.repeat(32),
            ready: { role: 'intermediate-input-prompt', literals: ['Proceed?'] },
            timeoutMs: 1000,
        },
    ])
        assert.throws(() => consoleRpcRequest(request));
});
test(
    'native protocol drives one console through distinct capability and sequential input while retaining null exits',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t);
        await f.session.connect(f.server.options, async (key) => key === f.server.pinned);
        const requests: unknown[] = [];
        const rpc: ConsoleRpc = (request) => {
            requests.push(structuredClone(request));
            return f.session.automationConsole(request, 'local-client', async () => f.store);
        };
        const client = f.adopt(new SshConsoleClient(rpc, 'local-client'));
        await client.open(f.session.automationConnection, id(), ready, 2500, () => {});
        assert.equal(f.session.consoleBusy, true);
        await client.step(segment('cd /'), 2000, () => {});
        await client.step(segment('pwd', 2), 2000, () => {});
        await client.step(segment('confirm-fixture', 3, false, true), 2000, () => {});
        await client.step(segment('', 4, true), 2000, () => {});
        await client.step(segment('', 5, true), 2000, () => {});
        const capture = await client.close('complete');
        assert.equal(capture!.state, 'complete');
        assert.equal(capture!.observedBytes, capture!.bytes);
        assert.equal(f.session.consoleBusy, false);
        assert.equal(f.session.consoleProtocolSnapshot, null);
        assert.equal(f.model.state.opens, 1);
        assert.equal(f.model.state.closes, 1);
        assert.deepEqual(
            Buffer.concat(f.model.state.inputs),
            Buffer.from('cd /\rpwd\rconfirm-fixture\r\r\r'),
        );
        assert.equal(
            requests.filter((value) => (value as { action: string }).action === 'step').length,
            5,
        );
        assert.equal(client.resourceSnapshot.owner, false);
    },
);
test(
    'actual authenticated GatewayClient carries bounded durable operation ACKs with gateway provenance',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t),
            previousFetch = globalThis.fetch,
            previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'),
            previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: new EventTarget(),
        });
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { protocol: 'http:' },
        });
        globalThis.fetch = (url, init) => {
            const headers = new Headers(init?.headers);
            if (!headers.has('Origin')) headers.set('Origin', 'http://127.0.0.1:5173');
            return previousFetch(url, { ...init, headers });
        };
        const gateway = new GatewayClient({ url: f.server.url, token: f.server.token });
        let client: SshConsoleClient | undefined;
        try {
            await gateway.connect(f.server.options);
            client = f.adopt(
                new SshConsoleClient(
                    (request) => gateway.automationConsole(request),
                    'gateway',
                    f.store,
                ),
            );
            const connection = gateway.automationConnection(),
                flow = id();
            await client.open(connection, flow, ready, 3000, () => {});
            const route = '/api/sessions/' + connection + '/automation/console/capabilities',
                body = { protocol: 1, action: 'capabilities' };
            assert.equal(
                (await f.server.request(route, 'POST', body, { Authorization: 'Bearer wrong' }))
                    .status,
                401,
            );
            assert.equal(
                (
                    await f.server.request(route, 'POST', body, {
                        Origin: 'https://untrusted.invalid',
                    })
                ).status,
                403,
            );
            await client.step(segment('cd /'), 2000, () => {});
            const result = await client.step(segment('pwd', 2), 2000, () => {});
            assert.equal(result.console.header.receiveTimeSource, 'gateway');
            assert.equal(result.exitCode, null);
            const stale = await f.server.request(
                '/api/sessions/' + connection + '/automation/console/step',
                'POST',
                {
                    protocol: 1,
                    action: 'step',
                    id: flow,
                    connection,
                    capability: '0'.repeat(64),
                    sequence: 2,
                    segment: segment('pwd', 3),
                    timeoutMs: 1000,
                },
            );
            assert.equal(stale.ok, false);
            const capture = await client.close('complete');
            assert.equal(capture!.state, 'complete');
            assert.equal(f.store.resourceClosed, true);
            assert.equal(f.model.state.opens, 1);
            assert.equal(f.model.state.closes, 1);
            await gateway.disconnect();
        } finally {
            await client?.close('cancelled').catch(() => {});
            await gateway.disconnect().catch(() => {});
            globalThis.fetch = previousFetch;
            if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
            else Reflect.deleteProperty(globalThis, 'window');
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
    },
);
test('the operation port refuses duplicate reads and stale ACKs; delivery is not cleanup', async () => {
    let revision = 0;
    const port = new ConsoleOperationPort(() => ({ revision }));
    const operation = port.call({ op: 'close' });
    const delivered = await port.read(0);
    assert.equal(delivered.type, 'operation');
    await assert.rejects(port.read(0), /one console operation/);
    assert.throws(
        () => port.acknowledge(7, { snapshot: null, value: null, closed: true }, null),
        /invalid or stale/,
    );
    assert.equal(port.snapshot.pending, 1);
    port.acknowledge(0, { snapshot: null, value: null, closed: true }, null);
    assert.deepEqual(await operation, { snapshot: null, value: null, closed: true });
    assert.equal(port.snapshot.pending, 0);
    const pending = port.read(0);
    revision++;
    port.notify();
    assert.equal((await pending).type, 'state');
    port.fail(Error('Synthetic lost client'));
    await assert.rejects(port.call({ op: 'close' }), /lost client/);
    assert.throws(
        () => port.acknowledge(0, { snapshot: null, value: null, closed: true }, null),
        /lost client/,
    );
});
