import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedLinuxSetupReadiness } from '../electron/linux-setup-readiness.ts';
import {
    createLinuxInstallerReadback,
    createLinuxMainReadback,
    type LinuxReadbackBinding,
} from '../electron/linux-setup-readback.ts';
import { createLinuxNativeSetupReadback } from '../electron/linux-setup-readback-native.ts';
import { linuxReadbackPair } from './fixtures/linux-readback-port.ts';
import type { LinuxSetupReadiness } from '../shared/types.ts';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
function fixture() {
    let now = 11000,
        randoms = 0;
    const record: LinuxSetupReadiness = {
        schemaVersion: 1,
        source: 'linux-main-self-observation',
        root: '/home/test/installed',
        installationId: '11111111-1111-4111-8111-111111111111',
        transactionId: '22222222-2222-4222-8222-222222222222',
        manifestSHA256: 'a'.repeat(64),
        version: '0.6.0',
        process: {
            pid: 888,
            uid: 1000,
            executable: '/home/test/installed/app/diagnostic-hub',
            creationTimeMs: 10000,
        },
        profile: { path: '/home/test/data/profile', lockOwned: true },
        window: {
            electronId: 1,
            nativeHandleHex: '0100000000000000',
            visible: true,
            minimized: false,
            mainFrameReady: true,
        },
        observedAtMs: now,
        payloadIntegrity: 'not-checked',
        independentProcessObservation: false,
        independentWindowObservation: false,
        descendantRetirement: false,
        finalizationAuthority: false,
    };
    const binding: LinuxReadbackBinding = {
        root: record.root,
        installationId: record.installationId,
        transactionId: record.transactionId,
        manifestSHA256: record.manifestSHA256,
        version: record.version,
        profile: record.profile.path,
        executable: record.process.executable,
        uid: 1000,
    };
    const pair = linuxReadbackPair(),
        clock = {
            now: () => now,
            nonce: () => {
                randoms++;
                return Buffer.alloc(32, 0xa);
            },
        },
        parent = createLinuxInstallerReadback(pair.parent, binding, clock),
        child = createLinuxMainReadback(pair.child, clock.now),
        process = {
            pid: 888,
            uid: 1000,
            executable: record.process.executable,
            startTicks: '10001',
        };
    return {
        record,
        binding,
        pair,
        clock,
        parent,
        child,
        process,
        get randoms() {
            return randoms;
        },
        advance(ms: number) {
            now += ms;
        },
    };
}
test('one-use owned pipe carries fresh nonce-bound readback and joins both EOFs, finish and close', async () => {
    const f = fixture();
    f.child.offer(f.record, async () => clone(f.record));
    f.parent.admit(f.process);
    await f.pair.pump(() => f.parent.summary().closed && f.child.summary().closed);
    assert.equal(await f.parent.wait(), true);
    await f.parent.joinClosure();
    await f.child.joinClosure();
    assert.deepEqual(f.parent.readiness(), f.record);
    assert.equal(f.randoms, 1);
    assert.equal(f.pair.frames.length, 3);
    assert.equal(f.parent.summary().channelBoundFreshReadback, true);
    assert.equal(f.parent.summary().finalizationAuthority, false);
    assert.equal(f.parent.summary().successorVerified, false);
    assert.equal(f.parent.summary().wholeGroupRetirement, false);
    assert.equal(f.pair.parent.ends, 1);
    assert.equal(f.pair.child.ends, 1);
});
test('offer can precede independently observed process admission, with no early challenge', async () => {
    const f = fixture();
    f.child.offer(f.record, async () => clone(f.record));
    await f.pair.pump(() => f.parent.summary().frames === 1);
    assert.equal(f.randoms, 0);
    assert.equal(f.pair.frames.length, 1);
    f.parent.admit(f.process);
    await f.pair.pump(() => f.parent.summary().closed);
    assert.equal(await f.parent.wait(), true);
});
test('wrong offered PID cannot cause nonce disclosure or parent readback acceptance', async () => {
    const f = fixture();
    f.parent.admit(f.process);
    f.child.offer({ ...f.record, process: { ...f.record.process, pid: 999 } }, async () =>
        clone(f.record),
    );
    await f.pair.pump(() => f.parent.summary().failed);
    assert.equal(await f.parent.wait(), false);
    assert.equal(f.randoms, 0);
    assert.equal(f.parent.summary().retained, true);
    assert.equal(f.pair.parent.ends, 0);
});
test('replayed or malformed challenge is refused before refreshing the main observation', async () => {
    for (const kind of ['nonce', 'binding', 'stale', 'extra'] as const) {
        const f = fixture();
        let reads = 0;
        f.child.offer(f.record, async () => {
            reads++;
            return clone(f.record);
        });
        await f.pair.pump(() => f.child.summary().pendingWrites === 0);
        const challenge: any = {
            v: 1,
            kind: 'challenge',
            nonce: 'a'.repeat(64),
            sentAt: 11000,
            binding: clone(f.binding),
            pid: 888,
            startTicks: '10001',
        };
        if (kind === 'nonce') challenge.nonce = '0'.repeat(64);
        if (kind === 'binding') challenge.binding.profile = '/foreign';
        if (kind === 'stale') challenge.sentAt = 9000;
        if (kind === 'extra') challenge.unknown = true;
        f.pair.child.emit('data', Buffer.from(JSON.stringify(challenge) + '\n'));
        assert.equal(f.child.summary().failed, true);
        assert.equal(reads, 0);
        assert.equal(f.pair.child.ends, 0);
    }
});
test('changed or unavailable refresh never yields a reply or authority', async () => {
    for (const kind of ['null', 'profile', 'generation-time', 'authority', 'error'] as const) {
        const f = fixture();
        f.parent.admit(f.process);
        f.child.offer(f.record, async () => {
            if (kind === 'null') return null;
            if (kind === 'error') throw Error('private-refresh-canary');
            const r = clone(f.record);
            if (kind === 'profile') r.profile.path = '/foreign';
            if (kind === 'generation-time') r.observedAtMs = 10999;
            if (kind === 'authority') (r as any).finalizationAuthority = true;
            return r;
        });
        await f.pair.pump(() => f.child.summary().failed);
        assert.equal(f.child.summary().failed, true);
        assert.equal(f.pair.child.writes, 1);
        assert.equal(f.pair.child.ends, 0);
        f.parent.abort();
        assert.equal(await f.parent.wait(), false);
        assert.equal(f.parent.readiness(), null);
    }
});
test('nonce mismatch and duplicate offers cannot be accepted by the specific parent channel', async () => {
    for (const kind of ['reply-nonce', 'duplicate-offer'] as const) {
        const f = fixture();
        f.parent.admit(f.process);
        f.pair.parent.emit(
            'data',
            Buffer.from(JSON.stringify({ v: 1, kind: 'offer', pid: 888 }) + '\n'),
        );
        const packet =
            kind === 'duplicate-offer'
                ? { v: 1, kind: 'offer', pid: 888 }
                : { v: 1, kind: 'reply', nonce: 'b'.repeat(64), readiness: f.record };
        f.pair.parent.emit('data', Buffer.from(JSON.stringify(packet) + '\n'));
        assert.equal(await f.parent.wait(), false);
        assert.equal(f.parent.readiness(), null);
        assert.equal(f.pair.parent.ends, 0);
    }
});
test('raw byte parser refuses oversized, duplicate-key, invalid UTF8 and truncated frames', async () => {
    for (const kind of ['oversize', 'duplicate', 'utf8', 'truncated'] as const) {
        const f = fixture();
        if (kind === 'oversize') f.pair.parent.emit('data', Buffer.alloc(12289));
        if (kind === 'duplicate')
            f.pair.parent.emit('data', Buffer.from('{"v":2,"v":1,"kind":"offer","pid":888}\n'));
        if (kind === 'utf8') f.pair.parent.emit('data', Buffer.from([0xff, 10]));
        if (kind === 'truncated') {
            f.pair.parent.emit('data', Buffer.from('{'));
            f.pair.parent.emit('end');
        }
        assert.equal(await f.parent.wait(), false);
        assert.equal(f.parent.summary().retained, true);
        assert.equal(f.pair.parent.ends, 0);
    }
});
test('exit/EOF without acknowledged write finish and close cannot retire the channel', async () => {
    const f = fixture();
    f.pair.parent.emit('close', false);
    assert.equal(await f.parent.wait(), false);
    await assert.rejects(f.parent.joinClosure(), /CUSTODY_RETAINED/);
    assert.equal(f.parent.summary().closed, false);
});
test('backpressure or callback error retains custody and never retries writes', async () => {
    for (const kind of ['backpressure', 'callback'] as const) {
        const f = fixture();
        f.parent.admit(f.process);
        if (kind === 'backpressure') f.pair.parent.backpressure = true;
        else f.pair.parent.writeError = true;
        f.child.offer(f.record, async () => clone(f.record));
        await f.pair.pump(() => f.parent.summary().failed);
        assert.equal(await f.parent.wait(), false);
        assert.equal(f.pair.parent.writes, 1);
        assert.equal(f.parent.summary().retained, true);
        assert.equal(f.pair.parent.ends, 0);
    }
});
test('an end callback error cannot acknowledge graceful channel closure', async () => {
    const f = fixture();
    f.pair.parent.endError = true;
    f.parent.admit(f.process);
    f.child.offer(f.record, async () => clone(f.record));
    await f.pair.pump(() => f.parent.summary().failed);
    assert.equal(await f.parent.wait(), false);
    assert.equal(f.parent.summary().endAck, false);
    assert.equal(f.parent.summary().closed, false);
    await assert.rejects(f.parent.joinClosure(), /CUSTODY_RETAINED/);
});
test('failed owner and late refreshed continuation cannot revive acceptance or release the pipe', async () => {
    const f = fixture();
    let resolve!: (value: LinuxSetupReadiness) => void;
    const held = new Promise<LinuxSetupReadiness>((r) => {
        resolve = r;
    });
    f.parent.admit(f.process);
    f.child.offer(f.record, () => held);
    await f.pair.pump(() => f.child.summary().frames === 1);
    f.parent.abort();
    assert.equal(await f.parent.wait(), false);
    f.pair.child.emit('error', Error('controlled-error'));
    resolve(f.record);
    await f.pair.pump(() => false);
    assert.equal(f.child.summary().failed, true);
    assert.equal(f.pair.child.writes, 1);
    assert.equal(f.parent.readiness(), null);
});
test('a previously accepted point-in-time observation expires without rewriting transport history', async () => {
    const f = fixture();
    f.parent.admit(f.process);
    f.child.offer(f.record, async () => clone(f.record));
    await f.pair.pump(() => f.parent.summary().closed);
    assert.equal(await f.parent.wait(), true);
    f.advance(2000);
    assert.equal(f.parent.readiness(), null);
    assert.equal(f.parent.summary().channelBoundFreshReadback, true);
});
test('wire projection rejects fabricated authority, nonfinite values, unknown fields and malformed handles', () => {
    const f = fixture();
    for (const mutate of [
        (r: any) => (r.finalizationAuthority = true),
        (r: any) => (r.descendantRetirement = true),
        (r: any) => (r.process.pid = Infinity),
        (r: any) => (r.window.nativeHandleHex = '00'),
        (r: any) => (r.unknown = true),
    ]) {
        const r = clone(f.record);
        mutate(r);
        assert.throws(() => checkedLinuxSetupReadiness(r));
    }
    const hidden = clone(f.record);
    Object.defineProperty(hidden, 'toJSON', {
        value: () => ({ ...f.record, finalizationAuthority: true }),
    });
    assert.throws(() => checkedLinuxSetupReadiness(hidden));
    const getter = clone(f.record);
    let reads = 0;
    Object.defineProperty(getter, 'root', {
        enumerable: true,
        get() {
            reads++;
            return f.record.root;
        },
    });
    assert.throws(() => checkedLinuxSetupReadiness(getter));
    assert.equal(reads, 0);
});
test('native port opt-out touches no descriptor; unsupported or changed inherited descriptor remains unqualified and held', async () => {
    const pair = linuxReadbackPair();
    let stats = 0,
        sockets = 0,
        changed = false;
    const ops = {
        stat: () => ({ dev: 1, ino: changed ? 56 : 55, uid: 1000, isSocket: () => true }),
        socket: () => {
            sockets++;
            changed = true;
            return pair.child;
        },
    };
    const off = createLinuxNativeSetupReadback(
        {
            enabled: false,
            platform: 'linux',
            layout: 'linux-folder',
            packaged: true,
            uid: 1000,
            euid: 1000,
        },
        {
            stat: () => {
                stats++;
                throw Error();
            },
            socket: () => {
                throw Error();
            },
        },
    );
    await off.joinClosure();
    assert.equal(stats, 0);
    const bad = createLinuxNativeSetupReadback(
        {
            enabled: true,
            platform: 'linux',
            layout: 'linux-folder',
            packaged: true,
            uid: 1000,
            euid: 1000,
        },
        ops,
    );
    assert.equal(bad.summary().unknown, true);
    assert.equal(bad.summary().returnedPortOwned, true);
    assert.equal(sockets, 1);
    await assert.rejects(bad.joinClosure(), /CUSTODY_RETAINED/);
    const unsupported = createLinuxNativeSetupReadback(
        {
            enabled: true,
            platform: 'win32',
            layout: 'windows-nsis',
            packaged: true,
            uid: 1000,
            euid: 1000,
        },
        ops,
    );
    assert.equal(unsupported.summary().unknown, true);
    assert.equal(sockets, 1);
    assert.equal(bad.summary().nativeQualified, false);
});
test('stable fake inherited descriptor flows through the concrete native adapter and acknowledged channel join', async () => {
    const f = fixture(),
        record = { ...f.record, observedAtMs: Date.now() },
        pair = linuxReadbackPair();
    let sockets = 0;
    const child = createLinuxNativeSetupReadback(
            {
                enabled: true,
                platform: 'linux',
                layout: 'linux-folder',
                packaged: true,
                uid: 1000,
                euid: 1000,
            },
            {
                stat: () => ({ dev: 1, ino: 55, uid: 1000, isSocket: () => true }),
                socket: () => {
                    sockets++;
                    return pair.child;
                },
            },
        ),
        parent = createLinuxInstallerReadback(pair.parent, f.binding, {
            now: Date.now,
            nonce: () => Buffer.alloc(32, 0xa),
        });
    parent.admit(f.process);
    child.offer(record, async () => ({ ...record, observedAtMs: Date.now() }));
    await pair.pump(() => parent.summary().closed);
    assert.equal(await parent.wait(), true);
    await child.joinClosure();
    assert.equal(child.summary().unknown, false);
    assert.equal(child.summary().nativeQualified, false);
    assert.equal(sockets, 1);
});
