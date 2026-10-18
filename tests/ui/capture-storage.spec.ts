import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {} from '../fixtures/capture-browser';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';

let server: Server, url: string;
test.beforeAll(async () => {
    const result = await build({
        entryPoints: ['tests/fixtures/capture-browser.ts'],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        write: false,
        target: 'es2022',
    });
    const script = result.outputFiles[0].contents;
    const assets = new Map<string, Uint8Array>();
    for (const [name, entry] of [
        ['capture-download-sw.js', 'capture-download-worker.ts'],
        ['capture-download-frame.js', 'capture-download-frame.ts'],
    ]) {
        const worker = await build({
            entryPoints: ['src/features/automation/capture/' + entry],
            bundle: true,
            format: 'iife',
            platform: 'browser',
            write: false,
            target: 'es2022',
        });
        assets.set('/nested/hub/' + name, worker.outputFiles[0].contents);
    }
    server = createServer((req, res) => {
        if (assets.has(req.url ?? '')) {
            res.writeHead(200, {
                'Content-Type': 'application/javascript',
                'Cache-Control': 'no-store',
            });
            res.end(assets.get(req.url!));
            return;
        }
        if (req.url === '/nested/hub/client.js') {
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(script);
            return;
        }
        if (req.url !== '/nested/hub/') {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/html',
            'Content-Security-Policy':
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'",
        });
        res.end(
            '<!doctype html><title>Capture repository fixture</title>' +
                ['json', 'csv', 'markdown', 'text']
                    .map(
                        (format) =>
                            '<button id="export-' + format + '">Export ' + format + '</button>',
                    )
                    .join('') +
                '<script src="./client.js"></script>',
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/nested/hub/';
});
test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
test.beforeEach(async ({ page }) => {
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.captureQA));
});

for (const fault of ['same-length corruption', 'frame reorder'] as const)
    test(
        'IndexedDB seal rejects ' + fault + ' before a later command can advance',
        async ({ page }) => {
            const result = await page.evaluate(async (fault) => {
                const { IndexedDbCaptureStore, CaptureWriter } = window.captureQA,
                    store = await IndexedDbCaptureStore.open(),
                    writer = await CaptureWriter.begin(store, {
                        transport: 'serial',
                        receiveTimeSource: 'local-client',
                        runId: 'seal-fault',
                        stepId: 'first',
                        command: 'fixture',
                        name: 'Seal integrity',
                        startedAt: '2026-10-15T00:00:00.000Z',
                    });
                await writer.append(
                    new Uint8Array([1, 2, 3, 4]),
                    '2026-10-15T00:00:00.000Z',
                    'serial',
                );
                await writer.append(
                    new Uint8Array([5, 6, 7, 8]),
                    '2026-10-15T00:00:00.001Z',
                    'serial',
                );
                await writer.flush();
                const db = await new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open('diagnostic-hub-captures-v1');
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                await new Promise<void>((resolve, reject) => {
                    const tx = db.transaction('frames', 'readwrite'),
                        frames = tx.objectStore('frames'),
                        first = frames.get([writer.id, 0]),
                        second = frames.get([writer.id, 1]);
                    second.onsuccess = () => {
                        if (fault === 'same-length corruption') {
                            const changed = first.result;
                            changed.bytes[0] ^= 4; // preserve key/count/length, invalidate CRC
                            frames.put(changed, [writer.id, 0]);
                        } else {
                            frames.put(second.result, [writer.id, 0]);
                            frames.put(first.result, [writer.id, 1]);
                        }
                    };
                    tx.oncomplete = () => resolve();
                    tx.onabort = () => reject(tx.error);
                });
                db.close();
                let sentNext = false,
                    code = '';
                try {
                    await writer.finish('prompt-observed');
                    sentNext = true;
                } catch (error) {
                    code = (error as { code: string }).code;
                }
                const saved = (await store.page()).records[0];
                await store.close();
                return {
                    sentNext,
                    code,
                    state: saved.state,
                    failureCode: saved.failure?.code,
                    committedBytes: saved.committedBytes,
                };
            }, fault);
            expect(result.sentNext).toBe(false);
            expect(result.code).toBe('integrity');
            expect(result.state).toBe('incomplete');
            expect(result.failureCode).toBe('integrity');
            expect(result.committedBytes).toBe(8);
        },
    );

