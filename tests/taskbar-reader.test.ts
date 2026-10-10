import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskbars } from '../electron/taskbar-reader';

test('native metadata rejects malformed, unbounded and invalid taskbar rectangles', () => {
    for (const line of [
        'invalid',
        'null',
        JSON.stringify({ bars: [null, {}, { edge: 'middle' }] }),
        ' '.repeat(16384),
    ])
        assert.deepEqual(parseTaskbars(line), []);
    const bounds = { x: -1920, y: 0, width: 40, height: 1080 };
    const bar = { edge: 'left', bounds, monitor: { x: -1920, y: 0, width: 1920, height: 1080 } };
    assert.deepEqual(parseTaskbars(JSON.stringify({ bars: [bar] })), [bar]);
    assert.deepEqual(
        parseTaskbars(JSON.stringify({ bars: [{ ...bar, bounds: { ...bounds, width: 0 } }] })),
        [],
    );
    assert.deepEqual(
        parseTaskbars(JSON.stringify({ bars: Array.from({ length: 33 }, () => bar) })),
        [],
    );
    assert.deepEqual(
        parseTaskbars(
            JSON.stringify({ bars: [{ ...bar, button: { x: 0, y: 0, width: -1, height: 32 } }] }),
        ),
        [bar],
    );
});
