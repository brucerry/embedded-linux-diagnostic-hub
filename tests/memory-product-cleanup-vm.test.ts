import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import {
    cleanupModelImports,
    loadCleanupFixture,
    transpileCleanupSource,
} from './fixtures/memory-product-cleanup-vm';

test('pure compilation preserves default/named imports, metadata and literal text while erasing types', () => {
    const source = `import value from 'default-port';
import { increment } from 'named-port';
import type { Unavailable } from 'type-only-port';
export const result: number = increment(value.amount);
export const directory = import.meta.dirname;
export const location = import.meta.url;
export const literal = 'import.meta.url';`;
    const output = transpileCleanupSource(source, 'file:///model/fixture.ts', '/model');
    const module = { exports: {} as any };
    vm.runInNewContext(output.code, {
        module,
        exports: module.exports,
        require: cleanupModelImports({
            'default-port': { amount: 4 },
            'named-port': { increment: (n: number) => n + 1 },
        }),
    });
    assert.equal(module.exports.result, 5);
    assert.equal(module.exports.directory, '/model');
    assert.equal(module.exports.location, 'file:///model/fixture.ts');
    assert.equal(module.exports.literal, 'import.meta.url');
    assert.deepEqual(output.replacements, { dirname: 1, url: 1 });
    assert.ok(!output.code.includes('type-only-port'));
});

test('malformed TypeScript refuses before module evaluation', () => {
    assert.throws(
        () => transpileCleanupSource('export const = ;', 'fixture.ts', '/model'),
        /Invalid cleanup fixture syntax/,
    );
});

test('closed imports refuse absent, inherited and accessor modules without fallback or getters', () => {
    let invoked = false;
    const ports = Object.create({ inherited: {} });
    ports.owned = Object.freeze({ value: 1 });
    Object.defineProperty(ports, 'accessor', {
        get() {
            invoked = true;
            return {};
        },
    });
    const require = cleanupModelImports(ports);
    assert.equal(require('owned'), ports.owned);
    for (const name of ['node:child_process', 'inherited', 'accessor', '__proto__'])
        assert.throws(() => require(name), /Unsupported cleanup model import/);
    assert.equal(invoked, false);
});

test('fixture selection and external roots refuse before any module can be evaluated', () => {
    for (const name of ['../memory-product-native-host.ts', '/outside.ts', 'other.ts'])
        assert.throws(() => loadCleanupFixture(name, {}), /Unsupported cleanup fixture/);
    const previous = process.env.HUB_CLEANUP_TEST_SOURCE;
    try {
        process.env.HUB_CLEANUP_TEST_SOURCE = '/unadmitted-fixtures';
        assert.throws(
            () => loadCleanupFixture('memory-product-browser-downloads.ts', {}),
            /External cleanup fixture roots/,
        );
    } finally {
        if (previous === undefined) delete process.env.HUB_CLEANUP_TEST_SOURCE;
        else process.env.HUB_CLEANUP_TEST_SOURCE = previous;
    }
    assert.throws(
        () => loadCleanupFixture('memory-product-browser-host.ts', {}),
        /Unsupported cleanup model import/,
    );
});

function journal() {
    let filesystemCalls = 0;
    const ports = {
        'node:assert/strict': assert,
        'node:fs/promises': {
            async lstat() {
                filesystemCalls++;
                throw Error('Forbidden journal filesystem observation');
            },
        },
        'node:path': path,
        'node:crypto': { createHash },
        '@playwright/test': {
            expect() {
                throw Error('Forbidden real SDK assertion');
            },
        },
    };
    return {
        ...loadCleanupFixture('memory-product-browser-downloads.ts', ports),
        filesystemCalls: () => filesystemCalls,
    };
}

test('the actual compiled download journal retains its event and ownership assertions without SDK execution', () => {
    const loaded = journal();
    const bytes = fs.readFileSync(
        new URL('./fixtures/memory-product-browser-downloads.ts', import.meta.url),
    );
    assert.equal(loaded.sourceSHA256, createHash('sha256').update(bytes).digest('hex'));
    const events = new loaded.api.BrowserDownloadEvents();
    const start = {
        guid: 'owned-download',
        frameId: 'owned-frame',
        suggestedFilename: 'report.json',
        url: 'http://fixture.invalid/report',
    };
    events.begin(start);
    assert.throws(() => events.consume(start.guid), /actual completed download/);
    events.progress({ guid: start.guid, state: 'completed', receivedBytes: 3, totalBytes: 3 });
    assert.equal(events.count(), 1);
    assert.equal(events.since(0).length, 1);
    assert.equal(events.since(0)[0].state, 'completed');
    events.consume(start.guid);
    assert.equal(events.snapshot().unconsumed.length, 0);
    assert.equal(events.snapshot().errors.length, 0);
    assert.equal(loaded.filesystemCalls(), 0);
});

test('an actual journal reader reaches only the explicit denied filesystem port', async () => {
    const loaded = journal();
    await assert.rejects(
        loaded.api.readCompletedBrowserDownload(
            '/model',
            {
                guid: 'owned-download',
                frameId: 'owned-frame',
                state: 'completed',
                suggestedFilename: 'report.json',
                receivedBytes: 3,
                totalBytes: 3,
            },
            'json',
            'owned-frame',
            16,
        ),
        /Forbidden journal filesystem observation/,
    );
    assert.equal(loaded.filesystemCalls(), 1);
});

test('CommonJS compilation preserves async rejection identity and injected AggregateError', async () => {
    const source = `export async function reject(error: unknown) { throw error; }
export function aggregate(error: unknown) { throw new AggregateError([error], 'owned failure'); }`;
    const output = transpileCleanupSource(source, 'fixture.ts', '/model');
    const module = { exports: {} as any };
    vm.runInNewContext(output.code, { module, exports: module.exports, AggregateError });
    const failure = Error('owned');
    await assert.rejects(module.exports.reject(failure), (error: unknown) => error === failure);
    assert.throws(() => module.exports.aggregate(failure), AggregateError);
});
