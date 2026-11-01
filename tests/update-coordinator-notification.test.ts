import assert from 'node:assert/strict';
import test from 'node:test';
import { UpdateCoordinator } from '../electron/update-coordinator';
import type { Snapshot } from '../shared/types';

type Updater = ConstructorParameters<typeof UpdateCoordinator>[0];
type Reports = ConstructorParameters<typeof UpdateCoordinator>[1];
type Lifecycle = ConstructorParameters<typeof UpdateCoordinator>[2];

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture() {
    const snapshot: Snapshot = {
        schemaVersion: 1,
        mode: 'ssh',
        endpoint: 'in-memory:22',
        username: 'fixture',
        capturedAt: '2026-10-29T00:00:00.000Z',
        results: [
            {
                id: 'identity',
                command: 'fixture identity',
                stdout: 'fixture kernel\nfixture host\nfixture architecture',
                stderr: '',
                status: 'collected',
                exitCode: 0,
                durationMs: 0,
                collectedAt: '2026-10-29T00:00:00.000Z',
                truncated: false,
            },
        ],
    };
    const saved = { id: '00000000-0000-4000-8000-000000000001', mode: 'smart' as const },
        backups = new Map<string, typeof snapshot>(),
        events: string[] = [],
        acknowledged: string[] = [];
    let marker: typeof saved | null = null;
    const updater: Updater = {
        assertCanDownload() {
            events.push('admit');
        },
        async download() {
            events.push('download');
            return '/memory/verified-update';
        },
        async executable() {
            events.push('verify');
            return '/memory/verified-update';
        },
    };
    const reports: Reports = {
        async save(mode, value) {
            events.push('save');
            assert.equal(mode, 'smart');
            assert.equal(value, snapshot);
            backups.set(saved.id, structuredClone(snapshot));
            return { ...saved };
        },
        async arm(value) {
            events.push('arm');
            assert.deepEqual(value, saved);
            assert.equal(marker, null);
            marker = { ...saved };
        },
        async acknowledge(id) {
            events.push('disarm');
            assert.equal(id, saved.id);
            assert.equal(marker?.id, id);
            acknowledged.push(id);
            marker = null;
        },
    };
    const lifecycle: Lifecycle = {
        isConnecting: () => false,
        isConnected: () => true,
        async waitForCollection() {
            events.push('drain');
        },
        latestSnapshot: () => snapshot,
        disconnect() {
            events.push('disconnect');
        },
        progress() {},
        restart() {
            events.push('restart');
        },
    };
    const coordinator = new UpdateCoordinator(updater, reports, lifecycle);
    return {
        coordinator, updater, reports, lifecycle, snapshot, saved, backups, events,
        acknowledged, marker: () => marker,
    };
}

test('early progress failure unlocks even when failed notification also throws', async () => {
    const f = fixture(),
        primary = Error('Preparing notification failed'),
        secondary = Error('Failed notification failed');
    let notifications = 0;
    f.lifecycle.progress = (progress) => {
        notifications++;
        assert.equal(f.coordinator.active, true);
        throw progress.stage === 'failed' ? secondary : primary;
    };
    await assert.rejects(f.coordinator.start({ mode: 'smart' }), (error) => error === primary);
    assert.equal(notifications, 2);
    assert.equal(f.coordinator.active, false);
    assert.deepEqual(f.events, ['admit']);
    assert.equal(f.backups.size, 0);
    assert.equal(f.marker(), null);
    assert.deepEqual(f.acknowledged, []);
});

test('download failure remains primary and unarmed backup survives a failed notification', async () => {
    const f = fixture(),
        primary = Error('Download failed');
    f.updater.download = async () => {
        f.events.push('download');
        throw primary;
    };
    f.lifecycle.progress = (progress) => {
        if (progress.stage === 'failed') throw Error('Renderer disappeared');
    };
    await assert.rejects(f.coordinator.start({ mode: 'smart' }), (error) => error === primary);
    assert.equal(f.coordinator.active, false);
    assert.deepEqual(f.events, ['admit', 'drain', 'disconnect', 'save', 'download']);
    assert.deepEqual(f.backups.get(f.saved.id), f.snapshot);
    assert.equal(f.marker(), null);
    assert.deepEqual(f.acknowledged, []);
});

