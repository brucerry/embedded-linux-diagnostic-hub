import assert from 'node:assert/strict';
import test from 'node:test';
import { armPlan, validatePlan, type AutomationPlan } from '../shared/automation';
import { FlowRunner, type FlowBackend, type RunClock } from '../src/features/automation/runner';

const local = Date.UTC(2028, 1, 29, 12);
const connection = '1';
const refusal = /^Device clock start requires SSH; choose local time for Serial scheduling\.$/;

function plan(): AutomationPlan {
    return {
        transport: 'serial',
        steps: [{ id: 'one', name: 'One', enabled: true, command: 'fixture', delaySeconds: 0 }],
        timeoutSeconds: 10,
        repeatSeconds: null,
        start: {
            epochMs: local + 5000,
            clock: 'device',
            zone: 'UTC',
            calibration: {
                source: 'fixture verified sample',
                connection,
                deviceEpochMs: local,
                sampledLocalMs: local,
                sampledMonoMs: 0,
                uncertaintyMs: 100,
                zone: 'UTC',
            },
        },
        serial: { lineEnding: 'CR', prompt: '# ', timestampPrefix: '' },
    };
}

function rejectsUnchanged(p: AutomationPlan, check: () => unknown, expected: RegExp) {
    const before = structuredClone(p);
    assert.throws(check, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected);
        return true;
    });
    assert.deepEqual(p, before);
}

function acceptsUnchanged(p: AutomationPlan) {
    const before = structuredClone(p);
    const result = validatePlan(p);
    assert.deepEqual(result, before);
    assert.notEqual(result, p);
    assert.notEqual(result.steps, p.steps);
    if (p.start) assert.notEqual(result.start, p.start);
    armPlan(p, local, 0, connection);
    assert.deepEqual(p, before);
}

test('authoritative boundaries reject Serial device clocks with current calibration', () => {
    for (const withWallMetadata of [false, true]) {
        const p = plan();
        if (withWallMetadata) {
            p.start!.wallTime = '2028-02-29T12:00:05';
            p.start!.utcOffset = '+00:00';
        }
        rejectsUnchanged(p, () => validatePlan(p), refusal);
        rejectsUnchanged(p, () => armPlan(p, local, 0, connection), refusal);
    }
});

test('changing an otherwise valid SSH device schedule to Serial does not retain admission', () => {
    const p = plan();
    p.transport = 'ssh';
    acceptsUnchanged(p);
    p.transport = 'serial';
    rejectsUnchanged(p, () => validatePlan(p), refusal);
    rejectsUnchanged(p, () => armPlan(p, local, 0, connection), refusal);
});

test('Serial device-clock refusal does not depend on future lead or supplied calibration', () => {
    for (const lead of [2100, 5000, 10000, 30000]) {
        const p = plan();
        p.start!.epochMs = local + lead;
        rejectsUnchanged(p, () => armPlan(p, local, 0, connection), refusal);
    }
    const missing = plan();
    delete missing.start!.calibration;
    rejectsUnchanged(missing, () => validatePlan(missing), refusal);
});

test('local-clock Serial schedules retain exact future cutoff and immutable drafts', () => {
    const p = plan();
    p.start!.clock = 'local';
    delete p.start!.calibration;
    p.start!.epochMs = local + 2000;
    acceptsUnchanged(p);
    p.start!.epochMs = local + 1999;
    rejectsUnchanged(p, () => armPlan(p, local, 0, connection), /future/);
});

test('immediate Serial plans remain valid without device-clock metadata', () => {
    const p = plan();
    p.start = null;
    acceptsUnchanged(p);
});

test('SSH device schedules retain uncertainty lead, freshness and connection checks', () => {
    const p = plan();
    p.transport = 'ssh';
    p.start!.epochMs = local + 2100;
    acceptsUnchanged(p);
    p.start!.epochMs = local + 2099;
    rejectsUnchanged(p, () => armPlan(p, local, 0, connection), /future/);
    p.start!.epochMs = local + 60000;
    rejectsUnchanged(p, () => armPlan(p, local + 30001, 30001, connection), /stale/);
    rejectsUnchanged(p, () => armPlan(p, local, 0, 'replacement'), /connection changed/);
    delete p.start!.calibration;
    rejectsUnchanged(p, () => validatePlan(p), /Device clock calibration/);
});

test('local schedules still refuse supplied device calibration for either transport', () => {
    for (const transport of ['serial', 'ssh'] as const) {
        const p = plan();
        p.transport = transport;
        p.start!.clock = 'local';
        rejectsUnchanged(p, () => validatePlan(p), /not applicable/);
    }
});

test('FlowRunner refuses Serial device clocks before reading clocks or touching backend', () => {
    const calls: string[] = [];
    const forbidden = (name: string): never => {
        calls.push(name);
        throw Error('Forbidden admission-test side effect: ' + name);
    };
    const clock: RunClock = {
        local: () => {
            calls.push('local');
            return local;
        },
        mono: () => {
            calls.push('mono');
            return 0;
        },
        sleep: () => forbidden('sleep'),
        watch: () => forbidden('watch'),
    };
    const backend: FlowBackend = {
        connection: () => {
            calls.push('connection');
            return connection;
        },
        available: () => {
            calls.push('available');
            return true;
        },
        // If admission regresses, this synchronous sentinel prevents run()/timer/cleanup entry.
        acquire: () => forbidden('acquire'),
        execute: () => forbidden('execute'),
        target: { endpoint: 'inert fixture' },
    };
    const runner = new FlowRunner(
        () => forbidden('changed'),
        () => forbidden('recorded'),
        clock,
    );
    const p = plan();
    rejectsUnchanged(p, () => runner.start(p, backend), refusal);
    assert.deepEqual(calls, []);
    assert.equal(runner.busy, false);
    assert.equal(runner.cleanupPending, false);
});
