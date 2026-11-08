import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ReleaseUpdater } from '../electron/updates';
import { UpdateCoordinator } from '../electron/update-coordinator';
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
test(
    'actual updater and coordinator preserve revalidation failure and admit only explicit successful recovery',
    options,
    async () =>
        scope(async (u) => {
            await u.check(false);
            const failure = Error('Synthetic executable read failure');
            memory.failRead(failure);
            let saves = 0,
                arms = 0,
                restarts = 0;
            const phases: string[] = [];
            let coordinator!: UpdateCoordinator;
            coordinator = new UpdateCoordinator(
                u,
                {
                    async save(mode) {
                        assert.equal(mode, 'clean');
                        saves++;
                        return null;
                    },
                    async arm(saved) {
                        assert.equal(saved, null);
                        arms++;
                    },
                    async acknowledge() {
                        assert.fail('No recovery marker should require disarm in this scenario');
                    },
                },
                {
                    isConnecting: () => false,
                    isConnected: () => false,
                    latestSnapshot: () => null,
                    async quiesceSerial() {
                        assert.equal(coordinator.active, true);
                    },
                    async waitForCollection() {
                        assert.equal(coordinator.active, true);
                    },
                    disconnect() {
                        assert.equal(coordinator.active, true);
                    },
                    progress(value) {
                        assert.equal(coordinator.active, true);
                        phases.push(value.stage);
                        if (value.stage === 'failed') assert.equal(value.message, failure.message);
                    },
                    restart(path) {
                        assert.equal(coordinator.active, true);
                        assert.equal(path, u.handoffInfo().executable);
                        restarts++;
                    },
                },
            );
            await assert.rejects(
                coordinator.start({ mode: 'clean' }),
                (error) => error === failure,
            );
            assert.equal(coordinator.active, false);
            assert.equal(saves, 1);
            assert.equal(arms, 0);
            assert.equal(restarts, 0);
            assert.equal(phases.at(-1), 'failed');
            assert.throws(() => u.handoffInfo(), /Download and verify/);
            const reads = memory.stats().reads;
            assert.equal((await u.check(false)).readyPath, undefined);
            assert.equal(memory.stats().reads, reads);
            await coordinator.start({ mode: 'clean' });
            assert.equal(coordinator.active, true);
            assert.equal(saves, 2);
            assert.equal(arms, 1);
            assert.equal(restarts, 1);
            assert.equal(phases.at(-1), 'handoff');
            await assert.rejects(coordinator.start({ mode: 'clean' }), /already in progress/);
            assert.equal(saves, 2);
            assert.equal(restarts, 1);
        }),
);
