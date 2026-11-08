import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeReportExports, type ReportExportIO } from '../electron/report-export';
import { UpdateCoordinator } from '../electron/update-coordinator';
import { ReportExportAction } from '../src/services/report-export-action';
import { reportExportMessage, type ReportExportStatus } from '../shared/report-export';
import { createReport } from '../shared/report';
import { runQuitCleanup, quitAllowsIpc } from '../shared/quit-cleanup';
import type { DesktopBridge, Snapshot } from '../shared/types';
const snapshot: Snapshot = {
    schemaVersion: 1,
    mode: 'demo',
    endpoint: 'synthetic.invalid',
    username: 'fixture',
    capturedAt: '2028-02-29T00:00:00.000Z',
    results: [],
};
const token = '00000000-0000-4000-8000-000000000001';
const directory = '/safe/.diagnostic-hub-report-' + token;
const temporary = directory + '/report.tmp';
const err = (code: string) => Object.assign(Error(code), { code });
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
async function pump() {
    for (let i = 0; i < 160; i++) await Promise.resolve();
}
function watched<T>(promise: Promise<T>) {
    let done = false;
    void promise.then(() => {
        done = true;
    });
    return () => done;
}
function fixture() {
    type Node = { kind: 'directory' | 'file' | 'link'; bytes: Uint8Array; ino: number };
    const nodes = new Map<string, Node>([
        ['/safe', { kind: 'directory', bytes: new Uint8Array(), ino: 1 }],
    ]);
    const hooks: Record<string, (() => unknown | Promise<unknown>) | undefined> = {};
    const log: string[] = [],
        states: ReportExportStatus[] = [],
        chunks: number[] = [];
    const listeners = new Set<(s: ReportExportStatus) => void>();
    let opened = false,
        serial = 2,
        partial = Infinity;
    const call = async (name: string) => {
        log.push(name);
        await hooks[name]?.();
    };
    const stat = (node: Node) => ({
        isDirectory: () => node.kind === 'directory',
        isFile: () => node.kind === 'file',
        isSymbolicLink: () => node.kind === 'link',
        nlink: 1,
        ino: node.ino,
        dev: 1,
    });
    const fs = {
        async lstat(name: string) {
            await call('lstat');
            const n = nodes.get(name);
            if (!n) throw err('ENOENT');
            return stat(n);
        },
        async realpath(name: string) {
            await call('realpath');
            return name;
        },
        async mkdir(name: string, options: unknown) {
            await call('mkdir');
            assert.deepEqual(options, { recursive: false, mode: 0o700 });
            if (nodes.has(name)) throw err('EEXIST');
            nodes.set(name, { kind: 'directory', bytes: new Uint8Array(), ino: serial++ });
        },
        async open(name: string, flags: string, mode: number) {
            await call('open');
            assert.equal(flags, 'wx');
            assert.equal(mode, 0o600);
            if (nodes.has(name)) throw err('EEXIST');
            const node: Node = { kind: 'file', bytes: new Uint8Array(), ino: serial++ };
            nodes.set(name, node);
            opened = true;
            return {
                async stat() {
                    await call('stat');
                    return stat(node);
                },
                async write(bytes: Uint8Array, offset: number, length: number, position: number) {
                    chunks.push(bytes.length);
                    await call('write');
                    const count = Math.min(length, partial);
                    const next = new Uint8Array(Math.max(node.bytes.length, position + count));
                    next.set(node.bytes);
                    next.set(bytes.subarray(offset, offset + count), position);
                    node.bytes = next;
                    return { bytesWritten: count };
                },
                async sync() {
                    await call('sync');
                },
                async close() {
                    await call('close');
                    opened = false;
                },
            };
        },
        async link(from: string, to: string) {
            await call('link');
            if (nodes.has(to)) throw err('EEXIST');
            nodes.set(to, nodes.get(from)!);
        },
        async unlink(name: string) {
            await call('unlink');
            assert.ok(nodes.has(name));
            nodes.delete(name);
        },
        async rmdir(name: string) {
            await call('rmdir');
            if ([...nodes.keys()].some((k) => k.startsWith(name + '/'))) throw err('ENOTEMPTY');
            nodes.delete(name);
        },
    };
    const io: ReportExportIO = {
        fs: fs as unknown as ReportExportIO['fs'],
        random: () => token,
        choose: async (filename) => {
            log.push('dialog');
            assert.equal(filename, 'diagnostic-demo-2028-02-29T00-00-00-000Z.json');
            await hooks.dialog?.();
            return { canceled: false, filePath: '/safe/report.json' };
        },
        notify: (s) => {
            states.push(s);
            for (const fn of listeners) fn(s);
        },
    };
    const service = new NativeReportExports(io);
    const bridge: Pick<
        DesktopBridge,
        'exportReport' | 'cancelReportExport' | 'reportExportStatus' | 'onReportExportStatus'
    > = {
        exportReport: (s, id) => service.start(id!, s!),
        cancelReportExport: async (id) => service.cancel(id),
        reportExportStatus: async () => service.status(),
        onReportExportStatus: (fn) => {
            listeners.add(fn);
            return () => {
                listeners.delete(fn);
            };
        },
    };
    return {
        io,
        service,
        bridge,
        nodes,
        hooks,
        log,
        states,
        chunks,
        listeners,
        setPartial: (n: number) => {
            partial = n;
        },
        opened: () => opened,
    };
}

