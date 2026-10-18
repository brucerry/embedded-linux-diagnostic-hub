import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import {
    connectProductSerial,
    disconnectProductSerial,
    runProductOnce,
    setProductCommand,
} from './memory-product-ui';
import {
    ProductViewerWorkers,
    exerciseViewerWhileLive,
    exerciseViewerExportLifecycle,
    assertViewerRunUnchanged,
    type ViewerLiveCheckpoint,
} from './memory-product-viewer-lifecycle';
import {
    serialExpectation,
    assertAggregateWindowTransition,
    type AggregateWindowTransition,
} from './memory-product-aggregate-contract';
import type { ResultsCapture } from './memory-product-results-ui';
import type {} from './memory-product-app';

export async function createAggregateViewerWitness(page: Page, assets: string) {
    const names = (await fs.readdir(assets)).filter((name) =>
        /^export\.worker-[\w-]+\.js$/.test(name),
    );
    assert.equal(names.length, 1, 'Bind exactly the actual compiled viewer worker.');
    const pathname = '/assets/' + names[0];
    const protocol = new URL(page.url()).protocol;
    return {
        sha256: createHash('sha256')
            .update(await fs.readFile(path.join(assets, names[0])))
            .digest('hex'),
        workers: new ProductViewerWorkers(page, (value) => {
            const url = new URL(value);
            return (
                url.protocol === protocol &&
                url.pathname.endsWith(pathname) &&
                !url.search &&
                !url.hash
            );
        }),
    };
}

/** Twenty-one real Run once operations, never repository seeding or invented metadata. */
export async function produceAggregateCrossPage(page: Page, ordinal: number, count = 21) {
    assert.ok(count === 1 || count === 21);
    const produced: ResultsCapture[] = [];
    await page.evaluate(() =>
        window.memoryProduct.serial.configure({ bytes: 32, delayMs: 0, tail: '', stall: false }),
    );
    await connectProductSerial(page);
    for (let index = 0; index < count; index++) {
        const command = `aggregate-page-${ordinal}-${index}`;
        await setProductCommand(page, command);
        await runProductOnce(page);
        const row = (await page.evaluate(() => window.memoryProduct.catalog())).find(
            (value) => value.command === command,
        );
        assert.ok(row);
        assert.equal(row.state, 'complete');
        const expected = serialExpectation(32, '');
        assert.equal(row.committedBytes, expected.bytes);
        const read = await page.evaluate((id) => window.memoryProduct.readSummary(id), row.id);
        assert.equal(read.outcome?.completion, 'prompt-observed');
        produced.push({
            ...row,
            state: 'complete',
            completion: 'prompt-observed',
            exitCode: null,
            streams: { serial: expected },
            readableOutput: expected,
        });
    }
    await disconnectProductSerial(page);
    return { produced, capturedBytes: produced.reduce((sum, row) => sum + row.committedBytes, 0) };
}

