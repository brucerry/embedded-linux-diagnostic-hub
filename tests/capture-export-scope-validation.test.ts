import test from 'node:test';
import assert from 'node:assert/strict';
import { captureRpcRequest } from '../shared/capture-rpc';
import { captureScope } from '../shared/capture-query';

test('capture export validates the same optional scope that reaches report generation', () => {
    assert.throws(() => captureRpcRequest({ op: 'export', format: 'json', scope: null }));
    for (const format of ['json', 'csv', 'markdown', 'text']) {
        const omitted = { op: 'export', format };
        assert.equal(captureRpcRequest(omitted), omitted);
        assert.deepEqual(captureScope(captureRpcRequest(omitted).scope), {});
        for (const scope of [
            undefined,
            {},
            { filter: {} },
            { filter: { query: '' } },
            { ids: [] },
        ]) {
            const input = { op: 'export', format, scope },
                before = structuredClone(input);
            const forwarded = captureRpcRequest(input);
            assert.equal(forwarded, input);
            assert.equal(forwarded.scope, scope);
            assert.doesNotThrow(() => captureScope(forwarded.scope));
            assert.deepEqual(input, before);
        }
    }
});
