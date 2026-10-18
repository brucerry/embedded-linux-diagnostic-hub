import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeCaptureStore, saveCaptureExport } from '../electron/capture-store';
import { physicalFS } from '../electron/physical-fs';
import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    captureHeader,
    frameCrc,
    type CaptureFrame,
    type CaptureHeader,
    type CaptureRepository,
} from '../shared/capture-store';
import { CaptureWriter } from '../shared/capture-writer';
import { streamCaptureJson } from '../shared/capture-export';
import { streamCaptureReport } from '../shared/capture-report';
import { serialPayload, bytesBase64, type AutomationPlan } from '../shared/automation';
import { FlowRunner, type FlowState } from '../src/features/automation/runner';

const stamp = '2026-10-15T00:00:00.000Z';
const header = (command = 'printf fixture'): CaptureHeader => ({
    transport: 'serial',
    receiveTimeSource: 'local-client',
    runId: 'fixture-run',
    stepId: 'step-one',
    name: 'Fixture command',
    command,
    startedAt: stamp,
});
const encode = (text: string) => new TextEncoder().encode(text);
const frame = (bytes = encode('fixture'), observation = 0): CaptureFrame => ({
    bytes,
    crc32: frameCrc(bytes),
    observation,
    offset: 0,
    totalBytes: bytes.length,
    stream: 'serial',
    receivedAt: stamp,
});
async function fixture(t: TestContext) {
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-capture-storage-'));
    const store = await NativeCaptureStore.open(profile, { profileOwned: true });
    t.after(async () => {
        await store.close();
        const resolved = path.resolve(profile);
        assert.ok(
            resolved.startsWith(temp + path.sep) &&
                path.basename(resolved).startsWith('hub-capture-storage-'),
        );
        await fs.rm(resolved, { recursive: true, force: true });
    });
    return { store, profile };
}
async function text(source: AsyncIterable<Uint8Array>) {
    let value = '';
    for await (const chunk of source) {
        assert.ok(chunk.length <= CAPTURE_STORAGE.batchBytes);
        value += new TextDecoder().decode(chunk);
    }
    return value;
}
async function record(
    store: CaptureRepository,
    bytes = encode('fixture'),
    command = 'printf fixture',
) {
    const writer = await CaptureWriter.begin(store, header(command));
    await writer.append(bytes, stamp, 'serial');
    return writer.finish('prompt-observed');
}

test('script and transmitted byte budgets accept maximum UTF-8 scripts with every Serial ending', () => {
    for (const script of ['a'.repeat(8192), '\u00e9'.repeat(4096)]) {
        assert.equal(encode(script).length, 8192);
        for (const ending of ['none', 'CR', 'LF', 'CRLF'] as const) {
            const payload = serialPayload(script, ending);
            const captured = captureHeader({
                ...header(script),
                requestBase64: bytesBase64(payload),
            });
            assert.equal(captured.command, script);
            assert.deepEqual(Buffer.from(captured.requestBase64!, 'base64'), Buffer.from(payload));
            assert.equal(payload.length, 8192 + { none: 0, CR: 1, LF: 1, CRLF: 2 }[ending]);
        }
        assert.throws(() => captureHeader(header(script + 'a')), /command/);
        assert.throws(
            () =>
                captureHeader({
                    ...header(script),
                    requestBase64: bytesBase64(encode(script + '\r\nX')),
                }),
            /transmitted/,
        );
    }
});

