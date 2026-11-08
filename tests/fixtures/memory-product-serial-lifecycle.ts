/** Page-driven Serial lifecycle facts. Uses only the primary private synthetic fixture. */
import assert from 'node:assert/strict';
import { expect, type Page } from '@playwright/test';

type Snapshot = {
    opens: number;
    closes: number;
    sent: number;
    produced: number;
    readerActive: boolean;
    writerActive: boolean;
    pumping: boolean;
    remaining: number;
    promptPending: boolean;
    heldOpen: boolean;
    heldWrite: boolean;
    events: { ordinal: number; event: string; bytes: number }[];
};
type Row = {
    id: string;
    command: string;
    state: string;
    committedBytes: number;
    observedBytes: number | null;
    failure?: { code: string; message: string } | null;
};
type Read = {
    bytes: number;
    frames: number;
    crcAndBoundariesVerified: boolean;
    streamBytes: { serial: number; stdout: number; stderr: number };
    outcome?: { completion: string; exitCode: number | null } | null;
};
type Api = {
    serial: {
        configure(mode: Record<string, unknown>): void;
        releaseOpen(): void;
        releaseWrite(): void;
        releaseOutput(): void;
        unplug(): void;
        snapshot(): Snapshot;
    };
    serialStatus(): { state: string; generation: number; isOwned: boolean };
    runnerState(): { busy: boolean; cleanupPending: boolean };
    catalog(): Promise<Row[]>;
    readSummary(id: string): Promise<Read>;
    unmount(): void;
    mount(): void;
};
export type ProductSerialLifecycleCase =
    | 'pending-open'
    | 'held-write-cancel'
    | 'timeout'
    | 'owner-loss'
    | 'stale-generation'
    | 'repeat-delay'
    | 'page-navigation'
    | 'unmount-remount';
const flow = (page: Page) => page.getByRole('region', { name: 'Automation', exact: true });
const setup = (page: Page, name: string) =>
    flow(page)
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(name) })
        .click();
const snapshot = (page: Page) =>
    page.evaluate(() =>
        (window as unknown as { memoryProduct: Api }).memoryProduct.serial.snapshot(),
    );
const status = (page: Page) =>
    page.evaluate(() => (window as unknown as { memoryProduct: Api }).memoryProduct.serialStatus());
const catalog = (page: Page) =>
    page.evaluate(() => (window as unknown as { memoryProduct: Api }).memoryProduct.catalog());
const runner = (page: Page) =>
    page.evaluate(() => (window as unknown as { memoryProduct: Api }).memoryProduct.runnerState());
const configure = (page: Page, mode: Record<string, unknown>) =>
    page.evaluate(
        (mode) =>
            (window as unknown as { memoryProduct: Api }).memoryProduct.serial.configure(mode),
        mode,
    );
const action = (page: Page, name: 'releaseOpen' | 'releaseWrite' | 'releaseOutput' | 'unplug') =>
    page.evaluate(
        (name) => (window as unknown as { memoryProduct: Api }).memoryProduct.serial[name](),
        name,
    );
const idle = (page: Page) =>
    page.waitForFunction(
        () => {
            const value = (window as unknown as { memoryProduct: Api }).memoryProduct.runnerState();
            return !value.busy && !value.cleanupPending;
        },
        undefined,
        { timeout: 120000 },
    );
const drained = (page: Page) =>
    page.waitForFunction(() => {
        const value = (window as unknown as { memoryProduct: Api }).memoryProduct.serial.snapshot();
        return (
            !value.pumping &&
            !value.remaining &&
            !value.promptPending &&
            !value.heldOpen &&
            !value.heldWrite
        );
    });
const closed = (page: Page) =>
    page.waitForFunction(() => {
        const api = (window as unknown as { memoryProduct: Api }).memoryProduct,
            value = api.serial.snapshot();
        return (
            value.opens === value.closes &&
            !value.readerActive &&
            !value.writerActive &&
            !value.pumping &&
            !value.heldOpen &&
            !value.heldWrite &&
            !api.serialStatus().isOwned
        );
    });

