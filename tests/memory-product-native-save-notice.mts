/** Actual production UI plus Node native Save control; IPC carrier is a Playwright binding. No Electron/PTY/Windows qualification. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exerciseNativeSaveCases } from './fixtures/memory-product-native-save-ui';
import { createProductBrowser } from './fixtures/memory-product-browser-host';
import { exerciseProductSerial } from './fixtures/memory-product-ui';
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
const writer = await CaptureWriter.begin(repository, {
    transport: 'serial',
    receiveTimeSource: 'local-client',
    runId: 'notice-ui',
    stepId: 'one',
    name: 'Native Save notice',
    command: 'no device command',
    startedAt: '2026-10-19T00:00:00.000Z',
});
await writer.append(
    new TextEncoder().encode('actual private native capture payload'),
    '2026-10-19T00:00:00.000Z',
    'serial',
);
await writer.finish('prompt-observed');
workerReadFault.wrap(port.store);
let browser: Awaited<ReturnType<typeof createProductBrowser>> | undefined;
const bridgeReplies: unknown[] = [];
let ordinal = 0;
const facade = {
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
    await exerciseProductSerial(page, {
        ordinal: 300000,
        payloadBytes: 128,
        viewer: false,
        faults: false,
    });
    const view = page
        .getByRole('region', { name: 'Automation', exact: true })
        .locator('[aria-label="Stored Serial captures"]');
    await page.exposeFunction('__nativeSaveExport', async (request: unknown) => {
        const reply = await native.dispatch(request);
        bridgeReplies.push({ request, reply });
        await emit('actual-native-host-rpc-reply', { request, reply });
        return reply;
    });
    await page.evaluate(
        'window.diagnosticHub={onDisconnected:()=>()=>{},readUpdateReport:async()=>null,captureStorage:(request)=>window.__nativeSaveExport(request)}',
    );
    const before = await repository.page(0, 100);
    try {
        const results = await exerciseNativeSaveCases(page, view, facade as any, emit);
        assert.equal(results.length, 2);
        assert.deepEqual(
            results.map((r: any) => r.decision),
            ['cancel', 'save'],
        );
        assert.deepEqual(await repository.page(0, 100), before);
        assert.equal(workerReadFault.activeReads(), 0);
        const notices = await view.getByRole('status').allTextContents();
        const alerts = await view.getByRole('alert').allTextContents();
        await emit('regression-passed', {
            results,
            notices,
            alerts,
            bridgeReplies,
            boundary:
                'Actual compiled production App and Results handler; actual Node NativeCaptureHost/RPC/SQLite/SaveControl/stream-failure. Playwright binding replaces Electron IPC carrier; display captures use browser IndexedDB. No Electron/PTY or Windows qualification.',
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
