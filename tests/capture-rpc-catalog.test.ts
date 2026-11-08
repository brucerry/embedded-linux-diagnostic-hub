import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeCaptureStore } from '../electron/capture-store';
import { NativeCaptureHost } from '../electron/capture-host';
import { trustedFrameHandler, trustedFrameReadyHandler } from '../electron/trusted-ipc';
import { CaptureRpcServer, type CaptureRpcReply } from '../shared/capture-rpc';
import { NativeCaptureRepository } from '../src/features/automation/capture/native-repository';
import { CaptureWriter } from '../shared/capture-writer';
import {
    CaptureStorageError,
    frameCrc,
    type CaptureHeader,
    type CaptureRepository,
} from '../shared/capture-store';
import { catalogPage, PlainCaptureText } from '../shared/capture-query';
import { streamCaptureReport } from '../shared/capture-report';
import type { AutomationOutcome } from '../shared/automation-result';
import { deferred, until } from './fixtures/serial-capture';
const stamp = '2026-10-15T00:00:00.000Z',
    encode = (value: string) => new TextEncoder().encode(value);

test('privileged capture handlers accept only the exact current application main frame', () => {
    const appUrl = 'app://bundle/index.html',
        frame = { url: appUrl },
        webContents = { mainFrame: frame };
    let destroyed = false,
        calls = 0;
    const handler = trustedFrameHandler(
        () => ({ webContents, isDestroyed: () => destroyed }),
        appUrl,
        () => {
            calls++;
            return true;
        },
    );
    assert.throws(() => handler({ sender: {}, senderFrame: frame }), /Untrusted/);
    assert.throws(
        () => handler({ sender: webContents, senderFrame: { url: appUrl } }),
        /Untrusted/,
    );
    assert.throws(() => handler({ sender: webContents, senderFrame: null }), /Untrusted/);
    frame.url = 'https://untrusted.example/';
    assert.throws(() => handler({ sender: webContents, senderFrame: frame }), /Untrusted/);
    frame.url = appUrl;
    destroyed = true;
    assert.throws(() => handler({ sender: webContents, senderFrame: frame }), /Untrusted/);
    destroyed = false;
    assert.equal(calls, 0);
    assert.equal(handler({ sender: webContents, senderFrame: frame }), true);
    assert.equal(calls, 1);
});
const header = (name = 'fixture'): CaptureHeader => ({
    transport: 'serial',
    receiveTimeSource: 'local-client',
    runId: 'fixture-run',
    stepId: 'one',
    command: 'fixture-script',
    name,
    startedAt: stamp,
});

