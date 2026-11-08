/** Actual App UI exercise. Fixture events corroborate product operations; they never replace them. */
import assert from 'node:assert/strict';
import { expect, type Page, type Request, type Response } from '@playwright/test';
import type { ProductGateway } from './memory-product-gateway';
import type { ProductTargetSnapshot } from './memory-product-gateway-target';
import type { AutomationOutcome } from '../../shared/automation-result';

type CatalogRow = {
    id: string;
    state: 'active' | 'complete' | 'incomplete';
    committedBytes: number;
    observedBytes: number | null;
    command: string;
    failure: { code: string; message: string } | null;
};
export type ProductSshRead = {
    bytes: number;
    frames: number;
    streamBytes: { stdout: number; stderr: number; serial: number };
    streamSamples: Record<string, number[]>;
    crcAndBoundariesVerified: boolean;
    outcome?: AutomationOutcome | null;
};
type ProductAppReadApi = {
    catalog(): Promise<CatalogRow[]>;
    readSummary(id: string): Promise<ProductSshRead>;
    runnerState(): { busy: boolean; cleanupPending: boolean };
    serial: {
        snapshot(): {
            opens: number;
            closes: number;
            sent: number;
            readerActive: boolean;
            writerActive: boolean;
            pumping: boolean;
        };
    };
};
export type ProductSshScenario =
    | 'stream'
    | 'serial-to-ssh'
    | 'manual-pty'
    | 'page-navigation'
    | 'server-loss-rearm'
    | 'client-reload-rearm';
export type ProductSshReceipt = {
    scenario: string;
    at: string;
    proof: Record<string, unknown>;
};
type RouteCounts = Record<
    'start' | 'read' | 'ack' | 'finalize' | 'cancel' | 'legacy' | 'failedResponses',
    number
>;
const flow = (page: Page) => page.getByRole('region', { name: 'Automation', exact: true });
const setup = (page: Page, name: string) =>
    flow(page)
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(name) })
        .click();
const catalog = (page: Page) =>
    page.evaluate(() =>
        (window as unknown as { memoryProduct: ProductAppReadApi }).memoryProduct.catalog(),
    );
const summary = (page: Page, id: string) =>
    page.evaluate(
        (id) =>
            (window as unknown as { memoryProduct: ProductAppReadApi }).memoryProduct.readSummary(
                id,
            ),
        id,
    );
const runner = (page: Page) =>
    page.evaluate(() =>
        (window as unknown as { memoryProduct: ProductAppReadApi }).memoryProduct.runnerState(),
    );
const serialState = (page: Page) =>
    page.evaluate(() =>
        (window as unknown as { memoryProduct: ProductAppReadApi }).memoryProduct.serial.snapshot(),
    );
const idle = (page: Page) =>
    page.waitForFunction(
        () => {
            const state = (
                window as unknown as { memoryProduct: ProductAppReadApi }
            ).memoryProduct.runnerState();
            return !state.busy && !state.cleanupPending;
        },
        undefined,
        { timeout: 120000 },
    );