test('new report preserves exact UTF8 serialization, partial-write acknowledgements and bounded chunks', async () => {
    for (const large of [false, true]) {
        const f = fixture();
        if (!large) f.setPartial(17);
        const s = {
            ...snapshot,
            results: large
                ? [
                      {
                          id: 'system',
                          stdout: 'x'.repeat(16230) + '😀'.repeat(20000),
                          stderr: '',
                          status: 'collected' as const,
                          exitCode: 0,
                          durationMs: 1,
                          truncated: false,
                          collectedAt: snapshot.capturedAt,
                      },
                  ]
                : [],
        };
        const result = await f.service.start('a', s);
        assert.equal(result.outcome, 'saved');
        assert.equal(result.retirement, 'acknowledged');
        assert.deepEqual(
            f.nodes.get('/safe/report.json')!.bytes,
            new TextEncoder().encode(JSON.stringify(createReport(s), null, 2)),
        );
        assert.ok(f.chunks.every((n) => n <= 65536));
        assert.ok(!f.nodes.has(temporary) && !f.nodes.has(directory));
        assert.ok(
            f.log.indexOf('sync') < f.log.indexOf('link') &&
                f.log.indexOf('link') < f.log.indexOf('close'),
        );
        await pump();
        assert.equal(f.service.retainedAttempt, undefined);
    }
});

test('existing regular file or link survives collision unchanged, including late collision', async () => {
    for (const kind of ['file', 'link'] as const)
        for (const late of [false, true]) {
            const f = fixture(),
                original = { kind, ino: 99, bytes: new TextEncoder().encode('existing') };
            if (late)
                f.hooks.link = () => {
                    f.nodes.set('/safe/report.json', original);
                };
            else f.nodes.set('/safe/report.json', original);
            const result = await f.service.start('a', snapshot);
            assert.equal(result.outcome, 'failed');
            assert.equal(result.publication, 'unpublished');
            assert.equal(result.primary, 'EEXIST');
            assert.equal(f.nodes.get('/safe/report.json'), original);
            assert.ok(!f.nodes.has(temporary) && !f.nodes.has(directory));
        }
});

test('dialog cancellation and cancellation during dialog never acquire staging or publish', async () => {
    for (const explicit of [false, true]) {
        const f = fixture(),
            held = gate();
        if (explicit) f.hooks.dialog = () => held.promise;
        else f.io.choose = async () => ({ canceled: true });
        const promise = f.service.start('a', snapshot);
        if (explicit) {
            f.service.cancel('a');
            held.resolve();
        }
        assert.equal((await promise).outcome, 'cancelled');
        assert.ok(!f.log.includes('mkdir') && !f.log.includes('link'));
    }
});

