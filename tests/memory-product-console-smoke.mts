import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { createProductBrowser } from './fixtures/memory-product-browser-host';
import { createProductNative } from './fixtures/memory-product-native-host';
import { createProductGateway } from './fixtures/memory-product-gateway';
import { connectProductSsh } from './fixtures/memory-product-ssh-ui';
import { connectProductNativeSsh } from './fixtures/memory-product-native-ssh-ui';
import {
    startProductConsoleUi,
    exerciseLiveProductConsole,
    finishProductConsoleUi,
    type ConsoleProductHooks,
    type ConsoleUiPlan,
} from './fixtures/memory-product-console-ui';
import { consoleRawCrc } from './fixtures/memory-product-console-read';

const root = process.env.HUB_PRODUCT_EVIDENCE;
if (!root) throw Error('Private evidence required.');
await fs.mkdir(root, { recursive: true });
const emit = async (stage: string, data: unknown) =>
    fs.appendFile(
        path.join(root, 'timeline.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), stage, data }) + '\n',
    );
const native = process.env.HUB_PRODUCT_CONSOLE_NATIVE === '1';
let host:
    | Awaited<ReturnType<typeof createProductBrowser>>
    | Awaited<ReturnType<typeof createProductNative>>
    | undefined;
let gateway: Awaited<ReturnType<typeof createProductGateway>> | undefined;
let failure: unknown;
try {
    host = native
        ? await createProductNative({ profile: path.join(root, 'profile'), gcMode: 'normal', emit })
        : await createProductBrowser({
              profile: path.join(root, 'profile'),
              gcMode: 'normal',
              engine: 'chromium',
              emit,
          });
    gateway = await createProductGateway({
        origin: 'origin' in host ? host.origin : 'http://127.0.0.1:9',
        gcMode: 'normal',
        profile: path.join(root, 'gateway-profile'),
        emit,
    });
    if ('proxyGateway' in host) host.proxyGateway(gateway.descriptor.url);
    const page = host.page;
    await emit(
        'actual-console-trust',
        native
            ? await connectProductNativeSsh(page, gateway)
            : await connectProductSsh(page, gateway, new URL(page.url()).origin),
    );
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Automation', exact: true })).toBeVisible();
    const beforeTarget = await gateway.control({ action: 'snapshot' });
    await gateway.control({
        action: 'program',
        program: { command: 'held-console-measure', stdoutBytes: 48, chunkBytes: 16, stall: true },
    });
    const hooks: ConsoleProductHooks = {
        consoleCatalog: () => page.evaluate(() => window.memoryProduct.consoleCatalog()),
        readConsoleSummary: (id, limits) =>
            page.evaluate(({ id, limits }) => window.memoryProduct.readConsoleSummary(id, limits), {
                id,
                limits,
            }),
        runnerState: () => page.evaluate(() => window.memoryProduct.runnerState()),
    };
    const limits = { maxCatalogRows: 500, maxMetadataRows: 256, maxTargetRequests: 256 };
    const prompt = 'fixture:/root# ';
    const plan: ConsoleUiPlan = {
        shellPrompts: [prompt],
        steps: [
            {
                name: 'Confirm script',
                intent: 'script',
                command: 'confirm-fixture',
                completion: {
                    role: 'intermediate-input-prompt',
                    literals: ['Proceed fixture [Enter]? '],
                },
            },
            { name: 'Confirm Enter', intent: 'send-enter', command: '' },
            { name: 'Empty Enter', intent: 'send-enter', command: '' },
            { name: 'Held final script', intent: 'script', command: 'held-console-measure' },
        ],
    };
    const started = await startProductConsoleUi(page, plan, hooks, limits);
    await expect
        .poll(async () => {
            const state = await gateway!.control({ action: 'snapshot' });
            return (
                state.owners.outputGates === 1 &&
                state.events.some(
                    (event) =>
                        event.type === 'shell-command' && event.command === 'held-console-measure',
                )
            );
        })
        .toBe(true);
    await emit('actual-console-live', await exerciseLiveProductConsole(page, hooks, limits));
    await emit('actual-console-held-product-owners', await gateway.snapshotOwners());
    await gateway.control({ action: 'release-output' });
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
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
    const commandOutput = [
        'Proceed fixture [Enter]? ',
        'CONFIRMED\r\n' + prompt,
        prompt,
        'A'.repeat(48) + prompt,
    ];
    const crc = (text: string) => {
        const result = consoleRawCrc();
        result.add(Buffer.from(text));
        return result.summary();
    };
    const expected = {
        receiveTimeSource: native ? ('local-client' as const) : ('gateway' as const),
        target: {
            endpoint: gateway.descriptor.options.host + ':' + gateway.descriptor.options.port,
            username: gateway.descriptor.options.username,
        },
        raw: crc('Synthetic interactive initialization\r\n' + prompt + commandOutput.join('')),
        commandRaw: commandOutput.map(crc),
    };
    await emit(
        'actual-console-finished',
        await finishProductConsoleUi(page, started, hooks, limits, expected),
    );
    const afterTarget = await gateway.control({ action: 'snapshot' });
    assert.equal(afterTarget.totals.openedChannels - beforeTarget.totals.openedChannels, 1);
    assert.equal(afterTarget.totals.closedChannels - beforeTarget.totals.closedChannels, 1);
    assert.equal(afterTarget.totals.shellCommands - beforeTarget.totals.shellCommands, 4);
    assert.equal(afterTarget.totals.enters - beforeTarget.totals.enters, 2);
    await emit('actual-console-shell-deltas', {
        before: beforeTarget.totals,
        after: afterTarget.totals,
        scope: 'Actual target channels and input parser; raw PTY owner/ACK identity trace is not exposed by this target snapshot.',
    });
    assert.equal(
        (await page.evaluate(() => window.memoryProduct.catalog())).length,
        0,
        'Console journal must not substitute an independent capture.',
    );
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.locator('.connection-button[data-connection="connected"]').click();
    await expect(page.locator('.connection-button')).toHaveAttribute(
        'data-connection',
        'disconnected',
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
    await emit(
        'actual-console-final-renderer-owners',
        await page.evaluate(() => window.memoryProduct.ownership()),
    );
    await emit('actual-console-final-gateway-owners', await gateway.snapshotOwners());
    if ('snapshot' in host) await emit('actual-console-final-native-owners', await host.snapshot());
    if ('errors' in host) assert.deepEqual(host.errors(), []);
} catch (error) {
    failure = error;
    await emit('failure', {
        message: String(error),
        stack: error instanceof Error ? error.stack : null,
    });
} finally {
    if (gateway)
        try {
            await gateway.close();
            await gateway.assertExited();
            await emit('actual-gateway-exit', { verified: true });
        } catch (error) {
            failure ??= error;
            await emit('gateway-cleanup-failure', { message: String(error) });
        }
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
            status: failure ? 'failed' : 'actual-console-development-passed',
            qualified: false,
            native,
            failure: failure ? String(failure) : null,
            scope: 'Actual App persistent SSH console, Script/Enter/Enter/Script, held live viewer/navigation, separately read schema2 journal with independent raw CRC and provenance. PTY/ACK identity traces, journal downloads and aggregate memory/artifact gates remain open.',
        },
        null,
        2,
    ),
);
if (failure) throw failure;