test('IndexedDB retains more than 200 captures and bounds metadata pages by bytes and rows', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { IndexedDbCaptureStore } = window.captureQA,
            store = await IndexedDbCaptureStore.open();
        const header = {
            transport: 'serial' as const,
            receiveTimeSource: 'local-client' as const,
            runId: 'retention',
            stepId: 'one',
            command: 'x'.repeat(8192),
            name: 'metadata fixture',
            startedAt: '2026-10-15T00:00:00.000Z',
        };
        for (let i = 0; i < 205; i++) {
            const capture = await store.begin(header);
            await store.seal(capture.id, 0, 'empty fixture');
        }
        let rows = 0,
            pages = 0,
            maxBytes = 0,
            maxRows = 0,
            after = 0;
        while (true) {
            const page = await store.page(after);
            rows += page.records.length;
            pages++;
            maxBytes = Math.max(
                maxBytes,
                new TextEncoder().encode(JSON.stringify(page.records)).length,
            );
            maxRows = Math.max(maxRows, page.records.length);
            if (page.next === null) break;
            after = page.next;
        }
        await store.close();
        return { rows, pages, maxBytes, maxRows };
    });
    expect(result.rows).toBe(205);
    expect(result.pages).toBeGreaterThan(2);
    expect(result.maxBytes).toBeLessThanOrEqual(256 * 1024 + 200);
    expect(result.maxRows).toBeLessThanOrEqual(100);
});

