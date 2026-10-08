import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UpdateCoordinator } from '../electron/update-coordinator';
import { UpdateReports } from '../electron/update-reports';
import { demoSnapshot } from './fixtures/snapshots';

async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'hub-update-reports-test-'));
    const reports = new UpdateReports(directory);
    const events: string[] = [];
    let connected = true;
    let connecting = false;
    let latest = { ...demoSnapshot(), mode: 'ssh' as const };
    let wait = Promise.resolve();
    const updater = {
        assertCanDownload: () => {},
        download: async () => {
            events.push('download');
            return '/verified/app';
        },
        executable: async () => {
            events.push('verify');
            return '/verified/app';
        },
    };
    const lifecycle = {
        isConnecting: () => connecting,
        isConnected: () => connected,
        waitForCollection: () => wait,
        latestSnapshot: () => latest,
        disconnect: () => {
            events.push('disconnect');
            connected = false;
        },
        progress: () => {},
        restart: () => {
            events.push('restart');
        },
    };
    return {
        directory,
        reports,
        events,
        updater,
        lifecycle,
        coordinator: new UpdateCoordinator(updater, reports, lifecycle),
        connected: () => connected,
        wait: (value: Promise<void>) => {
            wait = value;
        },
        connecting: (value: boolean) => {
            connecting = value;
        },
        latest: (value: typeof latest) => {
            latest = value;
        },
        close: () => rm(directory, { recursive: true, force: true }),
    };
}

for (const mode of ['clean', 'preserve', 'smart'] as const) {
    test(`${mode} update disconnects before download and handles its report without credentials`, async () => {
        const item = await fixture();
        try {
            item.lifecycle.isConnected = () => false;
            const snapshot = {
                ...demoSnapshot(),
                password: 'must-not-persist',
                privateKey: 'must-not-persist',
            };
            await item.coordinator.start({ mode, snapshot });
            assert.deepEqual(item.events, ['disconnect', 'download', 'verify', 'restart']);
            assert.equal(item.connected(), false);
            assert.equal(item.coordinator.active, true); // held until app quits
            const recovery = await item.reports.read();
            if (mode === 'clean') {
                assert.equal(recovery, null);
                assert.deepEqual(await readdir(item.directory), []);
            } else {
                assert.equal(recovery?.mode, mode);
                assert.equal(Boolean(recovery?.snapshot), mode === 'smart');
                const text = await readFile(recovery!.reportPath, 'utf8');
                assert.ok(!text.includes('must-not-persist'));
                await item.reports.acknowledge(recovery!.id);
                assert.equal(await item.reports.read(), null);
                assert.equal(await readFile(recovery!.reportPath, 'utf8'), text);
            }
        } finally {
            await item.close();
        }
    });
}

test('update drains collection under one lock and saves its newest completed snapshot', async () => {
    const item = await fixture();
    try {
        let finish!: () => void;
        item.wait(
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
        );
        const update = item.coordinator.start({ mode: 'smart', snapshot: demoSnapshot() });
        assert.equal(item.coordinator.active, true);
        assert.deepEqual(item.events, []);
        assert.equal(item.connected(), true);
        await assert.rejects(item.coordinator.start({ mode: 'clean' }), /already in progress/);
        const latest = { ...demoSnapshot(), mode: 'ssh' as const, endpoint: 'latest-device:22' };
        item.latest(latest);
        finish();
        await update;
        assert.equal((await item.reports.read())?.snapshot?.endpoint, latest.endpoint);
    } finally {
        await item.close();
    }
});

test('cancel/invalid options and connecting state never disconnect or start a download', async () => {
    const item = await fixture();
    try {
        await assert.rejects(item.coordinator.start({ mode: 'cancel' }), /Select an update option/);
        await assert.rejects(
            item.coordinator.start({ mode: 'smart', snapshot: {} }),
            /Unsupported report/,
        );
        item.connecting(true);
        await assert.rejects(item.coordinator.start({ mode: 'clean' }), /SSH connection to finish/);
        assert.deepEqual(item.events, []);
        assert.equal(item.connected(), true);
        assert.equal(item.coordinator.active, false);
    } finally {
        await item.close();
    }
});

test('save or download failure prevents restart, releases the lock and never reconnects', async () => {
    const item = await fixture();
    try {
        item.reports.save = async () => {
            throw Error('Cannot save backup');
        };
        await assert.rejects(item.coordinator.start({ mode: 'preserve' }), /Cannot save backup/);
        assert.deepEqual(item.events, ['disconnect']);
        assert.equal(item.coordinator.active, false);
        assert.equal(item.connected(), false);
        item.reports.save = UpdateReports.prototype.save.bind(item.reports);
        item.updater.download = async () => {
            throw Error('Download failed');
        };
        await assert.rejects(
            item.coordinator.start({ mode: 'smart', snapshot: demoSnapshot() }),
            /Download failed/,
        );
        assert.equal(await item.reports.read(), null);
        assert.equal(
            (await readdir(item.directory)).filter((name) => name.startsWith('report-')).length,
            1,
        );
        assert.ok(!item.events.includes('restart'));
        assert.equal(item.coordinator.active, false);
    } finally {
        await item.close();
    }
});

test('failed relaunch disarms restoration while keeping the completed report backup', async () => {
    const item = await fixture();
    try {
        item.lifecycle.restart = () => {
            throw Error('Relaunch failed');
        };
        await assert.rejects(item.coordinator.start({ mode: 'smart' }), /Relaunch failed/);
        assert.equal(await item.reports.read(), null);
        assert.equal((await readdir(item.directory)).length, 1);
        assert.equal(item.coordinator.active, false);
    } finally {
        await item.close();
    }
});

test('missing reports update normally and clean mode keeps older report backups', async () => {
    const item = await fixture();
    try {
        await item.reports.save('preserve', demoSnapshot());
        item.lifecycle.isConnected = () => false;
        await item.coordinator.start({ mode: 'smart' });
        assert.equal(await item.reports.read(), null);
        assert.equal((await readdir(item.directory)).length, 1);
    } finally {
        await item.close();
    }
});

test('report recovery is repeatable until acknowledged and rejects corrupt or unsafe markers', async () => {
    const item = await fixture();
    try {
        const pending = await item.reports.save('smart', demoSnapshot());
        await item.reports.arm(pending);
        const first = await item.reports.read();
        assert.deepEqual(await item.reports.read(), first);
        await writeFile(first!.reportPath, 'invalid JSON');
        await assert.rejects(item.reports.read(), /not valid JSON/);
        await writeFile(
            path.join(item.directory, 'pending.json'),
            JSON.stringify({ mode: 'smart', id: '../secret' }),
        );
        await assert.rejects(item.reports.read(), /Invalid saved update report/);
        await assert.rejects(item.reports.acknowledge('../secret'), /Invalid saved update report/);
    } finally {
        await item.close();
    }
});
