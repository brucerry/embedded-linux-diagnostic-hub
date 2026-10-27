import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeCaptureStore } from '../electron/capture-store';
import { physicalFS } from '../electron/physical-fs';
import type { FileHandle } from 'node:fs/promises';

const separator = '; journal close also failed: ';
const cases = [
    {
        name: 'three-byte 510-byte input',
        sync: '\u521d'.repeat(170),
        close: '\u754c'.repeat(170),
        syncPrefix: '\u521d'.repeat(74),
        closePrefix: '\u754c'.repeat(74),
    },
    {
        name: 'four-byte input',
        sync: '\u{1f600}'.repeat(127),
        close: '\u{1f6a7}'.repeat(127),
        syncPrefix: '\u{1f600}'.repeat(56),
        closePrefix: '\u{1f6a7}'.repeat(56),
    },
    {
        name: 'two-byte input',
        sync: '\u00e9'.repeat(255),
        close: '\u00f1'.repeat(255),
        syncPrefix: '\u00e9'.repeat(112),
        closePrefix: '\u00f1'.repeat(112),
    },
    {
        name: 'mixed boundary',
        sync: 'a'.repeat(222) + '\u20ac',
        close: 'b'.repeat(221) + '\u{1f6a7}',
        syncPrefix: 'a'.repeat(222),
        closePrefix: 'b'.repeat(221),
    },
    {
        name: 'ASCII maximum',
        sync: 'a'.repeat(512),
        close: 'b'.repeat(512),
        syncPrefix: 'a'.repeat(224),
        closePrefix: 'b'.repeat(224),
    },
];
for (const scenario of cases)
    test('journal dual failure retains UTF-8 prefixes: ' + scenario.name, async (t) => {
        const temp = path.resolve(os.tmpdir()),
            profile = await fs.mkdtemp(path.join(temp, 'hub-journal-message-'));
        const store = await NativeCaptureStore.open(profile, { profileOwned: true }),
            original = physicalFS.promises.open;
        let journal: FileHandle | undefined,
            closeCalls = 0;
        const patch = t.mock.method(
            physicalFS.promises,
            'open',
            async (...args: Parameters<typeof original>) => {
                const handle = await Reflect.apply(original, physicalFS.promises, args);
                if (path.basename(String(args[0])) === 'raw.jsonl') {
                    journal = handle;
                    const close = handle.close.bind(handle);
                    t.mock.method(handle, 'sync', async () => {
                        throw Object.assign(Error(scenario.sync), { code: 'EACCES' });
                    });
                    t.mock.method(handle, 'close', async () => {
                        closeCalls++;
                        await close();
                        throw Object.assign(Error(scenario.close), { code: 'EIO' });
                    });
                }
                return handle;
            },
        );
        t.after(async () => {
            patch.mock.restore();
            t.mock.restoreAll();
            if (journal && journal.fd >= 0) await journal.close();
            await store.close();
            const resolved = path.resolve(profile);
            assert.ok(
                resolved.startsWith(temp + path.sep) &&
                    path.basename(resolved).startsWith('hub-journal-message-'),
            );
            await fs.rm(resolved, { recursive: true, force: true });
        });
        let caught: any;
        try {
            await store.begin({
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'unicode-errors',
                stepId: 'one',
                name: 'Synthetic',
                command: 'synthetic',
                startedAt: '2026-10-16T00:00:00.000Z',
            });
        } catch (error) {
            caught = error;
        }
        assert.ok(caught);
        assert.equal(caught.code, 'permission');
        assert.equal(closeCalls, 1);
        assert.ok(journal);
        assert.equal(journal.fd, -1);
        assert.ok(caught.message.includes(separator), 'secondary close prefix was discarded');
        assert.equal(
            caught.message,
            scenario.syncPrefix + separator + scenario.closePrefix,
            'Both independently bounded prefixes must survive on complete code points.',
        );
        assert.ok(Buffer.byteLength(caught.message, 'utf8') <= 512);
        assert.equal(caught.message.includes('\ufffd'), false);
        assert.equal(Reflect.get(store, 'modifying'), false);
        assert.equal(Reflect.get(store, 'active'), undefined);
        assert.deepEqual((await store.page()).records, []);
    });
