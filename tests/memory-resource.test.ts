import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
    Owners,
    retained,
    provisional,
    trend,
    captureDiagnostic,
    type Memory,
} from './fixtures/memory-resource-core';
import { newCapture } from '../shared/capture-store';

const sample = (heapUsed = 0, arrayBuffers = 0): Memory => ({
    heapUsed,
    arrayBuffers,
    external: arrayBuffers,
    heapTotal: 0,
    rss: 0,
});
test('bounded failure evidence distinguishes a permission/storage pause without retaining output', () => {
    const stored = newCapture('00000000-0000-4000-8000-000000000001', 1, {
        transport: 'ssh',
        receiveTimeSource: 'local-client',
        runId: 'run',
        stepId: 'step',
        name: 'synthetic',
        command: 'fixture',
        startedAt: '2026-10-15T00:00:00.000Z',
    });
    stored.id = 'a'.repeat(80);
    stored.state = 'incomplete';
    stored.committedBytes = 851968;
    stored.observedBytes = 868352;
    stored.failure = { code: 'permission', message: 'EPERM rename '.repeat(100) };
    const detail = captureDiagnostic({ completion: 'storage-error', stored });
    assert.equal(detail.completion, 'storage-error');
    assert.equal(detail.stored!.id.length, 64);
    assert.equal(detail.stored!.failure!.code, 'permission');
    assert.equal(detail.stored!.failure!.message.length, 512);
    assert.equal(detail.stored!.committedBytes, 851968);
    assert.equal(detail.stored!.observedBytes, 868352);
    assert.deepEqual(captureDiagnostic({ completion: 'transport-error' }), {
        completion: 'transport-error',
        stored: null,
    });
    stored.observedBytes = null;
    assert.equal(
        captureDiagnostic({ completion: 'storage-error', stored }).stored!.observedBytes,
        null,
    );
    assert.ok(JSON.stringify(detail).length < 900);
});
test('retention diagnostics reject the specified 1 MiB JS and 512 KiB Buffer controls', () => {
    const baseline = sample();
    assert.throws(
        () =>
            retained(
                baseline,
                Array.from({ length: 12 }, (_, i) => sample((i + 1) * 1024 ** 2)),
            ),
        /retained-heapUsed/,
    );
    assert.throws(
        () =>
            retained(
                baseline,
                Array.from({ length: 12 }, (_, i) => sample(0, (i + 1) * 512 * 1024)),
            ),
        /retained-arrayBuffers/,
    );
    assert.doesNotThrow(() =>
        retained(
            baseline,
            Array.from({ length: 12 }, () =>
                sample(provisional.heapUsed, provisional.arrayBuffers),
            ),
        ),
    );
    assert.deepEqual(trend([1, 2, 3, 4, 5]), {
        firstMedian: 2,
        lastMedian: 4,
        medianDelta: 2,
        bytesPerCycle: 1,
    });
});
test('listener/timer/pin omission controls fail until real release acknowledges', async () => {
    const owners = new Owners(),
        events = new EventEmitter(),
        callback = () => {};
    const listener = owners.take('listener', 'negative-control');
    events.on('data', callback);
    assert.throws(() => owners.empty('listener'), /negative-control/);
    events.off('data', callback);
    listener();
    const timer = setInterval(() => {}, 60000),
        timerRelease = owners.take('timer', 'negative-control');
    timer.unref();
    assert.throws(() => owners.empty('timer'), /negative-control/);
    clearInterval(timer);
    timerRelease();
    let acknowledge!: () => void;
    const ack = new Promise<void>((resolve) => {
        acknowledge = resolve;
    });
    const pin = owners.take('pin', 'negative-control');
    const pending = (async () => {
        await ack;
        pin();
    })();
    assert.throws(() => owners.empty('pin'), /negative-control/);
    acknowledge();
    await pending;
    owners.empty('released');
    assert.equal(events.listenerCount('data'), 0);
});
test('owner accounting is bounded and retains an unsettled disposer after failure', async () => {
    const owners = new Owners();
    const release = owners.take('store', 'store-close-not-acknowledged');
    await assert.rejects(
        owners.join('pending-close', 'store', async () => {
            throw Error('busy');
        }),
        /busy/,
    );
    assert.throws(() => owners.empty('after rejected close'), /store-close-not-acknowledged/);
    release();
    release();
    owners.empty('idempotent release');
    for (let i = 0; i < 256; i++) owners.take('pin', String(i));
    assert.throws(() => owners.take('pin', 'overflow'), /bound exceeded/);
});
