import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, type CDPSession } from '@playwright/test';
import { createProductBrowser } from './fixtures/memory-product-browser-host';
import { ProcessSampler, readProcessTable } from './fixtures/memory-resource-processes';
import { AggregateCallTracker } from './fixtures/memory-product-aggregate-diagnostics';
assert.equal(process.platform, 'darwin');
const output = process.env.HUB_NATIVE_OUTPUT;
assert.ok(output && path.isAbsolute(output));
const emit = async (stage: string, data: unknown) => {
    fs.appendFileSync(
        path.join(output, 'timeline.jsonl'),
        JSON.stringify({ stage, at: performance.now(), data }) + '\n',
    );
};
const calls = new AggregateCallTracker(emit, 'mac-preflight-call');
const owned: {
    child?: ChildProcess;
    sampler?: ProcessSampler;
    closed?: Promise<void>;
    exit?: { code: number | null; signal: NodeJS.Signals | null };
    close?: { code: number | null; signal: NodeJS.Signals | null };
} = {};
let host: Awaited<ReturnType<typeof createProductBrowser>> | undefined;
let protocol: CDPSession | undefined;
let primary: unknown, cleanup: unknown, observation: unknown;
let cleanupVerified = false;
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
    protocol = await calls.run('open-owned-page-metadata', () =>
        host!.page.context().newCDPSession(host!.page),
    );
    const target = await calls.run('native-page-identity', () =>
        protocol!.send('Target.getTargetInfo'),
    );
    const version = await calls.run('native-browser-product', () =>
        protocol!.send('Browser.getVersion'),
    );
    assert.equal(target.targetInfo.type, 'page');
    assert.equal(target.targetInfo.url, host.origin + '/');
    assert.ok(owned.child?.pid && !owned.exit);
    const nativeRoot = (await readProcessTable()).find((row) => row.pid === owned.child!.pid);
    assert.ok(nativeRoot?.created);
    const executable = chromium.executablePath();
    observation = {
        target: target.targetInfo,
        contextIdentity: {
            present: Object.hasOwn(target.targetInfo, 'browserContextId'),
            value: target.targetInfo.browserContextId ?? null,
        },
        version,
        root: nativeRoot,
        executable,
        executableSHA256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
        page: await host.page.evaluate(() => ({
            url: location.href,
            title: document.title,
            visibility: document.visibilityState,
        })),
        pageErrors: host.errors(),
        scope: 'Actual headful Mac Chromium and production App identity preflight only; no reconnect, aggregate, memory or installer qualification.',
    };
    await emit('mac-native-identity-preflight', observation);
} catch (error) {
    primary = error;
    await emit('mac-native-preflight-failed', {
        error: String(error),
        stack: error instanceof Error ? error.stack : null,
    });
} finally {
    try {
        if (protocol) await calls.run('detach-preflight-metadata', () => protocol!.detach());
        if (host) {
            await calls.run('close-actual-app-host', () => host!.close());
            await calls.run('join-host-exit', () => host!.assertExited());
        }
        assert.ok(host && owned.closed && owned.sampler, 'Startup ownership/cleanup not proven.');
        await calls.run('join-root-child-close', () => owned.closed!);
        await calls.run('join-own-process-history', () => owned.sampler!.assertExited());
        assert.deepEqual(owned.exit, { code: 0, signal: null });
        assert.deepEqual(owned.close, { code: 0, signal: null });
        calls.assertJoined();
        cleanupVerified = true;
    } catch (error) {
        cleanup = error;
        await emit('mac-native-preflight-cleanup-failed', { error: String(error) });
    }
    fs.writeFileSync(
        path.join(output, 'native-result.json'),
        JSON.stringify(
            {
                status:
                    primary || cleanup
                        ? 'failed-native-identity-preflight'
                        : 'passed-native-identity-preflight',
                observation,
                primary: primary ? String(primary) : null,
                cleanup: cleanup ? String(cleanup) : null,
                cleanupVerified,
                rootExit: owned.exit,
                rootClose: owned.close,
                rootHistory: owned.sampler
                    ? await owned.sampler.sample().catch((error) => ({ error: String(error) }))
                    : null,
                actualAppRuns: 1,
                reconnects: 0,
                aggregateRuns: 0,
                qualified: false,
            },
            null,
            2,
        ) + '\n',
        { flag: 'wx' },
    );
}
if (primary || cleanup) process.exitCode = 1;
