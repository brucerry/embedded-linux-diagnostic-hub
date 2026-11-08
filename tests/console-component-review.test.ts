import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import type { ClientChannel } from 'ssh2';
import { NativeConsoleJournal } from '../electron/console-journal';
import { PersistentSshConsole } from '../backend/ssh/persistent-console';
import { bytesBase64 } from '../shared/capture-store';
import type { ConsoleRecord, ConsoleRepository, ConsoleSegment } from '../shared/console-journal';

const at = '2026-10-15T13:00:00.000Z';
const header = {
    flowId: 'review-flow',
    startedAt: at,
    receiveTimeSource: 'local-client' as const,
    target: { endpoint: 'synthetic' },
    ready: { role: 'shell-prompt' as const, literals: ['five!'] },
};
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
async function until(check: () => boolean) {
    const end = performance.now() + 2000;
    while (!check()) {
        if (performance.now() >= end) assert.fail('Expected fixture boundary missing.');
        await new Promise((r) => setTimeout(r, 5));
    }
}
async function fixture(t: TestContext) {
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-console-review-fix-'));
    const stores: NativeConsoleJournal[] = [];
    const open = async () => {
        const store = await NativeConsoleJournal.open(profile, { profileOwned: true });
        stores.push(store);
        return store;
    };
    t.after(async () => {
        for (const store of stores) await store.close();
        assert.ok(profile.startsWith(temp + path.sep));
        assert.ok(path.basename(profile).startsWith('hub-console-review-fix-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    return {
        profile,
        open,
        async records(id: string) {
            const store = await open(),
                records: ConsoleRecord[] = [];
            try {
                for await (const item of store.read(id))
                    if (item.kind === 'record') records.push(item.record);
            } finally {
                await store.close();
            }
            return records;
        },
    };
}
async function healthy(t: TestContext) {
    const f = await fixture(t),
        store = await f.open(),
        capture = await store.begin(header);
    await store.start({ kind: 'context', phase: 'startup' }, at);
    await store.observe(Buffer.from('five!'), at, 'channel');
    await store.end('ready', { role: 'shell-prompt', literal: 'five!' }, at);
    await store.start({ kind: 'context', phase: 'shutdown' }, at);
    await store.end('closed', null, at);
    return { ...f, store, id: capture.header.id };
}

test('complete journal rejects a known retained/observed byte gap at finish', async (t) => {
    const f = await healthy(t);
    await assert.rejects(f.store.finish('complete', 6, true), /equal|complete/i);
    await f.store.close();
    const reader = await f.open();
    for await (const item of reader.read(f.id))
        if (item.kind === 'metadata') assert.notEqual(item.capture.state, 'complete');
});
test('healthy equal-count completion remains complete after reopen', async (t) => {
    const f = await healthy(t);
    assert.equal((await f.store.finish('complete', 5, true)).state, 'complete');
    await f.store.close();
    const reader = await f.open();
    for await (const item of reader.read(f.id))
        if (item.kind === 'metadata') {
            assert.equal(item.capture.state, 'complete');
            assert.equal(item.capture.bytes, 5);
            assert.equal(item.capture.observedBytes, 5);
        }
});
for (const observed of [6, null])
    test(`complete replay rejects ${observed === null ? 'unknown' : 'greater'} observed count without changing retained files`, async (t) => {
        const f = await healthy(t);
        await f.store.finish('complete', 5, true);
        await f.store.close();
        const file = path.join(f.profile, 'console-captures-v2', f.id, 'meta.json'),
            meta = JSON.parse(await fs.readFile(file, 'utf8'));
        meta.observedBytes = observed;
        await fs.writeFile(file, JSON.stringify(meta));
        const before = await fs.readFile(file);
        const reader = await f.open();
        await assert.rejects(async () => {
            for await (const _ of reader.read(f.id)) {
            }
        }, /complete|cleanup|integrity/i);
        assert.deepEqual(await fs.readFile(file), before);
    });

class Channel extends Duplex {
    stderr = new PassThrough({ autoDestroy: false, emitClose: false });
    writes: Buffer[] = [];
    writeCallback?: (done: (error?: Error | null) => void) => void;
    constructor() {
        super({ autoDestroy: false, emitClose: false });
    }
    _read() {}
    _write(bytes: Buffer, _: BufferEncoding, done: (error?: Error | null) => void) {
        this.writes.push(Buffer.from(bytes));
        this.push(Buffer.from('five!'));
        if (this.writeCallback) this.writeCallback(done);
        else done();
    }
    close() {
        setImmediate(() => this.remoteClose());
        return this;
    }
    remoteClose() {
        if (!this.readableEnded) this.push(null);
        if (!this.stderr.writableEnded) this.stderr.end();
        this.emit('close');
    }
}
const command: Extract<ConsoleSegment, { kind: 'command' }> = {
    kind: 'command',
    runId: 'run-one',
    stepId: 'step-one',
    ordinal: 1,
    name: 'Step',
    input: { intent: 'script', command: 'fixture' },
    requestBase64: bytesBase64(Buffer.from('fixture\r')),
    criterion: { role: 'shell-prompt', literals: ['five!'] },
};
function proxy(store: NativeConsoleJournal, methods: Partial<ConsoleRepository>) {
    return new Proxy(store, {
        get(target, key) {
            const custom = Reflect.get(methods, key);
            if (custom) return custom;
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
async function actorFixture(
    t: TestContext,
    wrap: (store: NativeConsoleJournal) => ConsoleRepository,
) {
    const f = await fixture(t),
        store = await f.open(),
        channel = new Channel(),
        signal = new AbortController();
    let owned = false;
    const actor = new PersistentSshConsole(
        {
            acquire: () => {
                owned = true;
                return () => {
                    owned = false;
                };
            },
            assertCurrent: () => {},
            assertFresh: () => {},
            open: (callback) => {
                callback(undefined, channel as unknown as ClientChannel);
                channel.push(Buffer.from('five!'));
            },
        },
        wrap(store),
        50,
    );
    t.after(async () => {
        channel.remoteClose();
        await actor.cancel().catch(() => {});
        channel.destroy();
        channel.stderr.destroy();
    });
    await actor.open(header, signal.signal, 1000);
    return { ...f, store, channel, signal, actor, owned: () => owned };
}
function classified(records: ConsoleRecord[], needle: string) {
    const segments = new Map<number, ConsoleSegment>();
    for (const r of records) {
        if (r.kind === 'segment-start') segments.set(r.index, r.segment);
        if (
            r.kind === 'observation' &&
            Buffer.from(r.base64, 'base64').includes(Buffer.from(needle))
        )
            return { record: r, segment: segments.get(r.index) };
    }
    assert.fail('Expected raw fixture bytes missing.');
}
for (const boundary of ['idle-seal', 'command-start'] as const)
    test(
        `pre-write bytes during ${boundary} persistence remain ordered idle context`,
        { timeout: 8000 },
        async (t) => {
            const held = gate();
            t.after(() => held.resolve());
            let entered = false;
            const f = await actorFixture(t, (store) =>
                proxy(store, {
                    start: async (segment, at) => {
                        const index = await store.start(segment, at);
                        if (boundary === 'command-start' && segment.kind === 'command') {
                            entered = true;
                            await held.promise;
                        }
                        return index;
                    },
                    end: async (reason, match, at) => {
                        await store.end(reason, match, at);
                        if (boundary === 'idle-seal' && reason === 'idle-boundary') {
                            entered = true;
                            await held.promise;
                        }
                    },
                }),
            );
            if (boundary === 'idle-seal') f.channel.push(Buffer.from('IDLE-PREFIX\r\n'));
            const pending = f.actor.step(command, 1000);
            await until(() => entered);
            assert.equal(f.channel.writes.length, 0);
            f.channel.push(Buffer.from('PRE-WRITE-BACKGROUND\r\n'));
            held.resolve();
            await pending;
            const snapshot = await f.actor.finish(),
                records = await f.records(snapshot!.header.id);
            const background = classified(records, 'PRE-WRITE-BACKGROUND');
            assert.equal(background.segment?.kind, 'context');
            assert.equal(
                background.segment?.kind === 'context' && background.segment.phase,
                'idle',
            );
            const started = records.find(
                (r) => r.kind === 'segment-start' && r.segment.kind === 'command',
            );
            assert.ok(
                started &&
                    started.kind === 'segment-start' &&
                    started.inputSent?.disposition === 'write-dispatched',
            );
            assert.ok(background.record.sequence < started.sequence);
            assert.ok(records.some((r) => r.kind === 'preparation' && r.index === started.index));
            const response = records.find(
                (r) => r.kind === 'observation' && r.index === started.index,
            );
            assert.ok(response && response.sequence > started.sequence);
            assert.equal(f.channel.writes.length, 1);
            assert.equal(f.owned(), false);
        },
    );

test(
    'cancelled preparation records unsent intent without a command output segment or outcome',
    { timeout: 8000 },
    async (t) => {
        const held = gate();
        t.after(() => held.resolve());
        let entered = false;
        const f = await actorFixture(t, (store) =>
            proxy(store, {
                start: async (segment, at) => {
                    const index = await store.start(segment, at);
                    if (segment.kind === 'command') {
                        entered = true;
                        await held.promise;
                    }
                    return index;
                },
            }),
        );
        const pending = f.actor.step(command, 1000);
        void pending.catch(() => {});
        await until(() => entered);
        const cancelled = f.actor.cancel();
        assert.equal(f.owned(), true);
        held.resolve();
        await assert.rejects(pending);
        await cancelled;
        const records = await f.records(f.actor.snapshot!.header.id);
        assert.equal(f.channel.writes.length, 0);
        assert.ok(records.some((r) => r.kind === 'preparation'));
        assert.ok(records.some((r) => r.kind === 'preparation-end' && r.reason === 'cancelled'));
        assert.equal(
            records.some(
                (r) =>
                    r.kind === 'outcome' ||
                    (r.kind === 'segment-start' && r.segment.kind === 'command'),
            ),
            false,
        );
    },
);

test(
    'a delayed input write callback retains ownership through cancellation and the input-sent journal boundary',
    { timeout: 8000 },
    async (t) => {
        const held = gate();
        t.after(() => held.resolve());
        const f = await actorFixture(t, (store) => store);
        let entered = false;
        f.channel.writeCallback = (done) => {
            entered = true;
            void held.promise.then(() => done());
        };
        const pending = f.actor.step(command, 1000);
        void pending.catch(() => {});
        await until(() => entered);
        const cancelled = f.actor.cancel();
        await new Promise((r) => setImmediate(r));
        assert.equal(f.owned(), true);
        held.resolve();
        await assert.rejects(pending);
        await cancelled;
        assert.equal(f.owned(), false);
        const records = await f.records(f.actor.snapshot!.header.id);
        assert.ok(
            records.some(
                (r) =>
                    r.kind === 'segment-start' && r.inputSent?.disposition === 'write-dispatched',
            ),
        );
    },
);

for (const origin of ['channel', 'extended'] as const)
    test(
        `input-sent verifies retained idle ${origin} before outcome or subsequent input`,
        { timeout: 8000 },
        async (t) => {
            const held = gate();
            t.after(() => held.resolve());
            let entered = false,
                corrupted = false;
            let rawPath = '',
                damaged: Buffer | undefined;
            const marker = 'PRE-WRITE-IDLE-INTEGRITY\r\n';
            const f = await actorFixture(t, (store) =>
                proxy(store, {
                    start: async (segment, at) => {
                        const index = await store.start(segment, at);
                        if (segment.kind === 'command') {
                            entered = true;
                            await held.promise;
                        }
                        return index;
                    },
                    inputSent: async (at) => {
                        rawPath = path.join(
                            f.profile,
                            'console-captures-v2',
                            store.snapshot!.header.id,
                            'raw.jsonl',
                        );
                        const raw = await fs.readFile(rawPath, 'utf8'),
                            needle = Buffer.from(marker).toString('base64'),
                            replacement = Buffer.from('X' + marker.slice(1)).toString('base64');
                        assert.ok(
                            raw.includes(needle),
                            'The exact outgoing idle observation must already be retained.',
                        );
                        const next = raw.replace(needle, replacement);
                        assert.equal(Buffer.byteLength(next), Buffer.byteLength(raw));
                        await fs.writeFile(rawPath, next);
                        damaged = Buffer.from(next);
                        corrupted = true;
                        return store.inputSent(at);
                    },
                }),
            );
            const first = f.actor.step(command, 1000);
            void first.catch(() => {});
            await until(() => entered);
            if (origin === 'channel') f.channel.push(Buffer.from(marker));
            else f.channel.stderr.write(Buffer.from(marker));
            held.resolve();
            const result = await first.then(
                () => ({ completed: true, error: null }),
                (error) => ({ completed: false, error }),
            );
            assert.equal(
                result.completed,
                false,
                'An unverifiable outgoing idle prefix cannot acknowledge a command outcome.',
            );
            assert.equal(corrupted, true);
            assert.equal(
                f.channel.writes.length,
                1,
                'Post-dispatch verification cannot undo the first write.',
            );
            await assert.rejects(
                f.actor.step({ ...command, stepId: 'next', ordinal: 2 }, 1000),
                /unavailable|active/,
            );
            assert.equal(
                f.channel.writes.length,
                1,
                'No second input follows failed integrity verification.',
            );
            assert.equal(f.actor.snapshot?.state, 'incomplete');
            assert.equal(f.actor.snapshot?.failure?.code, 'integrity');
            assert.equal(f.store.resourceClosed, true);
            assert.equal(f.owned(), false);
            assert.deepEqual(
                await fs.readFile(rawPath),
                damaged,
                'Corrupted retained evidence is preserved.',
            );
            const records = (await fs.readFile(rawPath, 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as ConsoleRecord);
            assert.equal(
                records.some((r) => r.kind === 'outcome'),
                false,
                'No prompt-observed outcome is committed after the failed fence.',
            );
        },
    );
