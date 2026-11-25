import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleCaptureWorker } from '../scripts/lib/capture-worker-bundle.mjs';

const chunk = Object.freeze({
    type: 'chunk',
    isEntry: true,
    code: '(function () {})();',
    imports: [],
    dynamicImports: [],
});

test('capture build is isolated, in-memory, and configured for a single IIFE', async () => {
    const result = await bundleCaptureWorker(async (options) => {
        assert.equal(options.configFile, false);
        assert.equal(options.publicDir, false);
        assert.equal(options.build.write, false);
        assert.equal(options.build.target, 'es2022');
        assert.deepEqual(options.build.lib.formats, ['iife']);
        assert.equal(options.build.lib.entry, '/inert/capture.ts');
        assert.equal(options.build.rolldownOptions.output.inlineDynamicImports, true);
        return [{ output: [chunk] }];
    }, '/inert/capture.ts');
    assert.deepEqual(result, Buffer.from(chunk.code));
});

test('capture build rejects assets, extra chunks, and deferred or external imports', async () => {
    for (const output of [
        [],
        [{ type: 'asset' }],
        [chunk, chunk],
        [{ ...chunk, imports: ['external.js'] }],
        [{ ...chunk, dynamicImports: ['deferred.js'] }],
        [{ ...chunk, isEntry: false }],
    ]) {
        await assert.rejects(
            bundleCaptureWorker(async () => ({ output }), '/inert/capture.ts'),
            /Capture build/,
        );
    }
});
