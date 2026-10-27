import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeCaptureStore } from '../electron/capture-store';
import {
    CaptureExportBroker,
    type ExportClient,
} from '../src/features/automation/capture/export-broker';
const scope = 'https://fixture.test/nested/hub/';
async function fixture(t: TestContext) {
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-export-broker-'));
    const store = await NativeCaptureStore.open(profile, { profileOwned: true }),
        capture = await store.begin({
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'one',
            stepId: 'one',
            command: 'fixture',
            name: 'Fixture',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
    await store.seal(capture.id, 0, 'empty fixture');
    let now = 0;
    const clients = new Map<string, ExportClient>([
            ['owner', { id: 'owner', url: scope, frameType: 'top-level' }],
            ['other', { id: 'other', url: scope, frameType: 'top-level' }],
        ]),
        messages: unknown[] = [];
    const env = {
        scope,
        now: () => now,
        client: async (id: string) => clients.get(id),
        clients: async () => [...clients.values()],
        notify: async (_id: string, message: unknown) => {
            messages.push(message);
        },
    };
    const broker = new CaptureExportBroker(store, env);
    const jobs: { id: string }[] = [];
    t.after(async () => {
        for (const job of jobs) await broker.cancel(job.id, 'owner').catch(() => {});
        await store.close();
        const resolved = path.resolve(profile);
        assert.ok(
            resolved.startsWith(temp + path.sep) &&
                path.basename(resolved).startsWith('hub-export-broker-'),
        );
        await fs.rm(resolved, { recursive: true, force: true });
    });
    async function prepare() {
        const job = await broker.prepare('owner', 'json');
        jobs.push(job);
        return job;
    }
    async function claim() {
        const job = await prepare();
        await broker.frame(job.nonce, 'helper');
        clients.set('helper', { id: 'helper', url: job.frameUrl, frameType: 'nested' });
        const download = await broker.claim(job.nonce, 'helper');
        return { ...job, token: download.url.split('/').at(-1)! };
    }
    return {
        store,
        capture,
        broker,
        clients,
        messages,
        env,
        jobs,
        prepare,
        claim,
        advance: (value: number) => {
            now = value;
        },
    };
}

test('export tokens reject other clients, non-navigation requests and forged/duplicate helper provenance', async (t) => {
    const f = await fixture(t),
        job = await f.claim();
    await assert.rejects(
        f.broker.download(job.token, {
            clientId: 'other',
            referrer: job.frameUrl,
            mode: 'navigate',
        }),
        /another client/,
    );
    await assert.rejects(
        f.broker.download(job.token, { clientId: '', referrer: job.frameUrl, mode: 'cors' }),
        /does not own/,
    );
    await assert.rejects(
        f.broker.download(job.token, { clientId: '', referrer: scope, mode: 'navigate' }),
        /provenance/,
    );
    f.clients.set('duplicate', { id: 'duplicate', url: job.frameUrl, frameType: 'nested' });
    await assert.rejects(
        f.broker.download(job.token, { clientId: '', referrer: job.frameUrl, mode: 'navigate' }),
        /provenance/,
    );
    f.clients.delete('duplicate');
    const download = await f.broker.download(job.token, {
        clientId: '',
        referrer: job.frameUrl,
        mode: 'navigate',
    });
    await assert.rejects(
        f.broker.download(job.token, {
            clientId: 'helper',
            referrer: job.frameUrl,
            mode: 'navigate',
        }),
        /already consumed/,
    );
    let output = '';
    for await (const bytes of download.stream) output += new TextDecoder().decode(bytes);
    await download.done;
    assert.equal(JSON.parse(output).captures[0].captureComplete, true);
    assert.equal(download.filename, 'automation-results.json');
    assert.equal((await f.broker.status(job.id, 'owner')).state, 'stream-sent');
    await assert.rejects(f.broker.status(job.id, 'other'), /another|expired/);
    await f.store.delete(f.capture.id);
});

test('prepared jobs pin membership, expire without deleting captures and fail explicitly after worker restart', async (t) => {
    const f = await fixture(t),
        job = await f.prepare();
    await assert.rejects(f.store.delete(f.capture.id), /owns this record/);
    const restarted = new CaptureExportBroker(f.store, f.env);
    await assert.rejects(restarted.status(job.id, 'owner'), /worker restarted/);
    f.advance(60001);
    assert.equal((await f.broker.status(job.id, 'owner')).state, 'failed');
    assert.equal((await f.store.page()).records.length, 1);
    await f.store.delete(f.capture.id);
});

test('bounded export job reservations hold under concurrent preparation', async (t) => {
    const f = await fixture(t),
        outcomes = await Promise.allSettled(
            Array.from({ length: 12 }, () => f.broker.prepare('owner', 'json')),
        );
    const granted = outcomes.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof f.broker.prepare>>> =>
            r.status === 'fulfilled',
    );
    assert.equal(granted.length, 8);
    for (const result of granted) {
        f.jobs.push(result.value);
        await f.broker.cancel(result.value.id, 'owner');
    }
    await f.store.delete(f.capture.id);
});

test('an export uses its prepared high-water mark and cancellation releases ownership only after cleanup', async (t) => {
    const f = await fixture(t),
        job = await f.claim();
    const later = await f.store.begin({ ...f.capture.header, runId: 'later' });
    await f.store.seal(later.id, 0, 'empty fixture');
    const download = await f.broker.download(job.token, {
        clientId: 'helper',
        referrer: job.frameUrl,
        mode: 'navigate',
    });
    let output = '';
    for await (const bytes of download.stream) output += new TextDecoder().decode(bytes);
    await download.done;
    const raw = JSON.parse(output);
    assert.equal(raw.throughSequence, 1);
    assert.equal(raw.summary.captures, 1);
    const cancelled = await f.claim(),
        pending = await f.broker.download(cancelled.token, {
            clientId: 'helper',
            referrer: cancelled.frameUrl,
            mode: 'navigate',
        });
    await assert.rejects(f.store.delete(f.capture.id), /owns this record/);
    await pending.stream.cancel('user cancelled');
    await pending.done;
    assert.equal((await f.broker.status(cancelled.id, 'owner')).state, 'failed');
    await f.store.delete(f.capture.id);
});

test('cancelling slow verification fences later attachment creation and retains the lease until the read settles', async (t) => {
    const f = await fixture(t);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve)),
        started = new Promise<void>((resolve) => (entered = resolve));
    const adapter = new Proxy(f.store, {
        get(target, key) {
            if (key === 'read')
                return async function* (id: string) {
                    entered();
                    await held;
                    yield* target.read(id);
                };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const broker = new CaptureExportBroker(adapter, f.env),
        job = await broker.prepare('owner', 'json');
    t.after(async () => {
        release();
        await broker.cancel(job.id, 'owner').catch(() => {});
    });
    await broker.frame(job.nonce, 'slow-helper');
    f.clients.set('slow-helper', { id: 'slow-helper', url: job.frameUrl, frameType: 'nested' });
    const claim = await broker.claim(job.nonce, 'slow-helper'),
        pending = broker.download(claim.url.split('/').at(-1)!, {
            clientId: 'slow-helper',
            referrer: job.frameUrl,
            mode: 'navigate',
        });
    void pending.catch(() => {});
    await started;
    let cleaned = false;
    const cancel = broker.cancel(job.id, 'owner').then(() => {
        cleaned = true;
    });
    assert.equal(cleaned, false);
    await assert.rejects(f.store.delete(f.capture.id), /owns this record/);
    release();
    await cancel;
    await assert.rejects(pending, /cancel/);
    assert.equal(cleaned, true);
    await f.store.delete(f.capture.id);
});
