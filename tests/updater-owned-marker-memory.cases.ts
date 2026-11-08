import test from 'node:test';
import assert from 'node:assert/strict';
import { open as selectedOpen } from 'node:fs/promises';
import { open as memoryOpen, scope } from './fixtures/update-owned-memory';
import { UpdateOwnership } from '../electron/update-ownership';
import { UpdateReports } from '../electron/update-reports';
import { UpdateCoordinator } from '../electron/update-coordinator';
import { ReleaseUpdater } from '../electron/updates';
const options = {
    skip: selectedOpen === memoryOpen ? false : 'Requires audited memory filesystem aliases',
};
test(
    'actual marker stale acknowledgement cannot clear current identity; rejected disarm retains marker and quit custody',
    options,
    async () => {
        assert.equal(selectedOpen, memoryOpen);
        const s = scope(),
            owner = new UpdateOwnership();
        const reports = new UpdateReports('/memory/reports', owner);
        const saved = { id: '12345678-1234-1234-1234-123456789abc', mode: 'smart' as const };
        await owner.start(() => reports.arm(saved));
        await reports.acknowledge('87654321-1234-1234-1234-123456789abc');
        assert.equal(reports.isArmed(saved), true);
        assert.equal(s.files.has('/memory/reports/pending.json'), true);
        const primary = Error('restart'),
            cleanup = Error('marker removal');
        const coordinator = new UpdateCoordinator(
            {
                assertCanDownload() {},
                async download() {
                    return '/memory/exe';
                },
                async executable() {
                    return '/memory/exe';
                },
            },
            {
                async save() {
                    return saved;
                },
                arm: (value) => reports.arm(value),
                isArmed: (value) => reports.isArmed(value),
                acknowledge: (id) => reports.acknowledge(id),
            },
            {
                isConnecting: () => false,
                isConnected: () => false,
                async waitForCollection() {},
                latestSnapshot: () => null,
                disconnect() {},
                progress() {},
                restart() {
                    s.faults.rm = cleanup;
                    throw primary;
                },
            },
        );
        await assert.rejects(
            owner.start(() => coordinator.start({ mode: 'clean' })),
            (error) => {
                assert.ok(error instanceof AggregateError);
                assert.deepEqual(error.errors, [primary, cleanup]);
                assert.equal(error.cause, primary);
                return true;
            },
        );
        assert.equal(reports.isArmed(saved), true);
        assert.equal(s.files.has('/memory/reports/pending.json'), true);
        assert.equal(owner.blocked, true);
        assert.equal(s.handles.size, 0);
        let retired = false;
        void owner.shutdown().then(() => {
            retired = true;
        });
        for (let n = 0; n < 16; n++) await Promise.resolve();
        assert.equal(retired, false);
    },
);
test(
    'acknowledged HTTP error-body cancellation retires with the original failure and permits explicit new work',
    options,
    async () => {
        assert.equal(selectedOpen, memoryOpen);
        scope();
        const owner = new UpdateOwnership();
        const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')!;
        Object.defineProperty(AbortSignal, 'timeout', {
            configurable: true,
            value: () => new AbortController().signal,
        });
        try {
            const u = new ReleaseUpdater(
                '0.1.0',
                '/memory/updates',
                'win32',
                'x64',
                true,
                async () => new Response('error body', { status: 503 }),
                'portable',
                owner,
            );
            await assert.rejects(
                owner.start(() => u.check(false)),
                /503/,
            );
            assert.equal(owner.active, false);
            let called = false;
            await owner.start(async () => {
                called = true;
            });
            assert.equal(called, true);
            await owner.shutdown();
        } finally {
            Object.defineProperty(AbortSignal, 'timeout', descriptor);
        }
    },
);