export function assertSerialLifecycleRead(row: Row, read: Read, completion: string) {
    assert.notEqual(row.state, 'active', 'Serial lifecycle left an active stored producer.');
    assert.equal(read.crcAndBoundariesVerified, true);
    assert.equal(read.bytes, row.committedBytes);
    assert.equal(read.streamBytes.serial, read.bytes);
    assert.equal(read.streamBytes.stdout, 0);
    assert.equal(read.streamBytes.stderr, 0);
    assert.ok(read.outcome, 'Serial lifecycle outcome is missing.');
    assert.equal(read.outcome.completion, completion);
    assert.equal(read.outcome.exitCode, null);
    if (completion === 'prompt-observed') {
        assert.equal(row.state, 'complete');
        assert.equal(row.observedBytes, read.bytes);
    }
    return {
        captureId: row.id,
        state: row.state,
        bytes: read.bytes,
        observedBytes: row.observedBytes,
        completion,
        exitCode: null,
        crcAndBoundariesVerified: true,
    };
}
async function openSerial(page: Page) {
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const region = page.getByRole('region', { name: 'Local serial terminal', exact: true });
    await region.getByLabel('Local serial port', { exact: true }).selectOption('0');
    await region.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(region.getByText('Ready', { exact: true })).toBeVisible();
    assert.equal((await status(page)).state, 'connected');
}
export function assertSerialLifecycleClosed(value: Snapshot, current: { isOwned: boolean }) {
    assert.equal(
        current.isOwned,
        false,
        'Public status alone did not join the actual Serial owner.',
    );
    assert.equal(value.opens, value.closes);
    for (const key of [
        'readerActive',
        'writerActive',
        'pumping',
        'heldOpen',
        'heldWrite',
        'promptPending',
    ] as const)
        assert.equal(value[key], false, 'Serial close left ' + key);
    assert.equal(value.remaining, 0);
}
async function closeSerial(page: Page) {
    await page.getByRole('button', { name: 'Serial', exact: true }).click();
    const current = await status(page);
    if (!current.isOwned || current.state === 'closing') {
        // Cancellation may already have started or completed the real Session.close().
        // A public selected/idle label alone never counts as a joined port.
        await closed(page);
        await drained(page);
        assertSerialLifecycleClosed(await snapshot(page), await status(page));
        return;
    }
    await page
        .getByRole('region', { name: 'Local serial terminal', exact: true })
        .getByRole('button', { name: 'Disconnect', exact: true })
        .click();
    await closed(page);
    await drained(page);
    assertSerialLifecycleClosed(await snapshot(page), await status(page));
}
async function prepare(
    page: Page,
    command: string,
    options: { timeout?: number; repeat?: boolean; second?: string } = {},
) {
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    await setup(page, 'Connection');
    await flow(page).getByLabel('Automation transport', { exact: true }).selectOption('serial');
    await flow(page)
        .getByLabel('Serial completion prompt', { exact: true })
        .fill('qualification# ');
    await flow(page)
        .getByLabel('Serial automation line ending', { exact: true })
        .selectOption('LF');
    await setup(page, 'Commands');
    const remove = flow(page).getByRole('button', { name: 'Remove', exact: true });
    while ((await remove.count()) > 1) await remove.last().click();
    await flow(page).getByLabel('Enabled', { exact: true }).check();
    await flow(page).getByLabel('Command 1 script', { exact: true }).fill(command);
    if (options.second) {
        await flow(page).getByRole('button', { name: 'Duplicate', exact: true }).click();
        await flow(page).getByLabel('Command 2 script', { exact: true }).fill(options.second);
        await flow(page)
            .getByLabel('Step 2 name (optional)', { exact: true })
            .fill('queued lifecycle step');
    }
    await setup(page, 'Timing');
    await flow(page)
        .getByLabel('Command timeout', { exact: true })
        .fill(String(options.timeout ?? 60));
    await flow(page).getByLabel('Run mode', { exact: true }).selectOption('immediate');
    await flow(page).getByLabel('Command 1 delay', { exact: true }).fill('0');
    if (options.second) await flow(page).getByLabel('Command 2 delay', { exact: true }).fill('3');
    if (options.repeat) {
        await flow(page).getByLabel('Repeat completed flow', { exact: true }).check();
        await flow(page).getByLabel('Repetition delay', { exact: true }).fill('1');
    } else await flow(page).getByLabel('Repeat completed flow', { exact: true }).uncheck();
    await setup(page, 'Review');
}
async function begin(page: Page, command: string, repeat = false) {
    const before = new Set((await catalog(page)).map((row) => row.id)),
        serial = await snapshot(page),
        sequence = serial.events.at(-1)?.ordinal ?? 0;
    await flow(page)
        .getByRole('button', { name: repeat ? 'Start flow' : 'Run once', exact: true })
        .click();
    await page.waitForFunction(
        (sequence) =>
            (window as unknown as { memoryProduct: Api }).memoryProduct.serial
                .snapshot()
                .events.some((event) => event.ordinal > sequence && event.event === 'write-start'),
        sequence,
    );
    return { before, serial, command, generation: (await status(page)).generation };
}
async function evidence(page: Page, run: Awaited<ReturnType<typeof begin>>, completion: string) {
    await idle(page);
    const rows = (await catalog(page)).filter(
        (row) => !run.before.has(row.id) && row.command === run.command,
    );
    assert.equal(rows.length, 1);
    const read = await page.evaluate(
        (id) => (window as unknown as { memoryProduct: Api }).memoryProduct.readSummary(id),
        rows[0].id,
    );
    return assertSerialLifecycleRead(rows[0], read, completion);
}
export async function exerciseProductSerialLifecycle(
    page: Page,
    context: {
        ordinal: number;
        cases?: readonly ProductSerialLifecycleCase[];
        emit?(stage: string, data: unknown): Promise<void>;
    },
) {
    const cases = context.cases ?? [
        'pending-open',
        'held-write-cancel',
        'timeout',
        'owner-loss',
        'stale-generation',
        'repeat-delay',
        'page-navigation',
        'unmount-remount',
    ];
    const known = [
        'pending-open',
        'held-write-cancel',
        'timeout',
        'owner-loss',
        'stale-generation',
        'repeat-delay',
        'page-navigation',
        'unmount-remount',
    ];
    for (const name of cases) assert.ok(known.includes(name), 'Unsupported Serial lifecycle case.');
    assert.ok(Number.isSafeInteger(context.ordinal) && context.ordinal >= 0);
    assert.equal(
        await page.evaluate(() => {
            const api = (window as unknown as { memoryProduct: Api }).memoryProduct;
            return (
                typeof api.serialStatus === 'function' &&
                typeof api.serial.releaseOutput === 'function'
            );
        }),
        true,
        'Primary Serial lifecycle hooks are missing.',
    );
    const receipts: { scenario: string; at: string; proof: Record<string, unknown> }[] = [];
    const receipt = async (scenario: string, proof: Record<string, unknown>) => {
        const value = { scenario, at: new Date().toISOString(), proof };
        receipts.push(value);
        await context.emit?.('actual-product-serial-lifecycle', value);
    };
    const normal = {
        bytes: 32,
        chunkBytes: 16384,
        delayMs: 0,
        prompt: 'qualification# ',
        holdOpen: false,
        holdWrite: false,
        stall: false,
    };
    // Caller must end any preceding operation; never hide an existing port owner by replacing it.
    const initial = await status(page);
    if (initial.isOwned) {
        await closeSerial(page);
    }
    await closed(page);
    for (const name of cases) {
        const command = 'serial-lifecycle-' + context.ordinal + '-' + name;
        await configure(page, normal);
        if (name === 'pending-open') {
            const before = await snapshot(page);
            await configure(page, { holdOpen: true });
            await page.getByRole('button', { name: 'Serial', exact: true }).click();
            const region = page.getByRole('region', { name: 'Local serial terminal', exact: true });
            await region.getByLabel('Local serial port', { exact: true }).selectOption('0');
            await region.getByRole('button', { name: 'Connect', exact: true }).click();
            await page.waitForFunction(
                () =>
                    (window as unknown as { memoryProduct: Api }).memoryProduct.serial.snapshot()
                        .heldOpen,
            );
            await region.getByRole('button', { name: 'Disconnect', exact: true }).click();
            assert.equal((await status(page)).isOwned, true);
            assert.equal((await snapshot(page)).closes, before.closes);
            await expect(
                region.getByRole('button', { name: 'Connect', exact: true }),
            ).toBeDisabled();
            await action(page, 'releaseOpen');
            await closed(page);
            const after = await snapshot(page);
            assert.equal(after.opens, before.opens + 1);
            assert.equal(after.closes, before.closes + 1);
            assert.equal(after.sent, before.sent);
            await receipt(name, { opens: 1, closes: 1, noEarlyClose: true, noCommandBytes: true });
            continue;
        }
        await openSerial(page);
        if (name === 'held-write-cancel') {
            await configure(page, { holdWrite: true });
            await prepare(page, command);
            const run = await begin(page, command);
            await page.waitForFunction(
                () =>
                    (window as unknown as { memoryProduct: Api }).memoryProduct.serial.snapshot()
                        .heldWrite,
            );
            await flow(page).getByRole('button', { name: 'Cancel run', exact: true }).click();
            await page.waitForFunction(() => {
                const api = (window as unknown as { memoryProduct: Api }).memoryProduct;
                const current = api.serialStatus();
                return current.state === 'closing' && current.isOwned;
            });
            const held = await snapshot(page);
            assert.equal(held.heldWrite, true);
            assert.equal(held.writerActive, true);
            assert.equal(
                held.closes,
                run.serial.closes,
                'Port acknowledged close before its held write settled.',
            );
            await expect(
                flow(page).getByRole('button', { name: 'Run once', exact: true }),
            ).toBeDisabled();
            await action(page, 'releaseWrite');
            await closed(page);
            const proof = await evidence(page, run, 'cancelled');
            await drained(page);
            await closeSerial(page);
            await receipt(name, {
                ...proof,
                joinedHeldWrite: true,
                rearmBlockedWhileHeld: true,
                actualPortClosed: true,
                automaticCloseJoined: true,
            });
        } else if (name === 'timeout') {
            await configure(page, { stall: true });
            await prepare(page, command, { timeout: 1 });
            const run = await begin(page, command);
            const proof = await evidence(page, run, 'timeout');
            await action(page, 'releaseOutput');
            await drained(page);
            await closeSerial(page);
            await receipt(name, { ...proof, configuredTimeoutSeconds: 1, actualPortClosed: true });
        } else if (name === 'owner-loss') {
            await configure(page, { stall: true });
            await prepare(page, command);
            const run = await begin(page, command);
            await action(page, 'unplug');
            await closed(page);
            const proof = await evidence(page, run, 'cancelled');
            assert.ok((await status(page)).generation > run.generation);
            await drained(page);
            await receipt(name, { ...proof, generationChanged: true, actualPortClosed: true });
        } else if (name === 'stale-generation') {
            const queued = command + '-queued';
            await prepare(page, command, { second: queued });
            const run = await begin(page, command);
            await expect(flow(page).locator('.automation-state')).toContainText('Delay before', {
                timeout: 10000,
            });
            const beforeLoss = await snapshot(page);
            await action(page, 'unplug');
            await closed(page);
            await idle(page);
            assert.equal((await snapshot(page)).sent, beforeLoss.sent);
            assert.ok(!(await catalog(page)).some((row) => row.command === queued));
            assert.ok((await status(page)).generation > run.generation);
            const proof = await evidence(page, run, 'prompt-observed');
            assert.equal(
                proof.bytes,
                normal.bytes + new TextEncoder().encode('\r\nqualification# ').length,
            );
            await drained(page);
            await receipt(name, {
                ...proof,
                queuedCommand: queued,
                noQueuedBytes: true,
                noQueuedCapture: true,
                generationChanged: true,
                runnerDisarmed: true,
            });
        } else if (name === 'repeat-delay') {
            await prepare(page, command, { repeat: true });
            const run = await begin(page, command, true);
            const deadline = Date.now() + 10000;
            let rows: Row[] = [];
            for (;;) {
                rows = (await catalog(page)).filter(
                    (row) =>
                        !run.before.has(row.id) &&
                        row.command === command &&
                        row.state !== 'active',
                );
                if (rows.length >= 2) break;
                assert.ok(Date.now() < deadline, 'Actual repeated flow did not commit twice.');
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await expect(flow(page).locator('.automation-state')).toContainText('Repetition delay');
            await flow(page).getByRole('button', { name: 'Cancel run', exact: true }).click();
            await idle(page);
            rows = (await catalog(page)).filter(
                (row) => !run.before.has(row.id) && row.command === command,
            );
            assert.equal(rows.length, 2);
            for (const row of rows) {
                const proof = assertSerialLifecycleRead(
                    row,
                    await page.evaluate(
                        (id) =>
                            (window as unknown as { memoryProduct: Api }).memoryProduct.readSummary(
                                id,
                            ),
                        row.id,
                    ),
                    'prompt-observed',
                );
                assert.equal(
                    proof.bytes,
                    normal.bytes + new TextEncoder().encode('\r\nqualification# ').length,
                );
            }
            await drained(page);
            await closeSerial(page);
            await receipt(name, {
                committedFlows: 2,
                repeatDelaySeconds: 1,
                noOverlap: true,
                actualPortClosed: true,
            });
        } else if (name === 'page-navigation') {
            await configure(page, { stall: true });
            await prepare(page, command);
            const run = await begin(page, command);
            await page.getByRole('button', { name: 'Overview', exact: true }).click();
            assert.equal((await runner(page)).busy, true);
            await page.getByRole('button', { name: 'Automation', exact: true }).click();
            assert.equal((await runner(page)).busy, true);
            await action(page, 'releaseOutput');
            await expect(flow(page).locator('.automation-state')).toContainText('Flow finished', {
                timeout: 10000,
            });
            const proof = await evidence(page, run, 'prompt-observed');
            assert.equal(
                proof.bytes,
                normal.bytes + new TextEncoder().encode('\r\nqualification# ').length,
            );
            await drained(page);
            await closeSerial(page);
            await receipt(name, { ...proof, continuedWhileHidden: true, actualPortClosed: true });
        } else {
            await configure(page, { stall: true });
            await prepare(page, command);
            const run = await begin(page, command);
            await page.evaluate(() =>
                (window as unknown as { memoryProduct: Api }).memoryProduct.unmount(),
            );
            await closed(page);
            const proof = await evidence(page, run, 'cancelled');
            await drained(page);
            await page.evaluate(() =>
                (window as unknown as { memoryProduct: Api }).memoryProduct.mount(),
            );
            await page.getByRole('button', { name: 'Serial', exact: true }).click();
            await expect(
                page.getByRole('region', { name: 'Local serial terminal', exact: true }),
            ).toBeVisible();
            await receipt(name, {
                ...proof,
                actualReactUnmount: true,
                oldPortClosed: true,
                actualReactRemount: true,
            });
        }
        await closed(page);
    }
    return {
        receipts,
        serial: await snapshot(page),
        status: await status(page),
        catalog: await catalog(page),
    };
}