test('partial write failure keeps primary error through successful cleanup and permits a fresh action', async () => {
    const f = fixture(),
        original = Error('original write');
    f.setPartial(2);
    let count = 0;
    f.hooks.write = () => {
        if (++count === 2) throw original;
    };
    const ownerPromise = f.service.start('a', snapshot),
        owner = f.service.retainedAttempt!;
    const result = await ownerPromise;
    assert.equal(result.primary, 'original write');
    assert.equal(owner.originalErrors().primary, original);
    assert.equal(result.outcome, 'failed');
    assert.ok(!f.nodes.has('/safe/report.json'));
    f.hooks.write = undefined;
    assert.equal((await f.service.start('b', snapshot)).outcome, 'saved');
});

test('close rejection preserves independent primary error, retained ownership, no retry or false completion', async () => {
    const f = fixture(),
        primary = Error('write failed'),
        close = Error('close failed');
    f.hooks.write = () => {
        throw primary;
    };
    f.hooks.close = () => {
        throw close;
    };
    const done = watched(f.service.start('a', snapshot)),
        owner = f.service.retainedAttempt!;
    const retirement = watched(owner.retired);
    await pump();
    assert.equal(done(), false);
    assert.equal(retirement(), false);
    assert.equal(f.opened(), true);
    assert.deepEqual(owner.retainedResources(), { directory, temporary, handleHeld: true });
    assert.equal(owner.originalErrors().primary, primary);
    assert.equal(owner.originalErrors().cleanup.get('close'), close);
    assert.equal(f.service.status()!.retirement, 'blocked');
    assert.match(reportExportMessage(f.service.status()!), /write failed.*close failed/);
    assert.throws(() => f.service.start('b', snapshot), /not retired/);
    f.service.cancel('a');
    const quit = watched(f.service.shutdown());
    await pump();
    assert.equal(quit(), false);
    assert.equal(f.log.filter((s) => s === 'close').length, 1);
    assert.ok(!f.log.includes('unlink'));
});

for (const stage of ['unlink', 'rmdir'] as const)
    test(`published report with ${stage} rejection stays saved but cleanup-blocked`, async () => {
        const f = fixture(),
            original = Error(stage + ' failed');
        f.hooks[stage] = () => {
            throw original;
        };
        const done = watched(f.service.start('a', snapshot));
        await pump();
        assert.equal(done(), false);
        assert.equal(f.service.status()!.publication, 'published');
        assert.equal(f.service.status()!.retirement, 'blocked');
        assert.ok(f.nodes.has('/safe/report.json'));
        assert.deepEqual(f.service.retainedAttempt!.retainedResources(), {
            directory,
            temporary: stage === 'unlink' ? temporary : undefined,
            handleHeld: false,
        });
        assert.match(reportExportMessage(f.service.status()!), /Report saved.*cleanup unconfirmed/);
        assert.ok(f.nodes.has(directory));
        f.service.cancel('a');
        await pump();
        assert.equal(f.log.filter((s) => s === stage).length, 1);
    });

test('unacknowledged link failure retains staged evidence and uncertain publication without replay', async () => {
    const f = fixture();
    f.hooks.link = () => {
        throw err('EIO');
    };
    const done = watched(f.service.start('a', snapshot));
    await pump();
    assert.equal(done(), false);
    assert.equal(f.service.status()!.publication, 'uncertain');
    assert.ok(f.nodes.has(temporary));
    assert.ok(!f.log.includes('unlink'));
    assert.equal(f.opened(), false);
    f.service.cancel('a');
    await pump();
    assert.equal(f.log.filter((s) => s === 'link').length, 1);
});

test('cancel after link dispatch cannot undo publication; completion waits for close and directory acknowledgement', async () => {
    const f = fixture(),
        link = gate(),
        close = gate(),
        remove = gate();
    f.hooks.link = () => link.promise;
    f.hooks.close = () => close.promise;
    f.hooks.rmdir = () => remove.promise;
    const promise = f.service.start('a', snapshot),
        done = watched(promise);
    await pump();
    f.service.cancel('a');
    link.resolve();
    await pump();
    assert.equal(f.service.status()!.publication, 'published');
    assert.equal(done(), false);
    close.resolve();
    await pump();
    assert.equal(done(), false);
    assert.ok(f.nodes.has('/safe/report.json'));
    remove.resolve();
    const result = await promise;
    assert.equal(result.outcome, 'saved');
    assert.equal(result.cancelRequested, true);
});

