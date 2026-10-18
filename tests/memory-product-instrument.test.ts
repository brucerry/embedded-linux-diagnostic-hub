import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'esbuild';
import {
    instrumentProductSource,
    productProbePreimages,
} from './fixtures/memory-product-instrument';

test('private product probes reject changed lifetime source before compilation', async () => {
    for (const [name] of productProbePreimages) {
        const file = path.resolve(import.meta.dirname, '..', name);
        const source = await fs.readFile(file, 'utf8');
        assert.ok(instrumentProductSource(source, file)?.code.includes('__qualificationProbe'));
        assert.throws(() => instrumentProductSource(source + '\n', file), /probe preimage changed/);
    }
    assert.equal(instrumentProductSource('export class Other {}', '/src/other.ts'), null);
});

test('actual page export RPC probe is source-bound and compiles without changing product inputs', async () => {
    const file = path.resolve(
        import.meta.dirname,
        '../src/features/automation/capture/browser-export.ts',
    );
    const source = await fs.readFile(file, 'utf8');
    const transformed = instrumentProductSource(source, file);
    assert.ok(transformed);
    assert.ok(transformed?.code.includes('__memoryTrackExportRpc'));
    assert.ok(transformed.code.includes('__memoryBrowserExports'));
    await transform(transformed.code, { loader: 'ts', target: 'es2022' });
    assert.throws(() => instrumentProductSource(source + '\n', file), /preimage changed/);
});
