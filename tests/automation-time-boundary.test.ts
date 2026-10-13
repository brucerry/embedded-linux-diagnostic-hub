import assert from 'node:assert/strict';
import test from 'node:test';
import { armPlan, validatePlan, type AutomationPlan } from '../shared/automation';
import { resolveWallTime } from '../shared/automation-time';
const plan = (): AutomationPlan => ({
    transport: 'ssh',
    steps: [{ id: 'one', name: 'One', enabled: true, command: 'fixture', delaySeconds: 0 }],
    timeoutSeconds: 10,
    repeatSeconds: null,
    start: {
        epochMs: Date.UTC(2028, 1, 29, 12),
        clock: 'local',
        zone: 'UTC',
        wallTime: '2028-02-29T12:00:00',
        utcOffset: '+00:00',
    },
    serial: { lineEnding: 'CR', prompt: '# ', timestampPrefix: '' },
});
test('programmatic/persisted plans require real timezone and matching wall time/offset/instant', () => {
    const valid = plan();
    armPlan(valid, Date.UTC(2028, 1, 29, 11), 0, 'fixture');
    assert.deepEqual(validatePlan(JSON.parse(JSON.stringify(valid))), valid);
    for (const change of [
        { zone: 'Invalid/Zone' },
        { zone: '+01:00' },
        { zone: 'Asia/Taipei UTC+08:00' },
        { wallTime: '2027-02-29T12:00:00' },
        { wallTime: '2028-02-30T12:00:00' },
        { wallTime: '2028-02-29T24:00:00' },
        { utcOffset: '+25:00' },
        { utcOffset: 'Infinity' },
        { utcOffset: '+01:00' },
        { epochMs: Date.UTC(2028, 1, 29, 12) + 1000 },
    ]) {
        const draft = plan();
        Object.assign(draft.start!, change);
        assert.throws(() => armPlan(draft, Date.UTC(2028, 1, 29, 11), 0, 'fixture'));
        assert.deepEqual(draft.start, { ...valid.start, ...change });
    }
    const numeric = plan();
    delete numeric.start!.wallTime;
    numeric.start!.utcOffset = '+01:00';
    assert.throws(() => validatePlan(numeric), /offset/);
});
test('execution boundary rejects DST gaps/folds and resolves explicit repeated-time offset', () => {
    const p = plan();
    p.start = {
        epochMs: Date.UTC(2026, 2, 8, 7, 30),
        clock: 'local',
        zone: 'America/New_York',
        wallTime: '2026-03-08T02:30:00',
        utcOffset: '-05:00',
    };
    assert.throws(() => validatePlan(p), /does not exist/);
    p.start = {
        epochMs: Date.UTC(2026, 10, 1, 6, 30),
        clock: 'local',
        zone: 'America/New_York',
        wallTime: '2026-11-01T01:30:00',
    };
    assert.throws(() => validatePlan(p), /repeats/);
    p.start.utcOffset = '-05:00';
    assert.doesNotThrow(() => validatePlan(p));
    assert.equal(
        p.start.epochMs,
        resolveWallTime(p.start.wallTime!, 'America/New_York', '-05:00').epochMs,
    );
});
test('inactive supplied metadata cannot bypass past arming or hide malformed values', () => {
    const p = plan();
    p.start!.epochMs = Date.UTC(2028, 1, 29, 10);
    delete p.start!.wallTime;
    delete p.start!.utcOffset;
    (p.start as unknown as { calibration: unknown }).calibration = { uncertaintyMs: NaN };
    assert.throws(() => armPlan(p, Date.UTC(2028, 1, 29, 11), 0, 'fixture'), /not applicable/);
    const extras = plan();
    (extras as unknown as Record<string, unknown>).scheduledDate = '2028-02-30';
    assert.throws(() => validatePlan(extras), /metadata/);
    const inactiveSerial = plan();
    inactiveSerial.serial.prompt = 'bad\x1b';
    assert.throws(() => validatePlan(inactiveSerial), /Serial/);
    const unknownStart = plan();
    (unknownStart.start as unknown as Record<string, unknown>).date = '2027-02-29';
    assert.throws(() => validatePlan(unknownStart), /metadata/);
    const c = plan();
    c.start!.clock = 'device';
    c.start!.calibration = {
        source: 'SSH fixed sample',
        connection: 'fixture',
        deviceEpochMs: Date.UTC(2028, 1, 29, 11),
        sampledLocalMs: Date.UTC(2028, 1, 29, 11),
        sampledMonoMs: 0,
        uncertaintyMs: 1000,
        zone: 'UTC',
    };
    (c.start!.calibration as unknown as Record<string, unknown>).extra = Infinity;
    assert.throws(() => validatePlan(c), /calibration/);
});
