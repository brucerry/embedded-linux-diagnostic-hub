import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectViewerArtifact } from '../../scripts/lib/owned-artifact-stream.mjs';
import { expect, type Page } from '@playwright/test';
import type {} from './memory-product-app';

const flowOf = (page: Page) => page.getByRole('region', { name: 'Automation', exact: true });
const setup = async (page: Page, name: string) =>
    flowOf(page)
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(name) })
        .click();
export async function connectProductSerial(page: Page) {
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await serial.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await serial.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(serial.getByText('Ready', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    await setup(page, 'Connection');
    await flowOf(page).getByLabel('Automation transport').selectOption('serial');
    await flowOf(page).getByLabel('Serial completion prompt').fill('qualification# ');
    await flowOf(page).getByLabel('Serial automation line ending').selectOption('LF');
}
export async function setProductCommand(page: Page, command: string) {
    await setup(page, 'Commands');
    await flowOf(page).getByLabel('Command 1 script').fill(command);
    await setup(page, 'Review');
}
export async function runProductOnce(page: Page) {
    await flowOf(page).getByRole('button', { name: 'Run once', exact: true }).click();
    await expect(flowOf(page).locator('.automation-state')).toContainText('Flow finished', {
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
    assert.equal((await page.evaluate(() => window.memoryProduct.runnerState())).busy, false);
}
export async function disconnectProductSerial(page: Page) {
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const serial = page.getByRole('region', { name: 'Local serial terminal' });
    await serial.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.waitForFunction(() => {
        const s = window.memoryProduct.serial.snapshot();
        return s.closes === s.opens && !s.readerActive && !s.writerActive && !s.pumping;
    });
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
}
export type ProductViewerArtifact = Buffer | { length: number; prefix: Buffer; sha256: string };
const viewerPrefix = (value: ProductViewerArtifact) =>
    Buffer.isBuffer(value) ? value : value.prefix;
export type ProductViewerDownload = (
    format: string,
    action: () => Promise<void>,
    validate?: (bytes: ProductViewerArtifact) => unknown,
) => Promise<ProductViewerArtifact>;
export async function exerciseProductViewer(page: Page, nativeDownload?: ProductViewerDownload) {
    const coverage: string[] = [];
    await flowOf(page).getByRole('button', { name: 'Show flow', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Automation flow', exact: true });
    await expect(dialog).toBeVisible();
    const card = dialog.locator('[data-ordinal="1"]');
    await card.focus();
    const before = await card.evaluate((e) => (e as HTMLElement).style.left);
    await card.press('ArrowRight');
    assert.notEqual(await card.evaluate((e) => (e as HTMLElement).style.left), before);
    const box = await card.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 75, box.y + 60, { steps: 3 });
    await page.mouse.up();
    await dialog.getByRole('button', { name: 'Fit graph', exact: true }).click();
    coverage.push('viewer-pointer-keyboard');
    assert.equal(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
        true,
    );
    coverage.push('viewer-reduced-motion');
    let exportedBytes = 0;
    for (const format of ['SVG', 'PNG', 'PDF']) {
        const action = () =>
            dialog.getByRole('button', { name: 'Export ' + format, exact: true }).click();
        const validate = (bytes: ProductViewerArtifact) => {
            assert.ok(bytes.length > 100, `${format} download was empty.`);
            if (format === 'PDF')
                assert.equal(viewerPrefix(bytes).subarray(0, 5).toString(), '%PDF-');
            if (format === 'PNG')
                assert.deepEqual(
                    [...viewerPrefix(bytes).subarray(0, 8)],
                    [137, 80, 78, 71, 13, 10, 26, 10],
                );
        };
        const bytes = nativeDownload
            ? await nativeDownload(format, action, validate)
            : await (async () => {
                  const download = page.waitForEvent('download');
                  await action();
                  const file = await download;
                  const privateRoot = process.env.HUB_PRODUCT_EVIDENCE;
                  assert.ok(
                      privateRoot,
                      'Viewer qualification needs its private artifact destination.',
                  );
                  const destination = path.join(
                      privateRoot,
                      'viewer-' + format.toLowerCase() + '.' + format.toLowerCase(),
                  );
                  await file.saveAs(destination);
                  const inspected = await inspectViewerArtifact(destination);
                  return {
                      length: inspected.bytes,
                      prefix: inspected.prefix,
                      sha256: inspected.sha256,
                  };
              })();
        assert.ok(bytes.length > 100, `${format} download was empty.`);
        if (format === 'PDF') assert.equal(viewerPrefix(bytes).subarray(0, 5).toString(), '%PDF-');
        if (format === 'PNG')
            assert.deepEqual(
                [...viewerPrefix(bytes).subarray(0, 8)],
                [137, 80, 78, 71, 13, 10, 26, 10],
            );
        exportedBytes += bytes.length;
        await expect(dialog.getByRole('status', { name: 'Flow export status' })).toContainText(
            format + ' exported',
        );
        coverage.push('viewer-' + format.toLowerCase());
    }
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    // Real navigation unmounts the entire viewer subtree; its own effect performs disposal.
    coverage.push('viewer-unmount');
    return { coverage, exportedBytes };
}

/** Bounded development cycle through actual product UI; receipts are case-specific. */
export async function exerciseProductSerial(
    page: Page,
    context: {
        ordinal: number;
        payloadBytes: number;
        viewer: boolean;
        faults?: boolean;
        nativeDownload?: ProductViewerDownload;
        expectedTail?: string;
        emit?: (stage: string, data: unknown) => Promise<void>;
    },
) {
    const coverage: string[] = [],
        geometryEvidence: { captureId: string; sha256: string; observations: number }[] = [];
    const geometryRead = async (id: string, bodyBytes: number) => {
        const actual = await page.evaluate(() => window.memoryProduct.serial.snapshot().geometry);
        assert.deepEqual(actual.expected, { chunkBytes: 16384, prompt: 'qualification# ' });
        assert.equal(actual.failure, null);
        assert.equal(actual.actual.chunkBytes, 16384);
        assert.equal(actual.actual.prompt, 'qualification# ');
        assert.equal(actual.actual.bodyBytes, bodyBytes);
        assert.equal(actual.actual.tail, context.expectedTail ?? '');
        const read = await page.evaluate(
            ({ id, bodyBytes, tail }) => window.memoryProduct.readSummary(id, { bodyBytes, tail }),
            { id, bodyBytes, tail: context.expectedTail ?? '' },
        );
        assert.ok(read.geometry?.everyRawByteVerified);
        const proof = { captureId: id, actualMode: actual.actual, read: read.geometry };
        await context.emit?.('actual-product-serial-geometry', proof);
        geometryEvidence.push({
            captureId: id,
            sha256: createHash('sha256').update(JSON.stringify(proof)).digest('hex'),
            observations: read.frames,
        });
        return read;
    };
    let capturedBytes = 0,
        exportedBytes = 0;
    await page.evaluate(
        (bytes) =>
            window.memoryProduct.serial.configure({
                bytes,
                delayMs: 1,
                stall: false,
                holdWrite: false,
                holdOpen: false,
            }),
        context.payloadBytes,
    );
    await connectProductSerial(page);
    const command = 'product-qualification-' + context.ordinal;
    await setProductCommand(page, command);
    await runProductOnce(page);
    let rows = await page.evaluate(() => window.memoryProduct.catalog());
    const first = rows.find((r) => r.command === command);
    assert.ok(first);
    const read = await geometryRead(first.id, context.payloadBytes);
    const expected = context.payloadBytes + new TextEncoder().encode('\r\nqualification# ').length;
    assert.equal(read.bytes, expected);
    assert.equal(first.committedBytes, expected);
    assert.equal(first.state, 'complete');
    assert.equal(read.outcome?.completion, 'prompt-observed');
    capturedBytes += read.bytes;
    coverage.push('run-success');
    if (context.payloadBytes > 32 * 1024 ** 2) coverage.push('large-slow-capture');
    await page.evaluate(() => window.memoryProduct.serial.configure({ bytes: 64, delayMs: 0 }));
    await runProductOnce(page);
    rows = await page.evaluate(() => window.memoryProduct.catalog());
    const primaryRows = rows
        .filter((r) => r.command === command)
        .sort((a, b) => a.sequence - b.sequence);
    assert.equal(primaryRows.length, 2);
    await geometryRead(primaryRows[1].id, 64);
    coverage.push('same-generation-rearm');
    if (context.viewer) {
        const viewer = await exerciseProductViewer(page, context.nativeDownload);
        coverage.push(...viewer.coverage);
        exportedBytes += viewer.exportedBytes;
    }
    if (context.faults) {
        // Keep the primary captures' output-search token out of fault-only captures.
        await page.evaluate(() => window.memoryProduct.serial.configure({ tail: '' }));
        for (const [method, label] of [
            ['begin', 'start'],
            ['append', 'append'],
            ['seal', 'seal'],
            ['record', 'outcome'],
        ] as const) {
            await page.evaluate((m) => {
                window.memoryProduct.faults.arm(m, 'hold');
                window.memoryProduct.serial.configure({ bytes: 32768, delayMs: 0 });
            }, method);
            await setProductCommand(page, command + '-cancel-' + label);
            await flowOf(page).getByRole('button', { name: 'Run once', exact: true }).click();
            await page.waitForFunction(
                () => window.memoryProduct.faults.status()?.entered === true,
            );
            await flowOf(page).getByRole('button', { name: 'Cancel run', exact: true }).click();
            assert.equal(
                await page.evaluate(() => window.memoryProduct.runnerState().busy),
                true,
                'Runner published idle before the held real repository operation settled.',
            );
            await page.evaluate(() => window.memoryProduct.faults.release());
            await page.waitForFunction(() => !window.memoryProduct.runnerState().busy);
            await page.waitForFunction(() => {
                const s = window.memoryProduct.serial.snapshot();
                return !s.remaining && !s.promptPending && !s.pumping;
            });
            await page.evaluate(() => window.memoryProduct.faults.clear());
            coverage.push('cancel-' + label);
        }
        for (const [method, label] of [
            ['begin', 'quota-before-begin'],
            ['append', 'quota-append'],
        ] as const) {
            await page.evaluate((m) => {
                window.memoryProduct.faults.arm(m, 'quota');
                window.memoryProduct.serial.configure({ bytes: 32768, delayMs: 0 });
            }, method);
            const before = await page.evaluate(() => window.memoryProduct.serial.snapshot().sent);
            await setProductCommand(page, command + '-' + label);
            await flowOf(page).getByRole('button', { name: 'Run once', exact: true }).click();
            await page.waitForFunction(
                () =>
                    window.memoryProduct.faults.status()?.entered === true &&
                    !window.memoryProduct.runnerState().busy,
            );
            await page.waitForFunction(() => {
                const s = window.memoryProduct.serial.snapshot();
                return !s.remaining && !s.promptPending && !s.pumping;
            });
            const after = await page.evaluate(() => window.memoryProduct.serial.snapshot().sent);
            if (method === 'begin')
                assert.equal(after, before, 'Quota before begin sent command bytes.');
            const failed = await page.evaluate(() => window.memoryProduct.catalog());
            if (method === 'append')
                assert.ok(
                    failed.some(
                        (r) =>
                            r.command.endsWith(label) &&
                            r.state === 'incomplete' &&
                            r.failure?.code === 'quota',
                    ),
                );
            await page.evaluate(() => window.memoryProduct.faults.clear());
            coverage.push(label);
        }
    }
    await disconnectProductSerial(page);
    coverage.push('connect-disconnect');
    await expect(flowOf(page).locator('.automation-results')).toHaveAttribute('aria-busy', 'false');
    const ownership = await page.evaluate(() => window.memoryProduct.ownership());
    for (const [kind, count] of Object.entries(ownership.owners))
        assert.equal(count, 0, `Product ${kind} remains: ${JSON.stringify(ownership)}`);
    return {
        coverage,
        capturedBytes,
        exportedBytes,
        geometryEvidence,
        catalog: await page.evaluate(() => window.memoryProduct.catalog()),
        ownership,
    };
}
