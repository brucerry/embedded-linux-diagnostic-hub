import assert from 'node:assert/strict';
import test from 'node:test';
import {
    armPlan,
    calibratedNow,
    serialPayload,
    validatePlan,
    type AutomationPlan,
    type AutomationRecord,
} from '../shared/automation';
import { resolveWallTime, strictIsoInstant } from '../shared/automation-time';
import {
    FlowRunner,
    ResultStore,
    type FlowBackend,
    type RunClock,
} from '../src/features/automation/runner';
import { exportResults } from '../src/features/automation/exports';
import { VisibleTail, observedDeviceTime } from '../src/features/automation/serial-completion';
const plan = (): AutomationPlan => ({
    transport: 'ssh',
    steps: [
        {
            id: 'a',
            name: 'First',
            enabled: true,
            command: 'echo first\necho second',
            delaySeconds: 0,
        },
    ],
    timeoutSeconds: 10,
    repeatSeconds: null,
    start: null,
    serial: { lineEnding: 'CR', prompt: 'target# ', timestampPrefix: '' },
});
test('calendar validation rejects normalization, DST gaps/folds and offset conflicts', () => {
    for (const text of [
        '2025-02-29T12:00:00',
        '2026-04-31T12:00:00',
        '2026-13-01T12:00:00',
        '2026-01-01T24:00:00',
        '2026-01-01T12:60:00',
        '2026-01-01T12:00:60',
        '2026-01-01',
        '2026-01-01T-1:00:00',
    ])
        assert.throws(() => resolveWallTime(text, 'UTC'));
    assert.equal(resolveWallTime('2028-02-29T12:00:00', 'UTC').epochMs, Date.UTC(2028, 1, 29, 12));
    assert.throws(
        () => resolveWallTime('2026-03-08T02:30:00', 'America/New_York'),
        /does not exist/,
    );
    assert.throws(() => resolveWallTime('2026-11-01T01:30:00', 'America/New_York'), /repeats/);
    const early = resolveWallTime('2026-11-01T01:30:00', 'America/New_York', '-04:00'),
        late = resolveWallTime('2026-11-01T01:30:00', 'America/New_York', '-05:00');
    assert.equal(late.epochMs - early.epochMs, 3600000);
    assert.throws(() => resolveWallTime('2026-11-01T01:30:00', 'America/New_York', '-06:00'));
    assert.throws(() => resolveWallTime('2026-01-01T12:00:00', 'Invalid/Zone'));
    assert.throws(() => strictIsoInstant('2026-02-30T12:00:00Z'));
    assert.throws(() => strictIsoInstant('2026-01-01T12:00:00+14:30'));
    assert.equal(
        strictIsoInstant('2026-01-01T12:00:00.1+01:30'),
        Date.UTC(2026, 0, 1, 10, 30, 0, 100),
    );
});
test('execution boundary rejects invalid magnitudes, malformed plans and race-past starts', () => {
    for (const number of [NaN, Infinity, -1, 86401]) {
        const p = plan();
        p.repeatSeconds = number;
        assert.throws(() => validatePlan(p));
    }
    const p = plan();
    p.steps[0].delaySeconds = Infinity;
    assert.throws(() => validatePlan(p));
    p.steps[0].delaySeconds = 0;
    p.steps[0].enabled = false;
    assert.throws(() => validatePlan(p));
    p.steps[0].enabled = true;
    const local = Date.UTC(2026, 0, 1);
    p.start = { epochMs: local + 2000, clock: 'local', zone: 'UTC' };
    armPlan(p, local, 0, 'connection');
    assert.throws(() => armPlan(p, local + 1, 1, 'connection'), /future/);
    p.start.epochMs = local - 100;
    assert.throws(() => armPlan(p, local, 0, 'connection'));
    p.start.epochMs = NaN;
    assert.throws(() => validatePlan(p));
});
test('device calibration uses actual source and fails stale, jumped or replaced clocks', () => {
    const c = {
        source: 'fixture verified device sample',
        connection: 'one',
        deviceEpochMs: 100000,
        sampledLocalMs: 200000,
        sampledMonoMs: 1000,
        uncertaintyMs: 100,
        zone: 'UTC',
    };
    assert.equal(calibratedNow(c, 200500, 1500, 'one'), 100500);
    assert.throws(() => calibratedNow(c, 230001, 31001, 'one'), /stale/);
    assert.throws(() => calibratedNow(c, 210000, 1500, 'one'), /jumped/);
    assert.throws(() => calibratedNow(c, 200500, 1500, 'two'), /changed/);
    assert.throws(() => calibratedNow({ ...c, uncertaintyMs: Infinity }, 200000, 1000, 'one'));
    const p = plan();
    p.start = { epochMs: 104000, clock: 'device', zone: 'UTC', calibration: c };
    armPlan(p, 200000, 1000, 'one');
    assert.throws(() => armPlan(p, 201950, 2950, 'one'), /future/);
});
function fakeClock() {
    let local = Date.UTC(2026, 0, 1),
        mono = 0;
    const sleeps: number[] = [];
    const clock: RunClock = {
        local: () => local,
        mono: () => mono,
        async sleep(ms, signal) {
            if (signal.aborted) throw Error('Cancelled.');
            sleeps.push(ms);
            local += ms;
            mono += ms;
            await Promise.resolve();
        },
    };
    return {
        clock,
        sleeps,
        jump(ms: number) {
            local += ms;
        },
        advance(ms: number) {
            local += ms;
            mono += ms;
        },
    };
}
test('flow preserves multiline snapshot, disabled steps, elapsed delays and no-overlap repetition', async () => {
    const f = fakeClock(),
        p = plan(),
        calls: string[] = [],
        rows: AutomationRecord[] = [];
    let active = 0,
        max = 0,
        runs = 0,
        releases = 0;
    p.steps.push(
        { id: 'disabled', name: 'Disabled', enabled: false, command: 'never', delaySeconds: 0 },
        { id: 'last', name: 'Last', enabled: true, command: 'last', delaySeconds: 1 },
    );
    p.repeatSeconds = 2;
    const runner = new FlowRunner(
            () => {},
            (r) => rows.push(r),
            f.clock,
        ),
        backend: FlowBackend = {
            connection: () => 'one',
            available: () => true,
            acquire: () => () => {
                releases++;
            },
            target: { endpoint: 'fixture' },
            async execute(s) {
                active++;
                max = Math.max(max, active);
                calls.push(s.command);
                await Promise.resolve();
                f.advance(500);
                active--;
                if (s.id === 'last' && ++runs === 2) runner.stop();
                return {
                    stdout: s.command,
                    stderr: '',
                    exitCode: 0,
                    completion: 'exit',
                    truncated: false,
                    chunks: [],
                };
            },
        };
    const task = runner.start(p, backend);
    p.steps[0].command = 'edited';
    await task;
    assert.deepEqual(calls, ['echo first\necho second', 'last', 'echo first\necho second', 'last']);
    assert.equal(max, 1);
    assert.equal(rows.length, 4);
    assert.equal(releases, 1);
    assert.equal(
        f.sleeps.reduce((a, b) => a + b, 0),
        4000,
    );
});
test('waiting schedule cancellation, clock jumps and replacement pause without executing', async () => {
    for (const failure of ['cancel', 'jump', 'replace']) {
        const f = fakeClock(),
            p = plan(),
            messages: string[] = [],
            calls: string[] = [];
        p.start = { epochMs: f.clock.local() + 5000, clock: 'local', zone: 'UTC' };
        let connection = 'one',
            once = false;
        const original = f.clock.sleep;
        let runner: FlowRunner;
        f.clock.sleep = async (ms, signal) => {
            await original(ms, signal);
            if (!once) {
                once = true;
                if (failure === 'cancel') runner.cancel();
                else if (failure === 'jump') f.jump(2000);
                else connection = 'two';
            }
        };
        runner = new FlowRunner(
            (s) => messages.push(s.message),
            () => {},
            f.clock,
        );
        await runner.start(p, {
            connection: () => connection,
            available: () => true,
            acquire: () => () => {},
            target: { endpoint: 'fixture' },
            async execute(s) {
                calls.push(s.command);
                return {
                    stdout: '',
                    stderr: '',
                    exitCode: 0,
                    completion: 'exit',
                    truncated: false,
                    chunks: [],
                };
            },
        });
        assert.equal(calls.length, 0);
        assert.match(messages.at(-1)!, /cancelled|changed|paused/i);
    }
});
test('Serial literal completion spans ANSI chunks and keeps exact payload/time provenance', () => {
    const tail = new VisibleTail();
    tail.append('noise\x1b[');
    tail.append('32mHELLO\x1b]52;clipboard');
    tail.append('\x07\ncon');
    tail.append('sole# ');
    assert.ok(tail.value.endsWith('console# '));
    assert.equal(tail.value.includes('clipboard'), false);
    assert.equal(Buffer.from(serialPayload('a\nb', 'CRLF')).toString(), 'a\nb\r\n');
    assert.equal(observedDeviceTime('TIME=2026-02-30T00:00:00Z', 'TIME=', 'receipt'), null);
    assert.equal(
        observedDeviceTime('TIME=2026-01-01T00:00:00+01:00', 'TIME=', 'receipt')?.zone,
        '+01:00',
    );
});
const row = (): AutomationRecord => ({
    id: 'one',
    runId: 'run',
    ordinal: 1,
    name: '<img> `name`',
    command: '=formula\n`\n`````',
    transport: 'serial',
    target: { endpoint: 'fixture' },
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
    localZone: 'UTC',
    durationMs: 1000,
    deviceTime: null,
    stdout: ' @SUM(1,2)\n"quoted",\0\x1b',
    stderr: '',
    exitCode: null,
    completion: 'prompt-observed',
    truncated: false,
    chunks: [{ stream: 'serial', base64: 'AA==', receivedAt: '2026-01-01T00:00:01Z' }],
});
test('QA formats preserve exact JSON, quote/protect CSV, fence hostile Markdown and mark retention', () => {
    const r = row(),
        json = JSON.parse(exportResults([r], 'json', 'selected', 4));
    assert.deepEqual(json.records[0], r);
    assert.equal(json.previouslyEvicted, 4);
    const csv = exportResults([r], 'csv', 'filtered', 4);
    assert.ok(csv.includes(`"'=formula`));
    assert.ok(csv.includes(`"' @SUM`));
    assert.ok(csv.includes('""quoted""'));
    assert.ok(csv.includes('command;stdout'));
    const md = exportResults([r], 'markdown', 'all-retained', 4);
    assert.ok(md.includes('\\x00'));
    assert.ok(md.includes('``````text'));
    assert.ok(md.includes('&lt;img&gt;'));
    assert.equal(md.includes('\0'), false);
    const txt = exportResults([r], 'text', 'selected', 4);
    assert.ok(txt.includes('Exit: unavailable'));
    assert.ok(txt.includes('previously evicted: 4'));
    const store = new ResultStore();
    for (let i = 0; i < 205; i++) store.add({ ...r, id: String(i) });
    assert.equal(store.records.length, 200);
    assert.equal(store.evicted, 5);
});

