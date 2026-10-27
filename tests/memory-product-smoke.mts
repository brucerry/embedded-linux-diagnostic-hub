import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createProductBrowser } from './fixtures/memory-product-browser-host';
import { exerciseProductSerial } from './fixtures/memory-product-ui';
import { createProductGateway } from './fixtures/memory-product-gateway';
import { exerciseProductSsh } from './fixtures/memory-product-ssh-ui';

const root = process.env.HUB_PRODUCT_EVIDENCE;
if (!root)
    throw Error(
        'HUB_PRODUCT_EVIDENCE is required; no product workload without a private evidence directory.',
    );
await fs.mkdir(root, { recursive: true });
let lineCount = 0;
const emit = async (stage: string, data: unknown) => {
    const line = JSON.stringify({ at: new Date().toISOString(), stage, data });
    lineCount++;
    await fs.appendFile(path.join(root, 'timeline.jsonl'), line + '\n');
};
let host: Awaited<ReturnType<typeof createProductBrowser>> | undefined;
let gateway: Awaited<ReturnType<typeof createProductGateway>> | undefined;
const gcMode = process.env.HUB_PRODUCT_GC ?? 'normal';
assert.ok(['normal', 'forced'].includes(gcMode));
let failure: unknown;
try {
    host = await createProductBrowser({
        profile: path.join(root, 'profile'),
        gcMode,
        engine: process.env.HUB_MEMORY_BROWSER ?? 'chromium',
        emit,
    });
    const result = await exerciseProductSerial(host.page, {
        ordinal: 0,
        payloadBytes: Number(process.env.HUB_PRODUCT_BYTES ?? 1048576),
        viewer: true,
        faults: true,
    });
    await emit('actual-product-cycle', result);
    if (process.env.HUB_PRODUCT_SSH === '1') {
        gateway = await createProductGateway({
            origin: host.origin,
            gcMode,
            profile: path.join(root, 'gateway-profile'),
            emit,
        });
        host.proxyGateway(gateway.descriptor.url);
        const ssh = await exerciseProductSsh(host.page, gateway, {
            ordinal: 1,
            payloadBytes: 65536,
            scenarios: process.env.HUB_PRODUCT_SSH_SCENARIOS === 'all' ? undefined : ['stream'],
            gatewayUrl: host.origin,
            emit,
        });
        await emit('actual-product-ssh-cycle', ssh);
        await emit('actual-gateway-owners', await gateway.snapshotOwners());
        await emit(
            'actual-gateway-processes',
            await gateway.sample({ quiescent: true, forceGc: false }),
        );
    }
    await host.joinDedicatedWorkers();
    await emit('actual-processes', await host.sample({ quiescent: true, forceGc: false }));
    await host.page.evaluate(async () => {
        window.memoryProduct.unmount();
        await window.memoryProduct.closeSerial();
    });
    await host.page.waitForFunction(
        () => Object.values(window.memoryProduct.ownership().owners).every((count) => count === 0),
        undefined,
        { timeout: 10000 },
    );
    await emit(
        'actual-unmounted-operation-owners',
        await host.page.evaluate(() => window.memoryProduct.ownership()),
    );
    if (gcMode === 'forced')
        await emit(
            'forced-baseline-collection',
            await host.sample({ quiescent: true, forceGc: true }),
        );
    await emit(
        'unmounted-baseline',
        await host.page.evaluate(() => window.memoryProduct.baselineAfterUnmount()),
    );
    await host.page.evaluate(() => window.memoryProduct.mount());
    const remount = await exerciseProductSerial(host.page, {
        ordinal: 2,
        payloadBytes: 32768,
        viewer: true,
        faults: false,
    });
    await emit('actual-product-remount', remount);
    await host.joinDedicatedWorkers();
    await host.page.evaluate(async () => {
        window.memoryProduct.unmount();
        await window.memoryProduct.closeSerial();
    });
    if (gcMode === 'forced')
        await emit(
            'forced-post-remount-collection',
            await host.sample({ quiescent: true, forceGc: true }),
        );
    await emit(
        'actual-ledger-delta',
        await host.page.evaluate(() => window.memoryProduct.ledgerDelta()),
    );
    await host.page.evaluate(() => window.memoryProduct.closeRepository());
    const final = await host.page.evaluate(() => window.memoryProduct.ownership());
    for (const [kind, count] of Object.entries(final.owners))
        assert.equal(count, 0, `Post-unmount ${kind} owner remains.`);
    assert.ok(
        final.retained
            .filter((r) => r.kind === 'repository')
            .every((r) => r.details.connectionOpen === false),
    );
    await emit('post-unmount', final);
    assert.deepEqual(host.errors(), []);
} catch (error) {
    failure = error;
    await emit('failure', {
        message: String(error),
        stack: error instanceof Error ? error.stack : null,
    });
} finally {
    if (gateway)
        try {
            await gateway.close();
            await gateway.assertExited();
            await emit('actual-gateway-exit', { verified: true });
        } catch (error) {
            failure ??= error;
            await emit('gateway-cleanup-failure', { message: String(error) });
        }
    if (host)
        try {
            await host.close();
            await host.assertExited();
            await emit('actual-process-exit', { verified: true });
        } catch (error) {
            failure ??= error;
            await emit('cleanup-failure', { message: String(error) });
        }
}
await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
        {
            status: failure ? 'failed' : 'development-product-cycle-passed',
            qualified: false,
            scope: 'Actual App Serial/optional gateway streaming/runner/IDB/viewer, original-identity browser ledger and remount; bounded development integration only. Native, complete coverage/aggregate owner and memory/platform gates remain open. Raw ledger candidates are observations, not an empty-owner claim.',
            failure: failure ? String(failure) : null,
            receipts: lineCount,
        },
        null,
        2,
    ),
);
if (failure) throw failure;
