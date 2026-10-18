import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
    EvidenceBudget,
    ProbeJournal,
    runProbeOwner,
    probeLimits,
    cleanupUnstartedProbe,
    validateProbeClient,
    validatePeerAck,
} from '../scripts/nonproduct-lifecycle-probe.mjs';
import { observeOwnedChild, requireObservedClosure } from '../scripts/lib/owned-child.mjs';

class Clock {
    time = 0;
    next = 0;
    timers = new Map<number, { due: number; fn: () => void }>();
    now = () => this.time;
    set = (fn: () => void, ms: number) => {
        const id = ++this.next;
        this.timers.set(id, { due: this.time + ms, fn });
        return id;
    };
    clear = (id: number) => {
        this.timers.delete(id);
    };
    async advance(ms: number) {
        const end = this.time + ms;
        for (;;) {
            for (let i = 0; i < 20; i++) await Promise.resolve();
            const next = [...this.timers]
                .filter(([, t]) => t.due <= end)
                .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
            if (!next) break;
            this.time = next[1].due;
            this.timers.delete(next[0]);
            next[1].fn();
        }
        this.time = end;
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }
}
function journal(
    options: {
        invalidWrite?: number;
        writeThrows?: boolean;
        syncThrows?: boolean;
        closeThrows?: boolean;
    } = {},
) {
    const chunks: Buffer[] = [];
    let closes = 0,
        writes = 0,
        syncs = 0;
    const io = {
        write(bytes: Uint8Array, offset: number, length: number) {
            writes++;
            if (options.writeThrows) throw Error('write failed');
            if (options.invalidWrite !== undefined) return options.invalidWrite;
            const size = Math.min(17, length);
            chunks.push(Buffer.from(bytes.subarray(offset, offset + size)));
            return size;
        },
        sync() {
            syncs++;
            if (options.syncThrows) throw Error('fsync failed');
        },
        close() {
            closes++;
            if (options.closeThrows) throw Error('close failed');
        },
    };
    const budget = new EvidenceBudget(),
        value = new ProbeJournal(io, budget);
    return { value, budget, chunks, counts: () => ({ closes, writes, syncs }) };
}
function fixture(mode = 'normal') {
    const clock = new Clock(),
        j = journal(
            mode === 'journal-write'
                ? { writeThrows: true }
                : mode === 'journal-sync'
                  ? { syncThrows: true }
                  : mode === 'journal-close'
                    ? { closeThrows: true }
                    : {},
        ),
        children: any[] = [],
        kills: any[] = [];
    let releases = 0;
    for (const bytes of probeLimits.reservations) j.budget.reserve(bytes);
    const spawnChild = (role: string, nonce: string) => {
        if (mode === 'second-spawn-throws' && children.length === 1) throw Error('spawn EAGAIN');
        const child: any = Object.assign(new EventEmitter(), { pid: 40 + children.length });
        children.push(child);
        let dead = false;
        const close = (code = 0, signal: string | null = null) => {
            if (dead) return;
            dead = true;
            child.emit('disconnect');
            child.emit('exit', code, signal);
            if (!(mode === 'missing-close' && role === 'work')) child.emit('close', code, signal);
        };
        const message = (kind: string, seq: number) => {
            if (!dead)
                child.emit('message', {
                    kind,
                    seq,
                    role,
                    pid: child.pid,
                    nonce: mode === 'bad-nonce' ? 'foreign' : nonce,
                });
        };
        child.kill = (signal: string) => {
            kills.push({ pid: child.pid, signal });
            if (mode === 'never-close') return false;
            clock.set(() => close(1, signal), 0);
            return true;
        };
        child.send = (ack: any, callback: (error?: Error) => void) => {
            if (mode === 'send-throws') throw Error('send failed');
            clock.set(() => {
                callback(mode === 'send-rejects' ? Error('callback failed') : undefined);
                if (mode === 'send-rejects' || dead) return;
                if (ack.seq === 0) {
                    if (role === 'observer') clock.set(() => message('unsubscribe', 1), 100);
                    else
                        for (let i = 1; i <= 4; i++)
                            clock.set(() => message(i === 4 ? 'done' : 'progress', i), i * 600);
                } else if (role === 'observer' || ack.seq === 4) {
                    if (mode !== 'never-close') clock.set(() => close(), 0);
                }
            }, 0);
        };
        clock.set(() => {
            child.emit('spawn');
            message('ready', 0);
            if (mode === 'duplicate') message('ready', 0);
        }, 0);
        return child;
    };
    const run = runProbeOwner({
        spawnChild,
        clock: clock as any,
        journal: j.value,
        lease: {
            release() {
                if (mode === 'foreign-marker') throw Error('Foreign marker changed');
                releases++;
            },
        },
        nonce: 'fixture-run',
        commitClosure: () => {
            if (mode === 'closure-rejects') throw Error('closure receipt failed');
            return true;
        },
        inputs: { fixtureOnly: true },
        started: 0,
    });
    return { run, clock, j, children, kills, releases: () => releases };
}

