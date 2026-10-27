import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeConsoleService } from '../electron/console-service';
import { NativeConsoleJournal } from '../electron/console-journal';
import { NativeConsoleArchive } from '../src/features/automation/capture/console-archive';
import { storageError } from '../shared/capture-store';
const at = '2026-10-15T15:00:00.000Z',
    header = {
        flowId: 'archive-fixture',
        startedAt: at,
        receiveTimeSource: 'local-client' as const,
        target: { endpoint: 'owned archive' },
        ready: { role: 'shell-prompt' as const, literals: ['fixture#'] },
    };
async function fixture(t: import('node:test').TestContext) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-console-archive-')),
        service = new NativeConsoleService(profile);
    const client = new NativeConsoleArchive(async (input) => {
        try {
            return {
                ok: true,
                value: structuredClone(await service.dispatch(structuredClone(input))),
            };
        } catch (error) {
            const failure = storageError(error);
            return { ok: false, error: { code: failure.code, message: failure.message } };
        }
    });
    t.after(async () => {
        await client.dispose();
        await service.shutdown();
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('hub-console-archive-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    const complete = async () => {
        const store = await service.createWriter(),
            meta = await store.begin(header);
        await store.start({ kind: 'context', phase: 'startup' }, at);
        await store.observe(Buffer.from('fixture#'), at, 'channel');
        await store.end('ready', { role: 'shell-prompt', literal: 'fixture#' }, at);
        await store.start({ kind: 'context', phase: 'shutdown' }, at);
        await store.end('closed', null, at);
        await store.finish('complete', 8, true);
        await store.close();
        return meta.header.id;
    };
    return { profile, service, client, complete };
}
test(
    'native catalog pages, complete raw replay and explicit deletion preserve other captures',
    { timeout: 10000 },
    async (t) => {
        const f = await fixture(t),
            ids = [await f.complete(), await f.complete(), await f.complete()].sort();
        const first = await f.client.list(undefined, 2);
        assert.equal(first.mode, 'scan');
        assert.deepEqual(
            first.captures.map((c) => c.header.id),
            ids.slice(0, 2),
        );
        assert.equal(first.next, ids[1]);
        const second = await f.client.list(first.next!, 2);
        assert.deepEqual(
            second.captures.map((c) => c.header.id),
            ids.slice(2),
        );
        assert.equal(second.next, null);
        let bytes = 0;
        for await (const event of f.client.read(ids[0]))
            if (event.kind === 'record' && event.record.kind === 'observation')
                bytes += Buffer.from(event.record.base64, 'base64').length;
        assert.equal(bytes, 8);
        assert.equal(f.service.snapshot.readers, 0);
        await f.client.delete(ids[0]);
        assert.deepEqual(
            (await f.client.list()).captures.map((c) => c.header.id),
            ids.slice(1),
        );
    },
);
test(
    'catalog pins and partial readers block deletion/new writers until their actual release',
    { timeout: 10000 },
    async (t) => {
        const f = await fixture(t),
            id = await f.complete(),
            pin = await f.client.pin();
        try {
            await assert.rejects(f.client.delete(id), { code: 'busy' });
            await assert.rejects(f.service.createWriter(), { code: 'busy' });
            assert.equal(f.service.snapshot.pins, 1);
        } finally {
            await Promise.all([pin.release(), pin.release()]);
        }
        assert.equal(f.service.snapshot.pins, 0);
        assert.equal(f.service.snapshot.references, 0);
        const iterator = f.client.read(id);
        await iterator.next();
        await assert.rejects(f.client.delete(id), { code: 'busy' });
        await iterator.return(undefined);
        assert.equal(f.service.snapshot.readers, 0);
        assert.equal(f.service.snapshot.references, 0);
        await f.client.delete(id);
        assert.equal((await f.client.list()).captures.length, 0);
    },
);
test(
    'a live immutable prefix stays readable while append continues; abandoned metadata stays incomplete',
    { timeout: 10000 },
    async (t) => {
        const f = await fixture(t),
            writer = await f.service.createWriter(),
            capture = await writer.begin(header);
        await writer.start({ kind: 'context', phase: 'idle' }, at);
        await writer.observe(Buffer.from('before'), at, 'channel');
        const iterator = f.client.read(capture.header.id),
            first = await iterator.next();
        assert.equal(first.value?.kind, 'metadata');
        if (first.value?.kind === 'metadata') assert.equal(first.value.capture.state, 'active');
        await writer.observe(Buffer.from('after'), at, 'channel');
        let retained = '';
        for await (const item of { [Symbol.asyncIterator]: () => iterator })
            if (item.kind === 'record' && item.record.kind === 'observation')
                retained += Buffer.from(item.record.base64, 'base64').toString();
        assert.equal(retained, 'before');
        await writer.close();
        const listed = (await f.client.list()).captures[0];
        assert.equal(listed.state, 'incomplete');
        assert.equal(listed.observedBytes, null);
        assert.equal(listed.bytes, 11);
    },
);
test(
    'unknown files refuse deletion without mutation; a previously requested tombstone is recoverable',
    { timeout: 10000 },
    async (t) => {
        const f = await fixture(t),
            id = await f.complete(),
            folder = path.join(f.profile, 'console-captures-v2', id),
            sentinel = Buffer.from('unique preserved evidence');
        await fs.writeFile(path.join(folder, 'unknown.bin'), sentinel);
        await assert.rejects(f.client.delete(id), { code: 'integrity' });
        assert.deepEqual(await fs.readFile(path.join(folder, 'unknown.bin')), sentinel);
        assert.equal((await f.client.list()).captures.length, 1);
        await fs.unlink(path.join(folder, 'unknown.bin'));
        await f.client.dispose();
        await f.service.shutdown();
        const tombstone = path.join(f.profile, 'console-captures-v2', '.deleting-' + id);
        await fs.rename(folder, tombstone);
        const reopened = await NativeConsoleJournal.open(f.profile, { profileOwned: true });
        try {
            assert.equal((await reopened.list()).captures.length, 0);
            await assert.rejects(fs.lstat(tombstone), { code: 'ENOENT' });
        } finally {
            await reopened.close();
        }
    },
);
