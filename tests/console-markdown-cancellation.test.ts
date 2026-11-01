import assert from 'node:assert/strict';
import test from 'node:test';
import nodeTimers from 'node:timers';
import promiseTimers from 'node:timers/promises';
import {
    CaptureExportBroker,
    type ExportClient,
    type ExportReportSource,
} from '../src/features/automation/capture/export-broker';
import { consoleExportSource } from '../src/features/automation/capture/console-export-source';
import {
    applyConsoleRecord,
    completeConsoleCursor,
    consoleHeader,
    newConsoleCursor,
    type ConsoleRecord,
    type ConsoleSegment,
} from '../shared/console-journal';
import { consoleSnapshot, type ConsoleArchive } from '../shared/console-storage';
import { bytesBase64, CAPTURE_STORAGE, CaptureStorageError, frameCrc } from '../shared/capture-store';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}
function observe<T>(promise: Promise<T>) {
    const state: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};
    void promise.then(
        (value) => { state.outcome = { ok: true, value }; },
        (error: unknown) => { state.outcome = { ok: false, error }; },
    );
    return state;
}
async function until(ready: () => boolean, label: string) {
    for (let turn = 0; turn < 512; turn++) {
        if (ready()) return;
        await Promise.resolve();
    }
    assert.ok(ready(), label + ' did not settle within512 logical microtask turns');
}
async function fulfilled<T>(pending: ReturnType<typeof observe<T>>, label: string): Promise<T> {
    await until(() => pending.outcome !== undefined, label);
    const result = pending.outcome!;
    if (!result.ok) throw result.error;
    return result.value;
}

/** A complete public-schema journal; only the second reader's close acknowledgement is held. */
function memoryArchive() {
    const at = '2026-10-30T00:00:00.000Z',
        encoder = new TextEncoder(),
        match = { role: 'shell-prompt' as const, literal: 'fixture#' },
        criterion = { role: 'shell-prompt' as const, literals: ['fixture#'] },
        header = consoleHeader({
            schema: 2, id: '00000000-0000-4000-8000-000000000065',
            flowId: 'memory-cancel-in-markdown', startedAt: at, receiveTimeSource: 'local-client',
            target: { endpoint: 'synthetic memory archive' }, ready: criterion,
        }),
        cursor = newConsoleCursor(), records: ConsoleRecord[] = [];
    const add = (value: Record<string, unknown>) =>
        records.push(applyConsoleRecord(cursor, { schema: 2, sequence: cursor.records, ...value }, header));
    const context = (phase: 'startup' | 'idle' | 'shutdown') => {
        const index = cursor.segments;
        add({ kind: 'segment-start', index, at, segment: { kind: 'context', phase } });
        return index;
    };
    const output = (index: number, text: string) => {
        const bytes = encoder.encode(text);
        add({ kind: 'observation', index, observation: cursor.observations, stream: 'pty',
            origin: 'channel', receivedAt: at, offset: 0, totalBytes: bytes.length,
            base64: bytesBase64(bytes), crc32: frameCrc(bytes) });
    };
    const startup = context('startup');
    output(startup, 'fixture#');
    add({ kind: 'segment-end', index: startup, at, reason: 'ready', match });
    const idle = context('idle'), index = cursor.segments;
    const segment: Extract<ConsoleSegment, { kind: 'command' }> = {
        kind: 'command', runId: 'memory-run', stepId: 'step-one', ordinal: 1, name: 'Bounded script',
        input: { intent: 'script', command: 'x'.repeat(8192) },
        requestBase64: bytesBase64(encoder.encode('x'.repeat(8192) + '\r')), criterion,
    };
    const preparedSequence = cursor.records;
    add({ kind: 'preparation', index, at, segment });
    add({ kind: 'segment-start', index, at, segment,
        inputSent: { preparation: preparedSequence, contextIndex: idle, disposition: 'write-dispatched' } });
    output(index, 'fixture#');
    add({ kind: 'segment-end', index, at, reason: 'prompt-observed', match });
    add({ kind: 'outcome', index, at, completion: 'prompt-observed', exitCode: null, match });
    const shutdown = context('shutdown');
    output(shutdown, 'bye');
    add({ kind: 'segment-end', index: shutdown, at, reason: 'closed', match: null });
    completeConsoleCursor(cursor);
    const meta = consoleSnapshot({ schema: 2, header, state: 'complete',
        offset: records.reduce((n, record) => n + encoder.encode(JSON.stringify(record) + '\n').length, 0),
        records: cursor.records, bytes: cursor.bytes, observations: cursor.observations, segments: cursor.segments,
        finalizedAt: at, reason: 'complete', observedBytes: cursor.bytes, failure: null, shellClosed: true });
    assert.equal(records.length, 12);
    assert.ok(meta.offset < 65536);
    const original = JSON.stringify({ meta, records }), close = gate();
    let acquired = 0, released = 0, pins = 0, reads = 0, closed = 0, activeReaders = 0;
    let closeRequested = false, markdownLastSequence = -1;
    const archive: ConsoleArchive = {
        async pin() {
            assert.ok(++acquired <= 3);
            pins++;
            let done = false;
            return { async release() {
                assert.equal(done, false, 'Each actual pin releases once');
                done = true; pins--; released++;
            } };
        },
        async list(after, limit = 25) {
            assert.equal(after, undefined); assert.equal(limit, 25); assert.ok(pins > 0);
            return { captures: [structuredClone(meta)], next: null, mode: 'scan' };
        },
        async *read(id) {
            assert.equal(id, header.id);
            const readNumber = ++reads;
            assert.ok(readNumber <= 2); activeReaders++;
            try {
                yield { kind: 'metadata', capture: structuredClone(meta) };
                for (const record of records) {
                    if (readNumber === 2) markdownLastSequence = record.sequence;
                    yield { kind: 'record', record: structuredClone(record) };
                }
            } finally {
                if (readNumber === 2) { closeRequested = true; await close.promise; }
                activeReaders--; closed++;
            }
        },
        async delete() { assert.fail('No storage deletion is allowed'); },
    };
    return { archive, meta, records, preparedSequence, releaseClose: close.release,
        state: () => ({ acquired, released, pins, reads, closed, activeReaders, closeRequested, markdownLastSequence }),
        assertUnchanged: () => assert.equal(JSON.stringify({ meta, records }), original) };
}