test('reload recovers an abandoned active capture as incomplete without removing its committed raw bytes', async ({
    page,
}) => {
    const id = await page.evaluate(async () => {
        const { IndexedDbCaptureStore, CaptureWriter } = window.captureQA;
        window.captureStore = await IndexedDbCaptureStore.open();
        const writer = await CaptureWriter.begin(window.captureStore, {
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'reload',
            stepId: 'one',
            command: 'fixture',
            name: 'Reload',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
        await writer.append(
            new Uint8Array([0, 255, 240, 159, 153, 130]),
            '2026-10-15T00:00:00.000Z',
            'serial',
        );
        await writer.flush();
        window.captureWriter = writer;
        return writer.id;
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.captureQA));
    const result = await page.evaluate(async (id) => {
        const { IndexedDbCaptureStore, streamCaptureJson } = window.captureQA,
            store = await IndexedDbCaptureStore.open();
        let output = '';
        for await (const bytes of streamCaptureJson(store, id))
            output += new TextDecoder().decode(bytes);
        await store.close();
        return JSON.parse(output);
    }, id);
    expect(result.capture.state).toBe('incomplete');
    expect(result.capture.observedBytes).toBeNull();
    expect(result.captureComplete).toBe(false);
    expect(result.verifiedCommittedBytes).toBe(6);
    expect(Buffer.from(result.rawObservations[0].base64, 'base64')).toEqual(
        Buffer.from([0, 255, 240, 159, 153, 130]),
    );
});

test('cross-tab writer, export and deletion leases protect records and a pinned high-water mark', async ({
    page,
    context,
}) => {
    const id = await page.evaluate(async () => {
        const { IndexedDbCaptureStore, CaptureWriter } = window.captureQA;
        window.captureStore = await IndexedDbCaptureStore.open();
        window.captureWriter = await CaptureWriter.begin(window.captureStore, {
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'lease',
            stepId: 'one',
            command: 'fixture',
            name: 'Lease',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
        return window.captureWriter.id;
    });
    const other = await context.newPage();
    await other.goto(url);
    await other.waitForFunction(() => Boolean(window.captureQA));
    expect(
        await other.evaluate(async (id) => {
            window.captureStore = await window.captureQA.IndexedDbCaptureStore.open();
            const errors = [];
            try {
                await window.captureStore.begin({
                    transport: 'serial',
                    receiveTimeSource: 'local-client',
                    runId: 'other',
                    stepId: 'one',
                    command: 'x',
                    name: 'x',
                    startedAt: '2026-10-15T00:00:00.000Z',
                });
            } catch (e) {
                errors.push((e as Error).message);
            }
            try {
                await window.captureStore.delete(id);
            } catch (e) {
                errors.push((e as Error).message);
            }
            return errors;
        }, id),
    ).toHaveLength(2);
    await page.evaluate(async () => {
        await window.captureWriter!.append(
            new Uint8Array([1, 2, 3]),
            '2026-10-15T00:00:00.000Z',
            'serial',
        );
        await window.captureWriter!.finish('prompt-observed');
        window.capturePin = await window.captureStore!.pin();
        window.captureIterator = window
            .captureStore!.read(window.captureWriter!.id)
            [Symbol.asyncIterator]();
        await window.captureIterator.next();
    });
    const result = await other.evaluate(async (id) => {
        let refused = false;
        try {
            await window.captureStore!.delete(id);
        } catch {
            refused = true;
        }
        const next = await window.captureStore!.begin({
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'other',
            stepId: 'one',
            command: 'x',
            name: 'x',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
        await window.captureStore!.seal(next.id, 0, 'empty');
        return { refused, sequence: next.sequence };
    }, id);
    expect(result.refused).toBe(true);
    expect(result.sequence).toBe(2);
    expect(
        await page.evaluate(async () => {
            const page = await window.captureStore!.page(0, 100, window.capturePin!.through);
            await window.captureIterator!.return?.();
            await window.capturePin!.release();
            return page.records.map((r) => r.sequence);
        }),
    ).toEqual([1]);
    await other.evaluate(async (id) => {
        await window.captureStore!.delete(id);
        await window.captureStore!.close();
    }, id);
    expect(
        await page.evaluate(async () => {
            const page = await window.captureStore!.page();
            await window.captureStore!.close();
            return page.records.map((r) => r.sequence);
        }),
    ).toEqual([2]);
    await other.close();
});

test('missing final blocks and corrupt bytes fail streaming export instead of becoming normal EOF', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { IndexedDbCaptureStore, CaptureWriter, streamCaptureJson } = window.captureQA,
            store = await IndexedDbCaptureStore.open();
        const writer = await CaptureWriter.begin(store, {
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'missing',
            stepId: 'one',
            command: 'fixture',
            name: 'Missing block',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
        await writer.append(
            new Uint8Array(256 * 1024).fill(17),
            '2026-10-15T00:00:00.000Z',
            'serial',
        );
        await writer.finish('prompt-observed');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('diagnostic-hub-captures-v1');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('frames', 'readwrite');
            tx.objectStore('frames').delete([writer.id, 15]);
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
        });
        db.close();
        let output = '',
            error = '';
        try {
            for await (const bytes of streamCaptureJson(store, writer.id))
                output += new TextDecoder().decode(bytes);
        } catch (e) {
            error = (e as Error).message;
        }
        await store.close();
        return { error, completeTrailer: output.endsWith('}\n') };
    });
    expect(result.error).toContain('missing');
    expect(result.completeTrailer).toBe(false);
});

test('an actual IndexedDB transaction abort reports quota failure, retains the prefix and blocks the next send', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { IndexedDbCaptureStore, CaptureWriter, streamCaptureJson } = window.captureQA,
            store = await IndexedDbCaptureStore.open();
        const writer = await CaptureWriter.begin(store, {
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'quota',
            stepId: 'one',
            command: 'fixture',
            name: 'Quota',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
        await writer.append(new Uint8Array([10, 11, 12]), '2026-10-15T00:00:00.000Z', 'serial');
        await writer.flush();
        const original = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...args: Parameters<typeof original>) {
            if (this.name === 'frames')
                throw new DOMException('Synthetic quota exhausted', 'QuotaExceededError');
            return original.apply(this, args);
        };
        let sent = false,
            error = '';
        try {
            await writer.append(new Uint8Array([20, 21]), '2026-10-15T00:00:00.000Z', 'serial');
            await writer.finish('prompt-observed');
            sent = true;
        } catch (e) {
            error = (e as Error).message;
        } finally {
            IDBObjectStore.prototype.add = original;
        }
        await writer.abort(writer.error);
        let output = '';
        for await (const bytes of streamCaptureJson(store, writer.id))
            output += new TextDecoder().decode(bytes);
        await store.close();
        return { sent, error, raw: JSON.parse(output) };
    });
    expect(result.sent).toBe(false);
    expect(result.error).toContain('quota');
    expect(result.raw.capture.failure.code).toBe('quota');
    expect(result.raw.capture.observedBytes).toBe(5);
    expect(result.raw.verifiedCommittedBytes).toBe(3);
    expect(result.raw.captureComplete).toBe(false);
});

test('full-quota recovery keeps the committed prefix exportable and deletable even when failure metadata cannot be saved', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { IndexedDbCaptureStore, CaptureWriter, CaptureStorageError, streamCaptureJson } =
                window.captureQA,
            store = await IndexedDbCaptureStore.open();
        const writer = await CaptureWriter.begin(store, {
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'readonly-recovery',
            stepId: 'one',
            command: 'fixture',
            name: 'Read-only recovery',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
        await writer.append(new Uint8Array([0, 255, 3]), '2026-10-15T00:00:00.000Z', 'serial');
        await writer.flush();
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
            if (this.name === 'captures')
                throw new DOMException('Still full', 'QuotaExceededError');
            return original.apply(this, args);
        };
        try {
            await writer.abort(new CaptureStorageError('quota', 'Still full'));
            await store.close();
            const reopened = await IndexedDbCaptureStore.open();
            let output = '';
            for await (const bytes of streamCaptureJson(reopened, writer.id))
                output += new TextDecoder().decode(bytes);
            const warning = reopened.recoveryFailure?.code;
            await reopened.delete(writer.id);
            const rows = (await reopened.page()).records.length;
            await reopened.close();
            return { warning, rows, raw: JSON.parse(output) };
        } finally {
            IDBObjectStore.prototype.put = original;
        }
    });
    expect(result.warning).toBe('quota');
    expect(result.raw.captureComplete).toBe(false);
    expect(result.raw.capture.observedBytes).toBeNull();
    expect(result.raw.capture.finalizedAt).toBeNull();
    expect(result.raw.verifiedCommittedBytes).toBe(3);
    expect(result.rows).toBe(0);
});

