import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeConsoleJournal } from '../electron/console-journal';
import { CaptureStorageError } from '../shared/capture-store';
import { RemoteConsoleRepository, dispatchConsoleWrite } from '../shared/console-storage';

const at = '2026-10-15T15:00:00.000Z';
const header = {
    flowId: 'rpc-fixture',
    startedAt: at,
    receiveTimeSource: 'local-client' as const,
    target: { endpoint: 'owned native journal fixture' },
    ready: { role: 'shell-prompt' as const, literals: ['fixture#'] },
};
async function fixture(t: import('node:test').TestContext) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-console-rpc-'));
    const native = await NativeConsoleJournal.open(profile, { profileOwned: true });
    t.after(async () => {
        await native.close();
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('hub-console-rpc-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    return native;
}
test('bounded RPC joins actual native commits and close before acknowledging cleanup', async (t) => {
    const native = await fixture(t),
        remote = new RemoteConsoleRepository((input) => dispatchConsoleWrite(native, input));
    const capture = await remote.begin(header);
    await remote.start({ kind: 'context', phase: 'startup' }, at);
    await remote.observe(new TextEncoder().encode('fixture#'), at, 'channel');
    await remote.end('ready', { role: 'shell-prompt', literal: 'fixture#' }, at);
    await remote.start({ kind: 'context', phase: 'shutdown' }, at);
    await remote.end('closed', null, at);
    const sealed = await remote.finish('complete', 8, true);
    assert.equal(sealed.header.id, capture.header.id);
    assert.equal(sealed.bytes, 8);
    assert.equal(sealed.observedBytes, 8);
    assert.equal(remote.resourceClosed, false);
    await remote.close();
    assert.equal(native.resourceClosed, true);
    assert.equal(remote.resourceClosed, true);
    await remote.close();
    const clone = remote.snapshot!;
    clone.header.target.endpoint = 'external mutation';
    assert.equal(remote.snapshot!.header.target.endpoint, header.target.endpoint);
});
test('concurrent requests refuse while the first durable acknowledgement is pending', async (t) => {
    const native = await fixture(t);
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
        resume = resolve;
    });
    const remote = new RemoteConsoleRepository(async (input) => {
        await held;
        return dispatchConsoleWrite(native, input);
    });
    const first = remote.begin(header);
    await assert.rejects(remote.begin(header), { code: 'busy' });
    resume();
    await first;
    await remote.close();
    assert.equal(native.resourceClosed, true);
});
test('lost acknowledgement disarms later writes; explicit fail/close preserve the retained prefix', async (t) => {
    const native = await fixture(t);
    let lose = false;
    const remote = new RemoteConsoleRepository(async (input) => {
        const reply = await dispatchConsoleWrite(native, input);
        if (lose) {
            lose = false;
            throw new CaptureStorageError('io', 'Deliberately lost commit acknowledgement');
        }
        return reply;
    });
    await remote.begin(header);
    await remote.start({ kind: 'context', phase: 'startup' }, at);
    lose = true;
    await assert.rejects(
        remote.observe(new TextEncoder().encode('fixture#'), at, 'channel'),
        /lost commit/,
    );
    await assert.rejects(
        remote.end('ready', { role: 'shell-prompt', literal: 'fixture#' }, at),
        /lost commit/,
    );
    assert.equal(native.snapshot!.bytes, 8);
    assert.equal(remote.snapshot!.bytes, 0);
    await remote.fail(null, new CaptureStorageError('io', 'Acknowledgement uncertain'), true);
    await remote.close();
    assert.equal(remote.snapshot!.bytes, 8);
    assert.equal(remote.snapshot!.state, 'incomplete');
    assert.equal(remote.snapshot!.observedBytes, null);
    assert.equal(native.resourceClosed, true);
});
test('changed identity, rollback and false early cleanup acknowledgements fail closed', async (t) => {
    for (const mode of ['identity', 'rollback', 'closed'] as const) {
        await t.test(mode, async (t) => {
            const native = await fixture(t);
            let corrupt = false;
            const remote = new RemoteConsoleRepository(async (input) => {
                const reply = await dispatchConsoleWrite(native, input);
                if (corrupt) {
                    corrupt = false;
                    if (mode === 'identity')
                        reply.snapshot!.header.id = '00000000-0000-4000-8000-000000000000';
                    else if (mode === 'rollback') reply.snapshot!.records = 0;
                    else reply.closed = true;
                }
                return reply;
            });
            await remote.begin(header);
            await remote.start({ kind: 'context', phase: 'startup' }, at);
            corrupt = true;
            await assert.rejects(
                remote.observe(new TextEncoder().encode('fixture#'), at, 'channel'),
                { code: 'integrity' },
            );
            await assert.rejects(
                remote.end('ready', { role: 'shell-prompt', literal: 'fixture#' }, at),
                { code: 'integrity' },
            );
            assert.equal(remote.resourceClosed, false);
            await remote.fail(
                null,
                new CaptureStorageError('integrity', 'Bad acknowledgement'),
                true,
            );
            await remote.close();
            assert.equal(native.resourceClosed, true);
        });
    }
});
