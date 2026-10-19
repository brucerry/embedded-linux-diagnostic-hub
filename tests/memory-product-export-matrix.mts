/** Actual production UI plus Node native Save control; IPC carrier is a Playwright binding. No Electron/PTY/Windows qualification. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exerciseNativeSaveCases } from './fixtures/memory-product-native-save-ui';
import { createProductBrowser } from './fixtures/memory-product-browser-host';
import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { ProductViewerDownload } from './fixtures/memory-product-ui';
import {
    exerciseProductResults,
    inspectProductResultsReport,
    type ResultsCapture,
} from './fixtures/memory-product-results-ui';
import { NativeCaptureHost } from '../electron/capture-host';
import { NativeCaptureRepository } from '../src/features/automation/capture/native-repository';
import { CaptureWriter } from '../shared/capture-writer';
import { NativeSaveControl } from './fixtures/memory-product-native-save-control';
import { workerReadFault, workerQuotaMessage } from './fixtures/memory-product-worker-faults';

const root = process.env.HUB_PRODUCT_EVIDENCE;
assert(root && path.isAbsolute(root), 'Use an explicitly owned absolute evidence directory.');
await fs.mkdir(root, { recursive: true });
const timeline: unknown[] = [];
const emit = async (stage: string, data: unknown) => {
    timeline.push({ stage, data });
    await fs.appendFile(path.join(root, 'timeline.jsonl'), JSON.stringify({ stage, data }) + '\n');
};
await fs.mkdir(path.join(root, 'native-profile'));
const native = await NativeCaptureHost.open(
    path.join(root, 'native-profile'),
    { profileOwned: true },
    async () => {
        throw Error('Uncontrolled Save selector');
    },
);
const port = native as any;
const control = new NativeSaveControl(port, (file) => assert.equal(path.dirname(file), root));
const repository = await NativeCaptureRepository.open((request) => native.dispatch(request));
const expected: ResultsCapture[] = [];
for (let index = 0; index < 3; index++) {
    const payload = Buffer.from(
        index < 2 ? 'primary export matrix ' + index : 'other scope payload',
    );
    const writer = await CaptureWriter.begin(repository, {
        transport: 'serial',
        receiveTimeSource: 'local-client',
        runId: 'export-matrix',
        stepId: String(index),
        name: 'Native matrix ' + index,
        command: 'private producer ' + index,
        startedAt: '2026-10-19T00:00:00.000Z',
    });
    await writer.append(payload, '2026-10-19T00:00:00.000Z', 'serial');
    const capture = await writer.finish('prompt-observed');
    const stream = {
        bytes: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex'),
    };
    expected.push({
        ...capture,
        transport: capture.header.transport,
        command: capture.header.command,
        name: capture.header.name,
        state: 'complete',
        completion: null,
        exitCode: null,
        streams: { serial: stream },
        readableOutput: stream,
    });
}
workerReadFault.wrap(port.store);
let browser: Awaited<ReturnType<typeof createProductBrowser>> | undefined;
const bridgeReplies: unknown[] = [];
let ordinal = 0;
const facade = {
    async beginNoReport() {
        control.forbidDestination();
    },
    async finishNoReport() {
        await Promise.allSettled([...port.exports]);
        const receipt = control.finishNoDestination();
        const ownership = await facade.snapshot();
        await emit('actual-native-empty-destination-guard', { receipt, ownership });
        for (const kind of ['reader', 'pin', 'export', 'rpc'] as const)
            assert.equal(ownership.capture.owners[kind], 0);
        return receipt;
    },
    async prepareHeldReport() {
        const file = path.join(root, 'held-' + ordinal++ + '.json');
        control.arm(file, true);
        return file;
    },
    async reportStatus() {
        return control.status();
    },
    async releaseReport(decision: 'save' | 'cancel') {
        const before = control.status();
        control.release(decision);
        await emit('actual-selector-release', { before, after: control.status() });
    },
    async finishReport() {
        const receipt = control.finish();
        if (receipt?.decision === 'cancel') {
            const view = browser!.page
                .getByRole('region', { name: 'Automation', exact: true })
                .locator('[aria-label="Stored Serial captures"]');
            const statuses = await view.getByRole('status').allTextContents();
            const alerts = await view.getByRole('alert').allTextContents();
            assert.deepEqual(statuses, ['Export cancelled.']);
            assert.deepEqual(alerts, []);
            await emit('actual-cancel-status-observed', {
                statuses,
                alerts,
                nativeOwners: await facade.snapshot(),
            });
        }
        await emit('actual-selector-finished', receipt);
        return receipt;
    },
    async snapshot() {
        const s = port.server,
            d = port.store;
        return {
            capture: {
                owners: {
                    reader:
                        s.readers.size +
                        [...d.readers.values()].reduce((a: number, b: any) => a + b, 0),
                    pin: s.pins.size + s.pinReservations + d.pins,
                    export: port.exports.size,
                    rpc: s.calls,
                },
            },
        };
    },
    async releaseQualificationHolds() {
        control.cancelForShutdown();
    },
    readFault: {
        quotaMessage: workerQuotaMessage,
        arm: async (action: 'hold' | 'quota') => workerReadFault.arm(action),
        status: async () => workerReadFault.status(),
        clear: async () => workerReadFault.clear(),
    },
};
try {
    browser = await createProductBrowser({
        profile: path.join(root, 'browser-profile'),
        gcMode: 'normal',
        engine: 'chromium',
        emit,
    });
    const page = browser.page;
    page.on(
        'pageerror',
        (error) => void emit('page-error', { message: String(error), stack: error.stack }),
    );
    await page.exposeFunction('__nativeSaveExport', async (request: unknown) => {
        const reply = await native.dispatch(request);
        bridgeReplies.push({ request, reply });
        await emit('actual-native-host-rpc-reply', { request, reply });
        return reply;
    });
    await page.addInitScript(
        'window.diagnosticHub={onDisconnected:()=>()=>{},readUpdateReport:async()=>null,captureStorage:(request)=>window.__nativeSaveExport(request)}',
    );
    await page.reload();
    await page.waitForFunction(() => Boolean(window.memoryProduct));
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const view = page
        .getByRole('region', { name: 'Automation', exact: true })
        .locator('[aria-label="Stored Serial captures"]');
    const before = await repository.page(0, 100);
    try {
        const nativeDownload: ProductViewerDownload = async (extension, run, validate) => {
            const file = path.join(root, 'report-' + ordinal++ + '.' + extension);
            control.arm(file, false);
            try {
                await run();
                await expect.poll(() => Boolean(control.status()?.invoked)).toBe(true);
                await expect(
                    view.getByRole('button', { name: 'Download QA results', exact: true }),
                ).toBeEnabled();
                await Promise.all([...port.exports]);
                const receipt = control.finish();
                assert.equal(receipt?.decision, 'save');
                await expect(view.getByRole('status')).toHaveText('Export saved.');
                await expect(view.getByRole('alert')).toHaveCount(0);
                const bytes = await fs.readFile(file);
                if (validate) await validate(bytes);
                await fs.unlink(file);
                await emit('actual-native-report-validated', {
                    extension,
                    bytes: bytes.length,
                    receipt,
                });
                return bytes;
            } finally {
                control.cancelForShutdown();
            }
        };
        const results = await exerciseProductResults(page, {
            transport: 'serial',
            catalog: expected,
            selection: [expected[0]],
            search: {
                query: 'primary export matrix',
                expectedIds: expected.slice(0, 2).map((c) => c.id),
            },
            evidenceDirectory: root,
            maxDownloadBytes: 1024 * 1024,
            requireCrossPage: false,
            clear: 'none',
            reopen: 'none',
            nativeSaveCases: (view) => exerciseNativeSaveCases(page, view, facade as any, emit),
            nativeEmptyExport: {
                begin: () => facade.beginNoReport(),
                finish: () => facade.finishNoReport(),
            },
            nativeDownload,
        });
        for (const scope of ['filtered', 'all'] as const) {
            await view
                .getByLabel('Search automation results', { exact: true })
                .fill('primary export matrix');
            await view.getByLabel('Export scope', { exact: true }).selectOption(scope);
            for (const format of ['csv', 'markdown', 'text'] as const) {
                await view.getByLabel('Export format', { exact: true }).selectOption(format);
                await nativeDownload(
                    { csv: 'csv', markdown: 'md', text: 'txt' }[format],
                    () =>
                        view
                            .getByRole('button', { name: 'Download QA results', exact: true })
                            .click(),
                    (bytes) =>
                        inspectProductResultsReport(
                            format,
                            bytes,
                            scope === 'filtered' ? expected.slice(0, 2) : expected,
                        ),
                );
                await emit('actual-native-extra-scope-format', {
                    scope,
                    format,
                    expectedIds: (scope === 'filtered' ? expected.slice(0, 2) : expected).map(
                        (c) => c.id,
                    ),
                });
            }
        }
        for (const format of ['json', 'csv', 'markdown', 'text']) {
            await view.getByLabel('Export scope', { exact: true }).selectOption('filtered');
            await view
                .getByLabel('Search automation results', { exact: true })
                .fill('__absent_matrix__');
            await view.getByLabel('Export format', { exact: true }).selectOption(format);
            await expect(view.locator('tr[data-capture-id]')).toHaveCount(0);
            const replies = bridgeReplies.length;
            await facade.beginNoReport();
            try {
                await view
                    .getByRole('button', { name: 'Download QA results', exact: true })
                    .click();
                await expect(view.getByRole('alert')).toHaveText(
                    'No stored captures match this export.',
                );
                await expect(view.getByRole('status')).toHaveText(
                    'Export did not complete; stored captures are retained.',
                );
                await expect(
                    view.getByRole('button', { name: 'Download QA results', exact: true }),
                ).toBeEnabled();
                assert.equal(control.status(), null);
                assert.equal(port.exports.size, 0);
                assert.equal(port.store.pins, 0);
            } finally {
                const receipt = await facade.finishNoReport();
                assert.deepEqual(receipt, { calls: 0, returned: 0 });
            }
            await emit('actual-native-empty-export-refused', {
                format,
                replies: bridgeReplies.slice(replies),
                owners: await facade.snapshot(),
            });
        }
        assert.deepEqual(await repository.page(0, 100), before);
        await view.getByLabel('Search automation results', { exact: true }).fill('');
        await expect(view.locator('tr[data-capture-id]')).toHaveCount(3);
        await view.getByRole('button', { name: 'Clear retained results', exact: true }).click();
        await view
            .getByRole('button', { name: 'Delete all stored Serial captures', exact: true })
            .click();
        await expect(view.getByRole('status')).toHaveText('Deleted 3 stored Serial captures.');
        await expect(view.getByRole('alert')).toHaveCount(0);
        assert.deepEqual((await repository.page(0, 100)).records, []);
        await emit('actual-native-clear-confirmed', {
            deleted: 3,
            status: await view.getByRole('status').allTextContents(),
        });
        for (const format of ['json', 'csv', 'markdown', 'text']) {
            await view.getByLabel('Export scope', { exact: true }).selectOption('all');
            await view.getByLabel('Export format', { exact: true }).selectOption(format);
            await facade.beginNoReport();
            try {
                await view
                    .getByRole('button', { name: 'Download QA results', exact: true })
                    .click();
                await expect(view.getByRole('alert')).toHaveText(
                    'No stored captures match this export.',
                );
                await expect(
                    view.getByRole('button', { name: 'Download QA results', exact: true }),
                ).toBeEnabled();
            } finally {
                assert.deepEqual(await facade.finishNoReport(), { calls: 0, returned: 0 });
            }
            await emit('actual-native-empty-catalog-refused', {
                format,
                owners: await facade.snapshot(),
            });
        }
        assert.equal(workerReadFault.activeReads(), 0);
        const notices = await view.getByRole('status').allTextContents();
        const alerts = await view.getByRole('alert').allTextContents();
        await emit('regression-passed', {
            results,
            notices,
            alerts,
            bridgeReplies,
            boundary:
                'Actual compiled production App and Results handler, actual native repository/RPC/Node NativeCaptureHost/SQLite/SaveControl/stream-failure. Playwright binding replaces Electron IPC carrier. Captures written through real CaptureWriter. No Electron/PTY or Windows qualification.',
        });
    } catch (error) {
        const evidence = {
            error: String(error),
            status: await view.getByRole('status').allTextContents(),
            alerts: await view.getByRole('alert').allTextContents(),
            buttonCount: await view
                .getByRole('button', { name: 'Download QA results', exact: true })
                .count(),
            body: (await page.locator('body').innerText()).slice(0, 12000),
            nativeSelector: control.status(),
            nativeOwners: await facade.snapshot(),
            bridgeReplies,
        };
        await emit('regression-failed', evidence);
        throw error;
    }
} finally {
    control.cancelForShutdown();
    await Promise.allSettled([...port.exports]);
    control.restoreAfterJoin();
    await native.shutdown();
    await emit('native-host-shutdown-joined', {
        activeReads: workerReadFault.activeReads(),
        exports: port.exports.size,
    });
    if (browser) {
        await browser.close();
        await browser.assertExited();
    }
}
