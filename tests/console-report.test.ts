import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeConsoleService } from '../electron/console-service';
import { NativeConsoleArchive } from '../src/features/automation/capture/console-archive';
import { streamConsoleReport, consoleReportScope } from '../shared/console-report';
import {
    CaptureExportBroker,
    type ExportClient,
} from '../src/features/automation/capture/export-broker';
import { consoleExportSource } from '../src/features/automation/capture/console-export-source';
import { bytesBase64, CaptureStorageError, CAPTURE_STORAGE } from '../shared/capture-store';
import type { CaptureReportFormat } from '../shared/capture-report';
import type { ConsoleRecord } from '../shared/console-journal';
import { saveCaptureExport } from '../electron/capture-store';

const at = '2026-10-15T17:00:00.000Z';
const match = { role: 'shell-prompt' as const, literal: 'fixture#' };
const header = {
    flowId: 'full-export-fixture',
    startedAt: at,
    receiveTimeSource: 'local-client' as const,
    target: { endpoint: 'owned synthetic journal' },
    ready: { role: 'shell-prompt' as const, literals: ['fixture#'] },
};
async function fixture(
    t: TestContext,
    destination?: (format: CaptureReportFormat) => Promise<string | null>,
) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-console-report-'));
    const service = new NativeConsoleService(profile, destination);
    const archive = new NativeConsoleArchive(async (request) => {
        try {
            return {
                ok: true,
                value: structuredClone(await service.dispatch(structuredClone(request))),
            };
        } catch (error) {
            return {
                ok: false,
                error: {
                    code: error instanceof CaptureStorageError ? error.code : 'io',
                    message: String((error as Error).message),
                },
            };
        }
    });
    t.after(async () => {
        await archive.dispose();
        await service.shutdown();
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('hub-console-report-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    return { profile, service, archive };
}
async function capture(service: NativeConsoleService, total = 0) {
    const store = await service.createWriter(),
        meta = await store.begin(header);
    let observed = 0;
    const observe = async (bytes: Uint8Array, origin: 'channel' | 'extended' = 'channel') => {
        observed += bytes.length;
        await store.observe(bytes, at, origin);
    };
    await store.start({ kind: 'context', phase: 'startup' }, at);
    await observe(Buffer.from('fixture#'));
    await store.end('ready', match, at);
    for (const [index, command] of ['cd /', '', '', 'pwd'].entries()) {
        await store.start(
            {
                kind: 'command',
                runId: 'one',
                stepId: 'step-' + index,
                ordinal: index + 1,
                name: '=hostile <script> & Unicode €',
                input: { intent: command ? 'script' : 'send-enter', command },
                requestBase64: bytesBase64(Buffer.from(command + '\r')),
                criterion: header.ready,
            },
            at,
        );
        if (index === 0) {
            await observe(Buffer.from('=1+1\x1b]52;c;hidden-clipboard\x07 <script>\r\n'));
            await observe(new Uint8Array([0xe2]));
            await observe(new Uint8Array([0x82, 0xac]));
            let remaining = total;
            while (remaining) {
                const bytes = Buffer.alloc(Math.min(remaining, CAPTURE_STORAGE.backlogBytes), 65);
                await observe(bytes, 'extended');
                remaining -= bytes.length;
            }
        }
        await observe(Buffer.from('fixture#'));
        await store.end('prompt-observed', match, at);
        await store.outcome('prompt-observed', match, at);
        await store.start({ kind: 'context', phase: 'idle' }, at);
        await store.end('idle-boundary', null, at);
    }
    await store.start({ kind: 'context', phase: 'shutdown' }, at);
    await observe(Buffer.from('bye'));
    await store.end('closed', null, at);
    await store.finish('complete', observed, true);
    await store.close();
    return { id: meta.header.id, observed };
}
async function output(source: AsyncIterable<Uint8Array>) {
    const parts: Buffer[] = [];
    for await (const part of source) {
        assert.ok(part.length <= CAPTURE_STORAGE.frameBytes);
        parts.push(Buffer.from(part));
    }
    return Buffer.concat(parts).toString('utf8');
}
function csvRows(value: string) {
    const rows: string[][] = [];
    let row: string[] = [],
        cell = '',
        quoted = false;
    for (let index = 0; index < value.length; index++) {
        const c = value[index];
        if (c === '"') {
            if (quoted && value[index + 1] === '"') {
                cell += '"';
                index++;
            } else quoted = !quoted;
        } else if (c === ',' && !quoted) {
            row.push(cell);
            cell = '';
        } else if (c === '\r' && value[index + 1] === '\n' && !quoted) {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
            index++;
        } else cell += c;
    }
    assert.equal(quoted, false);
    assert.equal(cell, '');
    return rows;
}
test(
    'four console report formats round-trip full >1-MiB PTY bytes, metadata, context and exact Enter requests',
    { timeout: 20000 },
    async (t) => {
        const f = await fixture(t),
            c = await capture(f.service, 1024 * 1024 + 16384);
        const original: ConsoleRecord[] = [];
        for await (const event of f.archive.read(c.id))
            if (event.kind === 'record') original.push(event.record);
        for (const format of ['json', 'csv', 'markdown', 'text'] as const) {
            const report = await output(streamConsoleReport(f.archive, format, { ids: [c.id] }));
            let restored: ConsoleRecord[];
            if (format === 'json') {
                const parsed = JSON.parse(report);
                assert.equal(parsed.mode, 'console');
                assert.equal(parsed.schema, 2);
                assert.equal(parsed.captures[0].capture.bytes, c.observed);
                restored = parsed.captures[0].records;
            } else if (format === 'csv') {
                const rows = csvRows(report);
                restored = rows
                    .slice(1)
                    .filter((r) => !['metadata', 'readable-tail', 'export-scope'].includes(r[1]))
                    .map((r) => JSON.parse(Buffer.from(r[5], 'base64').toString('utf8')));
                assert.ok(
                    rows.some((r) => r[3].startsWith("'=1+1") && r[4].includes('readable_text')),
                );
                assert.ok(!rows.some((r) => r[3].includes('hidden-clipboard')));
            } else {
                restored = [
                    ...report.matchAll(/Canonical record JSON base64: ([A-Za-z0-9+/=]+)/g),
                ].map((m) => JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')));
                assert.ok(report.includes('dispatch is uncertain'));
                if (format === 'markdown') assert.ok(!report.includes('<script>'));
            }
            assert.deepEqual(restored, original, format + ' must preserve every canonical record');
            const requests = restored.filter(
                (r) => r.kind === 'segment-start' && r.segment.kind === 'command',
            );
            assert.deepEqual(
                requests.map((r) =>
                    r.kind === 'segment-start' && r.segment.kind === 'command'
                        ? Buffer.from(r.segment.requestBase64, 'base64').toString()
                        : '',
                ),
                ['cd /\r', '\r', '\r', 'pwd\r'],
            );
            assert.ok(
                restored.filter((r) => r.kind === 'outcome').every((r) => r.exitCode === null),
            );
            assert.equal(f.service.snapshot.pins, 0);
            assert.equal(f.service.snapshot.readers, 0);
        }
    },
);
test('active, missing and damaged evidence refuse without leaking export/read pins or inventing completeness', async (t) => {
    const f = await fixture(t),
        c = await capture(f.service);
    await assert.rejects(
        output(streamConsoleReport(f.archive, 'json', { ids: [crypto.randomUUID()] })),
        /no longer retained/,
    );
    const writer = await f.service.createWriter(),
        active = await writer.begin(header);
    await writer.start({ kind: 'context', phase: 'idle' }, at);
    await assert.rejects(
        output(streamConsoleReport(f.archive, 'text', { ids: [active.header.id] })),
        { code: 'busy' },
    );
    await writer.close();
    const metaFile = path.join(f.profile, 'console-captures-v2', c.id, 'meta.json'),
        before = await fs.readFile(metaFile);
    const meta = JSON.parse(before.toString());
    meta.offset++;
    await fs.writeFile(metaFile, JSON.stringify(meta));
    await assert.rejects(output(streamConsoleReport(f.archive, 'json', { ids: [c.id] })), {
        code: 'integrity',
    });
    assert.equal(f.service.snapshot.references, 0);
    assert.equal(f.service.snapshot.pins, 0);
    await fs.writeFile(metaFile, before);
});
test('stopping a partial report returns its reader and catalog pin, leaving evidence deletable', async (t) => {
    const f = await fixture(t),
        c = await capture(f.service, 32768),
        iterator = streamConsoleReport(f.archive, 'json', { ids: [c.id] });
    for (let i = 0; i < 5; i++) await iterator.next();
    assert.ok(f.service.snapshot.references > 0);
    await iterator.return(undefined);
    assert.equal(f.service.snapshot.references, 0);
    await f.archive.delete(c.id);
    assert.equal((await f.archive.list()).captures.length, 0);
});
test('native Save cancellation/reset joins pending chooser and preserves an existing destination', async (t) => {
    let choose!: (file: string | null) => void, selecting!: () => void;
    const selected = new Promise<void>((resolve) => {
        selecting = resolve;
    });
    const f = await fixture(t, async () => {
        selecting();
        return new Promise((resolve) => {
            choose = resolve;
        });
    });
    const c = await capture(f.service),
        destination = path.join(f.profile, 'retained.json');
    await fs.writeFile(destination, 'existing evidence');
    const owner = crypto.randomUUID(),
        pending = f.service.dispatch({
            op: 'export',
            owner,
            format: 'json',
            scope: { ids: [c.id] },
        });
    void pending.catch(() => {});
    await selected;
    let resetDone = false;
    const reset = f.service.reset().then(() => {
        resetDone = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resetDone, false);
    assert.equal(f.service.snapshot.exports, 1);
    choose(destination);
    await assert.rejects(pending, /cancelled/);
    await reset;
    assert.equal(await fs.readFile(destination, 'utf8'), 'existing evidence');
    assert.equal(f.service.snapshot.references, 0);
    assert.equal(f.service.snapshot.exports, 0);
});
test('native full export commits atomically and failed encoder/cancel preserve the previous file', async (t) => {
    let destination = '';
    const f = await fixture(t, async () => destination),
        c = await capture(f.service);
    destination = path.join(f.profile, 'result.json');
    const result = await f.service.dispatch({
        op: 'export',
        owner: crypto.randomUUID(),
        format: 'json',
        scope: { ids: [c.id] },
    });
    assert.deepEqual(result, { saved: true });
    const before = await fs.readFile(destination);
    assert.equal(JSON.parse(before.toString()).captures[0].capture.bytes, c.observed);
    const controller = new AbortController();
    await assert.rejects(
        saveCaptureExport(
            destination,
            (async function* () {
                yield Buffer.from('replacement');
                controller.abort();
                yield Buffer.from('must not commit');
            })(),
            true,
            controller.signal,
        ),
        /cancelled/,
    );
    assert.deepEqual(await fs.readFile(destination), before);
    await assert.rejects(
        saveCaptureExport(
            destination,
            (async function* () {
                yield Buffer.from('partial');
                throw Error('intentional encoder fault');
            })(),
            true,
        ),
        /intentional encoder fault/,
    );
    assert.deepEqual(await fs.readFile(destination), before);
    assert.equal(
        (await fs.readdir(f.profile)).some((name) => name.startsWith('.diagnostic-hub-export-')),
        false,
    );
});
test('one broker securely selects the fixed console encoder without opening legacy storage', async (t) => {
    const f = await fixture(t),
        c = await capture(f.service),
        scope = 'https://fixture.test/hub/';
    const clients = new Map<string, ExportClient>([
        ['owner', { id: 'owner', url: scope, frameType: 'top-level' }],
        ['other', { id: 'other', url: scope, frameType: 'top-level' }],
    ]);
    let legacyOpened = false;
    const broker = new CaptureExportBroker(
        {
            filename: 'automation-results',
            validateScope: () => ({}),
            pin: async () => {
                legacyOpened = true;
                throw Error('legacy must stay unopened');
            },
            async *streamReport() {
                throw Error('legacy stream must stay unopened');
            },
        },
        {
            scope,
            now: () => performance.now(),
            client: async (id) => clients.get(id),
            clients: async () => [...clients.values()],
            notify: async () => {},
        },
        60000,
        consoleExportSource(async () => f.archive),
    );
    const job = await broker.prepare('owner', 'json', { ids: [c.id] }, 'console');
    t.after(() => broker.cancel(job.id, 'owner').catch(() => {}));
    await broker.frame(job.nonce, 'frame');
    clients.set('frame', { id: 'frame', url: job.frameUrl, frameType: 'nested' });
    const claim = await broker.claim(job.nonce, 'frame'),
        token = claim.url.split('/').at(-1)!;
    await assert.rejects(
        broker.download(token, { clientId: 'other', mode: 'navigate', referrer: job.frameUrl }),
        /another client/,
    );
    const download = await broker.download(token, {
        clientId: 'frame',
        mode: 'navigate',
        referrer: job.frameUrl,
    });
    assert.equal(download.filename, 'console-results.json');
    const result = JSON.parse(await output(download.stream));
    await download.done;
    assert.equal(result.captures[0].capture.header.id, c.id);
    assert.equal(legacyOpened, false);
    assert.equal(f.service.snapshot.references, 0);
    await assert.rejects(
        broker.prepare('owner', 'json', {}, 'untrusted' as 'console'),
        /Invalid export source/,
    );
    assert.throws(() => consoleReportScope({ database: 'foreign' }), /unknown|unexpected|Invalid/i);
});
