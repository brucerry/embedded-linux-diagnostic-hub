import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expect, type Worker } from '@playwright/test';
import { createProductBrowser } from './fixtures/memory-product-browser-host';
import {
    connectProductSerial,
    disconnectProductSerial,
    runProductOnce,
    setProductCommand,
} from './fixtures/memory-product-ui';
import {
    exerciseProductResults,
    type ResultsCapture,
    type ResultsExportReadFault,
} from './fixtures/memory-product-results-ui';
import { workerQuotaMessage } from './fixtures/memory-product-worker-faults';
import { CAPTURE_STORAGE } from '../shared/capture-store';

const root = process.env.HUB_PRODUCT_EVIDENCE;
if (!root) throw Error('A private evidence directory is required.');
await fs.mkdir(root, { recursive: true });
const emit = async (stage: string, data: unknown) =>
    fs.appendFile(
        path.join(root, 'timeline.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), stage, data }) + '\n',
    );
let host: Awaited<ReturnType<typeof createProductBrowser>> | undefined;
let failure: unknown;
interface WorkerState {
    owners: Record<string, number>;
    jobs: unknown[];
    services: Record<string, boolean>;
    cache: Record<string, number>;
    fault: unknown;
}
interface WorkerProbe {
    faults: {
        arm(action: 'hold' | 'quota'): void;
        status(): { action: 'hold' | 'quota'; entered: boolean; released: boolean } | null;
        release(): void;
        clear(): void;
    };
    quotaMessage: string;
    snapshot(): Promise<WorkerState>;
}
declare global {
    var __memoryProductWorker: WorkerProbe;
}
try {
    host = await createProductBrowser({
        profile: path.join(root, 'profile'),
        gcMode: 'normal',
        engine: 'chromium',
        emit,
    });
    const page = host.page;
    await page.evaluate(() => window.memoryProduct.serial.configure({ bytes: 1024, delayMs: 0 }));
    await connectProductSerial(page);
    const expected: ResultsCapture[] = [];
    const outputToken = 'output_only_after_preview_72edc',
        firstBytes = CAPTURE_STORAGE.previewBytes * 4;
    assert.ok(firstBytes - Buffer.byteLength(outputToken) > CAPTURE_STORAGE.previewBytes);
    for (let index = 0; index < 22; index++) {
        const count = index === 0 ? firstBytes : 1024,
            tail = index === 0 ? outputToken : '';
        await page.evaluate(
            ({ count, tail }) => window.memoryProduct.serial.configure({ bytes: count, tail }),
            { count, tail },
        );
        const bytes = Buffer.concat([
                Buffer.alloc(count - Buffer.byteLength(tail), 120),
                Buffer.from(tail + '\r\nqualification# '),
            ]),
            stream = {
                bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            };
        const command = 'catalog-command-' + String(index).padStart(2, '0');
        await setProductCommand(page, command);
        await runProductOnce(page);
        const row = (await page.evaluate(() => window.memoryProduct.catalog())).find(
            (value) => value.command === command,
        );
        assert.ok(row);
        assert.equal(row.state, 'complete');
        assert.equal(row.committedBytes, bytes.length);
        const read = await page.evaluate((id) => window.memoryProduct.readSummary(id), row.id);
        assert.equal(read.outcome?.completion, 'prompt-observed');
        expected.push({
            ...row,
            state: 'complete',
            completion: 'prompt-observed',
            exitCode: null,
            streams: { serial: stream },
            readableOutput: stream,
            readableTokens: index === 0 ? [outputToken, 'qualification# '] : ['qualification# '],
        });
    }
    await disconnectProductSerial(page);
    await emit('actual-produced-results', {
        catalog: expected,
        bytesPerCapture: expected.map((row) => row.committedBytes),
        origin: '22 actual App Run once executions; no repository seeding',
    });
    assert.ok(
        expected.every(
            ({ streams, readableTokens, ...metadata }) =>
                !JSON.stringify(metadata).includes(outputToken),
        ),
        'Output-only token leaked into capture metadata.',
    );
    await emit('actual-output-search-origin', {
        captureId: expected[0].id,
        token: outputToken,
        tokenByteOffset: firstBytes - Buffer.byteLength(outputToken),
        previewBytes: CAPTURE_STORAGE.previewBytes,
        metadataContainsToken: false,
        expectedStreamSHA256: expected[0].streams!.serial!.sha256,
    });
    let worker: Worker | undefined;
    const getWorker = () => {
        const workers = page
            .context()
            .serviceWorkers()
            .filter((value) => new URL(value.url()).pathname === '/capture-download-sw.js');
        assert.equal(workers.length, 1, 'Expected exactly one actual export service worker.');
        const current = workers[0];
        if (worker)
            assert.equal(
                current,
                worker,
                'Export worker identity changed during held-read exercise.',
            );
        worker = current;
        return current;
    };
    const fault: ResultsExportReadFault = {
        realm: 'service-worker',
        quotaMessage: workerQuotaMessage,
        async arm(action) {
            await getWorker().evaluate(
                (action) => globalThis.__memoryProductWorker.faults.arm(action),
                action,
            );
        },
        async status() {
            const status = await getWorker().evaluate(() =>
                globalThis.__memoryProductWorker.faults.status(),
            );
            assert.ok(status);
            return { method: 'read', ...status };
        },
        async release() {
            await getWorker().evaluate(() => globalThis.__memoryProductWorker.faults.release());
        },
        async clear() {
            await getWorker().evaluate(() => globalThis.__memoryProductWorker.faults.clear());
        },
        async snapshot() {
            return getWorker().evaluate(() => globalThis.__memoryProductWorker.snapshot());
        },
    };
    const result = await exerciseProductResults(page, {
        transport: 'serial',
        catalog: expected,
        selection: [expected[0], expected[21]],
        search: { query: outputToken, expectedIds: [expected[0].id] },
        evidenceDirectory: root,
        maxDownloadBytes: 1024 * 1024,
        requireCrossPage: true,
        clear: 'selected',
        reopen: 'none',
        exportReadFault: fault,
        evolution: {
            mode: 'bounded-growing',
            previousIds: [],
            expectedAddedIds: expected.map((value) => value.id),
            bound: 500,
        },
    });
    await emit('actual-results-cycle', result);
    await expect
        .poll(async () =>
            Object.values(
                (await getWorker().evaluate(() => globalThis.__memoryProductWorker.snapshot()))
                    .owners,
            ).every((value) => value === 0),
        )
        .toBe(true);
    const workerFinal = await getWorker().evaluate(() =>
        globalThis.__memoryProductWorker.snapshot(),
    );
    assert.deepEqual(workerFinal.jobs, []);
    await emit('actual-export-worker-quiescent', workerFinal);
    await expect
        .poll(() => page.evaluate(() => window.memoryProduct.browserExports()))
        .toMatchObject({ active: 0, rpc: 0, busyHelpers: 0 });
    await emit(
        'actual-page-export-quiescent',
        await page.evaluate(() => window.memoryProduct.browserExports()),
    );
    await page.evaluate(async () => {
        window.memoryProduct.unmount();
        await window.memoryProduct.closeSerial();
        await window.memoryProduct.closeRepository();
    });
    await page.waitForFunction(
        () => Object.values(window.memoryProduct.ownership().owners).every((value) => value === 0),
        undefined,
        { timeout: 10000 },
    );
    await page.reload();
    await page.waitForFunction(() => Boolean(window.memoryProduct));
    const remaining = await page.evaluate(() => window.memoryProduct.catalog());
    assert.deepEqual(
        remaining.map((row) => row.id).sort(),
        expected
            .slice(1, 21)
            .map((row) => row.id)
            .sort(),
    );
    assert.equal(await page.evaluate(() => window.memoryProduct.serial.snapshot().opens), 0);
    await emit('actual-results-profile-reopen', {
        remainingIds: remaining.map((row) => row.id),
        actualPageReload: true,
    });
    await page.evaluate(async () => {
        window.memoryProduct.unmount();
        await window.memoryProduct.closeSerial();
        await window.memoryProduct.closeRepository();
    });
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
}
await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
        {
            status: failure ? 'failed' : 'actual-results-development-passed',
            qualified: false,
            failure: failure ? String(failure) : null,
            scope: 'Actual App-produced stored captures, cross-page selection, four real semantic report formats, service-worker held-read cancellation/failure and profile reload. No aggregate memory, console journal, native Results or shipping artifact qualification.',
        },
        null,
        2,
    ),
);
if (failure) throw failure;
