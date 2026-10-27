import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { createProductBrowser } from './fixtures/memory-product-browser-host';
import {
    connectProductSerial,
    disconnectProductSerial,
    setProductCommand,
} from './fixtures/memory-product-ui';
import {
    ProductViewerWorkers,
    exerciseViewerWhileLive,
    exerciseViewerExportLifecycle,
    type ViewerLiveCheckpoint,
} from './fixtures/memory-product-viewer-lifecycle';

const root = process.env.HUB_PRODUCT_EVIDENCE;
if (!root) throw Error('Private evidence is required.');
await fs.mkdir(root, { recursive: true });
const emit = async (stage: string, data: unknown) =>
    fs.appendFile(
        path.join(root, 'timeline.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), stage, data }) + '\n',
    );
let host: Awaited<ReturnType<typeof createProductBrowser>> | undefined;
let workers: ProductViewerWorkers | undefined;
let failure: unknown;
try {
    host = await createProductBrowser({
        profile: path.join(root, 'profile'),
        gcMode: 'normal',
        engine: process.env.HUB_MEMORY_BROWSER ?? 'chromium',
        emit,
    });
    const page = host.page;
    const candidates = (await fs.readdir(path.join(host.root, 'assets'))).filter((name) =>
        /^export\.worker-[\w-]+\.js$/.test(name),
    );
    assert.equal(candidates.length, 1, 'Exact compiled export worker asset is required.');
    const workerPath = '/assets/' + candidates[0],
        workerSHA256 = createHash('sha256')
            .update(await fs.readFile(path.join(host.root, 'assets', candidates[0])))
            .digest('hex');
    workers = new ProductViewerWorkers(page, (value) => {
        const url = new URL(value);
        return (
            url.origin === host!.origin && url.pathname === workerPath && !url.search && !url.hash
        );
    });
    await emit('actual-viewer-worker-binding', {
        url: new URL(workerPath, host.origin).href,
        sha256: workerSHA256,
    });
    await page.evaluate(() =>
        window.memoryProduct.serial.configure({ bytes: 64, delayMs: 0, stall: true }),
    );
    await connectProductSerial(page);
    await setProductCommand(page, 'actual-held-viewer-command');
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const rows = await window.memoryProduct.catalog(),
                    serial = window.memoryProduct.serial.snapshot();
                return (
                    rows.some(
                        (row) =>
                            row.command === 'actual-held-viewer-command' && row.state === 'active',
                    ) &&
                    serial.writes === 1 &&
                    serial.promptPending &&
                    serial.stalled
                );
            }),
        )
        .toBe(true);
    const readCheckpoint = async (): Promise<ViewerLiveCheckpoint> => {
        const actual = await page.evaluate(async () => ({
            rows: await window.memoryProduct.catalog(),
            serial: window.memoryProduct.serial.snapshot(),
            session: window.memoryProduct.serialStatus(),
            refs: window.memoryProduct.pageRefs(),
            runner: window.memoryProduct.runnerState(),
        }));
        const row = actual.rows.find((row) => row.command === 'actual-held-viewer-command');
        assert.ok(row);
        assert.equal(row.state, 'active');
        assert.ok(actual.refs.inspectionId);
        assert.equal(actual.serial.stalled, true);
        return {
            transport: 'serial',
            viewerIdentity: actual.refs.inspectionId,
            runIdentity: row.runId,
            armGeneration: JSON.stringify([
                actual.refs.inspectionId,
                actual.refs.activityEpoch,
                actual.session.generation,
            ]),
            captureId: row.id,
            busy: actual.runner.busy,
            cleanupPending: actual.runner.cleanupPending,
            captureState: 'active',
            commandDispatches: actual.serial.writes,
            transportWriteBytes: actual.serial.sent,
            receivedBytes: actual.serial.produced,
            committedBytes: row.committedBytes,
            stall: {
                source: 'serial-prompt-withheld',
                id: JSON.stringify([actual.serial.generation, actual.serial.writes]),
                releasePending: actual.serial.stalled && actual.serial.promptPending,
            },
            acknowledgements: {
                status: 'unsupported',
                reason: 'Serial WebStreams use real write promises and capture append joins; no framed SSH ACK IDs or trace exists in this transport.',
            },
        };
    };
    const initial = await readCheckpoint();
    assert.notEqual(
        initial.viewerIdentity,
        initial.runIdentity,
        'Inspection and per-run IDs must retain distinct provenance.',
    );
    await emit(
        'actual-live-viewer',
        await exerciseViewerWhileLive(page, {
            transport: 'serial',
            expectedViewerIdentity: initial.viewerIdentity,
            repeatCount: 2,
            readCheckpoint,
            workers,
        }),
    );
    for (const [action, format] of [
        ['close-held-request', 'png'],
        ['codec-failure', 'png'],
    ] as const) {
        const result = await exerciseViewerExportLifecycle(page, {
            action,
            format,
            workers,
            expectedViewerIdentity: initial.viewerIdentity,
            readCheckpoint,
            joinWorkers: async (witnesses) => {
                await Promise.all(witnesses.map((witness) => witness.closed));
            },
        });
        assert.equal(result.status, 'exercised-actual-ui', 'Required fault hooks are missing.');
        await emit('actual-viewer-' + action, result);
    }
    await page.evaluate(() => window.memoryProduct.serial.releaseOutput());
    await expect(flow.locator('.automation-state')).toContainText('Flow finished', {
        timeout: 120000,
    });
    await page.waitForFunction(
        () => {
            const state = window.memoryProduct.runnerState();
            return !state.busy && !state.cleanupPending;
        },
        undefined,
        { timeout: 10000 },
    );
    const completed = await page.evaluate(async () => {
        const row = (await window.memoryProduct.catalog()).find(
            (row) => row.command === 'actual-held-viewer-command',
        );
        if (!row) throw Error('Actual viewer capture vanished.');
        return { row, read: await window.memoryProduct.readSummary(row.id) };
    });
    assert.equal(completed.read.bytes, 81);
    assert.equal(completed.read.outcome?.completion, 'prompt-observed');
    await emit('actual-live-viewer-completed', completed);
    await disconnectProductSerial(page);
    const unmounted = await exerciseViewerExportLifecycle(page, {
        action: 'unmount-held-request',
        format: 'pdf',
        workers,
        joinWorkers: async (witnesses) => {
            await Promise.all(witnesses.map((witness) => witness.closed));
        },
        unmountViewer: () => page.evaluate(() => window.memoryProduct.unmount()),
    });
    assert.equal(unmounted.status, 'exercised-actual-ui');
    await emit('actual-viewer-unmount-held-request', unmounted);
    await page.evaluate(async () => {
        await window.memoryProduct.closeSerial();
        await window.memoryProduct.closeRepository();
    });
    await page.waitForFunction(
        () => Object.values(window.memoryProduct.ownership().owners).every((value) => value === 0),
        undefined,
        { timeout: 10000 },
    );
    await host.joinDedicatedWorkers();
    await emit('actual-viewer-observer-before-page-exit', workers.snapshotObserver());
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
            await emit('actual-process-exit', { verified: true });
        } catch (error) {
            failure ??= error;
            await emit('cleanup-failure', { message: String(error) });
        }
    if (workers)
        try {
            workers.dispose();
            await emit('actual-viewer-observer-disposed', workers.snapshotObserver());
        } catch (error) {
            failure ??= error;
            await emit('observer-cleanup-failure', { message: String(error) });
        }
}
await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
        {
            status: failure ? 'failed' : 'actual-live-viewer-development-passed',
            qualified: false,
            failure: failure ? String(failure) : null,
            scope: 'Actual held Serial App run, separate inspection/run identity, live open/close and real Worker close/fault/unmount paths. No framed ACK, physical backing-store, aggregate memory or release qualification.',
        },
        null,
        2,
    ),
);
if (failure) throw failure;
