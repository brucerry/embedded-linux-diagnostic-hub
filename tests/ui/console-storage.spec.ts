import { test, expect } from '@playwright/test';
import type {} from '../fixtures/console-browser';
import fs from 'node:fs/promises';
import nodeCrypto from 'node:crypto';
test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
        const source = '/tests/fixtures/console-browser.ts';
        await import(source);
    });
});

test('v2 streams full context bytes and preserves exact counts after close/reopen', async ({
    page,
    browserName,
}) => {
    const result = await page.evaluate(
        async (total) => {
            const q = window.consoleQA,
                name = q.name(),
                writer = await q.IndexedDbConsoleJournal.open(name);
            const capture = await writer.begin(q.header);
            await writer.start({ kind: 'context', phase: 'shutdown' }, q.stamp);
            let offset = 0;
            while (offset < total) {
                const bytes = new Uint8Array(Math.min(256 * 1024, total - offset));
                bytes.fill((offset / (256 * 1024)) % 251);
                await writer.observe(bytes, q.stamp, 'channel');
                offset += bytes.length;
            }
            await writer.end('closed', null, q.stamp);
            const done = await writer.finish('complete', total, true);
            await writer.close();
            const archive = await q.IndexedDbConsoleJournal.open(name);
            let retained = 0,
                observations = 0;
            try {
                for await (const event of archive.read(capture.header.id))
                    if (event.kind === 'record' && event.record.kind === 'observation') {
                        const bytes = q.base64Bytes(event.record.base64);
                        for (const byte of bytes)
                            if (byte !== Math.floor(retained / (256 * 1024)) % 251)
                                throw Error('Retained pattern differs');
                        retained += bytes.length;
                        observations++;
                    }
                const list = await archive.list();
                return {
                    retained,
                    observations,
                    done,
                    rows: list.captures.length,
                    mode: list.mode,
                };
            } finally {
                await archive.close();
            }
        },
        browserName === 'chromium' ? 33 * 1024 * 1024 : 1024 * 1024,
    );
    expect(result.retained).toBe(browserName === 'chromium' ? 33 * 1024 * 1024 : 1024 * 1024);
    expect(result.observations).toBeGreaterThan(1);
    expect(result.done.state).toBe('complete');
    expect(result.done.observedBytes).toBe(result.retained);
    expect(result.rows).toBe(1);
    expect(result.mode).toBe('indexed');
});

test('outgoing idle corruption blocks inputSent and later persistence for both PTY origins', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.consoleQA,
            rows = [];
        for (const origin of ['channel', 'extended'] as const) {
            const name = q.name(),
                writer = await q.IndexedDbConsoleJournal.open(name),
                capture = await writer.begin(q.header);
            await writer.start({ kind: 'context', phase: 'idle' }, q.stamp);
            await writer.observe(new TextEncoder().encode('idle'), q.stamp, origin);
            await writer.start(q.command(), q.stamp);
            await q.change(name, capture.header.id, (_meta, records) => {
                const r = records.find((r) => r.kind === 'observation')!;
                if (r.kind === 'observation') r.base64 = 'eGRsZQ==';
            });
            const before = await q.inspect(name, capture.header.id);
            let first = '',
                later = '';
            try {
                await writer.inputSent(q.stamp);
            } catch (e) {
                first = (e as { code: string }).code;
            }
            try {
                await writer.inputSent(q.stamp);
            } catch (e) {
                later = (e as { code: string }).code;
            }
            await writer.fail(4, new q.CaptureStorageError('integrity', 'Retained fault'), true);
            await writer.close();
            const after = await q.inspect(name, capture.header.id);
            rows.push({
                origin,
                first,
                later,
                before: before.records,
                after: after.records,
                meta: after.meta.snapshot,
            });
        }
        return rows;
    });
    for (const row of result) {
        expect(row.first).toBe('integrity');
        expect(row.later).toBe('integrity');
        expect(row.after).toEqual(row.before);
        expect(
            row.after.some(
                (r) => r.kind === 'outcome' || (r.kind === 'segment-start' && r.inputSent),
            ),
        ).toBe(false);
        expect(row.meta.state).toBe('incomplete');
        expect(row.meta.failure.code).toBe('integrity');
    }
});

