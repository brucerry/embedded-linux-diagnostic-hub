import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open as selectedOpen } from 'node:fs/promises';
import { open as memoryOpen, scope } from './fixtures/update-owned-memory';
import { UpdateOwnership } from '../electron/update-ownership';
import { hashUpdateFile } from '../electron/update-owned-file';
import { createQuitController, runQuitCleanup } from '../shared/quit-cleanup';
const options = {
    skip: selectedOpen === memoryOpen ? false : 'Requires audited memory filesystem aliases',
};

test(
    'admission precedes pending acquisition; acknowledged no-handle failure and successful close both let frozen quit finish',
    options,
    async () => {
        assert.equal(selectedOpen, memoryOpen);
        for (const rejects of [true, false]) {
            const state = scope(),
                owner = new UpdateOwnership(),
                bytes = Buffer.from('memory verification');
            state.files.set('/memory/file', bytes);
            let resolve!: () => void;
            state.gates['open:r'] = new Promise<void>((done) => {
                resolve = done;
            });
            const failure = Error('open rejected before returning a handle');
            if (rejects) state.faults['open:r'] = failure;
            const calls: string[] = [];
            const quit = createQuitController(() =>
                runQuitCleanup({
                    joinUpdate: () => owner.shutdown(),
                    cancelConnection() {
                        calls.push('cancel');
                    },
                    clearHostVerification() {},
                    disconnect() {},
                    async prepareConsole() {},
                    async joinConnection() {},
                    async joinSsh() {},
                    async finishConsole() {},
                    async shutdownCapture() {},
                    async shutdownReports() {
                        calls.push('reports');
                    },
                }),
            );
            const observed = owner
                .start(() => hashUpdateFile(owner, '/memory/file', 1024))
                .then(
                    (value) => ({ value, error: undefined }),
                    (error) => ({ value: undefined, error }),
                );
            // Request quit before the work callback's first microtask or any returned handle.
            assert.equal(owner.active, true);
            const leaving = quit.begin(undefined);
            for (let n = 0; n < 32; n++) await Promise.resolve();
            assert.deepEqual(state.events, ['open:r']);
            assert.equal(state.handles.size, 0);
            assert.deepEqual(owner.snapshot().resources, []);
            assert.equal(owner.active, true);
            assert.equal(quit.phase, 'waiting');
            assert.deepEqual(calls, []);
            assert.throws(() => owner.start(async () => {}), /shutting down/);
            assert.throws(() => owner.observe(async () => {}), /shutting down/);
            resolve();
            const result = await observed;
            if (rejects) {
                assert.equal(result.error, failure);
                assert.equal(result.value, undefined);
            } else {
                assert.equal(result.error, undefined);
                assert.equal(result.value, createHash('sha256').update(bytes).digest('hex'));
            }
            assert.deepEqual(await leaving, { status: 'ready' });
            assert.equal(owner.active, false);
            assert.equal(state.handles.size, 0);
            assert.deepEqual(calls, ['cancel', 'reports']);
        }
    },
);
