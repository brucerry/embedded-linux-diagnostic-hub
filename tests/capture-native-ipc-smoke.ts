import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import type {} from './fixtures/capture-electron-renderer';

async function main() {
    const output = process.env.HUB_CAPTURE_NATIVE_EVIDENCE;
    if (!output)
        throw Error('Set HUB_CAPTURE_NATIVE_EVIDENCE to an owned fixture/evidence directory.');
    const root = path.resolve(output);
    await fs.mkdir(root, { recursive: true });
    for (const name of ['profile', 'crash', 'logs']) await fs.mkdir(path.join(root, name));
    await build({
        entryPoints: ['tests/fixtures/capture-electron-main.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: path.join(root, 'main.cjs'),
        external: ['electron'],
    });
    await build({
        entryPoints: ['electron/preload.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: path.join(root, 'preload.cjs'),
        external: ['electron'],
    });
    await build({
        entryPoints: ['tests/fixtures/capture-electron-renderer.ts'],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        outfile: path.join(root, 'renderer.js'),
    });
    await fs.writeFile(
        path.join(root, 'index.html'),
        "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'; frame-src 'none'; object-src 'none'; connect-src 'none'\"><title>Private capture IPC fixture</title><script src=\"./renderer.js\"></script>",
    );
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
                entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
        ),
    );
    const application = await electron.launch({
        args: [path.join(root, 'main.cjs')],
        env: { ...environment, HUB_CAPTURE_ELECTRON_ROOT: root },
    });
    try {
        const page = await application.firstWindow();
        await page.waitForFunction(() =>
            Boolean(window.captureElectronQA && window.diagnosticHub?.captureStorage),
        );
        const result = await page.evaluate(async () => {
            const { NativeCaptureRepository, CaptureWriter } = window.captureElectronQA,
                store = await NativeCaptureRepository.open(window.diagnosticHub!.captureStorage!),
                writer = await CaptureWriter.begin(store, {
                    transport: 'serial',
                    receiveTimeSource: 'local-client',
                    runId: 'electron-ipc-fixture',
                    stepId: 'one',
                    name: 'Native bridge fixture',
                    command: 'synthetic-only',
                    startedAt: '2026-10-15T00:00:00.000Z',
                });
            let expected = 2166136261,
                total = 0;
            for (let index = 0; index < 129; index++) {
                const bytes = new Uint8Array(16384).fill(index % 251);
                for (const byte of bytes) expected = Math.imul(expected ^ byte, 16777619) >>> 0;
                total += bytes.length;
                await writer.append(bytes, '2026-10-15T00:00:00.000Z', 'serial');
            }
            const capture = await writer.finish('prompt-observed'),
                outcome = {
                    id: globalThis.crypto.randomUUID().replaceAll('-', ''),
                    ordinal: 1,
                    completion: 'prompt-observed' as const,
                    exitCode: null,
                    truncated: false,
                    completedAt: '2026-10-15T00:00:00.000Z',
                    localZone: 'UTC',
                    durationMs: 0,
                    deviceTime: null,
                };
            await store.record(capture.id, outcome);
            const catalog = await store.page(),
                saved = await store.result(capture.id);
            let actual = 2166136261,
                readBytes = 0;
            for await (const event of store.read(capture.id))
                if (event.type === 'frame')
                    for (const byte of event.frame.bytes) {
                        actual = Math.imul(actual ^ byte, 16777619) >>> 0;
                        readBytes++;
                    }
            const exported = await window.diagnosticHub!.captureStorage!({
                op: 'export',
                format: 'json',
                scope: { ids: [capture.id] },
            });
            let rejected = false;
            try {
                const reply = await window.diagnosticHub!.captureStorage!({
                    op: 'export',
                    format: 'json',
                    scope: { path: 'outside' } as unknown,
                });
                rejected = !reply.ok;
            } catch {
                rejected = true;
            }
            await store.delete(capture.id);
            const remaining = (await store.page()).records.length;
            await store.close();
            return {
                total,
                readBytes,
                expected,
                actual,
                rawState: capture.state,
                catalogRows: catalog.records.length,
                outcome: saved,
                exported,
                rejected,
                remaining,
                isolatedNodeUnavailable:
                    typeof (globalThis as { require?: unknown }).require === 'undefined',
            };
        });
        assert.equal(result.total, result.readBytes);
        assert.equal(result.actual, result.expected);
        assert.equal(result.rawState, 'complete');
        assert.equal(result.catalogRows, 1);
        assert.equal(result.outcome?.completion, 'prompt-observed');
        assert.equal(result.remaining, 0);
        assert.equal(result.isolatedNodeUnavailable, true);
        assert.equal(result.exported.ok, true);
        assert.equal(result.rejected, true);
        const bytes = await fs.readFile(path.join(root, 'native-export.json')),
            json = JSON.parse(bytes.toString());
        assert.equal(json.captures.length, 1);
        assert.equal(json.captures[0].capture.committedBytes, result.total);
        assert.equal(json.captures[0].outcome.completion, 'prompt-observed');
        const runtime = await application.evaluate(() => ({
            electron: process.versions.electron,
            node: process.versions.node,
            noAsar: process.noAsar === true,
        }));
        assert.equal(runtime.noAsar, false);
        await fs.writeFile(
            path.join(root, 'receipt.json'),
            JSON.stringify(
                {
                    root,
                    runtime,
                    ...result,
                    nativeExportBytes: bytes.length,
                    nativeExportSHA256: crypto.createHash('sha256').update(bytes).digest('hex'),
                    DUT: false,
                    installation: false,
                },
                null,
                2,
            ) + '\n',
        );
        console.log(
            JSON.stringify({
                receipt: path.join(root, 'receipt.json'),
                rawBytes: result.total,
                ipcRoundTrip: true,
                trustedNativeExport: true,
                profile: root,
            }),
        );
    } finally {
        await application.close();
    }
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