test('console Markdown cancellation retains both owners until the in-record reader close is acknowledged', async (t) => {
    const surfaces: [object, string][] = [
        [globalThis, 'setTimeout'], [globalThis, 'clearTimeout'],
        [nodeTimers, 'setTimeout'], [nodeTimers, 'clearTimeout'], [promiseTimers, 'setTimeout'],
    ];
    const before = surfaces.map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key));
    const f = memoryArchive(), failures: unknown[] = [], tracked = new Set<unknown>();
    const messages: { state?: string; cleanupPending?: boolean }[] = [];
    const scope = 'https://console-fixture.invalid/hub/', ttl = 1000;
    const clients = new Map<string, ExportClient>([['owner', { id: 'owner', url: scope, frameType: 'top-level' }]]);
    const legacy: ExportReportSource = {
        filename: 'automation-results',
        validateScope() { assert.fail('No legacy scope route'); },
        async pin() { assert.fail('No legacy storage route'); },
        async *streamReport() { assert.fail('No legacy encoder route'); },
    };
    let now = 0, timerScope = false;
    let mocked: (PropertyDescriptor | undefined)[] = [];
    let job: Awaited<ReturnType<CaptureExportBroker['prepare']>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let readerClosed: ReturnType<typeof observe<void>> | undefined;
    let done: ReturnType<typeof observe<void>> | undefined;
    let cancellation: ReturnType<typeof observe<Awaited<ReturnType<CaptureExportBroker['cancel']>>>> | undefined;
    const broker = new CaptureExportBroker(legacy, {
        scope, now: () => now,
        client: async (id) => clients.get(id), clients: async () => [...clients.values()],
        notify: async (id, message) => {
            assert.equal(id, 'owner');
            assert.ok(message && typeof message === 'object');
            messages.push(structuredClone(message) as { state?: string; cleanupPending?: boolean });
        },
    }, ttl, consoleExportSource(async () => f.archive));
    const cancelOnce = () => {
        assert.ok(job);
        cancellation ??= observe(broker.cancel(job.id, 'owner'));
        return cancellation;
    };
    try {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        timerScope = true;
        mocked = surfaces.slice(0, 2).map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key));
        assert.ok(mocked.every((descriptor) => descriptor?.configurable && typeof descriptor.value === 'function'));
        const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
        Object.defineProperty(globalThis, 'setTimeout', { ...mocked[0], value: (...args: Parameters<typeof setTimeout>) => {
            const handle: unknown = Reflect.apply(set, globalThis, args);
            tracked.add(handle); return handle;
        } });
        Object.defineProperty(globalThis, 'clearTimeout', { ...mocked[1], value: (handle: unknown) => {
            tracked.delete(handle); return Reflect.apply(clear, globalThis, [handle]);
        } });
        job = await fulfilled(observe(broker.prepare('owner', 'markdown', { ids: [f.meta.header.id] }, 'console')), 'prepare');
        await fulfilled(observe(broker.frame(job.nonce, 'frame')), 'frame admission');
        clients.set('frame', { id: 'frame', url: job.frameUrl, frameType: 'nested' });
        const claim = await fulfilled(observe(broker.claim(job.nonce, 'frame')), 'claim');
        const download = await fulfilled(observe(broker.download(new URL(claim.url).pathname.split('/').at(-1)!,
            { clientId: 'frame', mode: 'navigate', referrer: job.frameUrl })), 'verified download');
        assert.equal(download.filename, 'console-results.md');
        done = observe(download.done); reader = download.stream.getReader(); readerClosed = observe(reader.closed);
        const decoder = new TextDecoder();
        let prefix = '', selected = false;
        for (let pulls = 0; pulls < 128; pulls++) {
            const part: ReadableStreamReadResult<Uint8Array> = await fulfilled(observe(reader.read()), 'Markdown chunk');
            assert.equal(part.done, false);
            assert.ok(part.value && part.value.length <= CAPTURE_STORAGE.frameBytes);
            prefix += decoder.decode(part.value, { stream: true });
            assert.ok(prefix.length < 131072);
            if (prefix.includes('### 📝 Prepared input · 1 · Bounded script')) {
                assert.equal(part.value.length, CAPTURE_STORAGE.frameBytes, 'Cancel within a multi-chunk record');
                selected = true; break;
            }
        }
        assert.ok(selected, 'The real formatter reached the bounded Script record');
        const completeMarkers = [...prefix.matchAll(/Canonical record JSON base64: ([A-Za-z0-9+/=]+)\n/g)].map((m) => m[1]);
        assert.deepEqual(completeMarkers, f.records.slice(0, f.preparedSequence).map((record) =>
            bytesBase64(new TextEncoder().encode(JSON.stringify(record)))));
        const pendingCancel = cancelOnce();
        await until(() => f.state().closeRequested, 'reader close request');
        assert.equal(pendingCancel.outcome, undefined);
        assert.equal(done.outcome, undefined);
        assert.deepEqual(f.state(), { acquired: 3, released: 1, pins: 2, reads: 2, closed: 1,
            activeReaders: 1, closeRequested: true, markdownLastSequence: f.preparedSequence });
        const held = await fulfilled(observe(broker.status(job.id, 'owner')), 'held status');
        assert.equal(held.state, 'closing');
        assert.equal(held.retirement, 'pending');
        assert.ok('cleanupPending' in held && held.cleanupPending === true);
        f.releaseClose();
        await fulfilled(pendingCancel, 'cancel acknowledgement');
        await fulfilled(done, 'download completion acknowledgement');
        const final = await fulfilled(observe(broker.status(job.id, 'owner')), 'final status');
        assert.equal(final.state, 'failed');
        assert.equal(final.retirement, 'acknowledged');
        assert.equal('cleanupPending' in final, false);
        assert.deepEqual(f.state(), { acquired: 3, released: 3, pins: 0, reads: 2, closed: 2,
            activeReaders: 0, closeRequested: true, markdownLastSequence: f.preparedSequence });
        assert.ok(messages.length > 0 && messages.every((message) => message.state !== 'stream-sent'));
        assert.equal(tracked.size, 0, 'Watchdog cleared before timer reset');
        now += 2000;
        const notices = messages.length;
        t.mock.timers.tick(2000);
        assert.equal(messages.length, notices);
        f.assertUnchanged();
        t.diagnostic('pins acquired=3 released=3; readers opened=2 closed=2; cancel/done waited for close; watchdogs cleared');
    } catch (error) { failures.push(error); }
    finally {
        f.releaseClose();
        try {
            if (job) await fulfilled(cancelOnce(), 'final original cancellation');
            if (done) await fulfilled(done, 'final original download');
            if (reader) {
                // A pre-cancel queued chunk may remain; no new record may be accepted afterward.
                let ended = false;
                for (let pulls = 0; pulls < 4 && !ended; pulls++) {
                    try { ended = (await fulfilled(observe(reader.read()), 'cancelled stream chunk')).done === true; }
                    catch (error) {
                        assert.ok(error instanceof CaptureStorageError && error.code === 'io' && /cancelled/i.test(error.message));
                        ended = true;
                    }
                }
                assert.ok(ended, 'Cancelled in-memory stream reaches an error/EOF');
                assert.ok(readerClosed);
                await until(() => readerClosed!.outcome !== undefined, 'stream reader closure');
                reader.releaseLock();
            }
        } catch (error) { failures.push(error); }
        if (timerScope) {
            for (let i = 0; i < 2; i++) {
                try { if (mocked[i]) Object.defineProperty(surfaces[i][0], surfaces[i][1], mocked[i]!); }
                catch (error) { failures.push(error); }
            }
        }
        try { t.mock.timers.reset(); }
        catch (error) { failures.push(error); }
        try {
            assert.deepEqual(surfaces.map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key)), before);
        } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Memory cancellation and restoration failures', { cause: failures[0] });
    t.diagnostic('restored exact5global/node timers descriptors; no real watchdog or external resource used');
});
