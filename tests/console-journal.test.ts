import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeConsoleJournal } from '../electron/console-journal';
import { CaptureStorageError, bytesBase64 } from '../shared/capture-store';
import type { ConsoleSegment } from '../shared/console-journal';

const at = '2026-10-15T00:00:00.000Z',
    ready = { role: 'shell-prompt' as const, literals: ['fixture:/root# '] };
const header = {
    flowId: 'fixture-flow',
    startedAt: at,
    receiveTimeSource: 'local-client' as const,
    target: { endpoint: 'local fixture' },
    ready,
};
const command: ConsoleSegment = {
    kind: 'command',
    runId: 'one',
    stepId: 'step',
    ordinal: 1,
    name: 'Unicode 韓 fixture',
    input: { intent: 'script', command: 'cd /' },
    requestBase64: bytesBase64(new TextEncoder().encode('cd /\r')),
    criterion: { role: 'shell-prompt', literals: ['fixture:/# '] },
};
async function fixture(t: import('node:test').TestContext) {
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-console-journal-'));
    let current: NativeConsoleJournal | undefined;
    t.after(async () => {
        await current?.close();
        assert.ok(
            path.resolve(profile).startsWith(temp + path.sep) &&
                path.basename(profile).startsWith('hub-console-journal-'),
        );
        await fs.rm(profile, { recursive: true, force: true });
    });
    return {
        profile,
        open: async () =>
            (current = await NativeConsoleJournal.open(profile, { profileOwned: true })),
    };
}
test('schema-2 native journal keeps typed PTY/context boundaries, exact bytes and null exits without touching old/future namespaces', async (t) => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.profile, 'captures-v1'));
    await fs.mkdir(path.join(f.profile, 'console-captures-v3'));
    const old = Buffer.from('old canonical bytes'),
        future = Buffer.from('unknown future bytes');
    await fs.writeFile(path.join(f.profile, 'captures-v1', 'sentinel'), old);
    await fs.writeFile(path.join(f.profile, 'console-captures-v3', 'sentinel'), future);
    const store = await f.open(),
        capture = await store.begin(header);
    await assert.rejects(
        NativeConsoleJournal.open(f.profile, { profileOwned: true }),
        /already owned/,
    );
    await store.start({ kind: 'context', phase: 'startup' }, at);
    await store.observe(Buffer.from('startup\r\nfixture:/root# '), at, 'channel');
    await store.end('ready', { role: 'shell-prompt', literal: 'fixture:/root# ' }, at);
    await store.start(command, at);
    const raw = Buffer.alloc(200000, 65),
        expected = crypto.createHash('sha256').update(raw).digest('hex');
    const writing = store.observe(raw, at, 'channel');
    raw.fill(66);
    await writing;
    await store.end('prompt-observed', { role: 'shell-prompt', literal: 'fixture:/# ' }, at);
    await assert.rejects(store.start({ kind: 'context', phase: 'idle' }, at), /persistence/);
    await store.fail(
        200024,
        new CaptureStorageError('integrity', 'Intentional boundary refusal control.'),
    );
    // The boundary refusal poisons this writer: it cannot silently retry or publish a fake outcome.
    await store.close();
    const reader = await f.open();
    let bytes = 0;
    const hash = crypto.createHash('sha256');
    let contexts = 0,
        outcomes = 0;
    for await (const item of reader.read(capture.header.id))
        if (item.kind === 'record') {
            if (item.record.kind === 'segment-start' && item.record.segment.kind === 'context') {
                contexts++;
                assert.equal(Object.hasOwn(item.record.segment, 'command'), false);
            }
            if (item.record.kind === 'outcome') outcomes++;
            if (item.record.kind === 'observation' && item.record.index === 1) {
                assert.equal(item.record.stream, 'pty');
                const part = Buffer.from(item.record.base64, 'base64');
                bytes += part.length;
                hash.update(part);
            }
        }
    assert.equal(bytes, 200000);
    assert.equal(hash.digest('hex'), expected);
    assert.equal(contexts, 1);
    assert.equal(outcomes, 0);
    assert.deepEqual(await fs.readFile(path.join(f.profile, 'captures-v1', 'sentinel')), old);
    assert.deepEqual(
        await fs.readFile(path.join(f.profile, 'console-captures-v3', 'sentinel')),
        future,
    );
});
test('native console raw seal and immutable outcome precede next context, with no context command or exit invention', async (t) => {
    const f = await fixture(t),
        store = await f.open(),
        capture = await store.begin(header);
    await store.start({ kind: 'context', phase: 'startup' }, at);
    await store.observe(Buffer.from('fixture:/root# '), at, 'channel');
    await store.end('ready', { role: 'shell-prompt', literal: 'fixture:/root# ' }, at);
    await store.start(command, at);
    await store.observe(Buffer.from('fixture:/# '), at, 'channel');
    const matched = { role: 'shell-prompt' as const, literal: 'fixture:/# ' };
    await store.end('prompt-observed', matched, at);
    await store.outcome('prompt-observed', matched, at);
    await store.start({ kind: 'context', phase: 'idle' }, at);
    await store.observe(Buffer.from('background'), at, 'extended');
    await store.end('idle-boundary', null, at);
    await store.start({ kind: 'context', phase: 'shutdown' }, at);
    await store.observe(Buffer.from('bye'), at, 'channel');
    await store.end('closed', null, at);
    const finished = await store.finish('complete', store.snapshot!.bytes, true);
    assert.equal(finished.state, 'complete');
    assert.equal(finished.shellClosed, true);
    await store.close();
    const reader = await f.open();
    let outcomes = 0,
        contexts = 0;
    for await (const item of reader.read(capture.header.id))
        if (item.kind === 'record') {
            if (item.record.kind === 'outcome') {
                outcomes++;
                assert.equal(item.record.exitCode, null);
            }
            if (item.record.kind === 'segment-start' && item.record.segment.kind === 'context') {
                contexts++;
                assert.equal(Object.hasOwn(item.record.segment, 'ordinal'), false);
            }
        }
    assert.equal(outcomes, 1);
    assert.equal(contexts, 3);
});
test('console reopen preserves committed prefix and uncommitted tail without fabricated outcomes', async (t) => {
    const f = await fixture(t),
        store = await f.open(),
        capture = await store.begin(header);
    await store.start({ kind: 'context', phase: 'startup' }, at);
    await store.observe(Buffer.from('retained'), at, 'channel');
    await store.close();
    const file = path.join(f.profile, 'console-captures-v2', capture.header.id, 'raw.jsonl');
    await fs.appendFile(file, '{uncommitted');
    const before = await fs.readFile(file);
    const reader = await f.open();
    let seen = 0,
        metadata = false;
    for await (const item of reader.read(capture.header.id)) {
        if (item.kind === 'metadata') {
            metadata = true;
            assert.equal(item.capture.reason, 'interrupted');
            assert.equal(item.capture.observedBytes, null);
        } else {
            seen++;
            assert.notEqual(item.record.kind, 'outcome');
        }
    }
    assert.equal(metadata, true);
    assert.equal(seen, 2);
    assert.deepEqual(await fs.readFile(file), before);
});
test('console seal rejects same-size corrupted raw evidence and retains ownership until close', async (t) => {
    const f = await fixture(t),
        store = await f.open(),
        capture = await store.begin(header);
    await store.start({ kind: 'context', phase: 'startup' }, at);
    await store.observe(Buffer.from('test'), at, 'channel');
    const file = path.join(f.profile, 'console-captures-v2', capture.header.id, 'raw.jsonl'),
        raw = await fs.readFile(file, 'utf8');
    assert.ok(raw.includes('dGVzdA=='));
    await fs.writeFile(file, raw.replace('dGVzdA==', 'dGVzdQ=='));
    await assert.rejects(
        store.end('ready', { role: 'shell-prompt', literal: 'fixture:/root# ' }, at),
        /integrity/,
    );
    await assert.rejects(NativeConsoleJournal.open(f.profile, { profileOwned: true }), /owned/);
    await store.fail(4, new CaptureStorageError('integrity', 'Retained corruption.'));
    await store.close();
    const reader = await f.open();
    await assert.rejects(async () => {
        for await (const _ of reader.read(capture.header.id)) {
        }
    }, /integrity/);
});
