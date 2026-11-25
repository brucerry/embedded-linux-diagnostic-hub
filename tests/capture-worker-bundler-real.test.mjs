import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { build, version } from 'vite';
import { bundleCaptureWorker } from '../scripts/lib/capture-worker-bundle.mjs';

const root = new URL('../', import.meta.url);
const pinned = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
assert.equal(version, pinned.packages['node_modules/vite'].version);

for (const name of ['frame', 'worker']) {
    test(`pinned Vite compiles the actual capture ${name} as a classic script`, async () => {
        const entry = fileURLToPath(
            new URL(`src/features/automation/capture/capture-download-${name}.ts`, root),
        );
        const output = await bundleCaptureWorker(build, entry);
        assert.ok(output.length > 0 && output.length < 1024 * 1024);
        assert.doesNotThrow(() => new Script(output.toString('utf8'), { filename: entry + '.js' }));
    });
}
