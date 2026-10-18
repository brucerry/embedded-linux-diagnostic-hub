import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { NativeCaptureStore } from '../electron/capture-store';
import { NativeCaptureCatalog } from '../electron/capture-catalog';
import { physicalFS } from '../electron/physical-fs';
import { CaptureWriter } from '../shared/capture-writer';
import {
    newCapture,
    sealedCapture,
    CaptureStorageError,
    type CaptureHeader,
} from '../shared/capture-store';
import { streamCaptureReport } from '../shared/capture-report';
import { CaptureRpcServer } from '../shared/capture-rpc';
import { NativeCaptureRepository } from '../src/features/automation/capture/native-repository';
const stamp = '2026-10-15T00:00:00.000Z';
const header = (name = 'legacy'): CaptureHeader => ({
    transport: 'serial',
    receiveTimeSource: 'local-client',
    runId: 'legacy-run',
    stepId: 'one',
    name,
    command: 'fixture',
    startedAt: stamp,
});
async function fixture(t: TestContext) {
    const temporary = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temporary, 'hub-index-lifecycle-')),
        opened: NativeCaptureStore[] = [];
    t.after(async () => {
        for (const store of opened) await store.close();
        assert.ok(
            path.resolve(profile).startsWith(temporary + path.sep) &&
                path.basename(profile).startsWith('hub-index-lifecycle-'),
        );
        await fs.rm(profile, { recursive: true, force: true });
    });
    return {
        profile,
        root: path.join(profile, 'captures-v1'),
        open: async () => {
            const store = await NativeCaptureStore.open(profile, { profileOwned: true });
            opened.push(store);
            return store;
        },
    };
}
async function record(store: NativeCaptureStore, text = 'exact legacy bytes') {
    const writer = await CaptureWriter.begin(store, header());
    await writer.append(new TextEncoder().encode(text), stamp, 'serial');
    return writer.finish('prompt-observed');
}
async function json(store: NativeCaptureStore) {
    let output = '';
    for await (const bytes of streamCaptureReport(store, 'json')) {
        output += new TextDecoder().decode(bytes);
        assert.ok(output.length < 1024 * 1024);
    }
    return JSON.parse(output);
}
async function terminateAt(profile: string, mode: string, id?: string) {
    const child = spawn(
        process.execPath,
        [
            '--import',
            'tsx',
            'tests/fixtures/capture-store-crash.ts',
            profile,
            mode,
            ...(id ? [id] : []),
        ],
        { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
        error = '';
    child.stderr.on('data', (bytes) => {
        error = (error + bytes).slice(-4096);
    });
    try {
        const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(Error('Owned crash fixture failed to reach its gate: ' + error)),
                15000,
            );
            child.on('error', (reason) => {
                clearTimeout(timeout);
                reject(reason);
            });
            child.on('exit', () => {
                clearTimeout(timeout);
                reject(Error('Owned crash fixture exited before its gate: ' + error));
            });
            child.stdout.on('data', (bytes) => {
                output += bytes;
                if (output.includes('\n')) {
                    clearTimeout(timeout);
                    try {
                        resolve(JSON.parse(output.split('\n')[0]));
                    } catch (reason) {
                        reject(reason);
                    }
                }
            });
        });
        const exited = once(child, 'exit');
        assert.equal(child.kill('SIGKILL'), true);
        await exited;
        return message;
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
        }
    }
}
test('legacy catalog recovery scans once and indexed pages read only a bounded window despite large sequence gaps', async (t) => {
    const { root, open } = await fixture(t);
    await fs.mkdir(root);
    const count = 2048;
    for (let start = 0; start < count; start += 16)
        await Promise.all(
            Array.from({ length: Math.min(16, count - start) }, async (_, offset) => {
                const sequence = start + offset + 1,
                    id = crypto.randomUUID(),
                    folder = path.join(root, id);
                await fs.mkdir(folder);
                const capture = sealedCapture(
                    newCapture(id, sequence, header('row-' + sequence)),
                    0,
                    'legacy empty',
                );
                await fs.writeFile(
                    path.join(folder, 'meta.json'),
                    JSON.stringify({ capture, offset: 0 }),
                );
                await fs.writeFile(path.join(folder, 'raw.jsonl'), '');
            }),
        );
    await fs.writeFile(path.join(root, 'sequence.json'), JSON.stringify({ sequence: 9000 }));
    const opendir = physicalFS.promises.opendir.bind(physicalFS.promises),
        openFile = physicalFS.promises.open.bind(physicalFS.promises);
    let scans = 0,
        metadataReads = 0;
    t.mock.method(physicalFS.promises, 'opendir', async (...args: Parameters<typeof opendir>) => {
        if (path.resolve(String(args[0])) === path.resolve(root)) scans++;
        return opendir(...args);
    });
    t.mock.method(physicalFS.promises, 'open', async (...args: Parameters<typeof openFile>) => {
        if (path.basename(String(args[0])) === 'meta.json') metadataReads++;
        return openFile(...args);
    });
    const store = await open();
    assert.equal(scans, 1);
    assert.equal(metadataReads, count);
    assert.equal(store.recoveryFailure, undefined);
    scans = metadataReads = 0;
    const page = await store.page(1000, 20);
    assert.deepEqual(
        page.records.map((row) => row.sequence),
        Array.from({ length: 20 }, (_, i) => 1001 + i),
    );
    assert.equal(page.next, 1020);
    assert.equal(scans, 0);
    assert.equal(metadataReads, 21);
    const tail = await store.page(2040, 20);
    assert.equal(tail.records.length, 8);
    assert.equal(tail.next, null);
    const next = await store.begin(header('new'));
    assert.equal(next.sequence, 9001);
    await store.seal(next.id, 0, 'empty');
    assert.equal((await store.page(2048, 20)).records[0].id, next.id);
    assert.equal(scans, 0);
    t.diagnostic(
        JSON.stringify({
            legacyRows: count,
            recoveryScans: 1,
            indexedPageMetadataReads: 21,
            indexedPageDirectoryScans: 0,
            reservedSequence: 9001,
        }),
    );
});
test('rebuilding a disposable index preserves legacy metadata, raw bytes and immutable outcomes exactly', async (t) => {
    const { root, open } = await fixture(t),
        store = await open(),
        capture = await record(store, '\u0000\u001b[31mlegacy\r\n');
    const outcome = {
        id: crypto.randomUUID().replaceAll('-', ''),
        ordinal: 1,
        completion: 'prompt-observed' as const,
        exitCode: null,
        truncated: false,
        completedAt: stamp,
        localZone: 'UTC',
        durationMs: 1,
        deviceTime: null,
    };
    await store.record(capture.id, outcome);
    await store.close();
    const files = ['meta.json', 'raw.jsonl', 'result.json'],
        before = await Promise.all(
            files.map((file) => fs.readFile(path.join(root, capture.id, file))),
        );
    await fs.writeFile(
        path.join(root, '.catalog-' + crypto.randomUUID() + '.sqlite'),
        'interrupted disposable index',
    );
    const reopened = await open(),
        report = await json(reopened);
    assert.equal(report.captures.length, 1);
    assert.deepEqual(report.captures[0].outcome, outcome);
    for (let i = 0; i < files.length; i++)
        assert.deepEqual(await fs.readFile(path.join(root, capture.id, files[i])), before[i]);
    assert.equal((await fs.readdir(root)).filter((name) => name.startsWith('.catalog-')).length, 1);
});
test('catalog creation failure preserves readable/exportable captures and explicit deletion', async (t) => {
    const { root, open } = await fixture(t),
        store = await open(),
        capture = await record(store);
    await store.close();
    const openFile = physicalFS.promises.open.bind(physicalFS.promises);
    const fault = t.mock.method(
        physicalFS.promises,
        'open',
        async (...args: Parameters<typeof openFile>) => {
            if (path.basename(String(args[0])).startsWith('.catalog-'))
                throw Object.assign(Error('Index disk full'), { code: 'ENOSPC' });
            return openFile(...args);
        },
    );
    const reopened = await open();
    fault.mock.restore();
    assert.equal(reopened.recoveryFailure?.code, 'quota');
    assert.equal((await reopened.page()).records[0].id, capture.id);
    assert.equal((await json(reopened)).captures.length, 1);
    await reopened.delete(capture.id);
    assert.equal((await reopened.page()).records.length, 0);
    assert.equal((await fs.readdir(root)).includes(capture.id), false);
});
test('index update failures cannot hide acknowledged captures or resurrect explicitly deleted captures', async (t) => {
    const { open } = await fixture(t),
        store = await open();
    const fault = t.mock.method(NativeCaptureCatalog.prototype, 'add', () => {
        throw Error('Injected derived index write failure');
    });
    const capture = await record(store);
    fault.mock.restore();
    assert.equal((await store.page()).records[0].id, capture.id);
    assert.match(store.recoveryFailure!.message, /captures are retained/);
    assert.equal((await json(store)).captures.length, 1);
    await store.close();
    const reopened = await open();
    const deletion = t.mock.method(NativeCaptureCatalog.prototype, 'delete', () => {
        throw Error('Injected derived index delete failure');
    });
    await reopened.delete(capture.id);
    deletion.mock.restore();
    assert.equal((await reopened.page()).records.length, 0);
});