for (const fault of ['same-length corruption', 'frame reorder'] as const)
    test(
        'native seal rejects ' + fault + ' before the runner can send the next command',
        async (t) => {
            const { store, profile } = await fixture(t),
                writer = await CaptureWriter.begin(store, header());
            await writer.append(new Uint8Array([1, 2, 3, 4]), stamp, 'serial');
            await writer.append(new Uint8Array([5, 6, 7, 8]), '2026-10-15T00:00:00.001Z', 'serial');
            await writer.flush();
            const journal = path.join(profile, 'captures-v1', writer.id, 'raw.jsonl'),
                before = await fs.readFile(journal, 'utf8'),
                lines = before.trimEnd().split('\n');
            if (fault === 'same-length corruption') {
                const raw = JSON.parse(lines[0]);
                raw.bytes = 'BQIDBA=='; // same encoded length, original CRC intentionally unchanged
                lines[0] = JSON.stringify(raw);
            } else lines.reverse();
            const changed = lines.join('\n') + '\n';
            assert.equal(Buffer.byteLength(changed), Buffer.byteLength(before));
            await fs.writeFile(journal, changed);
            let sends = 0,
                finishRejected = false,
                released = false;
            const states: FlowState[] = [],
                runner = new FlowRunner(
                    (state) => states.push(state),
                    () => {},
                );
            const plan: AutomationPlan = {
                transport: 'serial',
                start: null,
                timeoutSeconds: 10,
                repeatSeconds: null,
                serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: '' },
                steps: [1, 2].map((index) => ({
                    id: 'step-' + index,
                    name: 'Step ' + index,
                    command: 'fixture',
                    enabled: true,
                    delaySeconds: 0,
                })),
            };
            await runner.start(plan, {
                connection: () => 'fixture-generation',
                available: () => true,
                acquire: () => () => {
                    released = true;
                },
                target: { endpoint: 'synthetic serial' },
                execute: async () => {
                    sends++;
                    try {
                        await writer.finish('prompt-observed');
                    } catch (error) {
                        finishRejected = true;
                        throw error;
                    }
                    return {
                        stdout: '',
                        stderr: '',
                        exitCode: null,
                        completion: 'prompt-observed',
                        truncated: false,
                        chunks: [],
                    };
                },
            });
            assert.equal(finishRejected, true);
            assert.equal(sends, 1);
            assert.equal(released, true);
            assert.equal(states.at(-1)!.state, 'paused');
            const saved = (await store.page()).records[0];
            assert.equal(saved.state, 'incomplete');
            assert.equal(saved.failure?.code, 'integrity');
            assert.equal(await fs.readFile(journal, 'utf8'), changed); // preserve evidence; never repair bytes silently
        },
    );

test('native storage streams beyond both old byte caps without retaining the output or losing provenance', async (t) => {
    const { store, profile } = await fixture(t),
        writer = await CaptureWriter.begin(store, header()),
        expected = crypto.createHash('sha256');
    const block = Buffer.alloc(16384);
    let total = 0;
    for (let index = 0; index < 2369; index++) {
        crypto.randomFillSync(block);
        expected.update(block);
        total += block.length;
        await writer.append(block, index % 2 ? stamp : '2026-10-14T23:59:59.999Z', 'serial');
        assert.ok(writer.backlogBytes <= CAPTURE_STORAGE.backlogBytes);
    }
    const capture = await writer.finish('prompt-observed');
    assert.equal(capture.committedBytes, total);
    assert.ok(total > 32 * 1024 * 1024);
    assert.equal(writer.previewBytes.length, 8192);
    assert.equal(writer.previewClipped, true);
    const actual = crypto.createHash('sha256');
    let observations = 0,
        first = '',
        second = '';
    for await (const event of store.read(writer.id))
        if (event.type === 'frame') {
            actual.update(event.frame.bytes);
            if (!observations) first = event.frame.receivedAt;
            else if (observations === 1) second = event.frame.receivedAt;
            observations++;
        }
    assert.equal(actual.digest('hex'), expected.digest('hex'));
    assert.equal(observations, 2369);
    assert.ok(second > first);
    const destination = path.join(profile, 'full.json');
    await saveCaptureExport(destination, streamCaptureJson(store, writer.id));
    assert.ok((await fs.stat(destination)).size > 32 * 1024 * 1024);
});

test('one-byte observations and split large reads retain exact boundaries and clock jumps', async (t) => {
    const { store } = await fixture(t),
        writer = await CaptureWriter.begin(store, header());
    const bytes = encode('\u001b[31m雪🙂\u001b[0m\r\n# ');
    for (let i = 0; i < bytes.length; i++)
        await writer.append(
            bytes.slice(i, i + 1),
            i % 2 ? stamp : '2026-10-14T23:00:00.000Z',
            'serial',
        );
    const large = new Uint8Array(128 * 1024).fill(231);
    await writer.append(large, stamp, 'serial');
    const capture = await writer.finish('prompt-observed'),
        raw = JSON.parse(await text(streamCaptureJson(store, capture.id)));
    assert.equal(raw.captureComplete, true);
    assert.equal(capture.observations, bytes.length + 1);
    const decoded = Buffer.concat(
        raw.rawObservations.map((f: { base64: string }) => Buffer.from(f.base64, 'base64')),
    );
    assert.deepEqual(decoded, Buffer.concat([Buffer.from(bytes), Buffer.from(large)]));
    const parts = raw.rawObservations.filter(
        (f: { observation: number }) => f.observation === bytes.length,
    );
    assert.equal(parts.length, 8);
    assert.deepEqual(
        parts.map((f: { offset: number }) => f.offset),
        Array.from({ length: 8 }, (_, i) => i * 16384),
    );
});

