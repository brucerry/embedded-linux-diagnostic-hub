import assert from 'node:assert/strict';
import test from 'node:test';
import { armPlan, type AutomationPlan } from '../shared/automation';
import { resolveWallTime } from '../shared/automation-time';
import { draftIssues, type DraftFields } from '../src/features/automation/draft-validation';
import { SCHEDULE_FIELDS as data } from './ui/fixtures/schedule-fields-data';

test('schedule UI corpus maps explicit fold occurrences to literal UTC and keeps Serial clock guidance distinct', () => {
    const base: DraftFields = {
        transport: 'serial', steps: [{ id: 'fixture', name: '', enabled: true, command: data.command, delaySeconds: 0 }],
        timeout: '60', repeat: false, repeatSeconds: '10', scheduled: true,
        date: '', zone: data.zone, offset: '', clockKind: 'local', ending: 'CR',
        prompt: '# ', prefix: '', local: Date.parse(data.anchor), mono: 0, connection: 'fixture',
    };
    assert.deepEqual(draftIssues(base).map(row => [row.key, row.stage]), [['date', 2], ['time', 2]]);
    const gap = data.gap.date + 'T' + data.gap.time;
    assert.throws(() => resolveWallTime(gap, data.zone), /does not exist/);
    assert.deepEqual(draftIssues({ ...base, date: gap }).map(row => row.key), ['date', 'time']);
    const fold = data.fold.date + 'T' + data.fold.time;
    assert.throws(() => resolveWallTime(fold, data.zone), /repeats/);
    assert.deepEqual(draftIssues({ ...base, date: fold }).map(row => row.key), ['offset']);
    for (const expected of [data.earlier, data.later]) {
        const resolved = resolveWallTime(fold, data.zone, expected.offset);
        assert.equal(new Date(resolved.epochMs).toISOString(), expected.utc);
        assert.deepEqual(resolved.alternatives, [data.earlier.offset, data.later.offset]);
        assert.deepEqual(draftIssues({ ...base, date: fold, offset: expected.offset }), []);
        const plan: AutomationPlan = {
            transport: 'serial', steps: base.steps, timeoutSeconds: 60, repeatSeconds: null,
            serial: { lineEnding: 'CR', prompt: base.prompt, timestampPrefix: '' },
            start: { epochMs: resolved.epochMs, clock: 'local', zone: data.zone, wallTime: fold, utcOffset: expected.offset },
        };
        assert.doesNotThrow(() => armPlan(plan, base.local, 0, 'fixture'), 'Pure admission validation only; no runner is created.');
    }
    const deviceIssues = draftIssues({ ...base, date: fold, offset: data.later.offset, clockKind: 'device' });
    assert.deepEqual(deviceIssues, [{ key: 'clock', stage: 2, message: 'Choose local time for Serial scheduling.' }]);
    assert.equal(deviceIssues[0].message.includes('verified'), false, 'Serial guidance differs from missing SSH calibration.');
});