test('complete metadata refuses greater or unknown observations without resetting raw evidence', async ({
    page,
}) => {
    const rows = await page.evaluate(async () => {
        const q = window.consoleQA,
            result = [];
        for (const count of [9, null]) {
            const name = q.name(),
                writer = await q.IndexedDbConsoleJournal.open(name),
                id = await q.healthy(writer);
            await writer.finish('complete', 8, true);
            await writer.close();
            await q.change(name, id, (meta) => {
                meta.snapshot.observedBytes = count;
            });
            const before = await q.inspect(name, id),
                reader = await q.IndexedDbConsoleJournal.open(name);
            let error = '';
            try {
                await q.read(reader, id);
            } catch (e) {
                error = (e as { code: string }).code;
            } finally {
                await reader.close();
            }
            result.push({ error, before, after: await q.inspect(name, id) });
        }
        return result;
    });
    for (const row of rows) {
        expect(row.error).toBe('integrity');
        expect(row.after).toEqual(row.before);
    }
});

test('live prefix reading and old-capture export do not block the sole writer; pins block deletion', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.consoleQA,
            name = q.name(),
            first = await q.IndexedDbConsoleJournal.open(name),
            old = await q.healthy(first);
        await first.finish('complete', 8, true);
        await first.close();
        const writer = await q.IndexedDbConsoleJournal.open(name),
            current = await writer.begin(q.header);
        await writer.start({ kind: 'context', phase: 'idle' }, q.stamp);
        await writer.observe(new TextEncoder().encode('before'), q.stamp, 'channel');
        const archive = await q.IndexedDbConsoleJournal.open(name),
            other = await q.IndexedDbConsoleJournal.open(name);
        let busy = '',
            writerBusy = '';
        try {
            await other.begin(q.header);
        } catch (e) {
            writerBusy = (e as { code: string }).code;
        }
        await other.close();
        const pinned = archive.read(current.header.id),
            head = await pinned.next();
        await writer.observe(new TextEncoder().encode('after'), q.stamp, 'channel');
        let bytes = 0;
        for await (const event of { [Symbol.asyncIterator]: () => pinned })
            if (event.kind === 'record' && event.record.kind === 'observation')
                bytes += q.base64Bytes(event.record.base64).length;
        const held = archive.read(old);
        await held.next();
        try {
            await archive.delete(old);
        } catch (e) {
            busy = (e as { code: string }).code;
        }
        await held.return(undefined);
        const oldEvents = await q.read(archive, old);
        await archive.delete(old);
        await writer.close();
        const abandoned = await q.read(archive, current.header.id);
        await archive.close();
        return {
            head,
            bytes,
            busy,
            writerBusy,
            oldRecords: oldEvents.length,
            abandoned: abandoned[0],
        };
    });
    expect(result.head.value?.kind).toBe('metadata');
    if (result.head.value?.kind === 'metadata')
        expect(result.head.value.capture.state).toBe('active');
    expect(result.bytes).toBe(6);
    expect(result.busy).toBe('busy');
    expect(result.writerBusy).toBe('busy');
    expect(result.oldRecords).toBeGreaterThan(1);
    expect(result.abandoned.kind).toBe('metadata');
    if (result.abandoned.kind === 'metadata') {
        expect(result.abandoned.capture.state).toBe('incomplete');
        expect(result.abandoned.capture.observedBytes).toBeNull();
    }
});

test('close joins pending list and reader admission; versionchange preserves existing data and releases ownership', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.consoleQA,
            name = q.name(),
            writer = await q.IndexedDbConsoleJournal.open(name),
            id = await q.healthy(writer);
        await writer.finish('complete', 8, true);
        await writer.close();
        const archive = await q.IndexedDbConsoleJournal.open(name);
        let listSettled = false;
        const listing = archive.list().finally(() => {
            listSettled = true;
        });
        await archive.close();
        const listJoined = listSettled;
        await listing;
        const reader = await q.IndexedDbConsoleJournal.open(name),
            iterator = reader.read(id);
        let readSettled = false;
        const reading = iterator
            .next()
            .catch(() => null)
            .finally(() => {
                readSettled = true;
            });
        await reader.close();
        const readJoined = readSettled;
        await reading;
        const active = await q.IndexedDbConsoleJournal.open(name),
            current = await active.begin(q.header);
        await active.start({ kind: 'context', phase: 'startup' }, q.stamp);
        const before = await q.inspect(name, current.header.id);
        const future = await q.raw(name, 2, (db) => db.createObjectStore('future'));
        future.close();
        await active.close();
        let unsupported = '';
        try {
            await q.IndexedDbConsoleJournal.open(name);
        } catch (e) {
            unsupported = (e as { code: string }).code;
        }
        return {
            listJoined,
            readJoined,
            closed: active.resourceClosed,
            unsupported,
            before,
            after: await q.inspect(name, current.header.id),
        };
    });
    expect(result.listJoined).toBe(true);
    expect(result.readJoined).toBe(true);
    expect(result.closed).toBe(true);
    expect(result.unsupported).toBe('unsupported');
    expect(result.after).toEqual(result.before);
});

