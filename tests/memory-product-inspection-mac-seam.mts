import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { createProductBrowser } from './fixtures/memory-product-browser-host';
import { ProductInspectionController } from './fixtures/memory-product-inspection-controller';
import { ProcessSampler } from './fixtures/memory-resource-processes';
import { AggregateCallTracker } from './fixtures/memory-product-aggregate-diagnostics';
import { runNativeCleanup } from './fixtures/memory-product-native-cleanup';
import type {} from './fixtures/memory-product-app';

assert.equal(process.platform, 'darwin');
const output = process.env.HUB_NATIVE_OUTPUT;
assert.ok(output && path.isAbsolute(output));
const record = (stage: string, data: unknown) => {
    fs.appendFileSync(
        path.join(output, 'timeline.jsonl'),
        JSON.stringify({ stage, at: performance.now(), data }) + '\n',
    );
};
const emit = async (stage: string, data: unknown) => record(stage, data);
const calls = new AggregateCallTracker(emit, 'mac-seam-call');
const owned: {
    child?: ChildProcess;
    sampler?: ProcessSampler;
    closed?: Promise<void>;
    exit?: { code: number | null; signal: NodeJS.Signals | null };
    close?: { code: number | null; signal: NodeJS.Signals | null };
} = {};
let host: Awaited<ReturnType<typeof createProductBrowser>> | undefined;
let controller: ProductInspectionController | undefined;
let primary: unknown, cleanup: unknown;
let cleanupVerified = false;
const admissions: unknown[] = [],
    transitions: unknown[] = [];