/** Require complete verified raw storage, genuine exit and both original stream identities. */
export function assertProductSshRead(
    row: CatalogRow,
    read: ProductSshRead,
    expected: { stdout: number; stderr: number },
) {
    assert.equal(row.state, 'complete', 'SSH storage is not complete.');
    assert.equal(
        read.crcAndBoundariesVerified,
        true,
        'Pinned metadata/CRC/boundary verifier is missing.',
    );
    assert.equal(read.bytes, expected.stdout + expected.stderr);
    assert.equal(row.committedBytes, read.bytes);
    assert.equal(row.observedBytes, read.bytes);
    assert.ok(Number.isSafeInteger(read.frames) && read.frames > 0);
    assert.deepEqual(read.streamBytes, {
        stdout: expected.stdout,
        stderr: expected.stderr,
        serial: 0,
    });
    for (const [stream, byte, length] of [
        ['stdout', 65, expected.stdout],
        ['stderr', 66, expected.stderr],
    ] as const) {
        assert.deepEqual(
            read.streamSamples[stream],
            Array(Math.min(32, length)).fill(byte),
            'Raw ' + stream + ' prefix differs from the actual target byte program.',
        );
    }
    assert.ok(read.outcome, 'Stored command outcome is missing.');
    assert.equal(read.outcome.completion, 'exit');
    assert.equal(read.outcome.exitCode, 0);
    assert.equal(
        read.outcome.truncated,
        false,
        'A truncated preview cannot stand in for full stored output.',
    );
    return {
        captureId: row.id,
        bytes: read.bytes,
        frames: read.frames,
        streamBytes: read.streamBytes,
        crcAndBoundariesVerified: true,
        completion: read.outcome.completion,
        exitCode: read.outcome.exitCode,
    };
}
export function assertProductSshStreamRoutes(counts: RouteCounts) {
    assert.equal(
        counts.legacy,
        0,
        'Legacy /automation traffic is not independent streaming proof.',
    );
    assert.equal(counts.failedResponses, 0, 'Streaming RPC returned a failing HTTP status.');
    for (const action of ['start', 'read', 'ack', 'finalize'] as const)
        assert.ok(counts[action] > 0, 'Missing actual streaming ' + action + ' response.');
}
export function assertInterruptedProductSshRead(row: CatalogRow, read: ProductSshRead) {
    assert.ok(
        row.state === 'complete' || row.state === 'incomplete',
        'Interrupted capture still has an active storage owner.',
    );
    assert.equal(read.crcAndBoundariesVerified, true);
    if (read.outcome) {
        assert.ok(
            [
                'cancelled',
                'transport-error',
                'uncertain-close',
                'storage-error',
                'timeout',
            ].includes(read.outcome.completion),
            'Interrupted independent script published success or unrelated completion.',
        );
        assert.equal(read.outcome.exitCode, null, 'Interruption fabricated a command exit code.');
    } else
        assert.equal(
            row.state,
            'incomplete',
            'Missing interruption outcome requires explicit incomplete storage.',
        );
}
function watchStreaming(page: Page) {
    const counts: RouteCounts = {
        start: 0,
        read: 0,
        ack: 0,
        finalize: 0,
        cancel: 0,
        legacy: 0,
        failedResponses: 0,
    };
    const requested = (request: Request) => {
        if (
            request.method() === 'POST' &&
            /\/api\/sessions\/[^/]+\/automation$/.test(new URL(request.url()).pathname)
        )
            counts.legacy++;
    };
    const responded = (response: Response) => {
        const action = new URL(response.url()).pathname.match(
            /\/api\/sessions\/[^/]+\/automation\/stream\/(start|read|ack|finalize|cancel)$/,
        )?.[1] as keyof RouteCounts | undefined;
        if (!action || response.request().method() !== 'POST') return;
        if (response.status() >= 200 && response.status() < 300) counts[action]++;
        else counts.failedResponses++;
    };
    page.on('request', requested);
    page.on('response', responded);
    return {
        counts,
        dispose() {
            page.off('request', requested);
            page.off('response', responded);
        },
    };
}

