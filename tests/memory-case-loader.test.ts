import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadMemoryCases } from './fixtures/memory-case-loader';

test('a case outside the selected memory group refuses before loading its production imports', () => {
    assert.throws(
        () =>
            loadMemoryCases(
                new URL('./updater-cache-failure-memory.cases.ts', import.meta.url),
                'ssh',
            ),
        assert.AssertionError,
    );
});

test('a previously cached production importer refuses memory alias registration', () => {
    const load = createRequire(import.meta.url);
    const file = fileURLToPath(new URL('../backend/ssh/session.ts', import.meta.url));
    const previous = load.cache[file];
    const marker = load.cache[fileURLToPath(import.meta.url)];
    assert.ok(marker);
    assert.equal(previous, undefined);
    // A cache marker only; no production/SSH2 module is evaluated by this negative control.
    load.cache[file] = marker;
    try {
        assert.throws(
            () =>
                loadMemoryCases(
                    new URL('./desktop-connection-retirement.cases.ts', import.meta.url),
                    'ssh',
                ),
            /Scoped source was already loaded/,
        );
    } finally {
        if (previous) load.cache[file] = previous;
        else delete load.cache[file];
    }
});