test('permission-denied stale-cache cleanup does not prevent reading retained capture evidence', async (t) => {
    const { root, open } = await fixture(t),
        store = await open(),
        capture = await record(store);
    await store.close();
    const stale = path.join(root, '.catalog-' + crypto.randomUUID() + '.sqlite');
    await fs.writeFile(stale, 'retained derived cache');
    const openFile = physicalFS.promises.open.bind(physicalFS.promises),
        unlink = physicalFS.promises.unlink.bind(physicalFS.promises);
    const denied = () => Object.assign(Error('Denied derived cache operation'), { code: 'EACCES' });
    const creation = t.mock.method(
        physicalFS.promises,
        'open',
        async (...args: Parameters<typeof openFile>) => {
            if (path.basename(String(args[0])).startsWith('.catalog-') && String(args[0]) !== stale)
                throw denied();
            return openFile(...args);
        },
    );
    const cleanup = t.mock.method(
        physicalFS.promises,
        'unlink',
        async (file: Parameters<typeof unlink>[0]) => {
            if (String(file) === stale) throw denied();
            return unlink(file);
        },
    );
    const reopened = await open();
    creation.mock.restore();
    cleanup.mock.restore();
    assert.equal(reopened.recoveryFailure?.code, 'permission');
    assert.equal((await reopened.page()).records[0].id, capture.id);
    assert.equal((await json(reopened)).captures.length, 1);
    assert.equal(await fs.readFile(stale, 'utf8'), 'retained derived cache');
});
test('conflicting legacy sequences fail explicitly and retain both capture folders', async (t) => {
    const { root, open } = await fixture(t),
        store = await open(),
        first = await record(store),
        second = await record(store);
    await store.close();
    const file = path.join(root, second.id, 'meta.json'),
        metadata = JSON.parse(await fs.readFile(file, 'utf8'));
    metadata.capture.sequence = first.sequence;
    await fs.writeFile(file, JSON.stringify(metadata));
    await assert.rejects(open(), /conflict/);
    assert.equal(
        (await fs.readdir(root)).filter((name) => name === first.id || name === second.id).length,
        2,
    );
});

