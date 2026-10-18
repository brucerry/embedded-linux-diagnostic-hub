import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { gatewayFixture } from './fixtures/gateway';
import { consoleFixture } from './fixtures/ssh-console';
import type {} from './fixtures/ssh-stream-electron-renderer';
import type {} from './fixtures/ssh-stream-electron-preload';

async function main() {
    const output = process.env.HUB_SSH_NATIVE_EVIDENCE;
    if (!output) throw Error('Set HUB_SSH_NATIVE_EVIDENCE to an owned fixture root.');
    const root = path.resolve(output);
    await fs.mkdir(root, { recursive: true });
    for (const name of ['profile', 'crash', 'logs']) await fs.mkdir(path.join(root, name));
    const fixture = await gatewayFixture(undefined, consoleFixture());
    let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        await fs.writeFile(
            path.join(root, 'connection.json'),
            JSON.stringify({ options: fixture.options, pinned: fixture.pinned }),
        );
        await build({
            entryPoints: ['tests/fixtures/ssh-stream-electron-main.ts'],
            bundle: true,
            platform: 'node',
            format: 'cjs',
            outfile: path.join(root, 'main.cjs'),
            // Match desktop packaging: existing JS crypto, optional native acceleration absent.
            external: ['electron', '*.node', 'cpu-features'],
        });
        await build({
            entryPoints: ['tests/fixtures/ssh-stream-electron-preload.ts'],
            bundle: true,
            platform: 'node',
            format: 'cjs',
            outfile: path.join(root, 'preload.cjs'),
            external: ['electron'],
        });
        await build({
            entryPoints: ['tests/fixtures/ssh-stream-electron-renderer.ts'],
            bundle: true,
            platform: 'browser',
            format: 'iife',
            outfile: path.join(root, 'renderer.js'),
        });
        await fs.writeFile(
            path.join(root, 'index.html'),
            `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; frame-src 'none'; object-src 'none'; connect-src 'none'"><title>Private production SSH IPC fixture</title><script src="./renderer.js"></script>`,
        );
        const environment = Object.fromEntries(
            Object.entries(process.env).filter(
                (entry): entry is [string, string] =>
                    entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
            ),
        );
        application = await electron.launch({
            args: [path.join(root, 'main.cjs')],
            env: { ...environment, HUB_SSH_ELECTRON_ROOT: root },
        });
        const page = await application.firstWindow();
        await page.waitForFunction(() =>
            Boolean(window.sshNativeQA && window.diagnosticHub?.automationStream),
        );
        const result = await page.evaluate(async (options) => {
            const { NativeCaptureRepository, SshStreamClient, captureToRepository } =
                    window.sshNativeQA,
                bridge = window.diagnosticHub!;
            await bridge.connect(options);
            const store = await NativeCaptureRepository.open(bridge.captureStorage!),
                client = new SshStreamClient(
                    (input) => bridge.automationStream!(input),
                    'local-client',
                );
            const id = crypto.randomUUID().replaceAll('-', ''),
                capture = await captureToRepository(
                    store,
                    {
                        transport: 'ssh',
                        receiveTimeSource: 'local-client',
                        runId: 'native-production',
                        stepId: 'one',
                        command: 'fixture-large',
                        name: 'Native SSH',
                        startedAt: new Date().toISOString(),
                        execution: {
                            mode: 'independent-script',
                            intent: 'script',
                            timeoutMs: 20000,
                        },
                    },
                    new AbortController().signal,
                    (sink, signal) =>
                        client.execute(
                            {
                                id,
                                connection: bridge.automationConnection!(),
                                command: 'fixture-large',
                                timeoutMs: 20000,
                            },
                            sink,
                            signal,
                        ),
                );
            let total = 0,
                hash = 2166136261,
                held = false;
            for await (const item of store.read(capture.stored.id))
                if (item.type === 'frame') {
                    for (const byte of item.frame.bytes)
                        hash = Math.imul(hash ^ byte, 16777619) >>> 0;
                    total += item.frame.bytes.length;
                }
            try {
                await bridge.collect();
            } catch {
                held = true;
            }
            await store.record(capture.stored.id, {
                id,
                ordinal: 1,
                completedAt: new Date().toISOString(),
                localZone: 'UTC',
                durationMs: 1,
                deviceTime: null,
                completion: capture.completion,
                exitCode: capture.exitCode,
                truncated: false,
            });
            await client.finalize();
            await store.delete(capture.stored.id);
            const remaining = (await store.page()).records.length;
            await store.close();
            await bridge.disconnect();
            return {
                total,
                hash,
                held,
                remaining,
                completion: capture.completion,
                exitCode: capture.exitCode,
                previewClipped: capture.previewClipped,
                receiveTimeSource: capture.stored.header.receiveTimeSource,
                nodeUnavailable:
                    typeof (globalThis as { process?: unknown }).process === 'undefined',
            };
        }, fixture.options);
        let expected = 2166136261;
        for (let i = 0; i < 129; i++)
            for (let j = 0; j < 16384; j++)
                expected = Math.imul(expected ^ (i % 251), 16777619) >>> 0;
        assert.equal(result.total, 2113536);
        assert.equal(result.hash, expected);
        assert.equal(result.held, true);
        assert.equal(result.remaining, 0);
        assert.equal(result.completion, 'exit');
        assert.equal(result.exitCode, 0);
        assert.equal(result.previewClipped, true);
        assert.equal(result.receiveTimeSource, 'local-client');
        assert.equal(result.nodeUnavailable, true);
        const runtime = await application.evaluate(() => ({
            versions: process.versions,
            noAsar: process.noAsar === true,
        }));
        const isolation = await page.evaluate(() => window.sshNativeRuntime);
        assert.equal(runtime.noAsar, false);
        assert.equal(isolation.sandboxed, true);
        assert.equal(isolation.contextIsolated, true);
        const receipt = { root, result, expected, runtime, isolation };
        await fs.writeFile(
            path.join(root, 'receipt.json'),
            JSON.stringify(receipt, null, 2) + '\n',
        );
        console.log(
            JSON.stringify({
                passed: true,
                receipt: path.join(root, 'receipt.json'),
                bytes: result.total,
            }),
        );
    } finally {
        await application?.close();
        await fixture.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