test('capture initialization reauthorizes frame identity and document generation before dispatch', async () => {
    const appUrl = 'app://bundle/index.html',
        frame = { url: appUrl },
        webContents = { mainFrame: frame },
        event = { sender: webContents, senderFrame: frame },
        gate = deferred();
    let epoch = 0,
        initializations = 0,
        dispatches = 0;
    const handler = trustedFrameReadyHandler(
        () => ({ webContents, isDestroyed: () => false }),
        appUrl,
        () => epoch,
        async () => {
            initializations++;
            await gate.promise;
            return 'host';
        },
        (host, request) => {
            assert.equal(host, 'host');
            assert.equal(request, 'info');
            dispatches++;
            return true;
        },
    );
    await assert.rejects(handler({ sender: {}, senderFrame: frame }, 'info'), /Untrusted/);
    assert.equal(initializations, 0);
    const stale = handler(event, 'info');
    epoch++;
    const rejected = assert.rejects(stale, /Renderer changed/);
    gate.resolve();
    await rejected;
    assert.equal(dispatches, 0);
    const changedFrame = handler(event, 'info');
    webContents.mainFrame = { url: appUrl };
    await assert.rejects(changedFrame, /Untrusted/);
    assert.equal(dispatches, 0);
    webContents.mainFrame = frame;
    assert.equal(await handler(event, 'info'), true);
    assert.equal(dispatches, 1);
});
const outcome = (): AutomationOutcome => ({
    id: crypto.randomUUID().replaceAll('-', ''),
    ordinal: 1,
    completion: 'prompt-observed',
    exitCode: null,
    truncated: false,
    completedAt: stamp,
    localZone: 'UTC',
    durationMs: 1,
    deviceTime: null,
});
async function fixture(t: TestContext) {
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-capture-rpc-')),
        store = await NativeCaptureStore.open(profile, { profileOwned: true });
    t.after(async () => {
        await store.close();
        assert.ok(
            path.resolve(profile).startsWith(temp + path.sep) &&
                path.basename(profile).startsWith('hub-capture-rpc-'),
        );
        await fs.rm(profile, { recursive: true, force: true });
    });
    return { profile, store };
}
async function record(store: CaptureRepository, name = 'fixture', text = 'fixture output') {
    const writer = await CaptureWriter.begin(store, header(name));
    await writer.append(encode(text), stamp, 'serial');
    const capture = await writer.finish('prompt-observed'),
        result = outcome();
    await store.record!(capture.id, result);
    return { capture, result };
}
async function text(source: AsyncIterable<Uint8Array>) {
    let result = '';
    for await (const bytes of source) {
        assert.ok(bytes.length <= 65536);
        result += new TextDecoder().decode(bytes);
        assert.ok(result.length <= 2 * 1024 * 1024);
    }
    return result;
}
function freeze<T>(value: T): T {
    if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

test('native RPC round-trips bounded frames and immutable outcomes through copied/frozen bridge values', async (t) => {
    const { store } = await fixture(t),
        server = new CaptureRpcServer(store);
    t.after(() => server.dispose());
    let maxBatch = 0;
    const proxy = await NativeCaptureRepository.open(async (request) => {
        const reply = await server.dispatch(structuredClone(request));
        if (reply.ok && request.op === 'pull')
            maxBatch = Math.max(maxBatch, (reply.value as { events: unknown[] }).events.length);
        return freeze(structuredClone(reply));
    });
    const { capture, result } = await record(proxy, 'round trip', 'X'.repeat(200000));
    assert.deepEqual(await proxy.result(capture.id), result);
    assert.equal((await proxy.page()).records.length, 1);
    await proxy.record(capture.id, result);
    await assert.rejects(proxy.record(capture.id, { ...result, durationMs: 2 }), /immutable/);
    let bytes = 0;
    for await (const event of proxy.read(capture.id))
        if (event.type === 'frame') bytes += event.frame.bytes.length;
    assert.equal(bytes, 200000);
    assert.ok(maxBatch <= 3);
    const snapshot = await proxy.pin();
    await assert.rejects(proxy.delete(capture.id), /owns/);
    await snapshot.release();
    const iterator = proxy.read(capture.id)[Symbol.asyncIterator]();
    await iterator.next();
    await assert.rejects(proxy.delete(capture.id), /owns/);
    await iterator.return(undefined);
    const exported = JSON.parse(
        await text(streamCaptureReport(proxy, 'json', { ids: [capture.id] })),
    );
    assert.deepEqual(exported.captures[0].outcome, result);
    assert.equal(exported.captures[0].captureComplete, true);
    await proxy.delete(capture.id);
    assert.equal((await proxy.page()).records.length, 0);
    await proxy.close();
});

test('capture RPC rejects host paths, missing fields, wrong writers and over-budget frames before side effects', async (t) => {
    const { store } = await fixture(t);
    let saves = 0;
    const server = new CaptureRpcServer(store, async () => {
        saves++;
        return true;
    });
    t.after(() => server.dispose());
    const id = crypto.randomUUID(),
        bad = [
            { op: 'delete', id: '../../target' },
            { op: 'delete' },
            { op: 'begin', header: header(), path: 'C:/outside' },
            { op: 'export', format: 'json', scope: { path: '/arbitrary' } },
            { op: 'page', limit: 101 },
            {
                op: 'append',
                id,
                frames: [
                    {
                        observation: 0,
                        receivedAt: stamp,
                        stream: 'serial',
                        offset: 0,
                        totalBytes: 65536,
                        bytes: new Uint8Array(65536),
                        crc32: '00000000',
                    },
                ],
            },
        ];
    for (const input of bad) {
        const reply = await server.dispatch(input);
        assert.equal(reply.ok, false);
    }
    const raw = new Uint8Array([1]);
    const wrong = await server.dispatch({
        op: 'append',
        id,
        frames: [
            {
                observation: 0,
                receivedAt: stamp,
                stream: 'serial',
                offset: 0,
                totalBytes: 1,
                bytes: raw,
                crc32: frameCrc(raw),
            },
        ],
    });
    assert.equal(wrong.ok, false);
    assert.equal(saves, 0);
    assert.equal((await store.page()).records.length, 0);
});

test('renderer reset rejects a queued old-generation begin before it creates a capture', async (t) => {
    const { store } = await fixture(t),
        server = new CaptureRpcServer(store);
    t.after(() => server.dispose());
    const stale = server.dispatch({ op: 'begin', header: header('stale') }),
        reset = server.reset();
    assert.equal((await stale).ok, false);
    await reset;
    assert.equal((await store.page()).records.length, 0);
    const proxy = await NativeCaptureRepository.open((request) => server.dispatch(request)),
        replacement = await proxy.begin(header('replacement'));
    await proxy.fail(replacement.id, 0, new CaptureStorageError('io', 'Explicit fixture cleanup.'));
});

test('a queued stale close cannot reset or reject the replacement renderer writer', async (t) => {
    const { store } = await fixture(t),
        server = new CaptureRpcServer(store);
    t.after(() => server.dispose());
    const stale = server.dispatch({ op: 'close' }),
        reset = server.reset(),
        replacement = server.dispatch({ op: 'begin', header: header('replacement') });
    assert.equal((await stale).ok, false);
    await reset;
    const created = await replacement;
    assert.equal(created.ok, true);
    const rows = (await store.page()).records;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'active');
    assert.equal(rows[0].header.name, 'replacement');
    assert.equal(
        (
            await server.dispatch({
                op: 'fail',
                id: rows[0].id,
                observedBytes: 0,
                error: { code: 'io', message: 'Explicit fixture cleanup.' },
            })
        ).ok,
        true,
    );
});

