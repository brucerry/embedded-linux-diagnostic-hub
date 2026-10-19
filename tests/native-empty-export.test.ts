import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeCaptureHost } from '../electron/capture-host';
import { NativeCaptureRepository } from '../src/features/automation/capture/native-repository';
import { CaptureWriter } from '../shared/capture-writer';

for (const format of ['json', 'csv', 'markdown', 'text'] as const) {
    test(`empty native ${format} export refuses before Save and joins storage shutdown`, async () => {
        const root = await fs.mkdtemp(path.join(path.resolve(os.tmpdir()), 'hub-empty-export-'));
        let saves = 0;
        const destination = path.join(root, 'existing-report');
        const sentinel = Buffer.from('retain this destination');
        await fs.writeFile(destination, sentinel, { flag: 'wx' });
        const host = await NativeCaptureHost.open(root, { profileOwned: true }, async () => {
            saves++;
            return destination;
        });
        const port = host as any;
        try {
            const empty = await host.dispatch({ op: 'export', format, scope: {} });
            assert.equal(empty.ok, false);
            if (!empty.ok)
                assert.equal(empty.error.message, 'No stored captures match this export.');
            assert.equal(saves, 0);
            assert.equal(port.store.pins, 0);
            const proxy = await NativeCaptureRepository.open((request) => host.dispatch(request));
            const writer = await CaptureWriter.begin(proxy, {
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'empty-export',
                stepId: 'one',
                name: 'Retained capture',
                command: 'kept',
                startedAt: '2026-10-19T00:00:00.000Z',
            });
            await writer.append(
                new TextEncoder().encode('retained bytes'),
                '2026-10-19T00:00:00.000Z',
                'serial',
            );
            await writer.finish('prompt-observed');
            const before = await proxy.page(0, 100);
            for (const scope of [
                { filter: { transport: 'ssh' } },
                { filter: { transport: 'serial', query: '__absent__' } },
                { ids: [] },
            ]) {
                const reply = await host.dispatch({ op: 'export', format, scope });
                assert.equal(reply.ok, false);
                if (!reply.ok)
                    assert.equal(reply.error.message, 'No stored captures match this export.');
                assert.equal(saves, 0, 'Empty scope must not open a native Save dialog.');
                assert.equal(port.exports.size, 0);
                assert.equal(port.store.pins, 0);
                assert.equal(port.store.readers.size, 0);
                assert.deepEqual(await proxy.page(0, 100), before);
                assert.deepEqual(await fs.readFile(destination), sentinel);
                assert.ok(
                    !(await fs.readdir(root)).some((name) =>
                        name.startsWith('.diagnostic-hub-export-'),
                    ),
                );
            }
            const unavailable = await host.dispatch({
                op: 'export',
                format,
                scope: { ids: [crypto.randomUUID()] },
            });
            assert.equal(unavailable.ok, false);
            if (!unavailable.ok)
                assert.equal(
                    unavailable.error.message,
                    'Some selected captures are unavailable in this snapshot; no partial selection is exported.',
                );
            assert.equal(saves, 0);
            assert.equal(port.store.pins, 0);
            const invalid = await host.dispatch({
                op: 'export',
                format,
                scope: { ids: [], filter: {} },
            });
            assert.equal(invalid.ok, false);
            if (!invalid.ok) assert.equal(invalid.error.code, 'invalid');
            assert.equal(saves, 0);
            assert.equal(port.exports.size, 0);
            assert.equal(port.store.pins, 0);
            await host.shutdown();
            assert.equal(port.store.closed, true);
        } finally {
            await host.shutdown();
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    test(`valid native ${format} cancellation closes the primed report iterator and retains the catalog`, async () => {
        const root = await fs.mkdtemp(path.join(path.resolve(os.tmpdir()), 'hub-primed-cancel-'));
        let saves = 0;
        const host = await NativeCaptureHost.open(root, { profileOwned: true }, async () => {
            saves++;
            return null;
        });
        const port = host as any;
        try {
            const proxy = await NativeCaptureRepository.open((request) => host.dispatch(request));
            const writer = await CaptureWriter.begin(proxy, {
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'primed-cancel',
                stepId: 'one',
                name: 'Retained capture',
                command: 'kept',
                startedAt: '2026-10-19T00:00:00.000Z',
            });
            await writer.append(
                new TextEncoder().encode('retained bytes'),
                '2026-10-19T00:00:00.000Z',
                'serial',
            );
            await writer.finish('prompt-observed');
            const before = await proxy.page(0, 100);
            assert.deepEqual(await host.dispatch({ op: 'export', format, scope: {} }), {
                ok: true,
                value: false,
            });
            assert.equal(saves, 1);
            assert.equal(port.exports.size, 0);
            assert.equal(port.store.pins, 0);
            assert.equal(port.store.readers.size, 0);
            assert.deepEqual(await proxy.page(0, 100), before);
            await host.shutdown();
            assert.equal(port.store.closed, true);
        } finally {
            await host.shutdown();
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    test(`corrupt native ${format} read after Save preserves the destination and joins shutdown`, async () => {
        const root = await fs.mkdtemp(
            path.join(path.resolve(os.tmpdir()), 'hub-export-integrity-'),
        );
        const destination = path.join(root, 'existing-report');
        const sentinel = Buffer.from('retain original destination');
        await fs.writeFile(destination, sentinel, { flag: 'wx' });
        let saves = 0;
        const host = await NativeCaptureHost.open(root, { profileOwned: true }, async () => {
            saves++;
            return destination;
        });
        const port = host as any;
        try {
            const proxy = await NativeCaptureRepository.open((request) => host.dispatch(request));
            const writer = await CaptureWriter.begin(proxy, {
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'corrupt-export',
                stepId: 'one',
                name: 'Retained capture',
                command: 'kept',
                startedAt: '2026-10-19T00:00:00.000Z',
            });
            await writer.append(
                new TextEncoder().encode('retained bytes'),
                '2026-10-19T00:00:00.000Z',
                'serial',
            );
            const capture = await writer.finish('prompt-observed');
            const before = await proxy.page(0, 100);
            await fs.truncate(path.join(root, 'captures-v1', capture.id, 'raw.jsonl'), 2);
            const reply = await host.dispatch({ op: 'export', format, scope: {} });
            assert.equal(reply.ok, false);
            if (!reply.ok) assert.equal(reply.error.code, 'integrity');
            assert.equal(saves, 1, 'The actual body read must fail after Save.');
            assert.equal(port.exports.size, 0);
            assert.equal(port.store.pins, 0);
            assert.equal(port.store.readers.size, 0);
            assert.deepEqual(await fs.readFile(destination), sentinel);
            assert.deepEqual(await proxy.page(0, 100), before);
            assert.ok(
                !(await fs.readdir(root)).some((name) =>
                    name.startsWith('.diagnostic-hub-export-'),
                ),
            );
            await host.shutdown();
            assert.equal(port.store.closed, true);
        } finally {
            await host.shutdown();
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}