/** Real held Serial run; Serial has promise/append joins, not fabricated SSH ACK identities. */
export async function exerciseAggregateHeldViewer(
    page: Page,
    input: {
        ordinal: number;
        viewer: boolean;
        workers: ProductViewerWorkers;
        visibility(hidden: boolean): Promise<AggregateWindowTransition>;
        browserDownloads?: { count(): number };
        emit(stage: string, data: unknown): Promise<void>;
    },
) {
    const command = 'aggregate-held-viewer-' + input.ordinal;
    await page.evaluate(() =>
        window.memoryProduct.serial.configure({
            bytes: 64,
            delayMs: 0,
            stall: false,
            holdPrompt: true,
            tail: '',
        }),
    );
    await connectProductSerial(page);
    await setProductCommand(page, command);
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect
        .poll(() =>
            page.evaluate(async (command) => {
                const rows = await window.memoryProduct.catalog(),
                    serial = window.memoryProduct.serial.snapshot();
                return (
                    rows.some(
                        (row) =>
                            row.command === command &&
                            row.state === 'active' &&
                            row.committedBytes === 64,
                    ) &&
                    serial.promptPending &&
                    !serial.stalled &&
                    serial.promptHeld &&
                    serial.remaining === 0
                );
            }, command),
        )
        .toBe(true);
    const readCheckpoint = async (): Promise<ViewerLiveCheckpoint> => {
        const value = await page.evaluate(async () => ({
            rows: await window.memoryProduct.catalog(),
            serial: window.memoryProduct.serial.snapshot(),
            session: window.memoryProduct.serialStatus(),
            refs: window.memoryProduct.pageRefs(),
            runner: window.memoryProduct.runnerState(),
        }));
        const row = value.rows.find((row) => row.command === command);
        assert.ok(row?.state === 'active' && value.refs.inspectionId);
        return {
            transport: 'serial',
            viewerIdentity: value.refs.inspectionId,
            runIdentity: row.runId,
            armGeneration: JSON.stringify([
                value.refs.inspectionId,
                value.refs.activityEpoch,
                value.session.generation,
            ]),
            captureId: row.id,
            busy: value.runner.busy,
            cleanupPending: value.runner.cleanupPending,
            captureState: 'active',
            commandDispatches: value.serial.writes,
            transportWriteBytes: value.serial.sent,
            receivedBytes: value.serial.produced,
            committedBytes: row.committedBytes,
            stall: {
                source: 'serial-prompt-withheld',
                id: JSON.stringify([value.serial.generation, value.serial.writes]),
                releasePending: value.serial.promptHeld && value.serial.promptPending,
            },
            acknowledgements: {
                status: 'unsupported',
                reason: 'Actual Serial WebStreams use write promises and durable append joins; this transport has no framed SSH ACK IDs.',
            },
        };
    };
    const before = await readCheckpoint();
    const minimized = await input.visibility(true);
    assertAggregateWindowTransition(minimized, true);
    const restored = await input.visibility(false);
    assertAggregateWindowTransition(restored, false);
    assert.equal(minimized.windowId, restored.windowId);
    const after = await readCheckpoint();
    assertViewerRunUnchanged(before, after);
    await input.emit('aggregate-actual-hide-show', {
        before,
        after,
        minimized,
        restored,
        actualVisibilityStates: [minimized.documentVisibility, restored.documentVisibility],
    });
    const coverage = ['hide-show'];
    if (input.viewer) {
        const live = await exerciseViewerWhileLive(page, {
            transport: 'serial',
            expectedViewerIdentity: before.viewerIdentity,
            repeatCount: 2,
            readCheckpoint,
            workers: input.workers,
        });
        assert.equal(live.coverage[0], 'viewer-open-close-live');
        coverage.push('viewer-open-close-live');
        await input.emit('aggregate-live-viewer', live);
        for (const action of ['close-held-request', 'codec-failure'] as const) {
            const result = await exerciseViewerExportLifecycle(page, {
                action,
                format: 'png',
                workers: input.workers,
                expectedViewerIdentity: before.viewerIdentity,
                readCheckpoint,
                browserDownloads: input.browserDownloads,
                joinWorkers: async (witnesses) => {
                    await Promise.all(witnesses.map((w) => w.closed));
                },
            });
            assert.equal(result.status, 'exercised-actual-ui');
            await input.emit('aggregate-viewer-' + action, result);
        }
        coverage.push('viewer-export-cancel-failure');
    }
    await page.evaluate(() => window.memoryProduct.serial.releaseOutput());
    await expect(flow.locator('.automation-state')).toContainText('Flow finished', {
        timeout: 120000,
    });
    await page.waitForFunction(
        () => {
            const row = window.memoryProduct.runnerState();
            return !row.busy && !row.cleanupPending;
        },
        undefined,
        { timeout: 10000 },
    );
    const completed = await page.evaluate(async (command) => {
        const row = (await window.memoryProduct.catalog()).find((row) => row.command === command);
        if (!row) throw Error('Held aggregate capture vanished.');
        return { row, read: await window.memoryProduct.readSummary(row.id) };
    }, command);
    assert.equal(completed.read.bytes, 81);
    assert.equal(completed.read.outcome?.completion, 'prompt-observed');
    await disconnectProductSerial(page);
    if (input.viewer) {
        const unmounted = await exerciseViewerExportLifecycle(page, {
            action: 'unmount-held-request',
            format: 'pdf',
            workers: input.workers,
            browserDownloads: input.browserDownloads,
            joinWorkers: async (witnesses) => {
                await Promise.all(witnesses.map((w) => w.closed));
            },
            // The modal correctly blocks background navigation. Exercise the actual
            // React parent unmount through the private root fixture instead.
            unmountViewer: () => page.evaluate(() => window.memoryProduct.unmount()),
        });
        assert.equal(unmounted.status, 'exercised-actual-ui');
        await input.emit('aggregate-viewer-parent-unmount', unmounted);
        await page.evaluate(() => window.memoryProduct.mount());
        await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Automation', exact: true }).click();
    }
    return { coverage, capturedBytes: completed.read.bytes };
}
