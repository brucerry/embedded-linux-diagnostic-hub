import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Client, ClientChannel } from 'ssh2';
import { captureCommand } from '../backend/ssh/automation';
import { validateCapture, type AutomationPlan, type AutomationRecord } from '../shared/automation';
import { FlowRunner, type RunClock } from '../src/features/automation/runner';
import { exportResults } from '../src/features/automation/exports';
type Outcome = 'signal' | 'unknown' | 'zero' | 'nonzero' | 'timeout';
function fakeClient(outcome: Outcome) {
    const stream = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        closed: 0,
        close() {
            this.closed++;
        },
    });
    const client = {
        exec(_command: string, callback: (error: null, channel: ClientChannel) => void) {
            callback(null, stream as unknown as ClientChannel);
            queueMicrotask(() => {
                stream.emit('data', Buffer.from('retained output'));
                if (outcome === 'signal') {
                    stream.emit('exit', null, 'TERM', false, 'terminated');
                    stream.emit('close', null, 'TERM');
                } else if (outcome === 'unknown') stream.emit('close', null);
                else if (outcome !== 'timeout') {
                    const code = outcome === 'zero' ? 0 : 7;
                    stream.emit('exit', code);
                    stream.emit('close', code);
                }
            });
        },
    } as unknown as Client;
    return { client, stream };
}
test('exit-signal preserves signal/core/message and unknown close has no invented status', async () => {
    for (const outcome of ['signal', 'unknown', 'zero', 'nonzero'] as const) {
        const fixture = fakeClient(outcome);
        const result = await captureCommand(
            fixture.client,
            'synthetic fixture',
            1000,
            new AbortController().signal,
        );
        assert.equal(result.stdout, 'retained output');
        assert.equal(
            result.completion,
            outcome === 'signal' ? 'signalled' : outcome === 'unknown' ? 'uncertain-close' : 'exit',
        );
        assert.equal(result.exitCode, outcome === 'zero' ? 0 : outcome === 'nonzero' ? 7 : null);
        if (outcome === 'signal')
            assert.deepEqual(result.termination, {
                signal: 'TERM',
                coreDumped: false,
                message: 'terminated',
                truncated: false,
            });
        else assert.equal(result.termination, undefined);
        assert.deepEqual(validateCapture(result), result);
    }
    assert.throws(
        () =>
            validateCapture({
                stdout: '',
                stderr: '',
                exitCode: null,
                completion: 'exit',
                truncated: false,
                chunks: [],
            }),
        /genuine exit/,
    );
});
test('timeout/cancel remain distinct and preserve partial capture without exit status', async () => {
    const fixture = fakeClient('timeout'),
        abort = new AbortController(),
        pending = captureCommand(fixture.client, 'synthetic cancel', 1000, abort.signal);
    await Promise.resolve();
    abort.abort();
    const cancelled = await pending;
    assert.equal(cancelled.completion, 'cancelled');
    assert.equal(cancelled.stdout, 'retained output');
    assert.equal(cancelled.exitCode, null);
    assert.equal(fixture.stream.closed, 1);
    const timeout = await captureCommand(
        fakeClient('timeout').client,
        'synthetic timeout',
        20,
        new AbortController().signal,
    );
    assert.equal(timeout.completion, 'timeout');
    assert.equal(timeout.exitCode, null);
    assert.equal(timeout.stdout, 'retained output');
});
const plan = (): AutomationPlan => ({
    transport: 'ssh',
    steps: [
        { id: 'first', name: 'First', enabled: true, command: 'first', delaySeconds: 0 },
        { id: 'next', name: 'Next', enabled: true, command: 'next', delaySeconds: 0 },
    ],
    timeoutSeconds: 1,
    repeatSeconds: 1,
    start: null,
    serial: { lineEnding: 'CR', prompt: '# ', timestampPrefix: '' },
});
test('signal, absent exit, timeout and cancellation halt later steps and repetition', async () => {
    for (const outcome of ['signal', 'unknown', 'timeout', 'cancel'] as const) {
        const commands: string[] = [],
            rows: AutomationRecord[] = [],
            states: string[] = [];
        let releases = 0;
        const clock: RunClock = {
            local: () => Date.UTC(2026, 0, 1),
            mono: () => 0,
            sleep: async () => {
                throw Error('must not repeat');
            },
        };
        let runner: FlowRunner;
        runner = new FlowRunner(
            (s) => states.push(s.state),
            (r) => rows.push(r),
            clock,
        );
        await runner.start(plan(), {
            connection: () => 'fixture',
            available: () => true,
            acquire: () => () => {
                releases++;
            },
            target: { endpoint: 'fixture' },
            async execute(step, _plan, signal) {
                commands.push(step.command);
                const fixture = fakeClient(outcome === 'cancel' ? 'timeout' : outcome);
                const pending = captureCommand(
                    fixture.client,
                    step.command,
                    outcome === 'timeout' ? 20 : 1000,
                    signal,
                );
                if (outcome === 'cancel') queueMicrotask(() => runner.cancel());
                return pending;
            },
        });
        assert.deepEqual(commands, ['first']);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].exitCode, null);
        assert.equal(states.at(-1), 'paused');
        assert.equal(releases, 1);
        assert.equal(
            rows[0].completion,
            outcome === 'signal'
                ? 'signalled'
                : outcome === 'unknown'
                  ? 'uncertain-close'
                  : outcome === 'cancel'
                    ? 'cancelled'
                    : 'timeout',
        );
    }
});
test('genuine ordinary nonzero exit retains deliberate continue-to-next-step policy', async () => {
    const p = plan();
    p.repeatSeconds = null;
    const commands: string[] = [],
        rows: AutomationRecord[] = [];
    const runner = new FlowRunner(
        () => {},
        (r) => rows.push(r),
    );
    await runner.start(p, {
        connection: () => 'fixture',
        available: () => true,
        acquire: () => () => {},
        target: { endpoint: 'fixture' },
        async execute(step, _plan, signal) {
            commands.push(step.command);
            return captureCommand(
                fakeClient(step.id === 'first' ? 'nonzero' : 'zero').client,
                step.command,
                1000,
                signal,
            );
        },
    });
    assert.deepEqual(commands, ['first', 'next']);
    assert.deepEqual(
        rows.map((r) => r.exitCode),
        [7, 0],
    );
    assert.ok(rows.every((r) => r.completion === 'exit'));
});
test('human exports escape C0/C1 controls in names, metadata and body while JSON stays exact', () => {
    const r: AutomationRecord = {
        id: 'row',
        runId: 'run',
        ordinal: 1,
        name: 'QA\x1b[2J\rspoof\nheading',
        command: 'cmd\x1b[0m',
        transport: 'ssh',
        target: { endpoint: 'peer\x1b]52;c;payload\x07' },
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:00:01Z',
        localZone: 'UTC\x9b0m',
        durationMs: 1000,
        deviceTime: {
            value: '2026-01-01T00:00:00Z',
            source: 'fixture\x9dtitle\x9c',
            zone: 'UTC',
            observedAt: '2026-01-01T00:00:00Z',
        },
        stdout: 'body\x1b[2J\rspoof\x9b0m\x85next',
        stderr: 'error\x7f',
        exitCode: null,
        completion: 'signalled',
        truncated: false,
        chunks: [],
        termination: {
            signal: 'TERM',
            coreDumped: true,
            message: 'terminated\x1b[2J\x9b0m',
            truncated: false,
        },
    };
    assert.deepEqual(JSON.parse(exportResults([r], 'json', 'selected', 0)).records[0], r);
    for (const format of ['text', 'markdown'] as const) {
        const output = exportResults([r], format, 'scope\x1b[2J', 0);
        assert.doesNotMatch(output, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
        assert.ok(output.includes('x1b'));
        assert.ok(output.includes('x0d'));
        assert.ok(output.includes('x9b'));
        assert.ok(output.includes('x9d'));
        assert.ok(output.includes('TERM'));
        assert.ok(output.includes('heading'));
    }
    const text = exportResults([r], 'text', 'selected', 0);
    assert.ok(text.includes('QA\\x1b[2J\\x0dspoof\\nheading'));
    assert.ok(text.includes('body\\x1b[2J\\x0dspoof\\x9b0m\\x85next'));
    const csv = exportResults([r], 'csv', 'selected', 0);
    assert.ok(csv.includes('terminationMessage'));
    assert.ok(csv.includes('TERM'));
});
