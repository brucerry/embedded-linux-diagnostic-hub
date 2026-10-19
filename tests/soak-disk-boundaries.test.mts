import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { treeInventory } from '../scripts/memory-product-collect.mts';
import { limits } from '../scripts/lib/product-collector-controller.mjs';
import { inspectOwnedArtifact } from '../scripts/lib/owned-artifact-stream.mjs';
for (const [label, limit] of [
    ['job', limits.jobBytes],
    ['cohort', limits.cohortBytes],
] as const)
    test(
        'actual ' +
            label +
            ' inventory below/exact/above apparent-byte boundary without filling disk',
        async (t) => {
            const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hub-inventory-bound-'));
            t.after(() => fsp.rm(root, { recursive: true, force: true }));
            const file = path.join(root, 'sparse-boundary');
            await fsp.writeFile(file, '');
            for (const size of [limit - 1, limit, limit + 1]) {
                await fsp.truncate(file, size);
                if (size <= limit)
                    assert.equal(treeInventory(root, { maxBytes: limit }).bytes, size);
                else assert.throws(() => treeInventory(root, { maxBytes: limit }), /budget/);
            }
            // Source collector guards apparent file lengths. Sparse allocation here is deliberate test data,
            // not proof of Windows allocated-block usage or transient physical peak containment.
        },
    );
test('actual128-MiB report guard accepts below/exact EOF and refuses above before opening', async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hub-report-bound-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'sparse-report');
    await fsp.writeFile(file, '');
    const cap = 128 * 1024 ** 2;
    for (const size of [cap - 1, cap, cap + 1]) {
        await fsp.truncate(file, size);
        let opens = 0;
        const io = {
            ...fsp,
            async open(...args: any[]) {
                opens++;
                return (fsp.open as any)(...args);
            },
        };
        const read = () =>
            inspectOwnedArtifact(
                file,
                async (chunks) => {
                    let bytes = 0;
                    for await (const chunk of chunks) bytes += chunk.length;
                    return bytes;
                },
                { io },
            );
        if (size <= cap) {
            const result = await read();
            assert.equal(result.bytes, size);
            assert.equal(result.result, size);
            assert(result.descriptorClosed);
        } else {
            await assert.rejects(read(), /oversized/);
            assert.equal(opens, 0);
        }
    }
});