test('client-bound helper downloads all four formats with truthful complete and incomplete metadata', async ({
    page,
}, testInfo) => {
    await page.evaluate(async () => {
        const { IndexedDbCaptureStore, CaptureWriter, CaptureStorageError } = window.captureQA,
            store = await IndexedDbCaptureStore.open();
        const header = {
            transport: 'serial' as const,
            receiveTimeSource: 'local-client' as const,
            runId: 'download',
            stepId: 'one',
            command: 'echo "pipes | quotes"\n~~~\n```',
            name: 'Download | fixture',
            startedAt: '2026-10-15T00:00:00.000Z',
        };
        const complete = await CaptureWriter.begin(store, header);
        await complete.append(
            new TextEncoder().encode('Readable 雪🙂\n~~~~\n<script>literal</script>\n'),
            '2026-10-15T00:00:00.000Z',
            'serial',
        );
        await complete.finish('prompt-observed');
        const incomplete = await CaptureWriter.begin(store, {
            ...header,
            name: 'Incomplete fixture',
        });
        await incomplete.append(new Uint8Array([0, 255, 1]), '2026-10-15T00:00:00.000Z', 'serial');
        await incomplete.flush();
        await incomplete.abort(
            new CaptureStorageError('quota', 'Synthetic quota full; committed prefix retained'),
        );
        await store.close();
    });
    for (const [format, suffix] of [
        ['json', 'json'],
        ['markdown', 'md'],
        ['csv', 'csv'],
        ['text', 'txt'],
    ]) {
        const event = page.waitForEvent('download');
        await page.locator('#export-' + format).click();
        const download = await event;
        expect(download.suggestedFilename()).toBe('automation-results.' + suffix);
        expect(await download.failure()).toBeNull();
        await page.waitForFunction(() => window.captureExportOutcome?.state === 'stream-sent');
        const file = testInfo.outputPath('downloaded-results.' + suffix);
        await download.saveAs(file);
        const output = await fs.readFile(file, 'utf8');
        if (format === 'json') {
            const raw = JSON.parse(output);
            expect(raw.summary.complete).toBe(1);
            expect(raw.summary.incomplete).toBe(1);
            expect(
                raw.captures.map((c: { captureComplete: boolean }) => c.captureComplete),
            ).toEqual([true, false]);
        } else if (format === 'markdown') {
            expect(output).toContain('## 📋 Capture summary');
            expect(output).toContain('~~~~~text');
            expect(output).toContain('**Incomplete:** 1');
        } else if (format === 'csv') expect(output).toContain('base64:');
        else expect(output).toContain('incomplete: 1');
    }
});

