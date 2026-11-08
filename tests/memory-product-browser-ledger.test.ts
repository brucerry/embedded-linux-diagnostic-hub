import assert from 'node:assert/strict';
import test from 'node:test';
import { installBrowserResourceLedger } from './fixtures/memory-product-browser-ledger';

test('non-browser installation fails explicitly instead of manufacturing empty owner counts', () => {
    assert.throws(() => installBrowserResourceLedger(), /unsupported.*browser realm/i);
});

test('missing WeakRef support is unsupported before any instrumentation is installed', () => {
    const realm = { document: {}, WeakRef: undefined } as unknown as typeof globalThis;
    assert.throws(() => installBrowserResourceLedger(realm), /WeakRef/);
    assert.deepEqual(Object.keys(realm).sort(), ['WeakRef', 'document']);
});