test('reentrant cancellation before publication dispatch prevents the link', async () => {
    const f = fixture(),
        notify = f.io.notify;
    f.io.notify = (s) => {
        notify(s);
        if (s.publication === 'pending' && !s.cancelRequested) f.service.cancel(s.id);
    };
    const value = await f.service.start('a', snapshot);
    assert.equal(value.publication, 'unpublished');
    assert.equal(value.outcome, 'cancelled');
    assert.ok(!f.log.includes('link'));
});

test('exclusive staging collision never adopts/removes a foreign directory and acquisition/sync errors retire owned resources', async () => {
    const f = fixture(),
        foreign = { kind: 'directory' as const, bytes: new Uint8Array(), ino: 99 };
    f.nodes.set(directory, foreign);
    assert.equal((await f.service.start('a', snapshot)).outcome, 'failed');
    assert.equal(f.nodes.get(directory), foreign);
    assert.ok(!f.log.includes('rmdir'));
    for (const stage of ['open', 'stat', 'sync']) {
        const g = fixture();
        g.hooks[stage] = () => {
            throw Error(stage + ' failed');
        };
        const result = await g.service.start('a', snapshot);
        assert.equal(result.primary, stage + ' failed');
        assert.equal(result.retirement, 'acknowledged');
        assert.ok(!g.nodes.has(directory) && !g.nodes.has('/safe/report.json'));
    }
});

test('normal quit joins held report retirement and fences new admission alongside other cleanup ports', async () => {
    const f = fixture(),
        held = gate();
    f.hooks.close = () => held.promise;
    const saved = f.service.start('a', snapshot);
    await pump();
    const quit = runQuitCleanup({
        cancelConnection() {},
        clearHostVerification() {},
        disconnect() {},
        prepareConsole: async () => {},
        joinConnection: async () => {},
        joinSsh: async () => {},
        finishConsole: async () => {},
        shutdownCapture: async () => {},
        shutdownReports: () => f.service.shutdown(),
    });
    const done = watched(quit);
    await pump();
    assert.equal(done(), false);
    assert.throws(() => f.service.start('b', snapshot), /shutting down/);
    held.resolve();
    await quit;
    assert.equal((await saved).outcome, 'saved');
    assert.equal(quitAllowsIpc('hub:cancel-report-export'), true);
    assert.equal(quitAllowsIpc('hub:report-export-status'), true);
    assert.equal(quitAllowsIpc('hub:export'), false);
});

test('actual renderer action/native composition holds busy/status through blocked cleanup and detaches listeners', async () => {
    const f = fixture(),
        changes: ReportExportStatus[] = [];
    f.hooks.rmdir = () => {
        throw Error('directory retained');
    };
    const action = new ReportExportAction(
        f.bridge,
        (s) => {
            if (s) changes.push(s);
        },
        () => 'a',
    );
    const detach = action.attach();
    void action.start(snapshot);
    await pump();
    assert.equal(changes.at(-1)!.publication, 'published');
    assert.equal(changes.at(-1)!.retirement, 'blocked');
    const calls = f.log.length;
    await action.start(snapshot);
    assert.equal(f.log.length, calls);
    detach();
    assert.equal(f.listeners.size, 0);
    const n = changes.length;
    f.io.notify({ ...f.service.status()!, primary: 'late' });
    assert.equal(changes.length, n);
});

