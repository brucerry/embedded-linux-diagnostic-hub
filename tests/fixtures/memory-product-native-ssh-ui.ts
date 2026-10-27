/** Actual desktop UI/IPC exercise. HTTP gateway routes are not native streaming evidence. */
import assert from 'node:assert/strict';
import { expect, type Page } from '@playwright/test';
import type { ProductGateway } from './memory-product-gateway';
import type { ProductTargetSnapshot } from './memory-product-gateway-target';
import {
    assertProductSshRead,
    assertInterruptedProductSshRead,
    type ProductSshRead,
} from './memory-product-ssh-ui';

type Row = Parameters<typeof assertProductSshRead>[0];
type App = {
    catalog(): Promise<Row[]>;
    readSummary(id: string): Promise<ProductSshRead>;
    runnerState(): { busy: boolean; cleanupPending: boolean };
    serial: { snapshot(): { sent: number; opens: number } };
};
type RecordValue = Record<string, unknown>;
export type NativeProductSshTrust = {
    source: 'actual-native-host-dialog';
    endpoint: string;
    fingerprint: string;
};
export type NativeProductSshScenario =
    'stream' | 'manual-pty' | 'page-navigation' | 'server-loss-rearm' | 'client-reload-rearm';
const streamFields = [
    'currentStates',
    'retiringStates',
    'producers',
    'readers',
    'pendingAcks',
    'pendingDataBytes',
    'shutdownWaiters',
] as const;
const captureFields = ['writer', 'reader', 'pin', 'export', 'rpc', 'cleanup'] as const;
function object(value: unknown, name: string): RecordValue {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), name + ' missing.');
    return value as RecordValue;
}
function field(value: RecordValue, key: string) {
    assert.ok(Object.hasOwn(value, key), 'Native SSH fact absent: ' + key);
    return value[key];
}
function count(value: unknown, name: string) {
    assert.ok(
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
        name + ' malformed.',
    );
    return value as number;
}
export function assertNativeProductTarget(options: ProductGateway['descriptor']['options']) {
    assert.ok(
        ['127.0.0.1', '::1'].includes(options.host),
        'Only the actual owned loopback target is allowed.',
    );
    assert.ok(Number.isSafeInteger(options.port) && options.port > 0 && options.port <= 65535);
    assert.equal(options.auth, 'password');
    assert.ok(options.username && options.password && options.expectedFingerprint);
    assert.match(options.expectedFingerprint, /^SHA256:[A-Za-z0-9+/]{43}=?$/);
    return {
        endpoint: options.host + ':' + options.port,
        fingerprint: options.expectedFingerprint,
    };
}
export function assertNativeProductTrust(
    trust: NativeProductSshTrust,
    expected: { endpoint: string; fingerprint: string },
) {
    assert.equal(trust?.source, 'actual-native-host-dialog');
    assert.equal(trust.endpoint, expected.endpoint);
    assert.equal(trust.fingerprint, expected.fingerprint);
    return trust;
}
function facts(value: unknown) {
    const snapshot = object(value, 'Actual native main snapshot'),
        ssh = object(field(snapshot, 'ssh'), 'ssh'),
        streams = object(field(ssh, 'streams'), 'streams');
    assert.equal(typeof field(snapshot, 'sshHasResources'), 'boolean');
    assert.equal(typeof field(ssh, 'connected'), 'boolean');
    assert.equal(typeof field(ssh, 'collecting'), 'boolean');
    for (const key of ['connections', 'terminals'])
        assert.ok(Array.isArray(field(ssh, key)), key + ' missing.');
    for (const key of ['pendingOperations', 'independentExecution', 'consoleActor', 'clockRead'])
        count(field(ssh, key), key);
    for (const key of streamFields) count(field(streams, key), 'streams.' + key);
    for (const key of Object.keys(streams))
        assert.ok(
            (streamFields as readonly string[]).includes(key),
            'Unassessed native stream owner: ' + key,
        );
    const slots = object(field(ssh, 'execSlots'), 'execSlots');
    count(field(slots, 'active'), 'execSlots.active');
    count(field(slots, 'queued'), 'execSlots.queued');
    for (const key of Object.keys(slots))
        assert.ok(['active', 'queued'].includes(key), 'Unassessed native exec owner: ' + key);
    const capture = object(field(snapshot, 'capture'), 'Native capture host'),
        owners = object(field(capture, 'owners'), 'Native capture owners');
    for (const key of captureFields) count(field(owners, key), 'capture.' + key);
    for (const key of Object.keys(owners))
        assert.ok(
            (captureFields as readonly string[]).includes(key),
            'Unassessed native raw owner: ' + key,
        );
    return { snapshot, ssh, streams, slots, owners };
}
export function assertNativeProductSshActive(value: unknown) {
    const f = facts(value);
    assert.equal(f.snapshot.sshHasResources, true);
    assert.equal(f.ssh.connected, true);
    assert.equal(f.ssh.independentExecution, 1);
    assert.equal(
        f.ssh.consoleActor,
        0,
        'Native console mode cannot stand in for independent script.',
    );
    assert.equal(
        f.streams.currentStates,
        1,
        'Actual native independent stream state is absent or overlapping.',
    );
    assert.equal(
        f.streams.producers,
        1,
        'Actual native independent stream producer is absent or overlapping.',
    );
    assert.ok((f.owners.writer as number) > 0, 'Actual native raw writer is absent.');
    return {
        independentExecution: f.ssh.independentExecution,
        streams: { ...f.streams },
        captureOwners: { ...f.owners },
    };
}
export function assertNativeProductSshReleased(value: unknown, disconnected: boolean) {
    const f = facts(value);
    assert.equal(f.ssh.collecting, false);
    for (const key of ['pendingOperations', 'independentExecution', 'consoleActor', 'clockRead'])
        assert.equal(f.ssh[key], 0, 'Native SSH operation remains: ' + key);
    for (const key of streamFields)
        assert.equal(f.streams[key], 0, 'Native SSH stream remains: ' + key);
    assert.equal(f.slots.active, 0);
    assert.equal(f.slots.queued, 0);
    for (const key of captureFields)
        assert.equal(f.owners[key], 0, 'Native raw owner remains: ' + key);
    if (disconnected) {
        assert.equal(f.snapshot.sshHasResources, false);
        assert.equal(f.ssh.connected, false);
        assert.deepEqual(f.ssh.connections, []);
        assert.deepEqual(f.ssh.terminals, []);
        assert.equal(field(f.ssh, 'terminal'), null);
    } else {
        assert.equal(f.ssh.connected, true);
        assert.equal(f.snapshot.sshHasResources, true);
    }
    return { disconnected, ssh: f.ssh, captureOwners: { ...f.owners } };
}
export function assertNativeProductSshLoss(row: Row, read: ProductSshRead) {
    assertInterruptedProductSshRead(row, read);
    assert.equal(read.bytes, 0, 'Stalled target emitted bytes before actual loss.');
    assert.equal(row.committedBytes, 0);
    assert.equal(read.frames, 0);
    assert.deepEqual(read.streamBytes, { stdout: 0, stderr: 0, serial: 0 });
    assert.notEqual(
        read.outcome?.completion,
        'timeout',
        'An ordinary deadline is not target-loss evidence.',
    );
    return {
        captureId: row.id,
        state: row.state,
        observedBytes: row.observedBytes,
        committedBytes: row.committedBytes,
        completion: read.outcome?.completion ?? null,
        exitCode: read.outcome?.exitCode ?? null,
        failure: row.failure,
        crcAndBoundariesVerified: true,
    };
}

