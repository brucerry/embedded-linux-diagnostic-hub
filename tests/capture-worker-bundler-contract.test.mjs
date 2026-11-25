import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleCaptureWorker } from '../scripts/lib/capture-worker-bundle.mjs';

const chunk = Object.freeze({
    type: 'chunk',
    isEntry: true,
    fileName: 'capture.iife.js',
    code: '(function () {})();',
    imports: [],
    dynamicImports: [],
});

const standalone = () => ({ errors: [], module: { hasModuleSyntax: false, dynamicImports: [] } });

test('capture build is isolated, in-memory, and configured for a single IIFE', async () => {
    const result = await bundleCaptureWorker(async (options) => {
        assert.equal(options.configFile, false);
        assert.equal(options.publicDir, false);
        assert.equal(options.build.write, false);
        assert.equal(options.build.target, 'es2022');
        assert.deepEqual(options.build.lib.formats, ['iife']);
        assert.equal(options.build.lib.entry, '/inert/capture.ts');
        assert.equal(options.build.rolldownOptions.output.codeSplitting, false);
        return [{ output: [chunk] }];
    }, '/inert/capture.ts', standalone);
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
            bundleCaptureWorker(async () => ({ output }), '/inert/capture.ts', standalone),
            /Capture build/,
        );
    }
});

test('inlined self-reference metadata is accepted only when parsed output has no imports', async () => {
    const build = async () => ({ output: [{ ...chunk, dynamicImports: [chunk.fileName] }] });
    assert.deepEqual(await bundleCaptureWorker(build, '/inert/capture.ts', standalone), Buffer.from(chunk.code));
    await assert.rejects(
        bundleCaptureWorker(build, '/inert/capture.ts', () => ({
            errors: [],
            module: { hasModuleSyntax: false, dynamicImports: [{}] },
        })),
        /runtime imports/,
    );
});