test('renderer event beats initial snapshot, stale IDs cannot affect replacement, explicit retry follows retirement', async () => {
    const f = fixture(),
        read = gate();
    let first = true;
    const bridge = {
        ...f.bridge,
        reportExportStatus: async () => {
            if (first) {
                first = false;
                await read.promise;
                return null;
            }
            return f.service.status();
        },
    };
    const changes: ReportExportStatus[] = [];
    let identity = 0;
    const action = new ReportExportAction(
        bridge,
        (s) => {
            if (s) changes.push(s);
        },
        () => String(++identity),
    );
    const detach = action.attach();
    f.hooks.write = () => {
        throw Error('write failed');
    };
    await action.start(snapshot);
    assert.equal(changes.at(-1)!.outcome, 'failed');
    read.resolve();
    await pump();
    assert.equal(changes.at(-1)!.primary, 'write failed');
    f.hooks.write = undefined;
    const held = gate();
    f.hooks.close = () => held.promise;
    const next = action.start(snapshot);
    await pump();
    const n = changes.length;
    f.service.cancel('1');
    f.io.notify({ ...changes[0], outcome: 'failed', retirement: 'acknowledged' });
    assert.equal(changes.length, n);
    assert.equal(f.service.status()!.cancelRequested, false);
    held.resolve();
    await next;
    assert.equal(changes.at(-1)!.outcome, 'saved');
    detach();
});

test('held write cancellation waits for its acknowledgement, prevents publication and notification failure cannot release custody', async () => {
    const f = fixture(),
        held = gate();
    f.hooks.write = () => held.promise;
    f.io.notify = () => {
        throw Error('notification lost');
    };
    const saved = f.service.start('a', snapshot),
        done = watched(saved);
    await pump();
    f.service.cancel('stale');
    assert.equal(f.service.status()!.cancelRequested, false);
    f.service.cancel('a');
    await pump();
    assert.equal(done(), false);
    assert.equal(f.opened(), true);
    assert.ok(!f.log.includes('close') && !f.log.includes('link'));
    held.resolve();
    assert.equal((await saved).outcome, 'cancelled');
    assert.equal(f.log.filter((s) => s === 'write').length, 1);
    assert.ok(!f.log.includes('link'));
});

test('renderer IPC failure reconciles native ownership and unavailable status cannot falsely clear busy', async () => {
    for (const unavailable of [false, true]) {
        const f = fixture(),
            changes: ReportExportStatus[] = [];
        const bridge = {
            ...f.bridge,
            exportReport: async () => {
                throw Error('IPC rejected');
            },
            reportExportStatus: async () => {
                if (unavailable) throw Error('status unavailable');
                return null;
            },
        };
        const action = new ReportExportAction(
            bridge,
            (s) => {
                if (s) changes.push(s);
            },
            () => 'a',
        );
        const detach = action.attach();
        await action.start(snapshot);
        assert.equal(changes.at(-1)!.retirement, 'unknown');
        assert.equal(changes.at(-1)!.publication, 'uncertain');
        assert.equal(changes.at(-1)!.outcome, undefined);
        assert.match(reportExportMessage(changes.at(-1)!), /native retirement status unknown/);
        assert.doesNotMatch(reportExportMessage(changes.at(-1)!), /normal quit remain blocked/);
        assert.ok(!f.log.includes('dialog'));
        detach();
    }
    const f = fixture(),
        changes: ReportExportStatus[] = [];
    const bridge = {
        ...f.bridge,
        exportReport: async (s?: Snapshot, id?: string) => {
            await f.bridge.exportReport(s, id);
            throw Error('reply lost after publication');
        },
    };
    const action = new ReportExportAction(
        bridge,
        (s) => {
            if (s) changes.push(s);
        },
        () => 'saved',
    );
    const detach = action.attach();
    await action.start(snapshot);
    assert.equal(changes.at(-1)!.outcome, 'saved');
    assert.equal(changes.at(-1)!.publication, 'published');
    assert.equal(f.service.retainedAttempt, undefined);
    detach();
});