test('bounded transport responses reject malformed raw bytes and drop unrelated metadata', async () => {
    const { validateCapture } = await import('../shared/automation');
    const valid = {
        stdout: 'safe',
        stderr: '',
        exitCode: 0,
        completion: 'exit' as const,
        truncated: false,
        chunks: [
            {
                stream: 'stdout' as const,
                base64: 'c2FmZQ==',
                receivedAt: '2026-01-01T00:00:00.000Z',
            },
        ],
    };
    assert.deepEqual(validateCapture({ ...valid, password: 'never-retain' }), valid);
    assert.throws(() =>
        validateCapture({ ...valid, chunks: [{ ...valid.chunks[0], base64: '!!!' }] }),
    );
    assert.throws(() =>
        validateCapture({
            ...valid,
            chunks: [{ ...valid.chunks[0], receivedAt: '2026-02-30T00:00:00.000Z' }],
        }),
    );
    assert.throws(() => validateCapture({ ...valid, stdout: 'x'.repeat(196609) }));
    const exported = JSON.parse(
        exportResults(
            [
                {
                    ...row(),
                    target: { endpoint: 'fixture', password: 'not-exported' },
                } as AutomationRecord,
            ],
            'json',
            'all-retained',
            0,
        ),
    );
    assert.equal(exported.records[0].target.password, undefined);
    const invalid = plan();
    (invalid as unknown as { start: boolean }).start = false;
    assert.throws(() => validatePlan(invalid), /Start/);
    assert.throws(() => armPlan(plan(), NaN, 0, 'one'), /clock/);
});
test('optional local/device starts execute only at resolved due time; device source refresh cannot hide jumps', async () => {
    const f = fakeClock(),
        p = plan(),
        times: number[] = [];
    p.start = { epochMs: f.clock.local() + 4000, clock: 'local', zone: 'UTC' };
    const runner = new FlowRunner(
        () => {},
        () => {},
        f.clock,
    );
    await runner.start(p, {
        connection: () => 'one',
        available: () => true,
        acquire: () => () => {},
        target: { endpoint: 'fixture' },
        async execute() {
            times.push(f.clock.local());
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
                completion: 'exit',
                truncated: false,
                chunks: [],
            };
        },
    });
    assert.deepEqual(times, [p.start.epochMs]);
    const g = fakeClock(),
        d = plan(),
        messages: string[] = [],
        c = {
            source: 'fixture actual device sample',
            connection: 'one',
            deviceEpochMs: g.clock.local(),
            sampledLocalMs: g.clock.local(),
            sampledMonoMs: 0,
            uncertaintyMs: 100,
            zone: 'UTC',
        };
    d.start = { epochMs: g.clock.local() + 20000, clock: 'device', zone: 'UTC', calibration: c };
    let sent = 0;
    const flow = new FlowRunner(
        (s) => messages.push(s.message),
        () => {},
        g.clock,
    );
    await flow.start(d, {
        connection: () => 'one',
        available: () => true,
        acquire: () => () => {},
        target: { endpoint: 'fixture' },
        sampleClock: async () => ({
            ...c,
            deviceEpochMs: g.clock.local() + 5000,
            sampledLocalMs: g.clock.local(),
            sampledMonoMs: g.clock.mono(),
        }),
        async execute() {
            sent++;
            throw Error('must not run');
        },
    });
    assert.equal(sent, 0);
    assert.match(messages.at(-1)!, /Device clock changed/);
});