test('a missing pinned block fails verification before any native browser download starts', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { IndexedDbCaptureStore, CaptureWriter } = window.captureQA,
            store = await IndexedDbCaptureStore.open();
        const writer = await CaptureWriter.begin(store, {
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'missing-download',
            stepId: 'one',
            command: 'fixture',
            name: 'Missing',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
        await writer.append(new Uint8Array(40000).fill(5), '2026-10-15T00:00:00.000Z', 'serial');
        await writer.finish('prompt-observed');
        await store.close();
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('diagnostic-hub-captures-v1');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('frames', 'readwrite');
            tx.objectStore('frames').delete([writer.id, 2]);
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
        });
        db.close();
    });
    let downloads = 0;
    page.on('download', () => downloads++);
    await page.locator('#export-json').click();
    await page.waitForFunction(() => window.captureExportOutcome?.state === 'failed');
    expect(await page.evaluate(() => window.captureExportOutcome?.error)).toContain('missing');
    expect(downloads).toBe(0);
});

test('browser capture and authenticated streaming download exceed 32 MiB with bounded chunks', async ({
    page,
    context,
    browserName,
}, testInfo) => {
    test.setTimeout(120000);
    page.on('console', (message) => {
        if (message.text().startsWith('capture-phase ')) console.log(browserName, message.text());
    });
    const result = await page.evaluate(async () => {
        const started = performance.now();
        const { IndexedDbCaptureStore, CaptureWriter, streamCaptureReport, CAPTURE_STORAGE } =
                window.captureQA,
            store = await IndexedDbCaptureStore.open();
        const writer = await CaptureWriter.begin(store, {
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'large',
            stepId: 'one',
            command: 'fixture',
            name: 'Large',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
        let checksum = 2166136261,
            maxBacklog = 0;
        const bytes = new Uint8Array(16384);
        for (let i = 0; i < 2113; i++) {
            globalThis.crypto.getRandomValues(bytes);
            for (let offset = 0; offset < bytes.length; offset++)
                checksum = Math.imul(checksum ^ bytes[offset], 16777619) >>> 0;
            await writer.append(bytes, '2026-10-15T00:00:00.000Z', 'serial');
            maxBacklog = Math.max(maxBacklog, writer.backlogBytes);
            if (i % 512 === 511)
                console.info(
                    'capture-phase capture ' +
                        (i + 1) * bytes.length +
                        ' ' +
                        Math.round(performance.now() - started) +
                        'ms',
                );
        }
        const capture = await writer.finish('prompt-observed');
        const captureMs = performance.now() - started;
        console.info('capture-phase sealed ' + Math.round(captureMs) + 'ms');
        let actual = 2166136261;
        for await (const event of store.read(writer.id))
            if (event.type === 'frame')
                for (let offset = 0; offset < event.frame.bytes.length; offset++)
                    actual = Math.imul(actual ^ event.frame.bytes[offset], 16777619) >>> 0;
        const readMs = performance.now() - started - captureMs;
        console.info('capture-phase read ' + Math.round(readMs) + 'ms');
        let encodedBytes = 0,
            maxChunk = 0,
            exportHash = 2166136261;
        for await (const chunk of streamCaptureReport(store, 'json')) {
            encodedBytes += chunk.length;
            maxChunk = Math.max(maxChunk, chunk.length);
            for (let offset = 0; offset < chunk.length; offset++)
                exportHash = Math.imul(exportHash ^ chunk[offset], 16777619) >>> 0;
        }
        const encodeMs = performance.now() - started - captureMs - readMs;
        console.info('capture-phase encoded ' + Math.round(encodeMs) + 'ms');
        window.captureID = writer.id;
        await store.close();
        return {
            expected: checksum,
            actual,
            exportHash,
            bytes: capture.committedBytes,
            maxBacklog,
            maxChunk,
            encodedBytes,
            preview: writer.previewBytes.length,
            budget: CAPTURE_STORAGE.backlogBytes,
            captureMs,
            readMs,
            encodeMs,
        };
    });
    expect(result.bytes).toBeGreaterThan(32 * 1024 * 1024);
    expect(result.encodedBytes).toBeGreaterThan(result.bytes);
    expect(result.actual).toBe(result.expected);
    expect(result.maxBacklog).toBeLessThanOrEqual(result.budget);
    expect(result.maxChunk).toBeLessThanOrEqual(65536);
    expect(result.preview).toBe(8192);
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#export-json').click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('automation-results.json');
    expect(await download.failure()).toBeNull();
    let hash = 2166136261,
        received = 0;
    const sha = crypto.createHash('sha256');
    for await (const bytes of createReadStream((await download.path())!, {
        highWaterMark: 65536,
    })) {
        sha.update(bytes);
        received += bytes.length;
        for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    }
    expect(hash).toBe(result.exportHash);
    expect(received).toBe(result.encodedBytes);
    await page.waitForFunction(() => window.captureExportOutcome?.state === 'stream-sent');
    await fs.writeFile(
        testInfo.outputPath('large-download.json'),
        JSON.stringify({
            ...result,
            downloadBytes: received,
            downloadSHA256: sha.digest('hex'),
            browser: browserName,
        }),
    );
    if (browserName === 'chromium') {
        const cdp = await context.newCDPSession(page),
            secondDownload = page.waitForEvent('download');
        await cdp.send('ServiceWorker.enable');
        await page.locator('#export-json').click();
        const interrupted = await secondDownload;
        await cdp.send('ServiceWorker.stopAllWorkers');
        expect(await interrupted.failure()).not.toBeNull();
        await page.waitForFunction(() => Boolean(window.captureExportOutcome?.error), undefined, {
            timeout: 15000,
        });
        expect(await page.evaluate(() => window.captureExportOutcome?.state)).toBe('failed');
        await page.evaluate(async () => {
            const store = await window.captureQA.IndexedDbCaptureStore.open();
            await store.delete(window.captureID!);
            await store.close();
        });
    }
});

test('representative rich Markdown renders as a summary table and separate safe command/output sections', async ({
    page,
}, testInfo) => {
    const root = process.env.HUB_CAPTURE_EVIDENCE;
    if (!root)
        throw Error(
            'Set HUB_CAPTURE_EVIDENCE to the generated representative Markdown/AST directory.',
        );
    const ast = JSON.parse(
        await fs.readFile(path.join(root, 'representative-automation.ast.json'), 'utf8'),
    );
    const escape = (value: string) =>
        value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    type Node = { type: string; value?: string; depth?: number; children?: Node[] };
    const render = (node: Node): string => {
        const children = () => node.children?.map(render).join('') ?? '';
        if (node.type === 'text') return escape(node.value ?? '');
        if (node.type === 'root') return children();
        if (node.type === 'heading')
            return '<h' + node.depth + '>' + children() + '</h' + node.depth + '>';
        if (node.type === 'code') return '<pre><code>' + escape(node.value ?? '') + '</code></pre>';
        if (node.type === 'thematicBreak') return '<hr>';
        const tags: Record<string, string> = {
            paragraph: 'p',
            strong: 'strong',
            emphasis: 'em',
            blockquote: 'blockquote',
            table: 'table',
            tableRow: 'tr',
            tableCell: 'td',
            inlineCode: 'code',
        };
        const tag = tags[node.type];
        return tag
            ? '<' + tag + '>' + (node.value ? escape(node.value) : children()) + '</' + tag + '>'
            : children();
    };
    await page.setContent(
        '<!doctype html><meta charset="utf-8"><style>body{font:16px/1.55 system-ui;background:#f3f5f8;color:#182333;max-width:1120px;margin:36px auto;padding:28px}h1,h2{color:#173e59}table{border-collapse:collapse;width:100%;font-size:13px;background:white}td{border:1px solid #bccad3;padding:8px}tr:first-child{font-weight:bold;background:#dfeaf1}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#142633;color:#e9f1f5;padding:18px;border-radius:8px}blockquote{background:#e6edf1;padding:12px 20px;margin:20px 0;border-left:4px solid #45778f}hr{border:0;border-top:1px solid #b8c7cf;margin:30px 0}</style>' +
            render(ast),
    );
    await expect(page.locator('table')).toHaveCount(1);
    await expect(page.locator('pre')).toHaveCount(4);
    await expect(page.locator('img,script')).toHaveCount(0);
    await expect(page.locator('body')).toContainText('UTF-8 雪🙂');
    await expect(page.locator('body')).toContainText('Incomplete');
    const screenshot = path.join(root, 'rich-markdown-' + testInfo.project.name + '.png');
    await page.screenshot({ path: screenshot, fullPage: true });
});
