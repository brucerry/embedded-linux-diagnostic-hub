import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createQualificationDriver } from './fixtures/memory-product-aggregate';
import { sourceFingerprint } from './fixtures/memory-resource-identity';
import { announceResult, sendResultAndAwaitAck } from './fixtures/memory-product-result-handoff';

assert.ok(process.connected && process.send, 'Use the exclusive reviewed source coordinator.');
const admitted = await new Promise<{
    kind: string;
    output: string;
    sourceSHA256: string;
    lane: 'browser' | 'desktop';
    payloadBytes: number;
}>((resolve, reject) => {
    const timer = setTimeout(
        () => reject(Error('Actual aggregate start handshake exceeded10000ms.')),
        10000,
    );
    process.once('message', (value) => {
        clearTimeout(timer);
        resolve(value as never);
    });
    process.send!({ kind: 'ready', pid: process.pid });
});
assert.equal(admitted.kind, 'go');
assert.ok(path.isAbsolute(admitted.output));
assert.ok(['browser', 'desktop'].includes(admitted.lane));
assert.ok([65536, 33 * 1024 ** 2].includes(admitted.payloadBytes));
const source = await sourceFingerprint(path.resolve(import.meta.dirname, '..'));
assert.equal(source, admitted.sourceSHA256);
const emit = async (stage: string, data: unknown) =>
    fs.appendFile(
        path.join(admitted.output, 'timeline.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), stage, data }) + '\n',
    );
let driver: Awaited<ReturnType<typeof createQualificationDriver>> | undefined,
    failure: unknown,
    result: unknown,
    inspect: unknown,
    exited = false;
try {
    driver = await createQualificationDriver({
        lane: admitted.lane,
        gcMode: 'normal',
        profile: path.join(admitted.output, 'profile'),
        viewer: true,
        component: false,
        emit,
    });
    await emit('development-preflight', await driver.inspect());
    // Exactly one source-admitted development payload, never the5+25min/100-cycle gate.
    result = await driver.cycle({
        phase: 'warmup',
        ordinal: 0,
        payloadBytes: admitted.payloadBytes,
        catalogMode: 'constant',
    });
    const processes = await driver.sampleProcesses({ quiescent: true, forceGc: false });
    assert.ok(processes.some((row) => row.state === 'running' && row.created));
    await emit('development-quiescent-processes', processes);
    await emit('development-raw-owner-counts', await driver.snapshotOwners('development-only'));
    inspect = await driver.inspect();
} catch (error) {
    failure = error;
    await emit('development-failure', {
        primary: String(error),
        stack: error instanceof Error ? error.stack : null,
    });
} finally {
    if (driver)
        try {
            await driver.teardown();
            await driver.assertDescendantsExited();
            exited = true;
            await emit('development-full-teardown', {
                owners: await driver.snapshotOwners('full-teardown'),
                verified: true,
            });
        } catch (error) {
            failure = failure
                ? new AggregateError(
                      [failure, error],
                      'Actual App primary and cleanup failures retained.',
                  )
                : error;
            await emit('development-cleanup-failure', { error: String(error), verified: false });
        }
}
const receipt = {
    status: failure
        ? 'failed-actual-app-aggregate-development'
        : 'passed-actual-app-aggregate-development',
    sourceSHA256: source,
    qualified: false,
    fullProductMemoryPass: false,
    payloadBytes: admitted.payloadBytes,
    cycles: 1,
    result,
    inspect,
    driverTeardownVerified: exited,
    failure: failure ? String(failure) : null,
    scope: 'Actual App UI/transport/storage/results/viewer through aggregate interface; one developmental cycle, no calibrated warm series, no memory threshold or platform/artifact qualification.',
};
const receiptBytes = JSON.stringify(receipt, null, 2) + '\n';
await fs.writeFile(path.join(admitted.output, 'result.json'), receiptBytes, { flag: 'wx' });
try {
    const delivery = await sendResultAndAwaitAck(
        {
            events: process,
            connected: () => process.connected,
            send: (message, callback) => {
                process.send!(message, callback);
            },
        },
        announceResult(receiptBytes, source),
    );
    await emit('development-result-handoff', delivery);
} catch (error) {
    await emit('development-result-handoff-failure', {
        error: String(error),
        deliveryVerified: false,
    });
    throw error;
} finally {
    if (process.connected) process.disconnect();
}
if (failure) throw failure;