const flow = (page: Page) => page.getByRole('region', { name: 'Automation', exact: true });
const setup = (page: Page, name: string) =>
    flow(page)
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(name) })
        .click();
const catalog = (page: Page) =>
    page.evaluate(() => (window as unknown as { memoryProduct: App }).memoryProduct.catalog());
const read = (page: Page, id: string) =>
    page.evaluate(
        (id) => (window as unknown as { memoryProduct: App }).memoryProduct.readSummary(id),
        id,
    );
const runner = (page: Page) =>
    page.evaluate(() => (window as unknown as { memoryProduct: App }).memoryProduct.runnerState());
const serial = (page: Page) =>
    page.evaluate(() =>
        (window as unknown as { memoryProduct: App }).memoryProduct.serial.snapshot(),
    );
const connection = (page: Page) =>
    page.evaluate(() => window.diagnosticHub!.automationConnection!());
const idle = (page: Page) =>
    page.waitForFunction(
        () => {
            const s = (window as unknown as { memoryProduct: App }).memoryProduct.runnerState();
            return !s.busy && !s.cleanupPending;
        },
        undefined,
        { timeout: 120000 },
    );
async function targetUntil(
    gateway: ProductGateway,
    predicate: (value: ProductTargetSnapshot) => boolean,
) {
    const deadline = Date.now() + 10000;
    for (;;) {
        const value = await gateway.control({ action: 'snapshot' });
        if (predicate(value)) return value;
        assert.ok(Date.now() < deadline, 'Actual owned target boundary not observed.');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
const targetProgramsIdle = (value: ProductTargetSnapshot) =>
    (['pumps', 'pendingOpen', 'pendingWriteCallbacks', 'delays', 'outputGates'] as const).every(
        (key) => value.owners[key] === 0,
    );
async function mainUntil(snapshot: () => Promise<unknown>, accept: (value: unknown) => unknown) {
    const deadline = Date.now() + 10000;
    let last: unknown;
    for (;;) {
        const value = await snapshot();
        try {
            accept(value);
            return value;
        } catch (error) {
            last = error;
        }
        if (Date.now() >= deadline) throw last;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
async function uniqueCapture(page: Page, before: Set<string>, command: string) {
    const rows = (await catalog(page)).filter(
        (row) => !before.has(row.id) && row.command === command,
    );
    assert.equal(rows.length, 1, 'Expected exactly one new actual native raw capture.');
    return rows[0];
}
async function prepare(page: Page, command: string) {
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
async function run(page: Page) {
    const button = flow(page).getByRole('button', { name: 'Run once', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
}

export async function connectProductNativeSsh(
    page: Page,
    gateway: ProductGateway,
    previousTrust?: NativeProductSshTrust,
) {
    const expected = assertNativeProductTarget(gateway.descriptor.options);
    if (previousTrust) assertNativeProductTrust(previousTrust, expected);
    assert.equal(
        new URL(page.url()).protocol,
        'app:',
        'Actual desktop app:// renderer is required.',
    );
    assert.equal(
        await page.evaluate(
            () =>
                typeof window.diagnosticHub?.connect === 'function' &&
                typeof window.diagnosticHub?.automationStream === 'function' &&
                typeof window.diagnosticHub?.automationConnection === 'function',
        ),
        true,
        'Actual native preload bridge is absent.',
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
    await expect(modal.getByLabel('Gateway HTTPS address', { exact: true })).toHaveCount(0);
    const options = gateway.descriptor.options;
    await modal.getByLabel('Hostname or IP address', { exact: true }).fill(options.host);
    await modal.getByLabel('Port', { exact: true }).fill(String(options.port));
    await modal.getByLabel('SSH username', { exact: true }).fill(options.username);
    await modal.getByLabel('Authentication', { exact: true }).selectOption('password');
    await modal.getByLabel('Password', { exact: true }).fill(options.password!);
    await modal.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
    const verification = modal.getByRole('alertdialog');
    let approved = false;
    const deadline = Date.now() + 120000;
    while (await modal.isVisible()) {
        if (await verification.isVisible()) {
            assert.equal(approved, false, 'Unexpected additional host-verification handshake.');
            await expect(
                verification.locator('.host-fingerprint').last().locator('code'),
            ).toHaveText(expected.fingerprint);
            await expect(verification.locator('strong')).toHaveText(expected.endpoint);
            // Accept only the actual owned target fingerprint from its independently returned descriptor.
            await verification
                .getByRole('button', { name: /^(Trust device|Trust replacement device)$/ })
                .click();
            approved = true;
            await expect(verification).not.toBeVisible({ timeout: 10000 });
        }
        const error = modal.locator('.form-error');
        if (await error.isVisible())
            throw Error('Actual native connect failed: ' + (await error.textContent()));
        assert.ok(Date.now() < deadline, 'Actual native connection did not complete.');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
        approved || previousTrust,
        'First native handshake must verify the actual UI fingerprint.',
    );
    await expect(connected).toBeVisible();
    await expect(connected).toBeEnabled({ timeout: 120000 });
    const live = page.getByRole('switch', { name: 'Live updates', exact: true });
    if ((await live.getAttribute('aria-checked')) === 'true') await live.click();
    await expect(live).toHaveAttribute('aria-checked', 'false');
    const generation = await connection(page);
    assert.ok(generation, 'Actual native connection generation is absent.');
    const trust: NativeProductSshTrust = { source: 'actual-native-host-dialog', ...expected };
    return {
        trust,
        generation,
        verification: approved ? 'actual-ui-approved' : 'previously-confirmed-production-pin',
    };
}

export async function exerciseProductNativeSsh(
    page: Page,
    gateway: ProductGateway,
    context: {
        ordinal: number;
        payloadBytes: number;
        snapshot(): Promise<unknown>;
        scenarios?: readonly NativeProductSshScenario[];
        previousTrust?: NativeProductSshTrust;
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
    const scenarios = new Set(context.scenarios ?? ['stream', 'manual-pty', 'server-loss-rearm']);
    for (const name of scenarios)
        assert.ok(
            [
                'stream',
                'manual-pty',
                'page-navigation',
                'server-loss-rearm',
                'client-reload-rearm',
            ].includes(name),
            'Unsupported native SSH scenario: ' + name,
        );
    assert.ok(scenarios.size, 'At least one actual native SSH scenario is required.');
    const receipts: { scenario: string; at: string; proof: Record<string, unknown> }[] = [],
        captureIds: string[] = [];
    const receipt = async (scenario: string, proof: Record<string, unknown>) => {
        const item = { scenario, at: new Date().toISOString(), proof };
        receipts.push(item);
        await context.emit?.('actual-native-ssh-ui', item);
    };
    const connected = await connectProductNativeSsh(page, gateway, context.previousTrust);
    let generation = connected.generation;
    await receipt('native-connect-modal', connected);
    const initial = await context.snapshot();
    await receipt('native-main-connected', { snapshot: initial });
    // Stable program names replace the same bounded fixture entries across repeated cycles.
    const prefix = 'native-ssh-ui';
    let manualChannel: number | undefined,
        capturedBytes = 0;
    if (scenarios.has('manual-pty')) {
        const command = prefix + '-manual',
            before = new Set((await catalog(page)).map((row) => row.id));
        const start = await gateway.control({ action: 'snapshot' }),
            after = start.events.at(-1)?.sequence ?? 0;
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
                    event.sequence > after &&
                    event.type === 'shell-command' &&
                    event.command === command,
            ),
        );
        manualChannel = target.events.find(
            (event) =>
                event.sequence > after &&
                event.type === 'shell-command' &&
                event.command === command,
        )!.channel;
        assert.ok(manualChannel);
        assert.deepEqual(
            (await catalog(page)).map((row) => row.id).sort(),
            [...before].sort(),
            'Manual native PTY output entered automation raw storage.',
        );
        const main = await context.snapshot(),
            ssh = object(field(object(main, 'main'), 'ssh'), 'ssh');
        assert.ok(
            Array.isArray(ssh.terminals) &&
                ssh.terminals.some(
                    (value) =>
                        count(field(object(value, 'terminal'), 'channel'), 'terminal.channel') > 0,
                ),
            'Actual native manual PTY channel ownership absent.',
        );
        await receipt('native-manual-pty', {
            command,
            channel: manualChannel,
            catalogUnchanged: true,
            snapshot: main,
        });
    }
    const begin = async (command: string, expected: { stdout: number; stderr: number }) => {
        await targetUntil(gateway, targetProgramsIdle);
        const armed = await gateway.control({
                action: 'program',
                program: {
                    command,
                    stdoutBytes: expected.stdout,
                    stderrBytes: expected.stderr,
                    chunkBytes: 16384,
                    delayMs: 1,
                    stall: true,
                },
            }),
            after = armed.events.at(-1)?.sequence ?? 0;
        const before = new Set((await catalog(page)).map((row) => row.id)),
            serialBefore = await serial(page);
        await prepare(page, command);
        await run(page);
        const target = await targetUntil(
            gateway,
            (value) =>
                value.owners.outputGates > 0 &&
                value.events.some(
                    (event) =>
                        event.sequence > after &&
                        event.type === 'program-start' &&
                        event.command === command,
                ),
        );
        const exec = target.events.find(
            (event) =>
                event.sequence > after &&
                event.type === 'exec-command' &&
                event.command === command,
        );
        assert.ok(exec?.channel);
        if (manualChannel)
            assert.notEqual(
                exec.channel,
                manualChannel,
                'Independent native stream reused the manual PTY.',
            );
        assert.equal((await runner(page)).busy, true);
        assert.equal(await connection(page), generation);
        const active = await context.snapshot();
        assertNativeProductSshActive(active);
        return { before, serialBefore, channel: exec.channel, active, after };
    };
    const finish = async (
        command: string,
        expected: { stdout: number; stderr: number },
        started: Awaited<ReturnType<typeof begin>>,
    ) => {
        await expect(flow(page).locator('.automation-state')).toContainText('Flow finished', {
            timeout: 120000,
        });
        await idle(page);
        const row = await uniqueCapture(page, started.before, command),
            stored = await read(page, row.id),
            proof = assertProductSshRead(row, stored, expected);
        await targetUntil(
            gateway,
            (value) =>
                targetProgramsIdle(value) &&
                value.events.some(
                    (event) =>
                        event.sequence > started.after &&
                        event.type === 'program-complete' &&
                        event.command === command,
                ),
        );
        assert.equal(
            (await serial(page)).sent,
            started.serialBefore.sent,
            'Native SSH automation wrote Serial bytes.',
        );
        const released = await mainUntil(context.snapshot, (value) =>
            assertNativeProductSshReleased(value, false),
        );
        captureIds.push(row.id);
        capturedBytes += stored.bytes;
        return {
            ...proof,
            command,
            channel: started.channel,
            manualChannel: manualChannel ?? null,
            serialSentUnchanged: true,
            activeNativeMain: started.active,
            releasedNativeMain: released,
        };
    };
    const complete = async (command: string, expected: { stdout: number; stderr: number }) => {
        const started = await begin(command, expected);
        await gateway.control({ action: 'release-output' });
        return finish(command, expected, started);
    };
    if (scenarios.has('stream') || scenarios.has('manual-pty')) {
        const stderr = Math.min(16384, Math.floor(context.payloadBytes / 4));
        await receipt(
            'native-independent-stream-stored',
            await complete(prefix + '-stream', { stdout: context.payloadBytes - stderr, stderr }),
        );
    }
    if (scenarios.has('page-navigation')) {
        const command = prefix + '-navigate',
            started = await begin(command, { stdout: 128, stderr: 0 });
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        assert.equal((await runner(page)).busy, true);
        const away = await context.snapshot();
        assertNativeProductSshActive(away);
        await page.getByRole('button', { name: 'Automation', exact: true }).click();
        assert.equal((await runner(page)).busy, true);
        await gateway.control({ action: 'release-output' });
        await receipt('native-navigation-live', {
            ...(await finish(command, { stdout: 128, stderr: 0 }, started)),
            continuedWhileHidden: true,
            awayNativeMain: away,
        });
    }
    if (scenarios.has('server-loss-rearm')) {
        const command = prefix + '-loss',
            started = await begin(command, { stdout: 128, stderr: 0 });
        await gateway.control({ action: 'disconnect-clients' });
        const lost = await mainUntil(context.snapshot, (value) =>
            assertNativeProductSshReleased(value, true),
        );
        await idle(page);
        const row = await uniqueCapture(page, started.before, command),
            stored = await read(page, row.id),
            proof = assertNativeProductSshLoss(row, stored);
        captureIds.push(row.id);
        assert.equal(
            await connection(page),
            '',
            'Actual preload generation did not disarm on target loss.',
        );
        await targetUntil(gateway, (value) =>
            Object.values(value.owners).every((count) => count === 0),
        );
        await receipt('native-server-loss', {
            ...proof,
            activeNativeMain: started.active,
            releasedNativeMain: lost,
        });
        manualChannel = undefined;
        const reconnected = await connectProductNativeSsh(page, gateway, connected.trust);
        assert.notEqual(
            reconnected.generation,
            generation,
            'Reconnect reused a stale native generation.',
        );
        generation = reconnected.generation;
        await receipt('native-server-loss-reconnect', reconnected);
        await receipt(
            'native-server-loss-explicit-rearm',
            await complete(prefix + '-rearm', { stdout: 64, stderr: 32 }),
        );
    }
    if (scenarios.has('client-reload-rearm')) {
        const command = prefix + '-client-loss',
            started = await begin(command, { stdout: 128, stderr: 0 });
        await page.reload();
        await page.waitForFunction(() => Boolean(window.memoryProduct));
        await context.afterReload?.();
        const row = await uniqueCapture(page, started.before, command),
            stored = await read(page, row.id);
        const proof = assertNativeProductSshLoss(row, stored);
        captureIds.push(row.id);
        const released = await mainUntil(context.snapshot, (value) =>
            assertNativeProductSshReleased(value, false),
        );
        await receipt('native-client-loss', {
            ...proof,
            actualMainFrameReload: true,
            activeNativeMain: started.active,
            releasedNativeMain: released,
        });
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await page.locator('.connection-button[data-connection="connected"]').click();
        await mainUntil(context.snapshot, (value) => assertNativeProductSshReleased(value, true));
        await targetUntil(gateway, (value) =>
            Object.values(value.owners).every((count) => count === 0),
        );
        manualChannel = undefined;
        const reconnected = await connectProductNativeSsh(page, gateway, connected.trust);
        assert.notEqual(reconnected.generation, generation);
        generation = reconnected.generation;
        await receipt('native-client-loss-reconnect', reconnected);
        await receipt(
            'native-client-loss-explicit-rearm',
            await complete(prefix + '-client-rearm', { stdout: 64, stderr: 32 }),
        );
    }
    if (context.disconnect !== false) {
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        const button = page.locator('.connection-button[data-connection="connected"]');
        await expect(button).toBeEnabled();
        await button.click();
        await expect(page.locator('.connection-button')).toHaveAttribute(
            'data-connection',
            'disconnected',
        );
        const released = await mainUntil(context.snapshot, (value) =>
            assertNativeProductSshReleased(value, true),
        );
        await targetUntil(gateway, (value) =>
            Object.values(value.owners).every((count) => count === 0),
        );
        assert.equal(await connection(page), '');
        await receipt('native-ui-disconnect', { snapshot: released });
    }
    return {
        receipts,
        captureIds,
        capturedBytes,
        trust: connected.trust,
        finalNativeMain: await context.snapshot(),
        unsupported: {
            'native-console-mode':
                'Not exercised; independent stream/manual PTY receipts do not qualify the console actor.',
        },
    };
}