test('late reconciliation reply or failure cannot downgrade newer native publication and retirement events', async () => {
    for (const response of ['stale', 'missing', 'rejected', 'lost-after-retirement']) {
        const f = fixture(),
            heldClose = gate(),
            heldRead = gate();
        f.hooks.close = () => heldClose.promise;
        let reads = 0,
            native!: Promise<ReportExportStatus>;
        const bridge = {
            ...f.bridge,
            exportReport: async (s?: Snapshot, id?: string) => {
                native = f.bridge.exportReport(s, id);
                if (response === 'lost-after-retirement') await native;
                throw Error('export reply lost');
            },
            reportExportStatus: async () => {
                if (++reads === 1) return null; // Initial attachment query.
                const captured = f.service.status();
                await heldRead.promise;
                if (response === 'rejected') throw Error('old status read failed');
                return response === 'missing' ? null : captured;
            },
        };
        const changes: ReportExportStatus[] = [];
        const action = new ReportExportAction(
            bridge,
            (s) => {
                if (s) changes.push(s);
            },
            () => 'a',
        );
        const detach = action.attach(),
            started = action.start(snapshot);
        await pump();
        assert.equal(reads, response === 'lost-after-retirement' ? 1 : 2);
        heldClose.resolve();
        await native;
        const acknowledged = changes.at(-1)!;
        assert.equal(acknowledged.publication, 'published');
        assert.equal(acknowledged.retirement, 'acknowledged');
        heldRead.resolve();
        await started;
        assert.deepEqual(changes.at(-1), acknowledged, response);
        if (response === 'lost-after-retirement') assert.equal(reads, 1);
        detach();
    }
});

function updateWithReportOwner(f: ReturnType<typeof fixture>) {
    const events: string[] = [];
    const updater = {
        assertCanDownload() {
            events.push('admit');
        },
        async download() {
            events.push('download');
            return '/synthetic/update';
        },
        async executable() {
            events.push('verify');
            return '/synthetic/update';
        },
    };
    const coordinator = new UpdateCoordinator(
        updater,
        {
            async save() {
                events.push('save');
                return null;
            },
            async arm() {
                events.push('arm');
            },
            async acknowledge() {
                events.push('disarm');
            },
        },
        {
            isConnecting: () => false,
            isReportExporting: () => Boolean(f.service.retainedAttempt),
            isConnected: () => false,
            latestSnapshot: () => null,
            async waitForCollection() {
                events.push('collection');
            },
            disconnect() {
                events.push('disconnect');
            },
            progress() {},
            restart() {
                events.push('restart');
            },
        },
    );
    return { coordinator, updater, events };
}

test('report/update admission rejects pending or blocked native report ownership, including after Cancel', async () => {
    for (const state of ['pending', 'blocked']) {
        const f = fixture(),
            close = gate();
        f.hooks.close =
            state === 'pending'
                ? () => close.promise
                : () => {
                      throw Error('report close unacknowledged');
                  };
        f.io.notify = () => {
            throw Error('renderer unavailable');
        };
        const saved = f.service.start('report', snapshot);
        await pump();
        const update = updateWithReportOwner(f);
        for (const cancel of [false, true]) {
            if (cancel) f.service.cancel('report');
            await assert.rejects(update.coordinator.start({ mode: 'clean' }), /report export/i);
            assert.equal(update.coordinator.active, false);
            assert.deepEqual(update.events, []);
        }
        assert.equal(f.service.status()!.publication, 'published');
        if (state === 'pending') {
            close.resolve();
            assert.equal((await saved).outcome, 'saved');
            await update.coordinator.start({ mode: 'clean' });
            assert.equal(update.events.at(-1), 'restart');
        } else {
            assert.equal(f.service.status()!.retirement, 'blocked');
            assert.equal(f.opened(), true);
            assert.equal(f.log.filter((s) => s === 'close').length, 1);
        }
    }
});

test('report/update admission trusts acknowledged native retirement, not a stale renderer failure', async () => {
    const f = fixture();
    f.hooks.write = () => {
        throw Error('report failed');
    };
    assert.equal((await f.service.start('report', snapshot)).outcome, 'failed');
    assert.equal(f.service.retainedAttempt, undefined);
    const update = updateWithReportOwner(f);
    await update.coordinator.start({ mode: 'clean' });
    assert.equal(update.coordinator.active, true);
    assert.equal(update.events.at(-1), 'restart');
});