test('failed restart owns disarm until settlement, rejects reentry and preserves both failures', async () => {
    for (const disarmFails of [false, true]) {
        const f = fixture(),
            primary = Error('Relaunch failed'),
            disarmError = Error('Marker storage unavailable'),
            entered = deferred(),
            release = deferred();
        let reentrant: Promise<unknown> | undefined;
        f.lifecycle.restart = () => {
            f.events.push('restart');
            throw primary;
        };
        f.lifecycle.progress = (progress) => {
            if (progress.stage !== 'failed') return;
            assert.equal(f.coordinator.active, true);
            reentrant = f.coordinator.start({ mode: 'smart' }).then(
                () => assert.fail('Reentrant update must refuse.'),
                (error) => error,
            );
            throw Error('Renderer disappeared');
        };
        const acknowledge = f.reports.acknowledge;
        let attempts = 0;
        f.reports.acknowledge = async (id) => {
            attempts++;
            assert.equal(id, f.saved.id);
            assert.equal(f.coordinator.active, true);
            entered.resolve();
            await release.promise;
            if (disarmFails) throw disarmError;
            await acknowledge(id);
        };
        const outcome = f.coordinator.start({ mode: 'smart' }).then(
            () => assert.fail('Restart must fail.'),
            (error: unknown) => error,
        );
        try {
            await Promise.race([
                entered.promise,
                outcome.then(() => assert.fail('Failure unwind never attempted marker disarm.')),
            ]);
            assert.equal(f.coordinator.active, true);
            assert.deepEqual(f.marker(), f.saved);
            assert.match(String(await reentrant), /already in progress/);
            await assert.rejects(f.coordinator.start({ mode: 'smart' }), /already in progress/);
            assert.equal(f.events.filter((event) => event === 'admit').length, 1);
        } finally {
            release.resolve();
        }
        const failure = await outcome;
        if (disarmFails) {
            assert.ok(failure instanceof AggregateError);
            assert.equal(failure.cause, primary);
            assert.deepEqual(failure.errors, [primary, disarmError]);
            assert.match(failure.message, /Relaunch failed.*disarm failed.*Marker storage unavailable/);
            assert.deepEqual(f.marker(), f.saved);
            assert.deepEqual(f.acknowledged, []);
        } else {
            assert.equal(failure, primary);
            assert.equal(f.marker(), null);
            assert.deepEqual(f.acknowledged, [f.saved.id]);
        }
        assert.equal(attempts, 1);
        assert.equal(f.coordinator.active, false);
        assert.deepEqual(f.backups.get(f.saved.id), f.snapshot);
        assert.equal(f.events.filter((event) => event === 'restart').length, 1);
    }
});

test('normal smart handoff preserves its backup and marker and holds the lock after restart', async () => {
    const f = fixture(),
        phases: string[] = [];
    f.lifecycle.progress = (progress) => {
        phases.push(progress.stage);
        assert.equal(f.coordinator.active, true);
    };
    f.lifecycle.restart = (executable) => {
        assert.equal(executable, '/memory/verified-update');
        assert.deepEqual(f.marker(), f.saved);
        assert.deepEqual(f.backups.get(f.saved.id), f.snapshot);
        assert.equal(f.coordinator.active, true);
        f.events.push('restart');
    };
    await f.coordinator.start({ mode: 'smart' });
    assert.deepEqual(f.events, [
        'admit',
        'drain',
        'disconnect',
        'save',
        'download',
        'verify',
        'arm',
        'restart',
    ]);
    assert.equal(phases.at(-1), 'handoff');
    assert.ok(!phases.includes('failed'));
    assert.equal(f.coordinator.active, true);
    assert.deepEqual(f.marker(), f.saved);
    assert.deepEqual(f.backups.get(f.saved.id), f.snapshot);
    assert.deepEqual(f.acknowledged, []);
    const before = structuredClone({ events: f.events, marker: f.marker(), backup: f.backups });
    await assert.rejects(f.coordinator.start({ mode: 'smart' }), /already in progress/);
    assert.deepEqual({ events: f.events, marker: f.marker(), backup: f.backups }, before);
    assert.deepEqual(f.acknowledged, []);
    assert.equal(f.coordinator.active, true);
});