test('renderer reset waits for a pending commit, rejects stale acknowledgements and gates a replacement writer', async (t) => {
    const { store } = await fixture(t),
        gate = deferred();
    let entered = false;
    const wrapped = new Proxy(store, {
            get(target, key) {
                if (key === 'append')
                    return async (...args: Parameters<CaptureRepository['append']>) => {
                        entered = true;
                        await gate.promise;
                        return store.append(...args);
                    };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }),
        server = new CaptureRpcServer(wrapped);
    t.after(() => server.dispose());
    const proxy = await NativeCaptureRepository.open((request) => server.dispatch(request));
    const capture = await proxy.begin(header()),
        bytes = new Uint8Array([1, 2, 3]),
        pending = proxy.append(capture.id, [
            {
                observation: 0,
                receivedAt: stamp,
                stream: 'serial',
                offset: 0,
                totalBytes: 3,
                bytes,
                crc32: frameCrc(bytes),
            },
        ]);
    await until(() => entered);
    const failed = assert.rejects(pending, /generation changed/);
    let resetDone = false;
    const reset = server.reset().then(() => {
        resetDone = true;
    });
    const replacement = proxy.begin(header('replacement'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resetDone, false);
    gate.resolve();
    await failed;
    await reset;
    const next = await replacement;
    assert.notEqual(next.id, capture.id);
    const old = (await proxy.page()).records.find((row) => row.id === capture.id)!;
    assert.equal(old.state, 'incomplete');
    assert.equal(old.observedBytes, null);
    assert.equal(old.committedBytes, 3);
    await proxy.fail(next.id, 0, new CaptureStorageError('io', 'Explicit fixture cleanup.'));
});

test('concurrent snapshot reservations stay bounded and renderer cleanup releases all ownership', async (t) => {
    const { store } = await fixture(t),
        gate = deferred();
    let entered = 0;
    const wrapped = new Proxy(store, {
            get(target, key) {
                if (key === 'pin')
                    return async () => {
                        entered++;
                        await gate.promise;
                        return store.pin();
                    };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }),
        server = new CaptureRpcServer(wrapped);
    t.after(() => server.dispose());
    const replies: CaptureRpcReply[] = [];
    const pending = Array.from({ length: 12 }, () =>
        server.dispatch({ op: 'pin' }).then((reply) => {
            replies.push(reply);
            return reply;
        }),
    );
    await until(() => entered === 8 && replies.length === 4);
    gate.resolve();
    const all = await Promise.all(pending);
    assert.equal(all.filter((reply) => reply.ok).length, 8);
    await server.reset();
    const next = await store.begin(header());
    await store.fail(next.id, 0, new CaptureStorageError('io', 'Fixture cleanup.'));
});

test('catalog windows and exact exports match full output beyond previews, across ANSI/frame boundaries and off-screen selections', async (t) => {
    const { store } = await fixture(t),
        captures: Awaited<ReturnType<typeof record>>[] = [];
    for (let index = 0; index < 25; index++)
        captures.push(
            await record(
                store,
                'row-' + index,
                index === 0
                    ? 'X'.repeat(16382) + 'ne\x1b[31medle\x1b[0m'
                    : index === 24
                      ? 'NEEDLE'
                      : 'ordinary',
            ),
        );
    const first = await catalogPage(store, { transport: 'serial' });
    assert.equal(first.records.length, 20);
    assert.ok(new TextEncoder().encode(JSON.stringify(first)).length <= 262144);
    assert.equal(first.records[0].previewClipped, true);
    assert.equal(first.records[0].stdout.includes('needle'), false);
    const last = await catalogPage(store, { transport: 'serial' }, first.next!);
    assert.equal(last.records.length, 5);
    const filtered = await catalogPage(store, { transport: 'serial', query: 'needle' });
    assert.deepEqual(
        filtered.records.map((row) => row.capture.id),
        [captures[0].capture.id, captures[24].capture.id],
    );
    for (const scope of [
        { ids: [captures[0].capture.id, captures[24].capture.id] },
        { filter: { transport: 'serial' as const, query: 'needle' } },
    ]) {
        const json = JSON.parse(await text(streamCaptureReport(store, 'json', scope)));
        assert.equal(json.captures.length, 2);
        assert.deepEqual(
            json.captures.map((row: { capture: { id: string } }) => row.capture.id),
            [captures[0].capture.id, captures[24].capture.id],
        );
    }
    let emitted = 0;
    await assert.rejects(async () => {
        for await (const bytes of streamCaptureReport(store, 'json', {
            ids: [captures[0].capture.id, crypto.randomUUID()],
        }))
            emitted += bytes.length;
    }, /selected/);
    assert.equal(emitted, 0);
    const csv = await text(streamCaptureReport(store, 'csv', { ids: [captures[0].capture.id] }));
    assert.match(csv, /outcome_json_base64_prefixed/);
    assert.ok(csv.includes(Buffer.from(JSON.stringify(captures[0].result)).toString('base64')));
    const plain = new PlainCaptureText();
    assert.equal(plain.append('before\x1b]52;c;'), 'before');
    assert.equal(plain.append('evil\x07after'), 'after');
});

test('trusted native export holds its snapshot through destination selection and finishes before host shutdown', async (t) => {
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-capture-host-')),
        dialog = deferred(),
        destination = path.join(profile, 'export.json');
    let selecting = false;
    const host = await NativeCaptureHost.open(profile, { profileOwned: true }, async () => {
        selecting = true;
        await dialog.promise;
        return destination;
    });
    t.after(async () => {
        await host.shutdown();
        assert.ok(
            path.resolve(profile).startsWith(temp + path.sep) &&
                path.basename(profile).startsWith('hub-capture-host-'),
        );
        await fs.rm(profile, { recursive: true, force: true });
    });
    const proxy = await NativeCaptureRepository.open((request) => host.dispatch(request));
    await record(proxy);
    const exporting = host.dispatch({
        op: 'export',
        format: 'json',
        scope: { filter: { transport: 'serial' } },
    });
    await until(() => selecting);
    let closed = false;
    const closing = host.shutdown().then(() => {
        closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, false);
    dialog.resolve();
    const reply = await exporting;
    assert.equal(reply.ok, true);
    await closing;
    assert.equal(closed, true);
    const json = JSON.parse(await fs.readFile(destination, 'utf8'));
    assert.equal(json.captures.length, 1);
    assert.equal(json.captures[0].outcome.completion, 'prompt-observed');
});
