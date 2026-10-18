import assert from 'node:assert/strict';
import test from 'node:test';
import { draftIssues, type DraftFields } from '../src/features/automation/draft-validation';
const draft = (): DraftFields => ({
    transport: 'ssh',
    steps: [{ id: 'one', name: '', enabled: true, command: 'echo fixture', delaySeconds: 0 }],
    timeout: '60',
    repeat: false,
    repeatSeconds: '',
    scheduled: false,
    date: '',
    zone: 'UTC',
    offset: '',
    clockKind: 'local',
    ending: 'CR',
    prompt: '',
    prefix: '',
    local: Date.UTC(2026, 9, 14, 12),
    mono: 1000,
    connection: 'fixture',
});
const keys = (d: DraftFields) => draftIssues(d).map((i) => i.key);
test('optional blank names/prefix/inactive timing stay valid; missing required fields get actionable stable keys', () => {
    const d = draft();
    assert.deepEqual(draftIssues(d), []);
    d.transport = 'serial';
    assert.deepEqual(keys(d), ['prompt']);
    d.prompt = '# ';
    assert.deepEqual(keys(d), []);
    d.steps[0].command = '';
    d.timeout = '';
    d.repeat = true;
    d.repeatSeconds = 'Infinity';
    d.steps[0].delaySeconds = NaN;
    assert.deepEqual(new Set(keys(d)), new Set(['one.command', 'timeout', 'repeat', 'one.delay']));
    d.steps[0].name = 'x'.repeat(121);
    d.prefix = 'x'.repeat(129);
    assert.ok(keys(d).includes('one.name'));
    assert.ok(keys(d).includes('prefix'));
});
test('numeric UI guidance accepts small finite delays and matches magnitude/enablement rules', () => {
    const d = draft();
    d.steps[0].delaySeconds = 0.0000001;
    assert.deepEqual(keys(d), []);
    for (const value of [NaN, Infinity, -1, 86401]) {
        d.steps[0].delaySeconds = value;
        assert.ok(keys(d).includes('one.delay'));
    }
    d.steps[0].delaySeconds = 0;
    for (const text of ['', 'NaN', 'Infinity', '0', '301', '1e2']) {
        d.timeout = text;
        assert.ok(keys(d).includes('timeout'));
    }
    d.timeout = '1';
    d.steps[0].enabled = false;
    d.steps[0].command = '';
    assert.deepEqual(keys(d), ['one.enabled']);
    d.steps.push({ id: 'two', name: '', enabled: true, command: 'echo two', delaySeconds: 0 });
    assert.deepEqual(keys(d), []);
});
test('Enter-only, printable Serial metadata and command byte limits give correct field guidance', () => {
    const d = draft();
    d.transport = 'serial';
    d.prompt = '# ';
    d.steps[0].enterOnly = true;
    d.steps[0].command = '';
    assert.deepEqual(keys(d), []);
    d.ending = 'none';
    assert.deepEqual(keys(d), ['ending']);
    d.ending = 'CR';
    d.transport = 'ssh';
    assert.deepEqual(keys(d), ['one.command']);
    d.steps[0].enterOnly = false;
    d.steps[0].command = 'é'.repeat(4097);
    assert.ok(keys(d).includes('one.command'));
    d.steps[0].command = 'echo\0fixture';
    assert.match(draftIssues(d)[0].message, /NUL/);
    d.transport = 'serial';
    d.prompt = 'bad\n';
    d.prefix = 'bad\x1b';
    assert.ok(keys(d).includes('prompt'));
    assert.ok(keys(d).includes('prefix'));
});
test('schedule guidance identifies missing fields, invalid zones/calendars, DST occurrence and future bounds', () => {
    const d = draft();
    d.scheduled = true;
    assert.deepEqual(new Set(keys(d)), new Set(['date', 'time']));
    d.date = '2026-11-01T01:30:00';
    d.zone = 'America/New_York';
    assert.deepEqual(keys(d), ['offset']);
    d.offset = '-05:00';
    assert.deepEqual(keys(d), []);
    d.date = '2026-03-08T02:30:00';
    d.offset = '';
    assert.deepEqual(new Set(keys(d)), new Set(['date', 'time']));
    assert.match(draftIssues(d)[0].message, /does not exist/);
    d.date = '2025-02-29T12:00:00';
    d.zone = 'UTC';
    assert.match(draftIssues(d)[0].message, /valid calendar/);
    d.date = '2020-01-01T12:00:00';
    assert.match(draftIssues(d)[0].message, /future/);
    d.date = '2026-10-20T12:00:00';
    d.zone = 'Invalid/Zone';
    assert.deepEqual(keys(d), ['zone']);
});
test('device scheduling requires identified current SSH calibration, while Serial points to local clock', () => {
    const d = draft();
    d.scheduled = true;
    d.date = '2026-10-20T12:00:00';
    d.clockKind = 'device';
    assert.deepEqual(keys(d), ['clock']);
    d.calibration = {
        source: 'date',
        connection: 'fixture',
        deviceEpochMs: d.local,
        sampledLocalMs: d.local,
        sampledMonoMs: d.mono,
        uncertaintyMs: 100,
        zone: 'UTC',
    };
    assert.deepEqual(keys(d), []);
    d.connection = 'changed';
    assert.deepEqual(keys(d), ['clock']);
    d.connection = 'fixture';
    d.mono += 31000;
    assert.deepEqual(keys(d), ['clock']);
    d.transport = 'serial';
    d.prompt = '# ';
    assert.match(draftIssues(d).find((i) => i.key === 'clock')!.message, /local time/);
});

test('combined errors follow displayed controls within a stage, including timeout before step delays', () => {
    const d = draft();
    d.timeout = '301';
    d.repeat = true;
    d.repeatSeconds = '0';
    d.scheduled = true;
    d.date = '';
    d.zone = 'Invalid/Zone';
    d.clockKind = 'device';
    d.steps[0].delaySeconds = Infinity;
    assert.deepEqual(keys(d), ['timeout', 'repeat', 'date', 'time', 'zone', 'clock', 'one.delay']);
    d.scheduled = false;
    d.repeat = false;
    assert.deepEqual(keys(d), ['timeout', 'one.delay']);
    d.timeout = '60';
    d.steps[0].delaySeconds = 0;
    d.transport = 'serial';
    d.prompt = '';
    d.prefix = 'bad\x1b';
    d.ending = 'none';
    d.steps[0].command = '';
    d.steps[0].enterOnly = true;
    assert.deepEqual(keys(d), ['ending', 'prompt', 'prefix']);
});
