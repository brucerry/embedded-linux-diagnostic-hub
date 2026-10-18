import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeCaptureHost } from '../electron/capture-host';
import { NativeCaptureStore } from '../electron/capture-store';
import { NativeCaptureRepository } from '../src/features/automation/capture/native-repository';
import { CaptureWriter } from '../shared/capture-writer';
import { NativeSaveControl } from './fixtures/memory-product-native-save-control';
import { workerReadFault } from './fixtures/memory-product-worker-faults';
import {
    nativeCoverageDraft,
    parseNativeCoverage,
    nativeGenerationCase,
} from './fixtures/memory-product-native-contract';
import { requirements } from './fixtures/memory-resource-verdict';
import { sha256 } from './fixtures/memory-resource-identity';
import { until } from './fixtures/serial-capture';

async function fixture(t: TestContext) {
    const profile = await fs.mkdtemp(path.join(path.resolve(os.tmpdir()), 'hub-native-control-'));
    const host = await NativeCaptureHost.open(profile, { profileOwned: true }, async () => {
        throw Error('Uncontrolled Save selection');
    });
    const port = host as unknown as {
        store: NativeCaptureStore;
        exports: Set<Promise<boolean>>;
        destination(format: 'json' | 'csv' | 'markdown' | 'text'): Promise<string | null>;
    };
    const control = new NativeSaveControl(port, (file) =>
        assert.equal(path.dirname(file), profile),
    );
    const proxy = await NativeCaptureRepository.open((request) => host.dispatch(request));
    const writer = await CaptureWriter.begin(proxy, {
        transport: 'serial',
        receiveTimeSource: 'local-client',
        runId: 'control',
        stepId: 'one',
        name: 'Synthetic',
        command: 'fixture',
        startedAt: '2026-10-18T00:00:00.000Z',
    });
    await writer.append(
        new TextEncoder().encode('exact retained payload'),
        '2026-10-18T00:00:00.000Z',
        'serial',
    );
    const capture = await writer.finish('prompt-observed');
    t.after(async () => {
        control.cancelForShutdown();
        await Promise.allSettled([...port.exports]);
        control.restoreAfterJoin();
        await host.shutdown().catch(() => {});
        await fs.rm(profile, { recursive: true, force: true });
    });
    return { host, port, control, capture, file: path.join(profile, 'destination.json') };
}

test('held trusted Save cancellation owns the real export/pin until decision, preserves capture and writes no file', async (t) => {
    const { host, port, control, capture, file } = await fixture(t);
    control.arm(file, true);
    const exportResult = host.dispatch({
        op: 'export',
        format: 'json',
        scope: { ids: [capture.id] },
    });
    await until(() => Boolean(control.status()?.pending));
    assert.equal(port.exports.size, 1);
    assert.ok((port.store as unknown as { pins: number }).pins > 0);
    assert.throws(() => control.finish());
    assert.throws(() => control.arm(file, true));
    control.release('cancel');
    assert.throws(() => control.release('save'));
    const result = await exportResult;
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, false);
    await until(() => port.exports.size === 0);
    assert.equal((port.store as unknown as { pins: number }).pins, 0);
    assert.equal(control.finish()?.decision, 'cancel');
    await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
    const read = await host.dispatch({ op: 'read', id: capture.id });
    assert.equal(read.ok, true);
});

test('held Save then actual stream failure preserves destination and releases actual owners', async (t) => {
    const { host, port, control, capture, file } = await fixture(t);
    const sentinel = Buffer.from('original destination');
    await fs.writeFile(file, sentinel, { flag: 'wx' });
    workerReadFault.wrap(port.store);
    control.arm(file, true);
    const exportResult = host.dispatch({
        op: 'export',
        format: 'json',
        scope: { ids: [capture.id] },
    });
    await until(() => Boolean(control.status()?.pending));
    workerReadFault.arm('quota');
    control.release('save');
    const result = await exportResult;
    assert.equal(result.ok, false);
    assert.equal(workerReadFault.status()?.entered, true);
    await until(() => port.exports.size === 0);
    assert.equal((port.store as unknown as { pins: number }).pins, 0);
    assert.equal(workerReadFault.activeReads(), 0);
    assert.equal(control.finish()?.decision, 'save');
    workerReadFault.clear();
    assert.deepEqual(await fs.readFile(file), sentinel);
    assert.ok(
        !(await fs.readdir(path.dirname(file))).some((name) =>
            name.startsWith('.diagnostic-hub-export-'),
        ),
    );
    const read = await host.dispatch({ op: 'read', id: capture.id });
    assert.equal(read.ok, true);
});

test('native generation reset rejects actual stale readers and pins and permits reopening retained bytes', async (t) => {
    const { host, capture } = await fixture(t);
    const reader = await host.dispatch({ op: 'read', id: capture.id }),
        pin = await host.dispatch({ op: 'pin' });
    assert.ok(reader.ok && pin.ok);
    const r = reader.value as { handle: string },
        p = pin.value as { handle: string };
    await host.reset();
    assert.equal((await host.dispatch({ op: 'pull', handle: r.handle })).ok, false);
    assert.equal((await host.dispatch({ op: 'unpin', handle: p.handle })).ok, true); // Cleanup is deliberately idempotent; reset already released the pin.
    const reopened = await host.dispatch({ op: 'read', id: capture.id });
    assert.equal(reopened.ok, true);
});

test('backend applicability fails closed without exact independent review and does not credit IndexedDB versionchange', () => {
    const source = 'a'.repeat(64),
        draft = nativeCoverageDraft(source),
        bytes = Buffer.from(JSON.stringify(draft));
    assert.throws(() => parseNativeCoverage(bytes, sha256(bytes), source), /independent review/);
    const approved = Buffer.from(JSON.stringify({ ...draft, reviewed: true }));
    assert.throws(() => parseNativeCoverage(approved, 'b'.repeat(64), source));
    assert.throws(() => parseNativeCoverage(approved, sha256(approved), 'c'.repeat(64)));
    const contract = parseNativeCoverage(approved, sha256(approved), source);
    assert.equal(Object.isFrozen(contract.contract.cases.versionchange), true);
    assert.ok(requirements(false, [], false).coverage.includes('versionchange'));
    const required = requirements(false, [], false, contract).coverage;
    assert.ok(required.includes(nativeGenerationCase));
    assert.ok(!required.includes('versionchange'));
});