test('slow storage backpressures the producer with one commit and a bounded backlog', async (t) => {
    const { store } = await fixture(t);
    let release!: () => void,
        entered!: () => void,
        inFlight = 0,
        max = 0;
    const started = new Promise<void>((resolve) => (entered = resolve)),
        held = new Promise<void>((resolve) => (release = resolve));
    const adapter = new Proxy(store, {
        get(target, key) {
            if (key === 'append')
                return async (...args: Parameters<CaptureRepository['append']>) => {
                    inFlight++;
                    max = Math.max(max, inFlight);
                    entered();
                    await held;
                    try {
                        return await target.append(...args);
                    } finally {
                        inFlight--;
                    }
                };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as CaptureRepository;
    const writer = await CaptureWriter.begin(adapter, header());
    let accepted = false;
    const pending = writer.append(new Uint8Array(256 * 1024).fill(7), stamp, 'serial').then(() => {
        accepted = true;
    });
    await started;
    assert.equal(accepted, false);
    await assert.rejects(writer.flush(), /Await the receive observation/);
    assert.ok(writer.backlogBytes <= CAPTURE_STORAGE.backlogBytes);
    release();
    await pending;
    const capture = await writer.finish('prompt-observed');
    assert.equal(capture.committedBytes, 256 * 1024);
    assert.equal(max, 1);
});

test('an oversized receive observation is explicit incomplete capture and never authorizes the next command', async (t) => {
    const { store } = await fixture(t);
    let notices = 0,
        nextSent = false;
    const writer = await CaptureWriter.begin(store, header(), () => notices++);
    await assert.rejects(
        writer.append(new Uint8Array(CAPTURE_STORAGE.backlogBytes + 1), stamp, 'serial'),
        /bounded producer/,
    );
    await assert.rejects(
        (async () => {
            await writer.finish('prompt-observed');
            nextSent = true;
        })(),
    );
    await writer.abort(writer.error);
    assert.equal(nextSent, false);
    assert.equal(notices, 1);
    const row = (await store.page()).records[0];
    assert.equal(row.state, 'incomplete');
    assert.equal(row.failure?.code, 'backlog');
    assert.equal(row.committedBytes, 0);
    assert.equal(row.observedBytes, CAPTURE_STORAGE.backlogBytes + 1);
});

test('quota exhaustion preserves the committed prefix and stops later execution', async (t) => {
    const { store } = await fixture(t),
        writer = await CaptureWriter.begin(store, header());
    await writer.append(encode('committed-prefix'), stamp, 'serial');
    await writer.flush();
    const original = store.append.bind(store);
    let fail = true;
    t.mock.method(store, 'append', async (...args: Parameters<typeof original>) => {
        if (fail) throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
        return original(...args);
    });
    await writer.append(encode('uncommitted-tail'), stamp, 'serial');
    let nextSent = false;
    await assert.rejects(
        (async () => {
            await writer.finish('prompt-observed');
            nextSent = true;
        })(),
        /disk full/,
    );
    fail = false;
    assert.equal(nextSent, false);
    const raw = JSON.parse(await text(streamCaptureJson(store, writer.id)));
    assert.equal(raw.captureComplete, false);
    assert.equal(raw.capture.failure.code, 'quota');
    assert.equal(raw.capture.observedBytes, 32);
    assert.equal(raw.verifiedCommittedBytes, 16);
    assert.equal(
        Buffer.from(raw.rawObservations[0].base64, 'base64').toString(),
        'committed-prefix',
    );
});

test('native commit failure retains uncommitted journal bytes and recovers only a verified incomplete prefix', async (t) => {
    const { store, profile } = await fixture(t),
        writer = await CaptureWriter.begin(store, header());
    await writer.append(encode('prefix'), stamp, 'serial');
    await writer.flush();
    const rename = physicalFS.promises.rename.bind(physicalFS.promises);
    const mock = t.mock.method(
        physicalFS.promises,
        'rename',
        async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
            if (String(to).endsWith(path.sep + 'meta.json'))
                throw Object.assign(Error('metadata commit disk full'), { code: 'ENOSPC' });
            return rename(from, to);
        },
    );
    await writer.append(encode('retained-journal-tail'), stamp, 'serial');
    await assert.rejects(writer.finish('prompt-observed'), /disk full/);
    await writer.abort(writer.error);
    mock.mock.restore();
    const file = path.join(profile, 'captures-v1', writer.id, 'raw.jsonl'),
        before = await fs.readFile(file);
    await store.close();
    const reopened = await NativeCaptureStore.open(profile, { profileOwned: true });
    try {
        const row = (await reopened.page()).records[0];
        assert.equal(row.state, 'incomplete');
        assert.equal(row.observedBytes, null);
        assert.equal(row.committedBytes, 6);
        assert.match(row.reason!, /uncommitted journal bytes retained/);
        assert.deepEqual(await fs.readFile(file), before);
        const raw = JSON.parse(await text(streamCaptureJson(reopened, writer.id)));
        assert.equal(raw.captureComplete, false);
        assert.equal(raw.verifiedCommittedBytes, 6);
    } finally {
        await reopened.close();
    }
});

test('failed seal cannot authorize next input and existing export destination survives encoder failure', async (t) => {
    const { store, profile } = await fixture(t),
        writer = await CaptureWriter.begin(store, header());
    await writer.append(encode('all raw bytes'), stamp, 'serial');
    await writer.flush();
    const seal = store.seal.bind(store);
    t.mock.method(store, 'seal', async () => {
        throw new CaptureStorageError('io', 'seal failed');
    });
    let next = false;
    await assert.rejects(
        (async () => {
            await writer.finish('exit');
            next = true;
        })(),
        /seal failed/,
    );
    assert.equal(next, false);
    const destination = path.join(profile, 'existing-report.md');
    await fs.writeFile(destination, 'existing user export');
    async function* broken() {
        yield encode('partial report');
        throw Error('encoder integrity failure');
    }
    await assert.rejects(saveCaptureExport(destination, broken(), true), /encoder integrity/);
    assert.equal(await fs.readFile(destination, 'utf8'), 'existing user export');
    const raw = JSON.parse(await text(streamCaptureJson(store, writer.id)));
    assert.equal(raw.captureComplete, false);
    assert.equal(raw.verifiedCommittedBytes, 13);
    void seal;
});

test('retention exceeds 200 rows, explicit deletion respects leases and sequence survives deleting every result', async (t) => {
    const { store, profile } = await fixture(t);
    for (let i = 0; i < 205; i++) {
        const capture = await store.begin(header(''));
        await store.seal(capture.id, 0, 'empty fixture');
    }
    const first = await store.page(0, 100),
        second = await store.page(first.next!, 100),
        third = await store.page(second.next!, 100);
    assert.equal(first.records.length + second.records.length + third.records.length, 205);
    const pin = await store.pin();
    await assert.rejects(store.delete(first.records[0].id), /owns this record/);
    await pin.release();
    for (const row of [...first.records, ...second.records, ...third.records])
        await store.delete(row.id);
    await store.close();
    const reopened = await NativeCaptureStore.open(profile, { profileOwned: true });
    try {
        const capture = await reopened.begin(header());
        assert.equal(capture.sequence, 206);
        await reopened.seal(capture.id, 0, 'empty fixture');
    } finally {
        await reopened.close();
    }
});

test('short native writes are retried and corrupt/missing raw evidence cannot finish an export', async (t) => {
    const { store, profile } = await fixture(t),
        open = physicalFS.promises.open.bind(physicalFS.promises);
    const mock = t.mock.method(
        physicalFS.promises,
        'open',
        async (...args: Parameters<typeof open>) => {
            const handle = await open(...args);
            if (!String(args[0]).endsWith('raw.jsonl')) return handle;
            return new Proxy(handle, {
                get(target, key) {
                    if (key === 'write')
                        return (
                            buffer: Uint8Array,
                            offset: number,
                            length: number,
                            position: number,
                        ) => target.write(buffer, offset, Math.min(length, 7), position);
                    const value = Reflect.get(target, key);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
    );
    const capture = await record(store, encode('all short writes survive'));
    mock.mock.restore();
    const raw = JSON.parse(await text(streamCaptureJson(store, capture.id)));
    assert.equal(
        Buffer.from(raw.rawObservations[0].base64, 'base64').toString(),
        'all short writes survive',
    );
    const journal = path.join(profile, 'captures-v1', capture.id, 'raw.jsonl'),
        content = await fs.readFile(journal, 'utf8');
    const edited = JSON.parse(content.trim());
    edited.bytes = Buffer.from('all short writes survivf').toString('base64');
    await fs.writeFile(journal, JSON.stringify(edited) + '\n');
    await assert.rejects(text(streamCaptureJson(store, capture.id)), /checksum/);
    await fs.truncate(journal, 2);
    await assert.rejects(text(streamCaptureJson(store, capture.id)), /missing/);
});

test('rich Markdown keeps command/output outside tables and uses safe fences and streaming UTF-8', async (t) => {
    const { store, profile } = await fixture(t),
        command = 'echo "pipes | newlines"\n~~~\n```\n<script>alert(1)</script>';
    const writer = await CaptureWriter.begin(store, {
        ...header(command),
        name: '雪 | **danger** <img src=x onerror=alert(1)>',
    });
    const output = encode(
        'UTF-8 雪🙂\r\n~~~~\n```\n| output table? |\n<script>alert(2)</script>\n',
    );
    for (let i = 0; i < output.length; i++)
        await writer.append(output.slice(i, i + 1), stamp, 'serial');
    await writer.finish('prompt-observed');
    const interrupted = await CaptureWriter.begin(store, {
        ...header('=unsafe | "quoted"\nline'),
        name: '@Incomplete | fixture',
    });
    await interrupted.append(encode('Retained prefix before quota failure\n'), stamp, 'serial');
    await interrupted.flush();
    await interrupted.append(encode('not committed'), stamp, 'serial');
    await interrupted.abort(
        new CaptureStorageError('quota', 'Synthetic quota full | committed prefix retained'),
    );
    const markdown = await text(streamCaptureReport(store, 'markdown'));
    assert.match(markdown, /## 📋 Capture summary/);
    assert.match(markdown, /\| # \| Command label/);
    assert.match(markdown, /~~~~~text/);
    assert.match(markdown, /~~~~sh/);
    assert.match(markdown, /UTF-8 雪🙂/);
    assert.match(markdown, /Raw JSON v3/);
    assert.ok(!markdown.includes('**danger** <img'));
    const prettier = await import('prettier');
    const parsed = await (
        prettier as unknown as {
            __debug: {
                parse(source: string, options: { parser: string }): Promise<{ ast: unknown }>;
            };
        }
    ).__debug.parse(markdown, { parser: 'markdown' });
    const nodes = (
        parsed.ast as { children: { type: string; value?: string; children?: unknown[] }[] }
    ).children;
    const codes = nodes.filter((n) => n.type === 'code');
    assert.equal(codes.length, 4);
    assert.equal(codes[0].value, command);
    assert.equal(codes[1].value, new TextDecoder().decode(output).replace(/\r\n?/g, '\n'));
    assert.equal(nodes.filter((n) => n.type === 'table').length, 1);
    assert.equal(nodes.filter((n) => n.type === 'html').length, 0);
    const artifact = process.env.HUB_CAPTURE_EVIDENCE;
    if (artifact) {
        await fs.mkdir(artifact, { recursive: true });
        await fs.writeFile(path.join(artifact, 'representative-automation.md'), markdown);
        await fs.writeFile(
            path.join(artifact, 'representative-automation.ast.json'),
            JSON.stringify(parsed.ast),
        );
    }
    await saveCaptureExport(
        path.join(profile, 'report.md'),
        streamCaptureReport(store, 'markdown'),
    );
    const csv = await text(streamCaptureReport(store, 'csv'));
    assert.match(csv, /raw_base64_prefixed/);
    assert.match(csv, /base64:/);
    assert.ok(csv.includes('"\'=unsafe | ""quoted""\nline"'));
    const raw = JSON.parse(await text(streamCaptureReport(store, 'json')));
    assert.equal(raw.summary.complete, 1);
    assert.equal(raw.summary.incomplete, 1);
    assert.equal(raw.captures[0].captureComplete, true);
    assert.equal(raw.captures[1].captureComplete, false);
});

test('Markdown fences span storage boundaries and UTF-8 decoders stay independent per SSH stream', async (t) => {
    const { store } = await fixture(t),
        writer = await CaptureWriter.begin(store, {
            ...header(),
            transport: 'ssh',
            receiveTimeSource: 'gateway',
        });
    await writer.append(new Uint8Array([240, 159]), stamp, 'stdout');
    await writer.append(encode('stderr|'), '2026-10-14T23:59:59.000Z', 'stderr');
    await writer.append(new Uint8Array([153, 130]), stamp, 'stdout');
    await writer.append(encode('\n' + '~'.repeat(50123) + '\n'), stamp, 'stdout');
    await writer.append(new Uint8Array([233]), stamp, 'stderr');
    const capture = await writer.finish('exit');
    const markdown = await text(streamCaptureReport(store, 'markdown'));
    assert.ok(markdown.includes('~'.repeat(50124) + 'text\n'));
    assert.ok(markdown.includes('stderr|🙂'));
    assert.ok(markdown.includes('�'));
    const raw = JSON.parse(await text(streamCaptureJson(store, capture.id)));
    assert.equal(raw.rawObservations[0].base64, '8J8=');
    assert.equal(raw.rawObservations[2].base64, 'mYI=');
    assert.equal(raw.capture.header.receiveTimeSource, 'gateway');
    assert.equal(raw.rawObservations[1].receivedAt, '2026-10-14T23:59:59.000Z');
    assert.match(await text(streamCaptureReport(store, 'csv')), /base64:8J8=/);
});

test('failure cleanup waits for an outstanding native commit before releasing writer ownership', async (t) => {
    const { store } = await fixture(t),
        capture = await store.begin(header()),
        open = physicalFS.promises.open.bind(physicalFS.promises);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve)),
        started = new Promise<void>((resolve) => (entered = resolve));
    const mock = t.mock.method(
        physicalFS.promises,
        'open',
        async (...args: Parameters<typeof open>) => {
            const handle = await open(...args);
            if (!String(args[0]).endsWith('raw.jsonl')) return handle;
            return new Proxy(handle, {
                get(target, key) {
                    if (key === 'sync')
                        return async () => {
                            entered();
                            await held;
                            await target.sync();
                        };
                    const value = Reflect.get(target, key);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
    );
    const append = store.append(capture.id, [frame()]);
    await started;
    let cleaned = false;
    const failing = store
        .fail(capture.id, 7, new CaptureStorageError('io', 'producer stopped'))
        .then(() => {
            cleaned = true;
        });
    await assert.rejects(store.begin(header()), /active capture/);
    await assert.rejects(store.delete(capture.id), /owns this record/);
    assert.equal(cleaned, false);
    release();
    await append;
    await failing;
    mock.mock.restore();
    const raw = JSON.parse(await text(streamCaptureJson(store, capture.id)));
    assert.equal(raw.captureComplete, false);
    assert.equal(raw.verifiedCommittedBytes, 7);
});

test('native seal sync failure stops completion after the committed prefix and preserves all raw bytes', async (t) => {
    const { store } = await fixture(t),
        writer = await CaptureWriter.begin(store, header());
    await writer.append(encode('synced prefix'), stamp, 'serial');
    await writer.flush();
    const open = physicalFS.promises.open.bind(physicalFS.promises),
        mock = t.mock.method(
            physicalFS.promises,
            'open',
            async (...args: Parameters<typeof open>) => {
                const handle = await open(...args);
                if (!String(args[0]).endsWith('raw.jsonl')) return handle;
                return new Proxy(handle, {
                    get(target, key) {
                        if (key === 'sync')
                            return async () => {
                                throw Object.assign(Error('seal sync disk full'), {
                                    code: 'ENOSPC',
                                });
                            };
                        const value = Reflect.get(target, key);
                        return typeof value === 'function' ? value.bind(target) : value;
                    },
                });
            },
        );
    await assert.rejects(writer.finish('exit'), /seal sync/);
    mock.mock.restore();
    const raw = JSON.parse(await text(streamCaptureJson(store, writer.id)));
    assert.equal(raw.captureComplete, false);
    assert.equal(raw.capture.failure.code, 'quota');
    assert.equal(raw.verifiedCommittedBytes, 13);
});

test('a still-full native store remains readable, exportable and explicitly deletable when recovery metadata cannot be saved', async (t) => {
    const { store, profile } = await fixture(t),
        writer = await CaptureWriter.begin(store, header());
    await writer.append(encode('keep raw'), stamp, 'serial');
    await writer.flush();
    const rename = physicalFS.promises.rename.bind(physicalFS.promises),
        mock = t.mock.method(
            physicalFS.promises,
            'rename',
            async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
                if (String(to).endsWith(path.sep + 'meta.json'))
                    throw Object.assign(Error('still full'), { code: 'ENOSPC' });
                return rename(from, to);
            },
        );
    await writer.abort(new CaptureStorageError('quota', 'still full'));
    await store.close();
    const reopened = await NativeCaptureStore.open(profile, { profileOwned: true });
    try {
        assert.equal(reopened.recoveryFailure?.code, 'quota');
        const row = (await reopened.page()).records[0];
        assert.equal(row.state, 'incomplete');
        assert.equal(row.finalizedAt, null);
        const raw = JSON.parse(await text(streamCaptureJson(reopened, writer.id)));
        assert.equal(raw.captureComplete, false);
        assert.equal(raw.capture.observedBytes, null);
        assert.equal(raw.verifiedCommittedBytes, 8);
        await reopened.delete(writer.id);
        assert.equal((await reopened.page()).records.length, 0);
    } finally {
        mock.mock.restore();
        await reopened.close();
    }
});

test('CSV keeps equal columns for empty output and preserves quoted/newline metadata and canonical raw bytes', async (t) => {
    const { store } = await fixture(t),
        capture = await store.begin({
            ...header(' \t\u0085=formula,"quoted"\nnext'),
            name: '@name|line',
        });
    await store.seal(capture.id, 0, 'empty output');
    const next = await CaptureWriter.begin(store, {
        ...header('line one\r\nline "two",done'),
        target: { endpoint: 'fixture | target', username: 'operator' },
        requestBase64: Buffer.from('line one\r\nline "two",done\r').toString('base64'),
        execution: { mode: 'serial-command', intent: 'script', timeoutMs: 1000 },
    });
    await next.append(new Uint8Array([0, 255, 34, 13, 10, 128]), stamp, 'serial');
    await next.finish('prompt-observed');
    const source = await text(streamCaptureReport(store, 'csv')),
        rows: string[][] = [];
    let row: string[] = [],
        field = '',
        quoted = false;
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (char === '"') {
            if (quoted && source[i + 1] === '"') {
                field += '"';
                i++;
            } else quoted = !quoted;
        } else if (!quoted && char === ',') {
            row.push(field);
            field = '';
        } else if (!quoted && (char === '\r' || char === '\n')) {
            if (char === '\r' && source[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else field += char;
    }
    assert.equal(quoted, false);
    assert.equal(rows.length, 3);
    for (const row of rows) assert.equal(row.length, rows[0].length);
    assert.equal(rows[1][rows[0].indexOf('command')], '\' \t\u0085=formula,"quoted"\nnext');
    assert.equal(rows[2][rows[0].indexOf('command')], 'line one\r\nline "two",done');
    assert.equal(rows[1][rows[0].indexOf('transformedFields')], 'name;command');
    const raw = rows[2][rows[0].indexOf('raw_base64_prefixed')];
    assert.deepEqual(
        Buffer.from(raw.slice('base64:'.length), 'base64'),
        Buffer.from([0, 255, 34, 13, 10, 128]),
    );
    const json = JSON.parse(await text(streamCaptureJson(store, next.id)));
    assert.equal(
        Buffer.from(json.capture.header.requestBase64, 'base64').toString(),
        'line one\r\nline "two",done\r',
    );
    assert.equal(json.capture.header.target.endpoint, 'fixture | target');
    assert.equal(json.capture.header.execution.intent, 'script');
    const enter = await CaptureWriter.begin(store, {
        ...header(''),
        requestBase64: 'DQ==',
        execution: { mode: 'serial-command', intent: 'send-enter', timeoutMs: 1000 },
    });
    await enter.finish('prompt-observed');
    const enterRaw = JSON.parse(await text(streamCaptureJson(store, enter.id)));
    assert.equal(enterRaw.capture.header.command, '');
    assert.equal(enterRaw.capture.header.requestBase64, 'DQ==');
    assert.equal(enterRaw.capture.header.execution.intent, 'send-enter');
});