test('native renderer repository refreshes a later index-degradation warning without hiding captures', async (t) => {
    const { open } = await fixture(t),
        store = await open(),
        server = new CaptureRpcServer(store),
        proxy = await NativeCaptureRepository.open((request) => server.dispatch(request));
    t.after(() => server.dispose());
    assert.equal(proxy.recoveryFailure, undefined);
    const fault = t.mock.method(NativeCaptureCatalog.prototype, 'add', () => {
        throw Error('Live index fault');
    });
    const capture = await record(store);
    fault.mock.restore();
    assert.equal((await proxy.page()).records[0].id, capture.id);
    assert.match(proxy.recoveryFailure!.message, /captures are retained/);
});
test('unsafe stale index files are not followed or removed', async (t) => {
    const { profile, root, open } = await fixture(t),
        store = await open(),
        capture = await record(store);
    await store.close();
    const outside = path.join(profile, 'retained-sentinel'),
        stale = path.join(root, '.catalog-' + crypto.randomUUID() + '.sqlite');
    await fs.writeFile(outside, 'retain this sentinel');
    await fs.link(outside, stale);
    await assert.rejects(open(), /regular|unlinked/);
    assert.equal(await fs.readFile(outside, 'utf8'), 'retain this sentinel');
    assert.equal(await fs.readFile(stale, 'utf8'), 'retain this sentinel');
    assert.ok(await fs.stat(path.join(root, capture.id, 'raw.jsonl')));
});
test('abrupt process termination retains committed bytes and unknown uncommitted tail without inventing an outcome', async (t) => {
    const { root, open, profile } = await fixture(t),
        checkpoint = await terminateAt(profile, 'write'),
        id = checkpoint.id as string,
        rawFile = path.join(root, id, 'raw.jsonl');
    const before = await fs.readFile(rawFile, 'base64');
    assert.equal(before, checkpoint.raw);
    const store = await open(),
        row = (await store.page()).records[0],
        report = await json(store);
    assert.equal(row.id, id);
    assert.equal(row.state, 'incomplete');
    assert.equal(row.observedBytes, null);
    assert.equal(row.committedBytes, 8);
    assert.equal(await store.result(id), null);
    assert.equal(await fs.readFile(rawFile, 'base64'), before);
    assert.deepEqual(
        Buffer.concat(
            report.captures[0].rawObservations.map((frame: { base64: string }) =>
                Buffer.from(frame.base64, 'base64'),
            ),
        ),
        Buffer.from([0, 255, 27, 91, 51, 49, 109, 65]),
    );
});
test('recovery finishes only previously requested interrupted deletion and retains unrelated legacy captures', async (t) => {
    const { root, open, profile } = await fixture(t),
        store = await open(),
        deleted = await record(store, 'delete this fixture'),
        retained = await record(store, 'retain this fixture');
    await store.close();
    const before = await fs.readFile(path.join(root, retained.id, 'raw.jsonl'));
    const checkpoint = await terminateAt(profile, 'delete', deleted.id);
    assert.equal(checkpoint.removed, 1);
    const reopened = await open();
    assert.deepEqual(
        (await reopened.page()).records.map((row) => row.id),
        [retained.id],
    );
    assert.equal(
        (await fs.readdir(root)).some((name) => name.startsWith('.deleting-')),
        false,
    );
    assert.deepEqual(await fs.readFile(path.join(root, retained.id, 'raw.jsonl')), before);
    assert.equal((await json(reopened)).captures.length, 1);
});
