import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createProductNative } from './fixtures/memory-product-native-host';
import { exerciseProductSerial } from './fixtures/memory-product-ui';

const destination = process.env.HUB_PRODUCT_EVIDENCE;
if (!destination) throw Error('Private native evidence directory is required.');
await fs.mkdir(destination, { recursive: true });
const emit = async (stage: string, data: unknown) => {
    await fs.appendFile(
        path.join(destination, 'timeline.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), stage, data }) + '\n',
    );
};
let host: Awaited<ReturnType<typeof createProductNative>> | undefined, failure: unknown;
try {
    host = await createProductNative({
        profile: path.join(destination, 'profile'),
        gcMode: process.env.HUB_PRODUCT_GC ?? 'normal',
        emit,
    });
    const result = await exerciseProductSerial(host.page, {
        ordinal: 0,
        payloadBytes: Number(process.env.HUB_PRODUCT_BYTES ?? 1048576),
        viewer: true,
        faults: true,
        nativeDownload: host.download,
    });
    await emit('actual-native-product-cycle', result);
    await host.joinDedicatedWorkers();
    await emit('actual-native-processes', await host.sample({ quiescent: true, forceGc: false }));
    await host.page.evaluate(async () => {
        window.memoryProduct.unmount();
        await window.memoryProduct.closeSerial();
        await window.memoryProduct.closeRepository();
    });
    const renderer = await host.page.evaluate(() => window.memoryProduct.ownership());
    for (const [kind, count] of Object.entries(renderer.owners))
        assert.equal(count, 0, 'Actual native renderer owner remains: ' + kind);
    const main = await host.snapshot();
    assert.equal(main.sshHasResources, false);
    assert.equal(main.activity.lease, false);
    assert.ok(main.capture);
    for (const [kind, count] of Object.entries(main.capture.owners))
        assert.equal(count, 0, 'Actual main capture owner remains: ' + kind);
    await emit('actual-native-quiescent', { renderer, main });
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
            await emit('actual-native-process-exit', { verified: true });
        } catch (error) {
            failure ??= error;
            await emit('cleanup-failure', { message: String(error) });
        }
}
await fs.writeFile(
    path.join(destination, 'result.json'),
    JSON.stringify(
        {
            status: failure ? 'failed' : 'actual-native-development-cycle-passed',
            qualified: false,
            scope: 'Actual production main/preload/sandbox/CSP and App/Serial/native capture/viewer, private entry/owner probes. Synthetic streams; no physical port. Not shipping artifact, full-product coverage or memory qualification.',
            failure: failure ? String(failure) : null,
        },
        null,
        2,
    ),
);
if (failure) throw failure;