test('active-command heartbeat detects suspension and cancels later steps while retaining capture', async () => {
    const f = fakeClock(),
        p = plan(),
        messages: string[] = [],
        rows: AutomationRecord[] = [];
    p.steps.push({ ...p.steps[0], id: 'next', command: 'must never send' });
    let watch: (() => void) | undefined,
        executions = 0,
        releases = 0;
    f.clock.watch = (callback) => {
        watch = callback;
        return () => {
            watch = undefined;
        };
    };
    const runner = new FlowRunner(
        (s) => messages.push(s.message),
        (r) => rows.push(r),
        f.clock,
    );
    await runner.start(p, {
        connection: () => 'one',
        available: () => true,
        acquire: () => () => {
            releases++;
        },
        target: { endpoint: 'fixture' },
        async execute(_s, _p, signal) {
            executions++;
            f.advance(5000);
            watch?.();
            assert.ok(signal.aborted);
            return {
                stdout: 'partial capture',
                stderr: '',
                exitCode: null,
                completion: 'cancelled',
                truncated: false,
                chunks: [],
            };
        },
    });
    assert.equal(executions, 1);
    assert.equal(rows[0].stdout, 'partial capture');
    assert.equal(releases, 1);
    assert.match(messages.at(-1)!, /timer stalled/);
    assert.equal(watch, undefined);
});