test('a real aborted IDB commit is not acknowledged and leaves the durable prefix unchanged', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.consoleQA,
            name = q.name(),
            writer = await q.IndexedDbConsoleJournal.open(name),
            capture = await writer.begin(q.header);
        await writer.start({ kind: 'context', phase: 'idle' }, q.stamp);
        const before = await q.inspect(name, capture.header.id),
            original = IDBDatabase.prototype.transaction;
        let injected = false,
            error = '',
            later = '';
        IDBDatabase.prototype.transaction = function (
            ...args: Parameters<IDBDatabase['transaction']>
        ) {
            const tx = original.apply(this, args);
            if (this.name === name && args[1] === 'readwrite' && !injected) {
                injected = true;
                queueMicrotask(() => tx.abort());
            }
            return tx;
        };
        try {
            await writer.observe(new Uint8Array([1, 2, 3]), q.stamp, 'channel');
        } catch (e) {
            error = (e as { code: string }).code;
        } finally {
            IDBDatabase.prototype.transaction = original;
        }
        try {
            await writer.start(q.command(), q.stamp);
        } catch (e) {
            later = (e as { code: string }).code;
        }
        await writer.close();
        return { injected, error, later, before, after: await q.inspect(name, capture.header.id) };
    });
    expect(result.injected).toBe(true);
    expect(result.error).toBe('io');
    expect(result.later).toBe('io');
    expect(result.after).toEqual(result.before);
});

test('unsupported locking and foreign schemas refuse without changing pre-existing data', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.consoleQA,
            name = q.name(),
            db = await q.raw(name, 1, (d) => d.createObjectStore('foreign'));
        let tx = db.transaction('foreign', 'readwrite'),
            done = q.completed(tx);
        await q.request(tx.objectStore('foreign').put({ preserve: 'exact' }, 'key'));
        await done;
        db.close();
        let schema = '',
            locks = '';
        try {
            await q.IndexedDbConsoleJournal.open(name);
        } catch (e) {
            schema = (e as { code: string }).code;
        }
        const saved = await q.raw(name);
        tx = saved.transaction('foreign', 'readonly');
        done = q.completed(tx);
        const value = await q.request(tx.objectStore('foreign').get('key'));
        await done;
        saved.close();
        Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
        try {
            await q.IndexedDbConsoleJournal.open(q.name());
        } catch (e) {
            locks = (e as { code: string }).code;
        } finally {
            delete (navigator as unknown as { locks?: unknown }).locks;
        }
        return { schema, locks, value };
    });
    expect(result.schema).toBe('unsupported');
    expect(result.locks).toBe('unsupported');
    expect(result.value).toEqual({ preserve: 'exact' });
});

test('catalog export pins fence membership/deletion and close joins their actual release', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.consoleQA,
            name = q.name(),
            writer = await q.IndexedDbConsoleJournal.open(name);
        const id = await q.healthy(writer);
        await writer.finish('complete', 8, true);
        await writer.close();
        const archive = await q.IndexedDbConsoleJournal.open(name),
            pin = await archive.pin();
        let deletion = '',
            admission = '',
            closed = false;
        try {
            await archive.delete(id);
        } catch (error) {
            deletion = (error as { code: string }).code;
        }
        const other = await q.IndexedDbConsoleJournal.open(name);
        try {
            await other.begin(q.header);
        } catch (error) {
            admission = (error as { code: string }).code;
        }
        await other.close();
        const closing = archive.close().then(() => {
            closed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const held = !closed;
        await Promise.all([pin.release(), pin.release()]);
        await closing;
        const reopened = await q.IndexedDbConsoleJournal.open(name);
        await reopened.delete(id);
        await reopened.close();
        return { deletion, admission, held, closed };
    });
    expect(result).toEqual({ deletion: 'busy', admission: 'busy', held: true, closed: true });
});