test('virtual two-role owner preserves work after observer disconnect and joins actual exit/close', async () => {
    const f = fixture();
    await f.clock.advance(3000);
    const result = await f.run;
    assert.equal(result.status, 'PASS_NARROW');
    assert.equal(f.children.length, 2);
    assert.ok(result.observerDisconnectedAt! < result.workExitedAt!);
    assert.deepEqual(result.sequences, { work: 5, observer: 2 });
    assert.equal(f.releases(), 1);
    assert.equal(f.j.value.closed, true);
    assert.equal(f.kills.length, 0);
    assert.ok(f.j.budget.bytes < probeLimits.bytes && f.j.budget.records < probeLimits.records);
    assert.ok(
        result.outcomes.every(
            (row: any) => row.exitObserved && row.closeObserved && row.code === 0,
        ),
    );
    // No real fork, process census, product import, memory sample or canonical marker mutation.
});
test('bad identities, duplicate messages, spawn/send failures and foreign marker never pass or retry', async () => {
    for (const mode of [
        'bad-nonce',
        'duplicate',
        'second-spawn-throws',
        'send-throws',
        'send-rejects',
        'foreign-marker',
        'closure-rejects',
    ]) {
        const f = fixture(mode);
        await f.clock.advance(8000);
        const result = await f.run;
        assert.notEqual(result.status, 'PASS_NARROW', mode);
        assert.ok(f.children.length <= 2);
        assert.ok(result.elapsedMs <= 8000);
        if (mode === 'foreign-marker') {
            assert.equal(f.releases(), 0);
            assert.equal(result.markerReleased, false);
        } else assert.ok(f.kills.every((k) => f.children.some((c) => c.pid === k.pid)));
        if (mode === 'second-spawn-throws') {
            assert.equal(result.status, 'INVALID');
            assert.equal(result.spawnUncertain, true);
            assert.equal(f.releases(), 0);
        }
        if (mode === 'closure-rejects') {
            assert.equal(result.status, 'INVALID');
            assert.equal(f.releases(), 0);
            assert.equal(result.closureReceiptClosed, false);
        }
    }
});
test('missing close and failed termination retain uncertainty and lease within fixed virtual deadline', async () => {
    for (const mode of ['missing-close', 'never-close']) {
        const f = fixture(mode);
        await f.clock.advance(8000);
        const result = await f.run;
        assert.equal(result.status, 'INVALID');
        assert.equal(f.releases(), 0);
        assert.ok(result.outcomes.some((x: any) => !x.closeObserved));
        assert.equal(result.elapsedMs, 8000);
        assert.equal(f.clock.timers.size, 0);
    }
});
test('leaf exit is insufficient: close is required; failed spawn preserves error without invented exit', async () => {
    const clock = new Clock(),
        child: any = Object.assign(new EventEmitter(), { pid: 42, kill: () => false });
    const watched = observeOwnedChild(child, { totalMs: 100, reserveMs: 20, clock: clock as any });
    child.emit('spawn');
    child.emit('exit', 0, null);
    let completed = false;
    void watched.outcome.then(() => {
        completed = true;
    });
    await clock.advance(50);
    assert.equal(completed, false);
    child.emit('close', 0, null);
    const row = await watched.outcome;
    requireObservedClosure(row);
    const missing: any = new EventEmitter();
    missing.kill = () => assert.fail('No PID to kill');
    const failed = observeOwnedChild(missing, { totalMs: 100, reserveMs: 20, clock: clock as any });
    missing.emit('error', Error('ENOENT'));
    missing.emit('close', -1, null);
    const outcome = await failed.outcome;
    assert.equal(outcome.exitObserved, false);
    assert.equal(outcome.closeObserved, true);
    assert.throws(() => requireObservedClosure(outcome));
});
test('journal joins short writes and fsync/close, rejects invalid progress, errors and global caps', () => {
    const j = journal();
    j.value.append('λ', { text: '🔬' });
    j.value.close();
    assert.equal(JSON.parse(Buffer.concat(j.chunks).toString()).event, 'λ');
    assert.ok(j.counts().writes > 1 && j.counts().syncs === 2 && j.counts().closes === 1);
    assert.throws(() => j.value.append('late', {}));
    for (const invalidWrite of [0, -1, 0.5, Infinity, 99999]) {
        const bad = journal({ invalidWrite });
        assert.throws(() => bad.value.append('bad', {}));
        assert.equal(bad.value.failed, true);
    }
    assert.throws(() => journal({ writeThrows: true }).value.append('bad', {}));
    const sync = journal({ syncThrows: true });
    assert.throws(() => sync.value.append('bad', {}));
    assert.throws(() => sync.value.close());
    assert.equal(sync.value.closed, true);
    const close = journal({ closeThrows: true });
    assert.throws(() => close.value.close());
    assert.equal(close.value.closed, false);
    const budget = new EvidenceBudget();
    for (let i = 0; i < 32; i++) budget.reserve(0);
    assert.throws(() => budget.reserve(0));
    assert.throws(() => new EvidenceBudget().reserve(16385));
});
test('controller joins journal failure cleanup; pre-spawn failures release only a verifiably closed own lease', async () => {
    for (const mode of ['journal-write', 'journal-sync', 'journal-close']) {
        const f = fixture(mode);
        await f.clock.advance(8000);
        const row = await f.run;
        assert.notEqual(row.status, 'PASS_NARROW');
        assert.equal(row.journalDurable, false);
        if (mode === 'journal-close') {
            assert.equal(row.status, 'INVALID');
            assert.equal(f.releases(), 0);
        } else {
            assert.equal(f.children.length, 0);
            assert.equal(f.releases(), 1);
        }
        assert.equal(f.clock.timers.size, 0);
    }
    for (const option of [{}, { syncThrows: true }, { closeThrows: true }]) {
        const j = journal(option);
        let releases = 0;
        const row = cleanupUnstartedProbe(j.value, {
            release: () => {
                releases++;
            },
        });
        assert.equal(releases, option.closeThrows ? 0 : 1);
        assert.equal(row.markerReleased, releases === 1);
    }
    const foreign = cleanupUnstartedProbe(undefined, {
        release: () => {
            throw Error('foreign token');
        },
    });
    assert.equal(foreign.markerReleased, false);
    assert.equal(foreign.errors.length, 1);
});
test('peer acknowledgements and yielded client completion require matching nonce, sequence and owner evidence', async () => {
    const ack = { kind: 'ack', nonce: 'n', role: 'work', seq: 1 };
    validatePeerAck(ack, 'n', 'work', 1);
    for (const bad of [
        { ...ack, nonce: 'foreign' },
        { ...ack, seq: 0 },
        { ...ack, role: 'observer' },
        { ...ack, extra: true },
        {},
    ])
        assert.throws(() => validatePeerAck(bad, 'n', 'work', 1));
    const f = fixture();
    await f.clock.advance(3000);
    const result = await f.run;
    const owner = {
        ...result,
        status: 'OWNER_COMPLETE_PENDING_CLIENT',
        ownerVerdict: result.status,
        ownerPID: 10,
    };
    const yielded = {
        phase: 'yield',
        state: 'running',
        nonce: owner.nonce,
        ownerPID: 10,
        sessionId: 'fixture-session',
        exitCode: null,
    };
    const resumed = { ...yielded, phase: 'resume', state: 'completed', exitCode: 0 };
    assert.equal(validateProbeClient(owner, yielded, resumed).status, 'PASS_NARROW');
    for (const bad of [
        { ...resumed, nonce: 'foreign' },
        { ...resumed, ownerPID: 11 },
        { ...resumed, sessionId: 'other' },
        { ...resumed, exitCode: 1 },
    ])
        assert.throws(() => validateProbeClient(owner, yielded, bad));
    assert.throws(() => validateProbeClient({ ...owner, markerReleased: false }, yielded, resumed));
    assert.throws(() => validateProbeClient({ ...owner, outcomes: [] }, yielded, resumed));
});
