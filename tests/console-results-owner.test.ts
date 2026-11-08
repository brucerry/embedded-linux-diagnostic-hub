import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    ConsoleResultsOwner,
    readConsolePreview,
} from '../src/features/automation/capture/console-results-owner';
import { NativeConsoleJournal } from '../electron/console-journal';
import { matchesConsoleCapture, consoleCatalogPage } from '../shared/console-query';
import { streamConsoleReport } from '../shared/console-report';
import type { ConsoleArchive } from '../shared/console-storage';
import type { ConsoleExportJob } from '../src/features/automation/capture/console-export';
import { bytesBase64 } from '../shared/capture-store';

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
const empty: ConsoleArchive = {
    pin: async () => ({ release: async () => {} }),
    list: async () => ({ captures: [], next: null, mode: 'scan' }),
    async *read() {},
    delete: async () => {},
};
test('view teardown joins late opening and actual disposal; closed views admit no operations', async () => {
    const opening = deferred<{ archive: ConsoleArchive; dispose(): Promise<void> }>(),
        disposing = deferred<void>(),
        busy: boolean[] = [];
    let disposed = 0;
    const owner = new ConsoleResultsOwner(
        () => opening.promise,
        (value) => busy.push(value),
    );
    const closing = owner.close();
    assert.equal(owner.close(), closing);
    await assert.rejects(
        owner.run(async () => 1),
        /closed/,
    );
    opening.resolve({
        archive: empty,
        dispose: async () => {
            disposed++;
            await disposing.promise;
        },
    });
    await turn();
    assert.equal(owner.resourceSnapshot.closed, false);
    assert.equal(disposed, 1);
    assert.equal(busy.at(-1), true);
    disposing.resolve();
    await closing;
    assert.deepEqual(owner.resourceSnapshot, {
        pending: 0,
        export: false,
        closing: false,
        closed: true,
    });
    assert.equal(busy.at(-1), false);
});
test('late export admission is reserved, cancellation awaits real cleanup and cannot abandon a job on unmount', async () => {
    const start = deferred<ConsoleExportJob>(),
        actualClose = deferred<void>(),
        completed = deferred<{ state: 'cancelled' }>();
    let started = false,
        cancellations = 0,
        disposed = 0;
    const owner = new ConsoleResultsOwner(
        async () => ({
            archive: empty,
            dispose: async () => {
                disposed++;
            },
        }),
        () => {},
    );
    await owner.ready;
    const exporting = owner.export(async () => {
        started = true;
        return start.promise;
    });
    void exporting.catch(() => {});
    await turn();
    assert.equal(started, true);
    await assert.rejects(
        owner.export(async () => {
            throw Error('must not enter');
        }),
        { code: 'busy' },
    );
    const cancelling = owner.cancelExport(),
        closing = owner.close();
    start.resolve({
        completed: completed.promise,
        cancel: async () => {
            cancellations++;
            await actualClose.promise;
            completed.resolve({ state: 'cancelled' });
        },
    });
    await turn();
    assert.equal(disposed, 0);
    assert.equal(owner.resourceSnapshot.closed, false);
    assert.equal(cancellations, 1);
    actualClose.resolve();
    await cancelling;
    await exporting;
    await closing;
    assert.equal(disposed, 1);
    assert.equal(owner.resourceSnapshot.export, false);
    assert.equal(owner.resourceSnapshot.closed, true);
});
test('failed actual disposal stays busy until an explicit successful cleanup retry', async () => {
    const busy: boolean[] = [];
    let attempts = 0;
    const owner = new ConsoleResultsOwner(
        async () => ({
            archive: empty,
            dispose: async () => {
                if (++attempts === 1) throw Error('intentional disposal failure');
            },
        }),
        (value) => busy.push(value),
    );
    await owner.ready;
    await assert.rejects(owner.close(), /cleanup remains pending/);
    await turn();
    assert.equal(owner.resourceSnapshot.closed, false);
    assert.equal(busy.at(-1), true);
    await owner.close();
    assert.equal(attempts, 2);
    assert.equal(owner.resourceSnapshot.closed, true);
    assert.equal(busy.at(-1), false);
});
test('full console query searches past the bounded preview and across receive/ANSI/UTF-8 boundaries', async (t) => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-console-view-query-'));
    let journal = await NativeConsoleJournal.open(profile, { profileOwned: true });
    t.after(async () => {
        await journal.close();
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('hub-console-view-query-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    const at = '2026-10-15T17:30:00.000Z',
        match = { role: 'shell-prompt' as const, literal: 'fixture#' };
    const meta = await journal.begin({
        flowId: 'query-flow',
        startedAt: at,
        receiveTimeSource: 'local-client',
        target: { endpoint: 'owned fixture' },
        ready: { role: 'shell-prompt', literals: ['fixture#'] },
    });
    await journal.start({ kind: 'context', phase: 'startup' }, at);
    await journal.observe(Buffer.from('fixture#'), at, 'channel');
    await journal.end('ready', match, at);
    await journal.start(
        {
            kind: 'command',
            runId: 'query-run',
            stepId: 'query-step',
            ordinal: 1,
            name: 'Long output',
            input: { intent: 'script', command: 'printf diagnostic' },
            requestBase64: bytesBase64(Buffer.from('printf diagnostic\r')),
            criterion: { role: 'shell-prompt', literals: ['fixture#'] },
        },
        at,
    );
    await journal.observe(Buffer.alloc(128 * 1024, 65), at, 'channel');
    await journal.observe(Buffer.from('late-\x1b[31mnee'), at, 'extended');
    await journal.observe(new Uint8Array([100, 108, 101, 0xe2]), at, 'channel');
    await journal.observe(new Uint8Array([0x82, 0xac]), at, 'extended');
    await journal.observe(Buffer.from('fixture#'), at, 'channel');
    await journal.end('prompt-observed', match, at);
    await journal.outcome('prompt-observed', match, at);
    await journal.start({ kind: 'context', phase: 'shutdown' }, at);
    await journal.end('closed', null, at);
    await journal.finish('complete', journal.snapshot!.bytes, true);
    await journal.close();
    journal = await NativeConsoleJournal.open(profile, { profileOwned: true });
    const preview = await readConsolePreview(journal, meta.header.id, () => {});
    assert.equal(preview.clipped, true);
    assert.ok(preview.shownBytes < 128 * 1024);
    assert.ok(preview.records.length <= 96);
    assert.ok(
        preview.records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0) <= 64 * 1024,
    );
    const stored = (await journal.list()).captures[0];
    assert.equal(
        await matchesConsoleCapture(journal, stored, {
            query: 'late-needle€',
            name: 'printf diagnostic',
            completion: 'prompt-observed',
        }),
        true,
    );
    assert.equal(await matchesConsoleCapture(journal, stored, { query: 'not-present' }), false);
    const page = await consoleCatalogPage(journal, { query: 'late-needle€' });
    assert.deepEqual(
        page.captures.map((c) => c.header.id),
        [meta.header.id],
    );
    let output = '';
    for await (const bytes of streamConsoleReport(journal, 'json', {
        filter: { query: 'late-needle€' },
    }))
        output += Buffer.from(bytes).toString();
    assert.equal(JSON.parse(output).captures[0].capture.header.id, meta.header.id);
    await journal.delete(meta.header.id);
    assert.equal((await journal.list()).captures.length, 0);
});
