import assert from 'node:assert/strict';
import test from 'node:test';
import { FlowRunner, type FlowState } from '../src/features/automation/runner';
import { serialCaptureBackend } from '../src/features/automation/capture/serial-backend';
import { SerialSession } from '../src/features/serial/session';
import type { AutomationPlan, AutomationRecord } from '../shared/automation';
import { automationOutcome, outcomeOf, type AutomationOutcome } from '../shared/automation-result';
import {
    CAPTURE_STORAGE, appendFrames, newCapture, sealedCapture,
    type CaptureFrame, type CaptureRepository, type StoredCapture,
} from '../shared/capture-store';
import { streamCaptureReport } from '../shared/capture-report';
import { DEFAULT_SERIAL_SETTINGS, type LocalSerialPort } from '../shared/serial';

async function until(check: () => boolean, label: string) {
    for (let turn = 0; turn < 256; turn++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.ok(check(), label + ' did not settle in 256 microtasks');
}

test('Serial raw export preserves beyond-preview device provenance, repeat identities and cancelled evidence', async (t) => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const prefix = 'TIMEé=', device = '2026-11-01T11:42:43.123+05:30';
    const timestamp = encode(prefix + device + '\r\nboard# ');
    const responses = [
        [encode('x'.repeat(CAPTURE_STORAGE.previewBytes + 3) + '\r\n'), timestamp.slice(0, 5), timestamp.slice(5)],
        [encode(prefix + device + 'invalid-suffix\r\nboard# ')],
        [encode(prefix + device + '\r\nboard# ')],
        [encode(prefix + device)], // Cancel is not a logical receive-line terminator.
    ];
    const captures = new Map<string, StoredCapture>(), frames = new Map<string, CaptureFrame[]>();
    const outcomes = new Map<string, AutomationOutcome>();
    const rows: AutomationRecord[] = [], states: FlowState[] = [], writes: Uint8Array[] = [];
    const received: { bytes: Uint8Array; at: string }[][] = responses.map(() => []);
    let sequence = 0, pins = 0, releases = 0, readers = 0, opens = 0, closes = 0, delivered = 0;
    let logicalMs = 1000, controller!: ReadableStreamDefaultController<Uint8Array>;
    const forbidden = async (): Promise<never> => { throw Error('Forbidden memory repository route'); };
    const repository: CaptureRepository = {
        async begin(header) {
            assert.equal(pins, 0); assert.ok(sequence < 4);
            const n = ++sequence, id = '00000000-0000-4000-8000-' + n.toString().padStart(12, '0');
            const capture = newCapture(id, n, header);
            captures.set(id, capture); frames.set(id, []);
            return structuredClone(capture);
        },
        async append(id, batch) {
            assert.equal(pins, 0);
            const current = captures.get(id)!;
            assert.ok(batch.length <= 4);
            const next = appendFrames(current, batch);
            frames.get(id)!.push(...structuredClone(batch)); captures.set(id, next);
            assert.ok(next.committedBytes < 10000);
            return structuredClone(next);
        },
        async seal(id, observed, reason) {
            const next = sealedCapture(captures.get(id)!, observed, reason);
            captures.set(id, next); return structuredClone(next);
        },
        async record(id, value) {
            assert.equal(pins, 0); assert.equal(captures.get(id)?.state, 'complete');
            assert.equal(outcomes.has(id), false);
            outcomes.set(id, automationOutcome(value));
        },
        async result(id) { return structuredClone(outcomes.get(id) ?? null); },
        async pin() {
            assert.equal(pins, 0); pins++;
            let released = false;
            return { through: sequence, async release() {
                assert.equal(released, false); assert.equal(readers, 0);
                released = true; pins--; releases++;
            } };
        },
        async page(after = 0, _limit, through = sequence) {
            assert.equal(pins, 1);
            return { records: structuredClone([...captures.values()].filter(c => c.sequence > after && c.sequence <= through)), next: null };
        },
        async *read(id) {
            assert.equal(pins, 1); readers++;
            try {
                yield { type: 'metadata' as const, capture: structuredClone(captures.get(id)!) };
                for (const frame of frames.get(id)!) yield { type: 'frame' as const, frame: structuredClone(frame) };
            } finally { readers--; }
        },
        fail: forbidden, delete: forbidden, close: forbidden,
    };
    const port: LocalSerialPort = {
        readable: null, writable: null, getInfo: () => ({}),
        async open() {
            opens++;
            this.readable = new ReadableStream({ start(c) { controller = c; } });
            this.writable = new WritableStream({ write(bytes) {
                assert.ok(writes.length < 4); writes.push(Uint8Array.from(bytes));
            } });
        },
        async close() {
            assert.equal(this.readable?.locked, false); assert.equal(this.writable?.locked, false);
            closes++; this.readable = null; this.writable = null;
        },
    };
    const session = new SerialSession(async () => { delivered++; });
    const runner = new FlowRunner(state => states.push(state), async row => {
        await repository.record!(row.stored!.id, outcomeOf(row)); rows.push(row);
        assert.ok(rows.length <= 4);
        if (rows.length === 2) runner.stop();
    }, {
        local: () => Date.UTC(2026, 10, 1) + logicalMs,
        mono: () => logicalMs,
        async sleep(ms, signal) {
            assert.equal(ms, 250); assert.equal(signal.aborted, false);
            logicalMs += ms; t.mock.timers.tick(ms);
        },
    });
    const plan = (extract = true, repeatSeconds: number | null = null): AutomationPlan => ({
        transport: 'serial', start: null, timeoutSeconds: 5, repeatSeconds, captureDeviceTime: extract,
        serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: prefix },
        steps: [{ id: 'same-step', name: 'Clock evidence', command: 'date', enabled: true, enterOnly: false, delaySeconds: 0 }],
    });
    const timerDescriptors = ['setTimeout', 'clearTimeout', 'Date'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)!] as const);
    const now = Object.getOwnPropertyDescriptor(performance, 'now');
    const oldNow = performance.now;
    let active: Promise<void> | undefined;
    let settled = false, failure: unknown;
    const start = (p: AutomationPlan) => {
        settled = false; failure = undefined;
        active = runner.start(p, serialCaptureBackend(session, repository));
        void active.then(() => { settled = true; }, error => { failure = error; settled = true; });
    };
    const join = async () => { await until(() => settled, 'flow settlement'); if (failure) throw failure; };
    const advance = async (ms: number) => {
        logicalMs += ms; t.mock.timers.tick(ms);
        for (let n = 0; n < 128; n++) await Promise.resolve();
    };
    const send = async (ordinal: number) => {
        await until(() => writes.length === ordinal, 'input write');
        for (const bytes of responses[ordinal - 1]) {
            const expected = delivered + 1;
            received[ordinal - 1].push({ bytes: bytes.slice(), at: new Date().toISOString() });
            controller.enqueue(bytes.slice());
            await until(() => delivered === expected, 'receive observation');
            for (let n = 0; n < 64; n++) await Promise.resolve();
        }
    };
    try {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 10, 1) + logicalMs });
        Object.defineProperty(performance, 'now', { value: () => logicalMs, configurable: true, writable: true });
        session.select(port, 'memory evidence UART'); await session.connect(DEFAULT_SERIAL_SETTINGS);
        const generation = session.current.generation;
        start(plan(true, 1));
        await send(1); await advance(200); await send(2); await advance(200); await join();
        assert.equal(rows.length, 2); assert.equal(states.at(-1)?.state, 'finished');
        assert.ok(rows[0].previewClipped); assert.equal(rows[0].stdout.includes(prefix), false);
        assert.deepEqual(rows[0].deviceTime, { value: device, source: 'Serial received literal prefix ' + prefix, zone: '+05:30', observedAt: received[0].at(-1)!.at });
        assert.equal(rows[1].deviceTime, null, 'A new execution cannot reuse an older valid prefix');
        start(plan(false)); await send(3); await advance(200); await join();
        assert.equal(rows[2].deviceTime, null, 'Disabled extraction leaves raw timestamp bytes intact');
        start(plan()); await send(4); runner.cancel(); await join();
        assert.equal(rows[3].completion, 'cancelled'); assert.equal(rows[3].deviceTime, null);
        assert.equal(states.at(-1)?.state, 'paused');
        assert.equal(new Set(rows.map(r => r.runId)).size, 4);
        assert.equal(new Set(rows.map(r => r.id)).size, 4);
        assert.equal(new Set(rows.map(r => r.stored!.id)).size, 4);
        assert.equal(session.current.generation, generation); assert.equal(session.current.state, 'connected');
        assert.equal(session.automationActive, false); assert.equal(runner.busy, false);
        assert.deepEqual(writes.map(bytes => new TextDecoder().decode(bytes)), ['date\r', 'date\r', 'date\r', 'date\r']);
        const before = structuredClone({ captures: [...captures], frames: [...frames], outcomes: [...outcomes] });
        const exported = async (scope = {}) => {
            let text = '', chunks = 0;
            for await (const bytes of streamCaptureReport(repository, 'json', scope)) {
                assert.ok(++chunks <= 64); text += new TextDecoder().decode(bytes); assert.ok(text.length < 65536);
            }
            return JSON.parse(text);
        };
        const report = await exported({ filter: { transport: 'serial' } });
        assert.equal(report.schemaVersion, 3); assert.equal(report.captures.length, 4);
        report.captures.forEach((capture: any, i: number) => {
            assert.equal(capture.capture.header.runId, rows[i].runId);
            assert.equal(capture.capture.header.stepId, 'same-step');
            assert.equal(capture.capture.header.receiveTimeSource, 'local-client');
            assert.deepEqual(capture.outcome, outcomeOf(rows[i]));
            assert.equal(capture.captureComplete, true);
            assert.deepEqual(capture.rawObservations.map((f: any) => ({ hex: Buffer.from(f.base64, 'base64').toString('hex'), receivedAt: f.receivedAt, observation: f.observation, stream: f.stream })), received[i].map((f, observation) => ({ hex: Buffer.from(f.bytes).toString('hex'), receivedAt: f.at, observation, stream: 'serial' })));
        });
        assert.equal(report.captures[3].outcome.completion, 'cancelled', 'Raw completeness is not command success');
        const repeated = await exported({ runId: rows[1].runId });
        assert.deepEqual(repeated.captures.map((c: any) => c.capture.id), [rows[1].stored!.id]);
        assert.deepEqual({ captures: [...captures], frames: [...frames], outcomes: [...outcomes] }, before);
        assert.deepEqual({ pins, releases, readers, opens, closes }, { pins: 0, releases: 2, readers: 0, opens: 1, closes: 0 });
    } finally {
        try {
            runner.cancel();
            if (active) await until(() => settled, 'owned flow unwind');
            let closed = false, closeError: unknown;
            void session.close(true).then(() => { closed = true; }, error => { closeError = error; closed = true; });
            await until(() => closed, 'memory port closure');
            if (closeError) throw closeError;
            assert.equal(closes, 1);
        } finally {
            if (now) Object.defineProperty(performance, 'now', now); else Reflect.deleteProperty(performance, 'now');
            t.mock.timers.reset();
            assert.equal(performance.now, oldNow);
            for (const [key, descriptor] of timerDescriptors) assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), descriptor);
        }
    }
});
