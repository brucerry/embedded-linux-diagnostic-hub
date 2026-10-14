import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutomationActivity } from '../electron/automation-activity';
import { wallTimeOptions, resolveWallTime } from '../shared/automation-time';
test('background lease fences ownership, suspend and update without making minimize an interruption', () => {
    const throttle: boolean[] = [],
        notices: string[] = [];
    let blocked = false;
    const activity = new AutomationActivity(
        (v) => throttle.push(v),
        (v) => notices.push(v),
        () => blocked,
    );
    const first = activity.acquire();
    assert.deepEqual(throttle, [false]);
    assert.throws(() => activity.acquire(), /already owns/);
    activity.release('stale');
    assert.deepEqual(throttle, [false]);
    activity.suspend();
    assert.equal(notices.length, 1);
    assert.match(notices[0], /slept/);
    assert.deepEqual(throttle, [false, true]);
    assert.throws(() => activity.acquire(), /sleep/);
    activity.resume();
    const second = activity.acquire();
    activity.release(first);
    assert.equal(throttle.at(-1), false);
    activity.release(second);
    assert.equal(throttle.at(-1), true);
    blocked = true;
    assert.throws(() => activity.acquire(), /update/);
    blocked = false;
    activity.acquire();
    activity.interrupt('Update started');
    assert.equal(notices.at(-1), 'Update started');
    activity.clear();
});
test('timezone options resolve date-specific offsets and expose sorted repeated occurrences', () => {
    assert.equal(resolveWallTime('2028-07-01T12:00:00', 'America/New_York').offset, '-04:00');
    assert.equal(resolveWallTime('2028-01-01T12:00:00', 'America/New_York').offset, '-05:00');
    assert.equal(resolveWallTime('2028-01-01T12:00:00', 'Asia/Kathmandu').offset, '+05:45');
    const repeated = wallTimeOptions('2028-11-05T01:30:00', 'America/New_York');
    assert.deepEqual(
        repeated.map((v) => v.offset),
        ['-04:00', '-05:00'],
    );
    assert.equal(repeated[1].epochMs - repeated[0].epochMs, 3600000);
    assert.throws(() => resolveWallTime('2028-11-05T01:30:00', 'America/New_York'), /repeats/);
    assert.throws(
        () => wallTimeOptions('2028-03-12T02:30:00', 'America/New_York'),
        /does not exist/,
    );
    assert.throws(() => wallTimeOptions('2027-02-29T12:00:00', 'UTC'), /calendar day/);
});