try {
    host = await createProductBrowser({
        profile: path.join(output, 'profile'),
        gcMode: 'normal',
        engine: 'chromium',
        headless: false,
        windowSemantics: 'native',
        emit,
        async observeRoot(child) {
            assert.ok(child.pid);
            owned.child = child;
            child.once('exit', (code, signal) => {
                owned.exit = { code, signal };
            });
            owned.closed = new Promise((resolve) =>
                child.once('close', (code, signal) => {
                    owned.close = { code, signal };
                    resolve();
                }),
            );
            owned.sampler = new ProcessSampler([child.pid]);
            await owned.sampler.sample();
        },
    });
    controller = new ProductInspectionController(host, emit, record);
    await calls.run('initialize-five-actual-observer-groups', () => controller!.initialize());
    const identity = structuredClone(controller.snapshot().nativeIdentity);
    assert.ok(identity);
    const wrappers = new Set<object>();
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
        await controller.use('actual-storage-and-download-admission-' + ordinal, async () => {
            const page = host!.page;
            assert.equal(
                wrappers.has(page),
                false,
                'Each generation requires the newly bound wrapper.',
            );
            wrappers.add(page);
            const capture = await page.evaluate(
                (ordinal) => window.memoryProduct.createInspectionFixtureCapture(ordinal),
                ordinal,
            );
            assert.equal(capture.committedBytes, 0);
            assert.equal(capture.state, 'complete');
            await page.getByRole('button', { name: 'Automation', exact: true }).click();
            const flow = page.getByRole('region', { name: 'Automation', exact: true });
            await flow
                .getByRole('navigation', { name: 'Automation setup steps' })
                .getByRole('button', { name: /Connection/ })
                .click();
            await flow.getByLabel('Automation transport', { exact: true }).selectOption('serial');
            const view = flow.locator('[aria-label="Stored Serial captures"]');
            await expect(view).toBeVisible();
            await view.getByRole('button', { name: 'Refresh stored results', exact: true }).click();
            await view
                .locator('tr[data-capture-id="' + capture.id + '"] input[type="checkbox"]')
                .check();
            await view.getByLabel('Export scope', { exact: true }).selectOption('selected');
            await view.getByLabel('Export format', { exact: true }).selectOption('json');
            const download = host!.download;
            assert.ok(download);
            const jsonBytes = await download('json', () =>
                view.getByRole('button', { name: 'Download QA results', exact: true }).click(),
            );
            const report = JSON.parse(jsonBytes.toString('utf8'));
            assert.equal(report.schemaVersion, 3);
            assert.deepEqual(
                report.captures.map((row: any) => row.capture.id),
                [capture.id],
            );
            assert.deepEqual(report.summary, {
                captures: 1,
                complete: 1,
                incomplete: 0,
                verifiedCommittedBytes: 0,
            });
            assert.equal(report.captures[0].capture.header.command, capture.header.command);
            assert.deepEqual(report.captures[0].rawObservations, []);
            const workers = controller!.viewerWorkers(),
                token = workers.baseline();
            let svgBytes: Buffer;
            try {
                await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
                const dialog = page.getByRole('dialog', { name: 'Automation flow', exact: true });
                await expect(dialog).toBeVisible();
                svgBytes = await download('svg', () =>
                    dialog.getByRole('button', { name: 'Export SVG', exact: true }).click(),
                );
                assert.ok(svgBytes.length > 100 && svgBytes.toString('utf8').includes('<svg'));
                await expect(
                    dialog.getByRole('status', { name: 'Flow export status' }),
                ).toContainText('SVG exported');
                const actual = workers.since(token);
                assert.equal(actual.length, 1, 'Exactly one actual compiled viewer export worker.');
                await page.keyboard.press('Escape');
                await expect(dialog).not.toBeVisible();
                await calls.run('join-actual-viewer-close-' + ordinal, () => actual[0].closed);
                record(
                    'mac-seam-viewer-close-before-inspector-release',
                    workers.assertClosed(actual),
                );
            } finally {
                workers.releaseBaseline(token);
            }
            await workers.settleInspectionWorkers();
            assert.equal(host!.downloadCount!(), ordinal * 2);
            assert.deepEqual(host!.errors(), []);
            const value = {
                ordinal,
                captureId: capture.id,
                syntheticStorageOnly: true,
                json: {
                    bytes: jsonBytes.length,
                    sha256: createHash('sha256').update(jsonBytes).digest('hex'),
                },
                svg: {
                    bytes: svgBytes!.length,
                    sha256: createHash('sha256').update(svgBytes!).digest('hex'),
                },
                snapshot: controller!.snapshot(),
            };
            admissions.push(value);
            record('mac-seam-actual-admission', value);
        });
        if (ordinal < 3) {
            const before = controller.snapshot();
            await controller.retire(async (page) => {
                await page.reload({ waitUntil: 'load', timeout: 10000 });
                await page.waitForFunction(() => Boolean(window.memoryProduct), undefined, {
                    timeout: 10000,
                });
            });
            const after: ReturnType<ProductInspectionController['snapshot']> =
                controller.snapshot();
            assert.equal(after.inspection?.generation, ordinal + 1);
            assert.equal(after.state, 'ready');
            assert.deepEqual(after.nativeIdentity, identity);
            assert.equal(after.connection?.downloads.observed, ordinal * 2);
            assert.equal(after.activeRetirementEpochs, 0);
            const transition = { ordinal, before, after };
            transitions.push(transition);
            record('mac-seam-actual-reconnect', transition);
        }
    }
} catch (error) {
    primary = error;
    record('mac-native-seam-failed', {
        error: String(error),
        stack: error instanceof Error ? error.stack : null,
        snapshot: controller?.snapshot(),
    });
} finally {
    try {
        await runNativeCleanup(
            [
                {
                    name: 'close-actual-controller-or-host',
                    run: () =>
                        calls.run('close-actual-owner', async () => {
                            if (controller) await controller.close();
                            else if (host) await host.close();
                        }),
                },
                {
                    name: 'join-actual-host',
                    run: () =>
                        calls.run('join-host-exit', async () => {
                            assert.ok(host);
                            await host.assertExited();
                        }),
                },
                {
                    name: 'join-root-child-close',
                    run: () =>
                        calls.run('join-root-child-close', async () => {
                            assert.ok(owned.closed);
                            await owned.closed;
                        }),
                },
                {
                    name: 'join-root-process-tree',
                    run: () =>
                        calls.run('join-root-process-tree', async () => {
                            assert.ok(owned.sampler);
                            await owned.sampler.assertExited();
                        }),
                },
            ],
            emit,
            { stage: 'mac-seam-cleanup-step' },
        );
        assert.deepEqual(owned.exit, { code: 0, signal: null });
        assert.deepEqual(owned.close, { code: 0, signal: null });
        calls.assertJoined();
        cleanupVerified = true;
    } catch (error) {
        cleanup = error;
        record('mac-native-seam-cleanup-failed', {
            error: String(error),
            stack: error instanceof Error ? error.stack : null,
        });
    }
    fs.writeFileSync(
        path.join(output, 'native-result.json'),
        JSON.stringify(
            {
                status:
                    primary || cleanup
                        ? 'failed-native-reconnect-seam'
                        : 'passed-native-reconnect-seam',
                primary: primary ? String(primary) : null,
                cleanup: cleanup ? String(cleanup) : null,
                cleanupVerified,
                admissions,
                transitions,
                finalSnapshot: controller?.snapshot(),
                rootExit: owned.exit,
                rootClose: owned.close,
                rootHistory: owned.sampler
                    ? await owned.sampler.sample().catch((error) => ({ error: String(error) }))
                    : null,
                actualAppRuns: 1,
                reconnects: transitions.length,
                aggregateRuns: 0,
                qualified: false,
                scope: 'Actual native Mac reconnect mechanism with synthetic empty storage fixtures and actual QA/SVG downloads. No Serial/SSH workload, aggregate memory, soak, installer, Electron or Windows qualification.',
            },
            null,
            2,
        ) + '\n',
        { flag: 'wx' },
    );
}
if (primary || cleanup) process.exitCode = 1;
