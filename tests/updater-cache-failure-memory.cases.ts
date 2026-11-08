import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ReleaseUpdater } from '../electron/updates';
import {
    memory,
    mkdir as memoryMkdir,
    createReadStream as memoryReadStream,
} from './fixtures/updater-memory-io';
import { mkdir as selectedMkdir } from 'node:fs/promises';
import { createReadStream as selectedReadStream } from 'node:fs';
const memoryOnly =
    Object.is(selectedMkdir, memoryMkdir) && Object.is(selectedReadStream, memoryReadStream);
const options = { skip: memoryOnly ? false : 'Requires reviewed memory filesystem alias harness' };
const bytes = Buffer.from('MZsynthetic-portable-bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
async function scope(verify: (u: ReleaseUpdater) => Promise<void>) {
    assert.ok(memoryOnly, 'Memory-only filesystem aliases required before constructing updater');
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')!;
    memory.reset();
    try {
        Object.defineProperty(AbortSignal, 'timeout', {
            configurable: true,
            writable: true,
            value: () => new AbortController().signal,
        });
        const root =
            'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v0.2.0/';
        const request: typeof fetch = async (input) => {
            const url = String(input);
            if (
                url ===
                'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/releases?per_page=100'
            )
                return Response.json([
                    {
                        tag_name: 'v0.2.0',
                        draft: false,
                        prerelease: false,
                        assets: [
                            {
                                name: 'Diagnostic-Hub.exe',
                                size: bytes.length,
                                browser_download_url: root + 'Diagnostic-Hub.exe',
                            },
                            {
                                name: 'Diagnostic-Hub.exe.sha256',
                                size: 100,
                                browser_download_url: root + 'Diagnostic-Hub.exe.sha256',
                            },
                        ],
                    },
                ]);
            if (url === root + 'Diagnostic-Hub.exe.sha256')
                return new Response(hash + '  Diagnostic-Hub.exe\n');
            assert.equal(url, root + 'Diagnostic-Hub.exe');
            return new Response(new Uint8Array(bytes));
        };
        await verify(new ReleaseUpdater('0.1.0', '/memory/updates', 'win32', 'x64', true, request));
    } finally {
        Object.defineProperty(AbortSignal, 'timeout', descriptor);
        assert.deepEqual(Object.getOwnPropertyDescriptor(AbortSignal, 'timeout'), descriptor);
        assert.equal(memory.stats().opens, memory.stats().closes);
    }
}
async function until(check: () => boolean) {
    for (let turn = 0; turn < 256; turn++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.fail('Bounded updater fixture did not reach read gate');
}
test(
    'failed executable checksum recheck invalidates handoff/cache until an explicit successful download',
    options,
    async () =>
        scope(async (u) => {
            await u.check(false);
            const path = await u.download();
            memory.replace(path, Buffer.from('MZtampered-memory-bytes'));
            await assert.rejects(u.executable(), /has changed/);
            assert.throws(() => u.handoffInfo(), /Download and verify/);
            const reads = memory.stats().reads;
            assert.equal((await u.check(false)).readyPath, undefined);
            assert.equal(memory.stats().reads, reads);
            assert.equal(await u.download(), path);
            assert.equal(await u.executable(), path);
            assert.equal(u.handoffInfo().executable, path);
            assert.equal((await u.check(false)).readyPath, path);
        }),
);
test(
    'pending executable revalidation holds admission until successful settlement',
    options,
    async () =>
        scope(async (u) => {
            await u.check(false);
            const path = await u.download();
            const gate = memory.holdRead(),
                pending = u.executable();
            try {
                await until(() => gate.entered);
                await assert.rejects(u.check(false), /already running/);
                await assert.rejects(u.download(), /already running/);
                await assert.rejects(u.executable(), /Download and verify/);
                assert.equal(memory.stats().reads, 1);
            } finally {
                gate.resolve();
                assert.equal(await pending, path);
            }
            assert.equal((await u.check(false)).readyPath, path);
            assert.equal(u.handoffInfo().executable, path);
        }),
);
test(
    'read failure preserves its original error and invalidates ready state without retaining admission',
    options,
    async () =>
        scope(async (u) => {
            await u.check(false);
            await u.download();
            const failure = Error('Synthetic memory read failed');
            memory.failRead(failure);
            await assert.rejects(u.executable(), (error) => error === failure);
            assert.throws(() => u.handoffInfo(), /Download and verify/);
            assert.equal((await u.check(false)).readyPath, undefined);
            assert.doesNotThrow(() => u.assertCanDownload());
        }),
);
