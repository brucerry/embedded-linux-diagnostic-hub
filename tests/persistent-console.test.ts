import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Duplex, PassThrough } from 'node:stream';
import { getEventListeners } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client, type ClientChannel } from 'ssh2';
import { NativeConsoleJournal } from '../electron/console-journal';
import { CaptureStorageError, bytesBase64 } from '../shared/capture-store';
import type { ConsoleRepository, ConsoleRecord, ConsoleSegment } from '../shared/console-journal';
import {
    interactiveShellBinding,
    PersistentSshConsole,
    type ConsoleBinding,
} from '../backend/ssh/persistent-console';
import { gatewayFixture } from './fixtures/gateway';
import { consoleFixture } from './fixtures/ssh-console';
import { fingerprint } from '../backend/ssh/session';

const at = '2026-10-15T00:00:00.000Z';
const ready = { role: 'shell-prompt' as const, literals: ['fixture:/root# '] };
const header = {
    flowId: 'flow-one',
    startedAt: at,
    receiveTimeSource: 'local-client' as const,
    target: { endpoint: 'owned local fixture' },
    ready,
};
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
async function until(check: () => boolean) {
    const end = performance.now() + 2500;
    while (!check()) {
        if (performance.now() >= end) assert.fail('Fixture boundary not reached.');
        await new Promise((r) => setTimeout(r, 5));
    }
}
function command(
    text: string,
    ordinal = 1,
    literal = 'fixture:/root# ',
    enter = false,
    role: 'shell-prompt' | 'intermediate-input-prompt' = 'shell-prompt',
): Extract<ConsoleSegment, { kind: 'command' }> {
    return {
        kind: 'command',
        runId: 'run-one',
        stepId: 'step-' + ordinal,
        ordinal,
        name: 'Step ' + ordinal,
        input: { intent: enter ? 'send-enter' : 'script', command: text },
        requestBase64: bytesBase64(new TextEncoder().encode(enter ? '\r' : text + '\r')),
        criterion: { role, literals: [literal] },
    };
}
async function journal(t: TestContext) {
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-console-actor-'));
    const store = await NativeConsoleJournal.open(profile, { profileOwned: true });
    t.after(async () => {
        await store.close();
        assert.ok(profile.startsWith(temp + path.sep));
        assert.ok(path.basename(profile).startsWith('hub-console-actor-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    return {
        store,
        profile,
        async records(id: string) {
            const reader = await NativeConsoleJournal.open(profile, { profileOwned: true });
            const records: ConsoleRecord[] = [];
            try {
                for await (const item of reader.read(id))
                    if (item.kind === 'record') records.push(item.record);
            } finally {
                await reader.close();
            }
            return records;
        },
    };
}
function proxy(store: ConsoleRepository, methods: Partial<ConsoleRepository>): ConsoleRepository {
    return new Proxy(store, {
        get(target, key) {
            const custom = Reflect.get(methods, key);
            if (custom) return custom;
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
class Channel extends Duplex {
    stderr = new PassThrough({ autoDestroy: false, emitClose: false });
    writes: Buffer[] = [];
    closeRequested = false;
    autoClose = true;
    onWrite?: (bytes: Buffer) => void;
    constructor() {
        super({ autoDestroy: false, emitClose: false });
    }
    _read() {}
    _write(bytes: Buffer, _: BufferEncoding, done: (error?: Error | null) => void) {
        this.writes.push(Buffer.from(bytes));
        this.onWrite?.(bytes);
        done();
    }
    close() {
        this.closeRequested = true;
        if (this.autoClose) setImmediate(() => this.remoteClose());
        return this;
    }
    remoteClose() {
        this.push(null);
        this.stderr.end();
        this.emit('close');
    }
}
async function fake(t: TestContext, wrap?: (store: NativeConsoleJournal) => ConsoleRepository) {
    const j = await journal(t),
        channel = new Channel(),
        signal = new AbortController();
    let owned = false,
        opens = 0,
        fresh = true,
        current = true;
    const binding: ConsoleBinding = {
        acquire: () => {
            assert.equal(owned, false);
            owned = true;
            return () => {
                owned = false;
            };
        },
        assertCurrent: () => {
            if (!current) throw Error('Connection generation changed.');
        },
        assertFresh: () => {
            if (!fresh) throw Error('App slept during preparation.');
        },
        open: (callback) => {
            opens++;
            callback(undefined, channel as unknown as ClientChannel);
            channel.push(Buffer.from(ready.literals[0]));
        },
    };
    const actor = new PersistentSshConsole(binding, wrap ? wrap(j.store) : j.store, 50);
    t.after(async () => {
        channel.autoClose = true;
        channel.remoteClose();
        await actor.cancel().catch(() => {});
        channel.destroy();
        channel.stderr.destroy();
    });
    await actor.open(header, signal.signal, 1500);
    return {
        ...j,
        actor,
        channel,
        signal,
        owned: () => owned,
        opens: () => opens,
        stale: () => {
            fresh = false;
        },
        replace: () => {
            current = false;
        },
    };
}

test(
    'owned actor drives one normally initialized loopback shell: cwd, aliases/functions, environment and explicit consecutive Enter',
    { timeout: 20000 },
    async (t) => {
        const j = await journal(t),
            model = consoleFixture({ fragment: 3 }),
            server = await gatewayFixture(undefined, model),
            client = new Client();
        client.on('error', () => {});
        t.after(async () => {
            client.end();
            await server.close();
        });
        await new Promise<void>((resolve, reject) => {
            client.once('ready', resolve);
            client.once('error', reject);
            client.connect({
                host: '127.0.0.1',
                port: server.options.port,
                username: server.options.username,
                password: server.options.password,
                hostVerifier: (key: Buffer) => fingerprint(key) === server.pinned,
                readyTimeout: 3000,
            });
        });
        let owned = false;
        const actor = new PersistentSshConsole(
            interactiveShellBinding(
                client,
                () => {
                    assert.equal(owned, false);
                    owned = true;
                    return () => {
                        owned = false;
                    };
                },
                () => {},
                () => {},
            ),
            j.store,
            50,
        );
        t.after(async () => {
            await actor.cancel().catch(() => {});
        });
        await actor.open(header, new AbortController().signal, 3000);
        const steps = [
            command('cd /', 1, 'fixture:/# '),
            command('pwd', 2, 'fixture:/# '),
            command('ll', 3, 'fixture:/# '),
            command('fixture_hi', 4, 'fixture:/# '),
            command('export FLAG=kept', 5, 'fixture:/# '),
            command('printenv FLAG', 6, 'fixture:/# '),
            command(
                'confirm-fixture',
                7,
                'Proceed fixture [Enter]? ',
                false,
                'intermediate-input-prompt',
            ),
        ];
        for (const step of steps) {
            const result = await actor.step(step, 2000);
            assert.equal(result.completion, 'prompt-observed');
            assert.equal(result.exitCode, null);
        }
        assert.equal(
            model.state.confirmations,
            0,
            'Input prompt observation never sends automatic confirmation.',
        );
        await actor.step(command('', 8, 'fixture:/# ', true), 2000);
        await actor.step(command('', 9, 'fixture:/# ', true), 2000);
        await actor.step({ ...command('pwd', 1, 'fixture:/# '), runId: 'run-two' }, 2000);
        const snapshot = await actor.finish();
        assert.equal(snapshot?.state, 'complete');
        assert.equal(snapshot?.shellClosed, true);
        assert.equal(owned, false);
        assert.equal(model.state.opens, 1);
        assert.equal(model.state.confirmations, 1);
        assert.equal(model.state.enters, 1);
        assert.deepEqual(model.state.commands, [
            'cd /',
            'pwd',
            'll',
            'fixture_hi',
            'export FLAG=kept',
            'printenv FLAG',
            'confirm-fixture',
            '',
            '',
            'pwd',
        ]);
        assert.equal(
            Buffer.concat(model.state.inputs).toString(),
            'cd /\rpwd\rll\rfixture_hi\rexport FLAG=kept\rprintenv FLAG\rconfirm-fixture\r\r\rpwd\r',
        );
        const records = await j.records(snapshot!.header.id);
        const output = records
            .filter(
                (r): r is Extract<ConsoleRecord, { kind: 'observation' }> =>
                    r.kind === 'observation',
            )
            .map((r) => Buffer.from(r.base64, 'base64').toString())
            .join('');
        assert.match(output, /fixture listing from \/\r\n/);
        assert.match(output, /hello from normal fixture initialization/);
        assert.match(output, /kept\r\n/);
        const outcomes = records.filter((r) => r.kind === 'outcome');
        assert.equal(outcomes.length, 10);
        assert.ok(outcomes.every((r) => r.kind === 'outcome' && r.exitCode === null));
        t.diagnostic(
            'Actual ssh2 loopback protocol with a modeled interactive shell; no real ash/PTY/DUT acceptance.',
        );
    },
);

test(
    'startup/stale prompt cannot satisfy a silent next command; timeout retains lease until actual channel close',
    { timeout: 8000 },
    async (t) => {
        const f = await fake(t);
        f.channel.autoClose = false;
        const pending = f.actor.step(command('fixture-stall'), 200);
        let settled = false;
        void pending.catch(() => {
            settled = true;
        });
        await until(() => f.channel.closeRequested);
        assert.equal(f.owned(), true);
        assert.equal(settled, false);
        assert.equal(f.channel.writes.length, 1);
        await assert.rejects(f.actor.step(command('never', 2), 500), /unavailable|active/);
        f.channel.remoteClose();
        await assert.rejects(pending, /timeout/);
        assert.equal(f.owned(), false);
        assert.equal(f.actor.snapshot?.reason, 'timeout');
        const records = await f.records(f.actor.snapshot!.header.id);
        assert.ok(
            records.some(
                (r) => r.kind === 'outcome' && r.completion === 'timeout' && r.exitCode === null,
            ),
        );
    },
);

test(
    'cancel joins accepted stdout/extended bytes, raw persistence and actual close without clearing the queue',
    { timeout: 8000 },
    async (t) => {
        const held = gate();
        let hold = false,
            entered = false;
        const f = await fake(t, (store) =>
            proxy(store, {
                observe: async (...args) => {
                    if (hold) {
                        entered = true;
                        await held.promise;
                    }
                    return store.observe(...args);
                },
            }),
        );
        f.channel.autoClose = false;
        hold = true;
        f.channel.push(Buffer.alloc(23, 65));
        f.channel.stderr.write(Buffer.alloc(17, 66));
        await until(() => entered);
        const cancel = f.actor.cancel();
        let done = false;
        void cancel.then(() => {
            done = true;
        });
        f.channel.remoteClose();
        await new Promise((r) => setImmediate(r));
        assert.equal(f.owned(), true);
        assert.equal(done, false);
        held.resolve();
        const snapshot = await cancel;
        assert.equal(snapshot?.bytes, Buffer.byteLength(ready.literals[0]) + 40);
        assert.equal(snapshot?.observedBytes, snapshot?.bytes);
        assert.equal(snapshot?.shellClosed, true);
        assert.equal(snapshot?.reason, 'cancelled');
        assert.equal(f.owned(), false);
        const records = await f.records(snapshot!.header.id);
        assert.equal(
            records.filter((r) => r.kind === 'observation' && r.origin === 'extended').length,
            1,
        );
        assert.ok(
            records.filter((r) => r.kind === 'segment-start' && r.segment.kind === 'context')
                .length >= 2,
        );
    },
);

test(
    'immutable outcome commit gates the next input and Cancel retains ownership through that commit',
    { timeout: 8000 },
    async (t) => {
        const held = gate();
        let committing = false;
        const f = await fake(t, (store) =>
            proxy(store, {
                outcome: async (...args) => {
                    committing = true;
                    await held.promise;
                    return store.outcome(...args);
                },
            }),
        );
        f.channel.onWrite = () => f.channel.push(Buffer.from(ready.literals[0]));
        const step = f.actor.step(command('pwd'), 1000);
        await until(() => committing);
        await assert.rejects(f.actor.step(command('later', 2), 1000), /active/);
        await assert.rejects(f.actor.finish(), /persisted outcome/);
        const cancel = f.actor.cancel();
        await new Promise((r) => setImmediate(r));
        assert.equal(f.owned(), true);
        held.resolve();
        await assert.rejects(step, /stopped/);
        const snapshot = await cancel;
        assert.equal(f.channel.writes.length, 1);
        assert.equal(f.owned(), false);
        const records = await f.records(snapshot!.header.id);
        const outcomes = records.filter((r) => r.kind === 'outcome');
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].kind === 'outcome' && outcomes[0].completion, 'prompt-observed');
    },
);

test(
    'storage failure retains its quota cause and known observed gap, then closes store before releasing the owner',
    { timeout: 8000 },
    async (t) => {
        let fail = false;
        const f = await fake(t, (store) =>
            proxy(store, {
                observe: async (...args) => {
                    if (fail)
                        throw new CaptureStorageError('quota', 'Synthetic full console storage.');
                    return store.observe(...args);
                },
            }),
        );
        f.channel.onWrite = () => f.channel.push(Buffer.alloc(23, 65));
        fail = true;
        await assert.rejects(f.actor.step(command('large'), 1000));
        const snapshot = f.actor.snapshot!;
        assert.equal(snapshot.state, 'incomplete');
        assert.equal(snapshot.failure?.code, 'quota');
        assert.equal(snapshot.observedBytes, snapshot.bytes + 23);
        assert.equal(snapshot.shellClosed, true);
        assert.equal(f.store.resourceClosed, true);
        assert.equal(f.owned(), false);
    },
);

test(
    'freshness and connection checks after pending command metadata prevent writes',
    { timeout: 10000 },
    async (t) => {
        for (const failure of ['sleep', 'generation']) {
            const held = gate();
            let entered = false;
            const f = await fake(t, (store) =>
                proxy(store, {
                    start: async (segment, at) => {
                        const result = await store.start(segment, at);
                        if (segment.kind === 'command') {
                            entered = true;
                            await held.promise;
                        }
                        return result;
                    },
                }),
            );
            const pending = f.actor.step(command('must-not-send'), 1000);
            await until(() => entered);
            failure === 'sleep' ? f.stale() : f.replace();
            held.resolve();
            await assert.rejects(pending, /slept|generation/);
            assert.equal(f.channel.writes.length, 0);
            assert.equal(f.owned(), false);
        }
    },
);

test(
    'owner survives repository close acknowledgement and every actor listener is removed afterward',
    { timeout: 8000 },
    async (t) => {
        const held = gate();
        let closing = false;
        const f = await fake(t, (store) =>
            proxy(store, {
                close: async () => {
                    closing = true;
                    await held.promise;
                    return store.close();
                },
            }),
        );
        const done = f.actor.finish();
        await until(() => closing);
        assert.equal(f.owned(), true);
        assert.equal(f.actor.owned, true);
        held.resolve();
        await done;
        assert.equal(f.owned(), false);
        assert.equal(f.channel.listenerCount('data'), 0);
        assert.equal(f.channel.stderr.listenerCount('data'), 0);
        assert.equal(f.channel.listenerCount('close'), 0);
        assert.equal(getEventListeners(f.signal.signal, 'abort').length, 0);
    },
);

test(
    'actual close before final buffered extended data still joins both readable drains and retains bytes',
    { timeout: 8000 },
    async (t) => {
        const f = await fake(t);
        f.channel.autoClose = false;
        const pending = f.actor.cancel();
        f.channel.emit('close');
        f.channel.stderr.emit('data', Buffer.alloc(23, 66));
        f.channel.push(null);
        f.channel.stderr.end();
        const snapshot = await pending;
        assert.equal(snapshot?.observedBytes, Buffer.byteLength(ready.literals[0]) + 23);
        assert.equal(snapshot?.bytes, snapshot?.observedBytes);
        assert.equal(f.owned(), false);
    },
);

test(
    'an incomplete ANSI sequence cannot settle a prompt and UTF-8 fragments remain exact raw bytes',
    { timeout: 8000 },
    async (t) => {
        const f = await fake(t);
        f.channel.onWrite = () => f.channel.push(Buffer.from(ready.literals[0] + '\x1b['));
        const pending = f.actor.step(command('ansi'), 1500);
        let done = false;
        void pending.then(() => {
            done = true;
        });
        await until(() => f.channel.writes.length === 1);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(done, false);
        f.channel.push(Buffer.from('0m'));
        await pending;
        f.channel.onWrite = () => {
            f.channel.push(Buffer.from([0xce]));
            setTimeout(() => f.channel.push(Buffer.from([0xbb, 35, 32])), 20);
        };
        const result = await f.actor.step(command('unicode', 2, 'λ# '), 1500);
        assert.equal(result.match.literal, 'λ# ');
        const snapshot = await f.actor.finish();
        const records = await f.records(snapshot!.header.id);
        const bytes = Buffer.concat(
            records
                .filter(
                    (r): r is Extract<ConsoleRecord, { kind: 'observation' }> =>
                        r.kind === 'observation',
                )
                .map((r) => Buffer.from(r.base64, 'base64')),
        );
        assert.ok(bytes.includes(Buffer.from('\x1b[0m')));
        assert.ok(bytes.includes(Buffer.from('λ# ')));
    },
);

test(
    'a background idle prompt is retained as context and cannot complete a silent command',
    { timeout: 8000 },
    async (t) => {
        const f = await fake(t);
        f.channel.push(Buffer.from('background\r\n' + ready.literals[0]));
        const pending = f.actor.step(command('silent'), 200);
        await assert.rejects(pending, /timeout/);
        const records = await f.records(f.actor.snapshot!.header.id);
        assert.ok(
            records.some(
                (r) =>
                    r.kind === 'segment-start' &&
                    r.segment.kind === 'context' &&
                    r.segment.phase === 'idle',
            ),
        );
        assert.equal(f.channel.writes.length, 1);
    },
);

test(
    'more than a MiB of PTY output streams through the journal without a total-output cap or invented exit',
    { timeout: 12000 },
    async (t) => {
        const f = await fake(t);
        const expected = createHash('sha256');
        let sourceError: unknown;
        f.channel.onWrite = () => {
            void (async () => {
                for (let i = 0; i < 65; i++) {
                    const bytes = Buffer.alloc(16384, i % 251);
                    expected.update(bytes);
                    f.channel.push(bytes);
                    await until(() => !f.channel.isPaused());
                }
                f.channel.push(Buffer.from(ready.literals[0]));
            })().catch((error) => {
                sourceError = error;
            });
        };
        const result = await f.actor.step(command('large'), 8000);
        assert.equal(result.exitCode, null);
        assert.equal(sourceError, undefined);
        const snapshot = await f.actor.finish();
        assert.equal(snapshot?.state, 'complete');
        const records = await f.records(snapshot!.header.id),
            actual = createHash('sha256');
        const commandIndex = records.find(
            (r) =>
                r.kind === 'segment-start' &&
                r.segment.kind === 'command' &&
                r.segment.input.command === 'large',
        )?.index;
        assert.notEqual(commandIndex, undefined);
        let count = 0;
        for (const r of records)
            if (r.kind === 'observation' && r.index === commandIndex) {
                const bytes = Buffer.from(r.base64, 'base64');
                if (count < 65 * 16384) {
                    actual.update(bytes);
                    count += bytes.length;
                }
            }
        assert.equal(count, 65 * 16384);
        assert.equal(actual.digest('hex'), expected.digest('hex'));
    },
);

test(
    'a prompt buffered during command metadata persistence cannot become a fresh post-write match',
    { timeout: 8000 },
    async (t) => {
        const held = gate();
        let entered = false;
        const f = await fake(t, (store) =>
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
        const pending = f.actor.step(command('silent'), 250);
        await until(() => entered);
        f.channel.push(Buffer.from(ready.literals[0]));
        held.resolve();
        await assert.rejects(pending, /timeout/);
        assert.equal(f.channel.writes.length, 1);
        assert.equal(f.actor.snapshot?.observedBytes, 2 * Buffer.byteLength(ready.literals[0]));
    },
);

test(
    'an unfinished idle escape sequence refuses later input before the write boundary',
    { timeout: 8000 },
    async (t) => {
        const f = await fake(t);
        f.channel.push(Buffer.from('\x1b['));
        const error = await f.actor.step(command('must-not-send'), 500).then(
            () => null,
            (error) => error,
        );
        assert.equal(f.channel.writes.length, 0);
        assert.match(error?.message ?? '', /unfinished/);
        assert.equal(f.owned(), false);
    },
);

test(
    'cancellation during journal creation sends no shell open and retains ownership through initialization cleanup',
    { timeout: 8000 },
    async (t) => {
        const j = await journal(t),
            held = gate(),
            signal = new AbortController();
        let entered = false,
            opens = 0,
            owned = false;
        t.after(() => held.resolve());
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
                open: () => {
                    opens++;
                },
            },
            proxy(j.store, {
                begin: async (input) => {
                    entered = true;
                    await held.promise;
                    return j.store.begin(input);
                },
            }),
            50,
        );
        const pending = actor.open(header, signal.signal, 1000);
        void pending.catch(() => {});
        await until(() => entered);
        signal.abort();
        assert.equal(owned, true);
        held.resolve();
        await assert.rejects(pending, /stopped|cancelled/);
        assert.equal(opens, 0);
        assert.equal(owned, false);
        assert.equal(j.store.resourceClosed, true);
    },
);

test(
    'cancellation awaits a late shell-open callback and then the actual owned channel close',
    { timeout: 8000 },
    async (t) => {
        const j = await journal(t),
            channel = new Channel(),
            signal = new AbortController();
        channel.autoClose = false;
        let callback: Parameters<ConsoleBinding['open']>[0] | undefined;
        let opening = false,
            owned = false;
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
                open: (cb) => {
                    callback = cb;
                    opening = true;
                },
            },
            j.store,
            50,
        );
        t.after(async () => {
            channel.remoteClose();
            await actor.cancel().catch(() => {});
            channel.destroy();
            channel.stderr.destroy();
        });
        const pending = actor.open(header, signal.signal, 1000);
        void pending.catch(() => {});
        await until(() => opening);
        signal.abort();
        assert.equal(owned, true);
        callback!(undefined, channel as unknown as ClientChannel);
        assert.equal(channel.closeRequested, true);
        assert.equal(owned, true);
        channel.remoteClose();
        await assert.rejects(pending, /cancelled/);
        assert.equal(owned, false);
    },
);

test(
    'execution-boundary validation rejects blank Script, implicit Enter and mismatched request bytes without input',
    { timeout: 8000 },
    async (t) => {
        const f = await fake(t);
        assert.throws(
            () =>
                f.actor.step(
                    { ...command('valid'), input: { intent: 'script', command: '' } },
                    500,
                ),
            /Script/,
        );
        assert.throws(
            () =>
                f.actor.step(
                    { ...command('valid'), input: { intent: 'send-enter', command: 'text' } },
                    500,
                ),
            /Enter/,
        );
        assert.throws(
            () =>
                f.actor.step(
                    { ...command('valid'), requestBase64: bytesBase64(Buffer.from('different\r')) },
                    500,
                ),
            /bytes/,
        );
        assert.equal(f.channel.writes.length, 0);
        assert.equal(f.owned(), true);
        await f.actor.finish();
    },
);