test('encoded checkpoint offset corruption refuses read and does not erase retained evidence', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.consoleQA,
            name = q.name(),
            writer = await q.IndexedDbConsoleJournal.open(name);
        const id = await q.healthy(writer);
        await writer.finish('complete', 8, true);
        await writer.close();
        await q.change(name, id, (meta) => {
            meta.snapshot.offset++;
        });
        const before = await q.inspect(name, id),
            reader = await q.IndexedDbConsoleJournal.open(name);
        let error = '';
        try {
            await q.read(reader, id);
        } catch (failure) {
            error = (failure as { code: string }).code;
        }
        await reader.close();
        return { error, before, after: await q.inspect(name, id) };
    });
    expect(result.error).toBe('integrity');
    expect(result.after).toEqual(result.before);
});

test('real client-bound service worker delivers all console formats independently of a foreign v1 database', async ({
    page,
    browserName,
}, info) => {
    const expected = await page.evaluate(
        async (total) => {
            const q = window.consoleQA;
            const foreign = await q.raw('diagnostic-hub-captures-v1', 1, (db) =>
                db.createObjectStore('foreign'),
            );
            foreign.close();
            const writer = await q.IndexedDbConsoleJournal.open(),
                capture = await writer.begin(q.header);
            await writer.start({ kind: 'context', phase: 'startup' }, q.stamp);
            await writer.observe(new TextEncoder().encode('fixture#'), q.stamp, 'channel');
            await writer.end('ready', { role: 'shell-prompt', literal: 'fixture#' }, q.stamp);
            await writer.start(q.command('send-enter'), q.stamp);
            let bytes = 8;
            for (let offset = 0; offset < total; offset += 65536) {
                const part = new Uint8Array(Math.min(65536, total - offset)).fill(65);
                await writer.observe(part, q.stamp, 'extended');
                bytes += part.length;
            }
            await writer.observe(new TextEncoder().encode('fixture#'), q.stamp, 'channel');
            bytes += 8;
            const matched = { role: 'shell-prompt' as const, literal: 'fixture#' };
            await writer.end('prompt-observed', matched, q.stamp);
            await writer.outcome('prompt-observed', matched, q.stamp);
            await writer.start({ kind: 'context', phase: 'shutdown' }, q.stamp);
            await writer.end('closed', null, q.stamp);
            await writer.finish('complete', bytes, true);
            await writer.close();
            const archive = await q.IndexedDbConsoleJournal.open();
            const hashes: Record<string, { hash: string; bytes: number }> = {};
            for (const format of ['json', 'csv', 'markdown', 'text'] as const) {
                const digestParts: Uint8Array[] = [];
                let count = 0;
                for await (const part of q.streamConsoleReport(archive, format)) {
                    digestParts.push(part);
                    count += part.length;
                }
                const all = new Uint8Array(count);
                let at = 0;
                for (const part of digestParts) {
                    all.set(part, at);
                    at += part.length;
                }
                const hash = [
                    ...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', all)),
                ]
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join('');
                hashes[format] = { hash, bytes: count };
            }
            await archive.close();
            q.exportButtons();
            return { id: capture.header.id, hashes };
        },
        browserName === 'chromium' ? 1024 * 1024 + 16384 : 65536,
    );
    for (const [format, suffix] of [
        ['json', 'json'],
        ['csv', 'csv'],
        ['markdown', 'md'],
        ['text', 'txt'],
    ]) {
        const event = page.waitForEvent('download');
        await page.locator('#qa-console-export-' + format).click();
        const download = await event;
        expect(download.suggestedFilename()).toBe('console-results.' + suffix);
        expect(await download.failure()).toBeNull();
        await page.waitForFunction(() => window.consoleExportOutcome?.state === 'stream-sent');
        const file = info.outputPath('console-results.' + suffix);
        await download.saveAs(file);
        const bytes = await fs.readFile(file);
        expect(bytes.length).toBe(expected.hashes[format].bytes);
        expect(nodeCrypto.createHash('sha256').update(bytes).digest('hex')).toBe(
            expected.hashes[format].hash,
        );
        if (format === 'json') {
            const report = JSON.parse(bytes.toString());
            expect(report.captures[0].capture.header.id).toBe(expected.id);
            expect(
                report.captures[0].records.some(
                    (r: { exitCode?: number | null }) => r.exitCode === null,
                ),
            ).toBe(true);
        }
    }
});
