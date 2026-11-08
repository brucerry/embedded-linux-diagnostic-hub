import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeCaptureStore } from '../electron/capture-store';
import { CaptureStorageError, type CaptureRepository } from '../shared/capture-store';
import { type AutomationPlan, type AutomationRecord } from '../shared/automation';
import { DEFAULT_SERIAL_SETTINGS } from '../shared/serial';
import { SerialSession } from '../src/features/serial/session';
import { FlowRunner, type FlowState } from '../src/features/automation/runner';
import { serialCaptureBackend } from '../src/features/automation/capture/serial-backend';
import { streamCaptureReport } from '../shared/capture-report';
import { serialCaptureFixture, deferred, until } from './fixtures/serial-capture';

const encode = (text: string) => new TextEncoder().encode(text);
const plan = (commands = ['ls', '', '', 'pwd']): AutomationPlan => ({
    transport: 'serial',
    start: null,
    timeoutSeconds: 300,
    repeatSeconds: null,
    captureDeviceTime: true,
    serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: 'CLOCK=' },
    steps: commands.map((command, index) => ({
        id: 'step-' + index,
        name: command || 'Enter ' + index,
        command,
        enabled: true,
        enterOnly: !command,
        delaySeconds: 0,
    })),
});
async function setup(t: TestContext, response: Parameters<typeof serialCaptureFixture>[0]) {
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-serial-integrated-')),
        store = await NativeCaptureStore.open(profile, { profileOwned: true }),
        fixture = serialCaptureFixture(response),
        session = new SerialSession(async () => {});
    session.select(fixture.port, 'synthetic storage UART');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    t.after(async () => {
        await session.close();
        await store.close();
        assert.ok(
            path.resolve(profile).startsWith(temp + path.sep) &&
                path.basename(profile).startsWith('hub-serial-integrated-'),
        );
        await fs.rm(profile, { recursive: true, force: true });
    });
    return { store, profile, fixture, session };
}
function wrapped(
    store: CaptureRepository,
    overrides: Partial<CaptureRepository>,
): CaptureRepository {
    return new Proxy(store, {
        get(target, key) {
            const replacement = Reflect.get(overrides, key);
            if (replacement !== undefined) return replacement;
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
async function* prompt() {
    yield encode('\r\nboard# ');
}

test(
    'real Serial + runner capture >32 MiB then consecutive Enter/Enter/script with exact raw bytes, fresh ownership and streaming export',
    { timeout: 120000 },
    async (t) => {
        const expected: string[] = [],
            byteCounts: number[] = [];
        const { store, fixture, session } = await setup(t, async function* (_request, ordinal) {
            const hash = crypto.createHash('sha256');
            let bytes = 0;
            const send = (value: Uint8Array) => {
                hash.update(value);
                bytes += value.length;
                return value;
            };
            if (ordinal === 1)
                for (let index = 0; index < 2113; index++)
                    yield send(new Uint8Array(16384).fill(65 + (index % 26)));
            yield send(encode('\r\nCLOCK=2026-10-15T05:00:00.000Z\r\n\x1b[32mboard# \x1b[0m'));
            expected.push(hash.digest('hex'));
            byteCounts.push(bytes);
        });
        const rows: AutomationRecord[] = [],
            states: FlowState[] = [],
            runner = new FlowRunner(
                (state) => states.push(state),
                (row) => {
                    rows.push(row);
                },
            );
        await runner.start(plan(), serialCaptureBackend(session, store));
        assert.equal(states.at(-1)!.state, 'finished');
        assert.equal(rows.length, 4);
        assert.deepEqual(
            fixture.writes.map((bytes) => Buffer.from(bytes).toString()),
            ['ls\r', '\r', '\r', 'pwd\r'],
        );
        assert.equal(fixture.opens, 1);
        assert.equal(fixture.closes, 0);
        const captures = (await store.page()).records;
        assert.equal(captures.length, 4);
        assert.ok(captures[0].committedBytes > 32 * 1024 * 1024);
        for (const [index, capture] of captures.entries()) {
            assert.equal(capture.state, 'complete');
            assert.equal(capture.committedBytes, byteCounts[index]);
            assert.equal(capture.header.runId, rows[index].runId);
            assert.equal(capture.header.stepId, plan().steps[index].id);
            const hash = crypto.createHash('sha256');
            let observations = 0;
            for await (const event of store.read(capture.id))
                if (event.type === 'frame') {
                    hash.update(event.frame.bytes);
                    if (!event.frame.offset) observations++;
                }
            assert.equal(hash.digest('hex'), expected[index]);
            assert.equal(observations, capture.observations);
            assert.equal(rows[index].stored?.id, capture.id);
            assert.equal(rows[index].truncated, false);
            assert.equal(rows[index].deviceTime?.value, '2026-10-15T05:00:00.000Z');
        }
        assert.equal(rows[0].previewClipped, true);
        assert.ok(Buffer.byteLength(rows[0].stdout) <= 8192);
        assert.equal(rows[0].chunks.length, 0); // the repository owns raw observations, not the preview
        let exported = 0;
        for await (const bytes of streamCaptureReport(store, 'json')) exported += bytes.length;
        assert.ok(exported > 32 * 1024 * 1024);
        // Explicitly re-arm the same session: no stale prompt/capture or extra port open.
        await runner.start(plan(['pwd']), serialCaptureBackend(session, store));
        assert.equal(rows.length, 5);
        assert.equal(fixture.writes.length, 5);
        assert.equal(fixture.opens, 1);
        assert.equal((await store.page()).records.length, 5);
    },
);

test('seal and async result commits both retain Serial ownership and block the next command until acknowledgement', async (t) => {
    const { store, fixture, session } = await setup(t, prompt),
        seal = deferred(),
        result = deferred();
    let sealing = false,
        recording = false;
    const gated = wrapped(store, {
            async seal(...args) {
                sealing = true;
                await seal.promise;
                return store.seal(...args);
            },
        }),
        runner = new FlowRunner(
            () => {},
            async () => {
                recording = true;
                await result.promise;
            },
        );
    const pending = runner.start(plan(['first', 'second']), serialCaptureBackend(session, gated));
    await until(() => sealing);
    assert.equal(fixture.writes.length, 1);
    assert.equal(runner.busy, true);
    assert.throws(() => session.send(encode('interactive')), /owned/);
    const capture = (await store.page()).records[0];
    await assert.rejects(store.delete(capture.id), /owns/);
    seal.resolve();
    await until(() => recording);
    assert.equal(fixture.writes.length, 1);
    assert.throws(() => session.send(encode('interactive')), /owned/);
    result.resolve();
    await pending;
    assert.equal(fixture.writes.length, 2);
});

for (const fault of ['begin', 'append', 'seal', 'record'] as const)
    test(
        'Serial storage ' +
            fault +
            ' failure stops the next command and reports retained completeness honestly',
        async (t) => {
            const { store, fixture, session } = await setup(t, async function* () {
                for (let index = 0; index < 20; index++) yield new Uint8Array(16384).fill(88);
                yield encode('\r\nboard# ');
            });
            let commits = 0;
            const broken = wrapped(store, {
                ...(fault === 'begin'
                    ? {
                          async begin() {
                              throw new CaptureStorageError(
                                  'permission',
                                  'Capture location denied.',
                              );
                          },
                      }
                    : {}),
                ...(fault === 'append'
                    ? {
                          async append(...args: Parameters<CaptureRepository['append']>) {
                              if (++commits === 2)
                                  throw Object.assign(Error('Capture disk full.'), {
                                      code: 'ENOSPC',
                                  });
                              return store.append(...args);
                          },
                      }
                    : {}),
                ...(fault === 'seal'
                    ? {
                          async seal() {
                              throw new CaptureStorageError('io', 'Capture seal failed.');
                          },
                      }
                    : {}),
            });
            const rows: AutomationRecord[] = [],
                states: FlowState[] = [],
                runner = new FlowRunner(
                    (state) => states.push(state),
                    async (row) => {
                        rows.push(row);
                        if (fault === 'record')
                            throw new CaptureStorageError(
                                'quota',
                                'Result metadata quota exhausted.',
                            );
                    },
                );
            await runner.start(
                plan(['first', 'never-send']),
                serialCaptureBackend(session, broken),
            );
            assert.equal(fixture.writes.length, fault === 'begin' ? 0 : 1);
            assert.equal(states.at(-1)!.state, 'paused');
            assert.equal(rows.length, 1);
            if (fault === 'begin') {
                assert.match(rows[0].stderr, /denied/);
                assert.equal((await store.page()).records.length, 0);
            } else if (fault === 'record') {
                assert.match(states.at(-1)!.message, /metadata quota/);
                assert.equal(rows[0].stored?.state, 'complete');
            } else {
                assert.equal(rows[0].completion, 'storage-error');
                assert.equal(rows[0].stored?.state, 'incomplete');
                assert.match(states.at(-1)!.message, /Capture incomplete/);
                assert.equal((await store.page()).records[0].state, 'incomplete');
                if (fault === 'append') {
                    assert.equal(rows[0].stored?.failure?.code, 'quota');
                    assert.ok(rows[0].stored!.committedBytes > 0);
                    assert.ok(rows[0].stored!.observedBytes! > rows[0].stored!.committedBytes);
                }
                let bytes = 0;
                for await (const event of store.read(rows[0].stored!.id))
                    if (event.type === 'frame') bytes += event.frame.bytes.length;
                assert.equal(bytes, rows[0].stored!.committedBytes);
            }
        },
    );

test('Cancel during an outstanding receive commit waits for cleanup, suppresses later commands and repetition', async (t) => {
    const { store, fixture, session } = await setup(t, async function* () {
        for (let index = 0; index < 12; index++) yield new Uint8Array(16384).fill(65);
        yield encode('\r\nboard# ');
    });
    const gate = deferred();
    let committing = false,
        commits = 0;
    const slow = wrapped(store, {
            async append(...args) {
                if (++commits === 2) {
                    committing = true;
                    await gate.promise;
                }
                return store.append(...args);
            },
        }),
        rows: AutomationRecord[] = [],
        runner = new FlowRunner(
            () => {},
            (row) => {
                rows.push(row);
            },
        ),
        p = plan(['first', 'never']);
    p.repeatSeconds = 1;
    const pending = runner.start(p, serialCaptureBackend(session, slow));
    await until(() => committing);
    runner.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runner.busy, true);
    assert.equal(rows.length, 0);
    assert.equal(fixture.writes.length, 1);
    assert.throws(() => session.send(encode('interactive')), /owned/);
    gate.resolve();
    await pending;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].completion, 'cancelled');
    assert.equal(fixture.writes.length, 1);
    assert.equal(runner.busy, false);
    assert.equal(rows[0].stored?.state, 'complete');
});

for (const ending of ['CR', 'CRLF'] as const)
    test(
        'maximum UTF-8 Serial script plus ' +
            ending +
            ' reaches the mock writer without being rejected by capture metadata',
        async (t) => {
            const { store, fixture, session } = await setup(t, prompt),
                p = plan(['\u00e9'.repeat(4096)]);
            p.serial.lineEnding = ending;
            p.steps[0].name = 'Maximum UTF-8 script';
            const runner = new FlowRunner(
                () => {},
                () => {},
            );
            await runner.start(p, serialCaptureBackend(session, store));
            assert.equal(fixture.writes.length, 1);
            assert.equal(fixture.writes[0].length, ending === 'CR' ? 8193 : 8194);
            assert.deepEqual(
                Buffer.from((await store.page()).records[0].header.requestBase64!, 'base64'),
                Buffer.from(fixture.writes[0]),
            );
        },
    );

test('an oversized actual Serial observation is incomplete and cannot authorize the next command', async (t) => {
    const { store, fixture, session } = await setup(t, async function* () {
        yield new Uint8Array(256 * 1024 + 1);
    });
    const rows: AutomationRecord[] = [],
        runner = new FlowRunner(
            () => {},
            (row) => {
                rows.push(row);
            },
        );
    await runner.start(plan(['first', 'never']), serialCaptureBackend(session, store));
    assert.equal(fixture.writes.length, 1);
    assert.equal(rows[0].stored?.state, 'incomplete');
    assert.equal(rows[0].stored?.failure?.code, 'backlog');
    assert.equal(rows[0].stored?.observedBytes, 256 * 1024 + 1);
});

test('a Serial generation change during storage begin prevents any bytes being sent', async (t) => {
    const { store, fixture, session } = await setup(t, prompt),
        gate = deferred();
    let beginning = false;
    const slow = wrapped(store, {
            async begin(...args) {
                beginning = true;
                await gate.promise;
                return store.begin(...args);
            },
        }),
        runner = new FlowRunner(
            () => {},
            () => {},
        ),
        pending = runner.start(plan(['first', 'never']), serialCaptureBackend(session, slow));
    await until(() => beginning);
    await session.close();
    gate.resolve();
    await pending;
    assert.equal(fixture.writes.length, 0);
    assert.equal(runner.busy, false);
});

test('fragmented clock text is accepted only after its complete literal line, independently of the preview window', async (t) => {
    const { store, fixture, session } = await setup(t, async function* () {
        yield encode('CLOCK=2026-10-15T05:00:00.000Z');
        yield encode('invalid-suffix\r\nboard# ');
    });
    const rows: AutomationRecord[] = [],
        runner = new FlowRunner(
            () => {},
            (row) => {
                rows.push(row);
            },
        );
    await runner.start(plan(['clock']), serialCaptureBackend(session, store));
    assert.equal(fixture.writes.length, 1);
    assert.equal(rows[0].completion, 'prompt-observed');
    assert.equal(rows[0].deviceTime, null);
});
