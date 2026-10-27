import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createProductBrowser } from './fixtures/memory-product-browser-host';
import { exerciseProductSerialLifecycle } from './fixtures/memory-product-serial-lifecycle';

const root = process.env.HUB_PRODUCT_EVIDENCE;
if (!root) throw Error('Private lifecycle evidence directory required.');
await fs.mkdir(root, { recursive: true });
const emit = async (stage: string, data: unknown) => {
    await fs.appendFile(
        path.join(root, 'timeline.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), stage, data }) + '\n',
    );
};
let host: Awaited<ReturnType<typeof createProductBrowser>> | undefined, failure: unknown;
try {
    host = await createProductBrowser({
        profile: path.join(root, 'profile'),
        gcMode: 'normal',
        engine: 'chromium',
        emit,
    });
    const result = await exerciseProductSerialLifecycle(host.page, { ordinal: 100, emit });
    assert.equal(result.receipts.length, 8);
    await emit('actual-serial-lifecycle-cases', result);
    await host.page.evaluate(async () => {
        window.memoryProduct.unmount();
        await window.memoryProduct.closeSerial();
        await window.memoryProduct.closeRepository();
    });
    const owners = await host.page.evaluate(() => window.memoryProduct.ownership());
    for (const [kind, count] of Object.entries(owners.owners))
        assert.equal(count, 0, 'Actual operation owner remains: ' + kind);
    await emit('actual-serial-lifecycle-closed', owners);
    assert.deepEqual(host.errors(), []);
} catch (error) {
    failure = error;
    await emit('failure', {
        message: String(error),
        stack: error instanceof Error ? error.stack : null,
    });
} finally {
    if (host)
        try {
            await host.close();
            await host.assertExited();
            await emit('actual-browser-process-exit', { verified: true });
        } catch (error) {
            failure ??= error;
            await emit('cleanup-failure', { message: String(error) });
        }
}
await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
        {
            status: failure ? 'failed' : 'actual-serial-lifecycle-development-passed',
            qualified: false,
            failure: failure ? String(failure) : null,
            scope: 'Actual App UI, eight synthetic Serial lifecycle scenarios; not full-product memory/platform/artifact qualification.',
        },
        null,
        2,
    ),
);
if (failure) throw failure;
