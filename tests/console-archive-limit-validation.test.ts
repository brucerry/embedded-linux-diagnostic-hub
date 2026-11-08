import test from 'node:test';
import assert from 'node:assert/strict';
import { consoleArchiveRequest } from '../shared/console-archive-rpc';
import { consoleArchiveBounds } from '../shared/console-storage';

test('archive list validates exactly the optional limit that it forwards to the store', () => {
    assert.throws(() => consoleArchiveRequest({ op: 'list', limit: null }));
    for (const value of [undefined, 1, 25, 50]) {
        const input = { op: 'list' as const, limit: value };
        const before = structuredClone(input),
            request = consoleArchiveRequest(input);
        assert.equal(request.op, 'list');
        if (request.op !== 'list') assert.fail('Expected a list request');
        assert.equal(request.limit, value);
        assert.deepEqual(consoleArchiveBounds(request.after, request.limit), {
            after: undefined,
            limit: value ?? 25,
        });
        assert.deepEqual(input, before);
    }
    for (const value of [false, true, '', '25', 0, -1, 1.5, 51, NaN, Infinity, {}, []])
        assert.throws(() => consoleArchiveRequest({ op: 'list', limit: value }));
});
