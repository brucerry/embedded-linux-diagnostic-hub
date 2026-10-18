import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createProductNative } from './fixtures/memory-product-native-host';
import { createProductGateway } from './fixtures/memory-product-gateway';
import { exerciseProductNativeSsh } from './fixtures/memory-product-native-ssh-ui';

const root = process.env.HUB_PRODUCT_EVIDENCE;
if (!root) throw Error('Private native SSH evidence directory required.');
await fs.mkdir(root, { recursive: true });
const emit = async (stage: string, data: unknown) => {
    await fs.appendFile(
        path.join(root, 'timeline.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), stage, data }) + '\n',
    );
};
let host: Awaited<ReturnType<typeof createProductNative>> | undefined;
let gateway: Awaited<ReturnType<typeof createProductGateway>> | undefined;
let failure: unknown;
try {
    host = await createProductNative({
        profile: path.join(root, 'profile'),
        gcMode: 'normal',
        emit,
    });
    // The gateway's HTTP side is an idle fixture here. Native UI connects directly to its owned SSH target.
    gateway = await createProductGateway({
        origin: 'http://127.0.0.1:9',
        gcMode: 'normal',
        profile: path.join(root, 'target-profile'),
        emit,
    });
    const result = await exerciseProductNativeSsh(host.page, gateway, {
        ordinal: 200,
        payloadBytes: 65536,
        snapshot: host.snapshot,
        scenarios: process.env.HUB_PRODUCT_SSH_SCENARIOS === 'all' ? undefined : ['stream'],
        emit,
    });
    await emit('actual-native-ssh-cycle', result);
    await emit('actual-native-ssh-main', await host.snapshot());
    await emit(
        'actual-native-ssh-processes',
        await host.sample({ quiescent: true, forceGc: false }),
    );
    await host.page.evaluate(async () => {
        window.memoryProduct.unmount();
        await window.memoryProduct.closeSerial();
        await window.memoryProduct.closeRepository();
    });
    await host.page.waitForFunction(
        () => Object.values(window.memoryProduct.ownership().owners).every((count) => count === 0),
        undefined,
        { timeout: 10000 },
    );
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
            await emit('actual-native-target-process-exit', { verified: true });
        } catch (error) {
            failure ??= error;
            await emit('cleanup-failure', {
                component: 'owned-target-fixture',
                message: String(error),
            });
        }
    if (host)
        try {
            await host.close();
            await host.assertExited();
            await emit('actual-native-process-exit', { verified: true });
        } catch (error) {
            failure ??= error;
            await emit('cleanup-failure', { component: 'native', message: String(error) });
        }
}
await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
        {
            status: failure ? 'failed' : 'actual-native-ssh-development-passed',
            qualified: false,
            failure: failure ? String(failure) : null,
            scope: 'Actual production native SSH UI/preload/DeviceMonitor/independent capture with owned authenticated synthetic loopback target; idle HTTP fixture is not native gateway coverage. No physical DUT, persistent-console or memory/artifact qualification.',
        },
        null,
        2,
    ),
);
if (failure) throw failure;