export async function connectProductSsh(
    page: Page,
    gateway: ProductGateway,
    gatewayUrl = new URL(page.url()).origin,
) {
    assert.equal(
        new URL(gatewayUrl).origin,
        new URL(page.url()).origin,
        'Use the primary same-origin proxy; do not weaken shipping CSP.',
    );
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    const connected = page.locator('.connection-button[data-connection="connected"]');
    if (await connected.count()) {
        await expect(connected).toBeEnabled();
        await connected.click();
        await expect(page.locator('.connection-button')).toHaveAttribute(
            'data-connection',
            'disconnected',
        );
    }
    await page.getByRole('button', { name: 'Connect device', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Connect a Linux device', exact: true });
    await expect(modal).toBeVisible();
    const options = gateway.descriptor.options;
    assert.equal(options.auth, 'password');
    assert.ok(options.password && options.expectedFingerprint);
    await modal.getByLabel('Gateway HTTPS address', { exact: true }).fill(gatewayUrl);
    await modal.getByLabel('Gateway access token', { exact: true }).fill(gateway.descriptor.token);
    await modal.getByLabel('Hostname or IP address', { exact: true }).fill(options.host);
    await modal.getByLabel('Port', { exact: true }).fill(String(options.port));
    await modal.getByLabel('SSH username', { exact: true }).fill(options.username);
    await modal.getByLabel('Authentication', { exact: true }).selectOption('password');
    await modal.getByLabel('Password', { exact: true }).fill(options.password);
    await modal.getByRole('button', { name: 'Read fingerprint', exact: true }).click();
    await expect(modal.locator('.fingerprint-panel code')).toHaveText(options.expectedFingerprint);
    await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
    await modal.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    await expect(modal).not.toBeVisible({ timeout: 120000 });
    await expect(connected).toBeVisible();
    await expect(connected).toBeEnabled({ timeout: 120000 });
    const live = page.getByRole('switch', { name: 'Live updates', exact: true });
    if ((await live.getAttribute('aria-checked')) === 'true') await live.click();
    await expect(live).toHaveAttribute('aria-checked', 'false');
    return {
        reused: false,
        endpoint: options.host + ':' + options.port,
        fingerprint: options.expectedFingerprint,
        gatewayOrigin: new URL(gatewayUrl).origin,
    };
}
async function selectIndependent(page: Page, command: string) {
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    await setup(page, 'Connection');
    await flow(page).getByLabel('Automation transport', { exact: true }).selectOption('ssh');
    await flow(page)
        .getByLabel('SSH execution mode', { exact: true })
        .selectOption('independent-script');
    await setup(page, 'Commands');
    const removes = flow(page).getByRole('button', { name: 'Remove', exact: true });
    while ((await removes.count()) > 1) await removes.last().click();
    await flow(page).getByLabel('Enabled', { exact: true }).check();
    await flow(page).getByLabel('Command 1 script', { exact: true }).fill(command);
    await setup(page, 'Timing');
    await flow(page).getByLabel('Command timeout', { exact: true }).fill('60');
    await flow(page).getByLabel('Command 1 delay', { exact: true }).fill('0');
    await flow(page).getByLabel('Run mode', { exact: true }).selectOption('immediate');
    await flow(page).getByLabel('Repeat completed flow', { exact: true }).uncheck();
    await flow(page).getByLabel('Capture device time', { exact: true }).uncheck();
    await setup(page, 'Review');
}
async function runOnce(page: Page) {
    const button = flow(page).getByRole('button', { name: 'Run once', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
}
async function targetUntil(
    gateway: ProductGateway,
    predicate: (value: ProductTargetSnapshot) => boolean,
) {
    const deadline = Date.now() + 10000;
    for (;;) {
        const value = await gateway.control({ action: 'snapshot' });
        if (predicate(value)) return value;
        assert.ok(Date.now() < deadline, 'Actual SSH fixture event boundary not observed.');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
async function newCapture(page: Page, before: Set<string>, command: string) {
    const rows = await catalog(page),
        matches = rows.filter((row) => !before.has(row.id) && row.command === command);
    assert.equal(matches.length, 1, 'Expected exactly one actual stored command capture.');
    return matches[0];
}

export async function exerciseProductSsh(
    page: Page,
    gateway: ProductGateway,
    context: {
        ordinal: number;
        payloadBytes: number;
        gatewayUrl?: string;
        scenarios?: readonly ProductSshScenario[];
        disconnect?: boolean;
        afterReload?(): Promise<void>;
        emit?(stage: string, data: unknown): Promise<void>;
    },
) {
    assert.ok(Number.isSafeInteger(context.ordinal) && context.ordinal >= 0);
    assert.ok(
        Number.isSafeInteger(context.payloadBytes) &&
            context.payloadBytes >= 4 &&
            context.payloadBytes <= 128 * 1024 ** 2,
    );
    const scenarios = new Set(
        context.scenarios ?? [
            'stream',
            'serial-to-ssh',
            'manual-pty',
            'page-navigation',
            'server-loss-rearm',
        ],
    );
    const allowed = [
        'stream',
        'serial-to-ssh',
        'manual-pty',
        'page-navigation',
        'server-loss-rearm',
        'client-reload-rearm',
    ];
    for (const scenario of scenarios)
        assert.ok(allowed.includes(scenario), 'Unsupported SSH UI scenario: ' + scenario);
    const receipts: ProductSshReceipt[] = [],
        captureIds: string[] = [];
    let capturedBytes = 0;
    const receipt = async (scenario: string, proof: Record<string, unknown>) => {
        const value = { scenario, at: new Date().toISOString(), proof };
        receipts.push(value);
        await context.emit?.('actual-product-ssh-ui', value);
    };
    await receipt('connect-modal', await connectProductSsh(page, gateway, context.gatewayUrl));
    const prefix = 'ssh-ui-' + context.ordinal;
    const expected = {
        stdout: context.payloadBytes - Math.min(16384, Math.floor(context.payloadBytes / 4)),
        stderr: Math.min(16384, Math.floor(context.payloadBytes / 4)),
    };
    let manualChannel: number | undefined;
    if (scenarios.has('serial-to-ssh')) {
        const serial = await serialState(page);
        assert.ok(
            serial.opens > 0 && serial.sent > 0,
            'Serial→SSH proof needs a preceding actual Serial UI exercise.',
        );
        await page.getByRole('button', { name: 'Automation', exact: true }).click();
        await setup(page, 'Connection');
        await flow(page).getByLabel('Automation transport', { exact: true }).selectOption('serial');
        await expect(flow(page).getByLabel('Automation transport', { exact: true })).toHaveValue(
            'serial',
        );
        await flow(page).getByLabel('Automation transport', { exact: true }).selectOption('ssh');
        await expect(flow(page).getByLabel('Automation transport', { exact: true })).toHaveValue(
            'ssh',
        );
        await receipt('serial-to-ssh-selection', {
            serialOpens: serial.opens,
            serialSent: serial.sent,
            selected: 'ssh',
        });
    }
    if (scenarios.has('manual-pty')) {
        const command = prefix + '-manual',
            before = new Set((await catalog(page)).map((row) => row.id));
        const checkpoint = await gateway.control({ action: 'snapshot' }),
            afterSequence = checkpoint.events.at(-1)?.sequence ?? 0;
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        const terminal = page.getByRole('region', {
            name: 'Connected device terminal',
            exact: true,
        });
        await expect(terminal.getByRole('status')).toHaveText('Ready', { timeout: 30000 });
        const input = terminal.getByLabel('Device terminal input', { exact: true });
        await input.focus();
        await input.pressSequentially(command);
        await input.press('Enter');
        const target = await targetUntil(gateway, (value) =>
            value.events.some(
                (event) =>
                    event.sequence > afterSequence &&
                    event.type === 'shell-command' &&
                    event.command === command,
            ),
        );
        manualChannel = target.events.find(
            (event) =>
                event.sequence > afterSequence &&
                event.type === 'shell-command' &&
                event.command === command,
        )!.channel;
        assert.ok(manualChannel);
        assert.deepEqual(
            (await catalog(page)).map((row) => row.id).sort(),
            [...before].sort(),
            'Manual PTY output entered automation capture storage.',
        );
        const owners = await gateway.snapshotOwners();
        assert.ok(owners.product.allSessionOwners.some((owner) => owner.terminals.length === 1));
        await receipt('manual-pty', { channel: manualChannel, command, catalogUnchanged: true });
    }
    const completeRun = async (command: string, bytes: { stdout: number; stderr: number }) => {
        const armed = await gateway.control({
            action: 'program',
            program: {
                command,
                stdoutBytes: bytes.stdout,
                stderrBytes: bytes.stderr,
                chunkBytes: 16384,
                delayMs: 1,
            },
        });
        const afterSequence = armed.events.at(-1)?.sequence ?? 0;
        const before = new Set((await catalog(page)).map((row) => row.id)),
            serialBefore = await serialState(page);
        await selectIndependent(page, command);
        const observed = watchStreaming(page);
        try {
            await runOnce(page);
            await targetUntil(gateway, (value) =>
                value.events.some(
                    (event) =>
                        event.sequence > afterSequence &&
                        event.type === 'program-start' &&
                        event.command === command,
                ),
            );
            await expect(flow(page).locator('.automation-state')).toContainText('Flow finished', {
                timeout: 120000,
            });
            await idle(page);
            const row = await newCapture(page, before, command),
                read = await summary(page, row.id);
            const proof = assertProductSshRead(row, read, bytes);
            assertProductSshStreamRoutes(observed.counts);
            const target = await targetUntil(gateway, (value) =>
                value.events.some(
                    (event) =>
                        event.sequence > afterSequence &&
                        event.type === 'program-complete' &&
                        event.command === command,
                ),
            );
            const exec = target.events.find(
                (event) =>
                    event.sequence > afterSequence &&
                    event.type === 'exec-command' &&
                    event.command === command,
            );
            assert.ok(exec?.channel);
            if (manualChannel)
                assert.notEqual(
                    exec.channel,
                    manualChannel,
                    'Independent script reused the manual shell channel.',
                );
            const serialAfter = await serialState(page);
            assert.equal(
                serialAfter.sent,
                serialBefore.sent,
                'SSH automation wrote to the Serial transport.',
            );
            captureIds.push(row.id);
            capturedBytes += read.bytes;
            return {
                ...proof,
                command,
                channel: exec.channel,
                manualChannel: manualChannel ?? null,
                routes: { ...observed.counts },
                serialSentUnchanged: true,
            };
        } finally {
            observed.dispose();
        }
    };
    // A requested switch/manual scenario also needs one real independent capture to prove isolation.
    if (scenarios.has('stream') || scenarios.has('serial-to-ssh') || scenarios.has('manual-pty'))
        await receipt('independent-stream-stored', await completeRun(prefix + '-stream', expected));
    const interrupted = async (command: string) => {
        const armed = await gateway.control({
            action: 'program',
            program: { command, stdoutBytes: 128, stall: true },
        });
        const afterSequence = armed.events.at(-1)?.sequence ?? 0;
        const before = new Set((await catalog(page)).map((row) => row.id));
        await selectIndependent(page, command);
        const observed = watchStreaming(page);
        try {
            await runOnce(page);
            await targetUntil(
                gateway,
                (value) =>
                    value.owners.outputGates > 0 &&
                    value.events.some(
                        (event) =>
                            event.sequence > afterSequence &&
                            event.type === 'program-start' &&
                            event.command === command,
                    ),
            );
            assert.equal((await runner(page)).busy, true);
            assert.equal(observed.counts.legacy, 0);
            assert.ok(observed.counts.start > 0);
            const ownership = await gateway.snapshotOwners();
            assert.ok(
                ownership.product.allSessionOwners.some((owner) => owner.streams.producers > 0),
                'Actual streaming producer ownership is missing.',
            );
            await receipt('stream-active-before-interruption', {
                command,
                routes: { ...observed.counts },
                runnerBusy: true,
            });
        } finally {
            observed.dispose();
        }
        return before;
    };
    const interruptedProof = async (before: Set<string>, command: string) => {
        await idle(page);
        const row = await newCapture(page, before, command),
            read = await summary(page, row.id);
        assertInterruptedProductSshRead(row, read);
        captureIds.push(row.id);
        return {
            captureId: row.id,
            state: row.state,
            observedBytes: row.observedBytes,
            committedBytes: row.committedBytes,
            completion: read.outcome?.completion ?? null,
            exitCode: read.outcome?.exitCode ?? null,
            failure: row.failure,
        };
    };
    if (scenarios.has('page-navigation')) {
        const command = prefix + '-navigate',
            observed = watchStreaming(page);
        try {
            const before = await interrupted(command);
            await page.getByRole('button', { name: 'Overview', exact: true }).click();
            assert.equal(
                (await runner(page)).busy,
                true,
                'Page navigation unexpectedly ended the live runner.',
            );
            const away = await gateway.snapshotOwners();
            assert.ok(away.product.allSessionOwners.some((owner) => owner.streams.producers > 0));
            assert.equal(away.target.owners.outputGates, 1);
            await page.getByRole('button', { name: 'Automation', exact: true }).click();
            assert.equal((await runner(page)).busy, true);
            await gateway.control({ action: 'release-output' });
            await expect(flow(page).locator('.automation-state')).toContainText('Flow finished', {
                timeout: 120000,
            });
            await idle(page);
            const row = await newCapture(page, before, command),
                read = await summary(page, row.id);
            const proof = assertProductSshRead(row, read, { stdout: 128, stderr: 0 });
            assertProductSshStreamRoutes(observed.counts);
            captureIds.push(row.id);
            capturedBytes += read.bytes;
            await receipt('page-navigation-live', {
                ...proof,
                continuedWhileHidden: true,
                routes: { ...observed.counts },
            });
        } finally {
            observed.dispose();
        }
        await receipt(
            'navigation-explicit-rearm',
            await completeRun(prefix + '-navigate-rearm', { stdout: 64, stderr: 32 }),
        );
    }
    if (scenarios.has('server-loss-rearm')) {
        const command = prefix + '-server-loss',
            before = await interrupted(command);
        await gateway.control({ action: 'disconnect-clients' });
        await idle(page);
        await receipt('server-connection-loss', await interruptedProof(before, command));
        manualChannel = undefined;
        await receipt(
            'server-loss-reconnect',
            await connectProductSsh(page, gateway, context.gatewayUrl),
        );
        await receipt(
            'server-loss-explicit-rearm',
            await completeRun(prefix + '-server-rearm', { stdout: 64, stderr: 32 }),
        );
    }
    if (scenarios.has('client-reload-rearm')) {
        const command = prefix + '-client-reload',
            before = await interrupted(command);
        await page.reload();
        await page.waitForFunction(() =>
            Boolean((window as unknown as { memoryProduct?: ProductAppReadApi }).memoryProduct),
        );
        await context.afterReload?.();
        // Opening catalog runs the real repository recovery after actual world destruction.
        const row = await newCapture(page, before, command);
        assert.equal(row.state, 'incomplete');
        assert.equal(row.observedBytes, null);
        const read = await summary(page, row.id);
        assert.equal(read.crcAndBoundariesVerified, true);
        assert.notEqual(read.outcome?.completion, 'exit');
        captureIds.push(row.id);
        await receipt('client-reload-loss', {
            captureId: row.id,
            state: row.state,
            observedBytes: row.observedBytes,
            committedBytes: row.committedBytes,
            actualNavigation: true,
        });
        manualChannel = undefined;
        await receipt(
            'client-reload-reconnect',
            await connectProductSsh(page, gateway, context.gatewayUrl),
        );
        await receipt(
            'client-reload-explicit-rearm',
            await completeRun(prefix + '-client-rearm', { stdout: 64, stderr: 32 }),
        );
    }
    if (context.disconnect !== false) {
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        const button = page.getByRole('button', { name: 'Disconnect device', exact: true });
        await expect(button).toBeEnabled();
        await button.click();
        await expect(page.locator('.connection-button')).toHaveAttribute(
            'data-connection',
            'disconnected',
        );
        const target = await targetUntil(gateway, (value) =>
            Object.values(value.owners).every((count) => count === 0),
        );
        const owners = await gateway.snapshotOwners();
        assert.equal(owners.product.ownedSessions, 0);
        assert.equal(owners.product.retiringSessions, 0);
        assert.deepEqual(owners.product.allSessionOwners, []);
        await receipt('ui-disconnect-joined', {
            productOwnedSessions: 0,
            retiringSessions: 0,
            targetOwners: target.owners,
        });
    }
    return { receipts, capturedBytes, captureIds, catalog: await catalog(page) };
}
