import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createVerifierCustody } from '../scripts/lib/attested-content-custody.mjs';
import { verifyLocalAttestation } from '../scripts/lib/attested-content-verifier.mjs';

const deferred = () => {
    let resolve!: (v?: any) => void, reject!: (e: any) => void;
    const promise = new Promise<any>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
const tick = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
};
function fixture() {
    const calls: any[] = [],
        files = new Map(),
        processes: any[] = [],
        handles: any[] = [],
        timers = new Map(),
        processWaiters = new Map<number, ReturnType<typeof deferred>>();
    let next = 1,
        now = 0;
    const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    function add(path: string, b: string | Buffer, mode = 0o100600) {
        const bytes = Buffer.from(b);
        const stat = {
            dev: 1,
            ino: next++,
            uid: 1000,
            mode,
            nlink: 1,
            size: bytes.length,
            mtimeMs: 1,
            ctimeMs: 1,
            isFile: () => true,
            isSymbolicLink: () => false,
            isDirectory: () => false,
        };
        files.set(path, { bytes, stat });
        return { path, bytes: bytes.length, sha256: hash(bytes) };
    }
    const subject = {
        ...add('/selected/subject', 'opaque synthetic archive'),
        kind: 'archive',
        name: 'archive.tar.gz',
    };
    const bundle = add('/selected/bundle', 'synthetic bundle\n'),
        toolFile = add('/selected/tool', Buffer.from([127, 69, 76, 70, 1]), 0o100700),
        root = add('/selected/root', 'synthetic root\n');
    const request: any = {
        subject,
        bundle,
        tool: { path: toolFile.path, sha256: toolFile.sha256, version: '2.103.3' },
        trustedRoot: root,
        configurationDirectory: '/isolated',
        constraints: {
            repository: 'brucerry/embedded-linux-diagnostic-hub',
            certificateIdentity:
                'https://github.com/brucerry/embedded-linux-diagnostic-hub/.github/workflows/content.yml@refs/heads/reviewed',
            issuer: 'https://token.actions.githubusercontent.com',
            signerDigest: 'a'.repeat(40),
            sourceDigest: 'b'.repeat(40),
            sourceRef: 'refs/heads/reviewed',
            predicateType: 'https://embedded-linux-diagnostic-hub.dev/attestation/content/v1',
        },
    };
    const controls: any = {
        open: null,
        close: null,
        read: null,
        dispatch: null,
        unsubscribe: null,
        automatic: true,
    };
    const filesystem = {
        async realpath(p: string) {
            return p;
        },
        async readdir() {
            return [];
        },
        async lstat(p: string) {
            return p === '/isolated'
                ? {
                      dev: 1,
                      ino: 100,
                      uid: 1000,
                      mode: 0o40700,
                      nlink: 2,
                      size: 0,
                      mtimeMs: 1,
                      ctimeMs: 1,
                      isFile: () => false,
                      isSymbolicLink: () => false,
                      isDirectory: () => true,
                  }
                : { ...files.get(p).stat };
        },
        async open(p: string, flags: number, observer: any) {
            calls.push(['open', p, flags]);
            const item = files.get(p),
                entry: any = { observer, handle: null };
            const handle = {
                async stat() {
                    return { ...item.stat };
                },
                async read(buffer: Buffer, offset: number, length: number, position: number) {
                    if (controls.read) await controls.read(entry);
                    const count = Math.min(length, item.bytes.length - position);
                    item.bytes.copy(buffer, offset, position, position + count);
                    return { bytesRead: count };
                },
                async close() {
                    calls.push(['close', p]);
                    if (controls.close) return controls.close(entry);
                },
            };
            entry.handle = handle;
            handles.push(entry);
            if (controls.open) await controls.open(entry);
            return handle;
        },
    };
    const clock = {
        now: () => now,
        set(fn: any, ms: number) {
            const id = next++;
            timers.set(id, { fn, ms });
            return id;
        },
        clear(id: number) {
            timers.delete(id);
        },
    };
    function normal(p: any, code = 0) {
        const s = p.sink;
        s.spawned();
        s.data(
            'stdout',
            Buffer.from(
                p.command.args[0] === '--version'
                    ? 'gh version 2.103.3\n'
                    : '[{"verificationResult":{"synthetic":true}}]\n',
            ),
        );
        s.streamClosed('stdout');
        s.streamClosed('stderr');
        s.exited(code, null);
        s.closed(code, null);
        p.group({ pid: p.pid, disposition: 'normal', remaining: 0 });
    }
    const ports: any = {
        filesystem,
        clock,
        uid: 1000,
        platform: 'linux',
        observeGroupRetirement(reference: any, callback: any) {
            const p = processes.find((p) => p.reference === reference);
            p.group = callback;
            return () => (controls.unsubscribe ? controls.unsubscribe(p) : undefined);
        },
        dispatch(command: any, sink: any) {
            const p: any = { command, sink, reference: {}, pid: 123 + processes.length };
            processes.push(p);
            sink.adopt(p.reference, p.pid);
            processWaiters.get(processes.length - 1)?.resolve(p);
            if (controls.dispatch) return controls.dispatch(p);
            if (controls.automatic) normal(p);
        },
    };
    return {
        owner: createVerifierCustody(ports),
        request,
        calls,
        files,
        processes,
        handles,
        controls,
        timers,
        ports,
        normal,
        waitForProcess(index = 0) {
            if (processes[index]) return Promise.resolve(processes[index]);
            const d = deferred();
            processWaiters.set(index, d);
            return d.promise;
        },
        advance(ms: number) {
            now += ms;
            for (const [id, t] of [...timers])
                if (t.ms <= ms) {
                    timers.delete(id);
                    t.fn();
                }
        },
    };
}
async function held(owner: any, attempt: any) {
    await tick();
    assert.equal(owner.snapshot().blocked, true);
    assert.throws(() => owner.begin({}), /custody still held/);
    let retired = false;
    attempt.retirement.then(() => (retired = true));
    await tick();
    assert.equal(retired, false);
}

test('actual verifier completes two acknowledged commands and all 12 descriptor closes', async () => {
    const f = fixture(),
        a = f.owner.begin(f.request);
    const r = await a.completion;
    assert.equal(r.status, 'completed-model-only');
    assert.equal(r.value.verificationResults.length, 1);
    assert.equal((await a.retirement).retirementProven, false);
    assert.equal(f.processes.length, 2);
    assert.equal(f.handles.length, 12);
    assert.equal(f.calls.filter((c) => c[0] === 'close').length, 12);
    assert.equal(f.timers.size, 0);
    assert.equal(f.owner.snapshot().blocked, false);
});
test('held open is fenced before acquisition; cancellation waits then closes without dispatch', async () => {
    const f = fixture(),
        d = deferred();
    f.controls.open = () => d.promise;
    const a = f.owner.begin(f.request);
    await held(f.owner, a);
    a.cancel();
    assert.equal((await a.completion).status, 'failed');
    await held(f.owner, a);
    d.resolve();
    await a.retirement;
    assert.equal(f.processes.length, 0);
    assert.equal(f.calls.filter((c) => c[0] === 'close').length, 1);
});
test('open rejection remains unknown until exact no-acquisition callback', async () => {
    const f = fixture(),
        error = Error('open primary');
    f.controls.open = () => {
        throw error;
    };
    const a = f.owner.begin(f.request);
    assert.equal((await a.completion).error, error);
    await held(f.owner, a);
    assert.equal(f.handles[0].observer.notAcquired(), true);
    await a.retirement;
    assert.equal(f.owner.snapshot().blocked, false);
});
test('no-acquisition followed by acquired handle cannot release custody', async () => {
    const f = fixture();
    f.controls.open = (e: any) => e.observer.notAcquired();
    const a = f.owner.begin(f.request);
    assert.match((await a.completion).error.message, /Contradictory/);
    await held(f.owner, a);
    assert.equal(a.snapshot().filesHeld, 1);
});
test('held close retains descriptor even if close event arrives before promise acknowledgement', async () => {
    const f = fixture(),
        d = deferred();
    f.controls.close = () => d.promise;
    const a = f.owner.begin(f.request);
    await held(f.owner, a);
    const h = f.handles[0];
    assert.equal(h.observer.closed(h.handle), true);
    await held(f.owner, a);
    d.resolve();
    await a.completion;
    await a.retirement;
    assert.equal(f.owner.snapshot().blocked, false);
});
test('rejected close preserves original error and exact later closure can retire without retry', async () => {
    const f = fixture(),
        error = Error('close primary');
    f.controls.close = () => Promise.reject(error);
    const a = f.owner.begin(f.request);
    assert.equal((await a.completion).error, error);
    await held(f.owner, a);
    const h = f.handles[0];
    assert.equal(h.observer.closed({}), false);
    await held(f.owner, a);
    h.observer.closed(h.handle);
    await a.retirement;
    assert.equal(f.calls.filter((c) => c[0] === 'close').length, 1);
});
test('read primary and close rejection both survive; closed handle does not replay reads or commands', async () => {
    const f = fixture(),
        primary = Error('read primary'),
        cleanup = Error('close cleanup');
    f.controls.read = () => {
        throw primary;
    };
    f.controls.close = () => {
        throw cleanup;
    };
    const a = f.owner.begin(f.request);
    const r = await a.completion;
    await held(f.owner, a);
    assert.equal(r.error, primary);
    assert.ok(a.diagnostics().some((error: unknown) => error === cleanup));
    const h = f.handles[0];
    h.observer.closed(h.handle);
    await a.retirement;
    assert.equal(f.processes.length, 0);
});
test('stale file callback cannot retire a replacement owner', async () => {
    const f = fixture(),
        first = f.owner.begin(f.request);
    await first.retirement;
    const old = f.handles[0];
    f.controls.close = () => new Promise(() => {});
    const next = f.owner.begin(f.request);
    await held(f.owner, next);
    assert.equal(old.observer.closed(old.handle), false);
    await held(f.owner, next);
});
for (const missing of ['group', 'stdout', 'stderr', 'exit', 'close'])
    test(
        'process settlement does not replace missing ' + missing + ' acknowledgement',
        async () => {
            const f = fixture();
            f.controls.automatic = false;
            const a = f.owner.begin(f.request);
            await f.waitForProcess();
            const p = f.processes[0],
                s = p.sink;
            s.spawned();
            s.data('stdout', Buffer.from('gh version 2.103.3\n'));
            if (missing !== 'stdout') s.streamClosed('stdout');
            if (missing !== 'stderr') s.streamClosed('stderr');
            if (missing !== 'exit') s.exited(0, null);
            if (missing !== 'close') s.closed(0, null);
            await held(f.owner, a);
            assert.equal(f.processes.length, 1);
            f.controls.automatic = true;
            if (missing === 'stdout' || missing === 'stderr') s.streamClosed(missing);
            if (missing === 'exit') s.exited(0, null);
            if (missing === 'close') s.closed(0, null);
            p.group({ pid: p.pid, disposition: 'normal', remaining: 0 });
            assert.equal((await a.completion).status, 'completed-model-only');
            await a.retirement;
        },
    );
test('dispatch acknowledgement held after normal lifecycle prevents next command and retirement', async () => {
    const f = fixture(),
        d = deferred();
    f.controls.dispatch = (p: any) => {
        f.normal(p);
        return d.promise;
    };
    const a = f.owner.begin(f.request);
    await held(f.owner, a);
    assert.equal(f.processes.length, 1);
    f.controls.dispatch = null;
    d.resolve();
    assert.equal((await a.completion).status, 'completed-model-only');
    await a.retirement;
});
test('rejected dispatch after adoption retains child until observed lifecycle joins original rejection', async () => {
    const f = fixture(),
        error = Error('dispatch primary');
    f.controls.dispatch = () => {
        throw error;
    };
    const a = f.owner.begin(f.request);
    assert.equal((await a.completion).error, error);
    await held(f.owner, a);
    f.normal(f.processes[0]);
    await a.retirement;
    assert.equal(f.processes.length, 1);
});
test('unknown dispatch failure without adoption remains held until explicit not-started', async () => {
    const f = fixture(),
        error = Error('unknown start');
    f.ports.dispatch = () => {};
    const ports = {
        ...f.ports,
        dispatch(_c: any, s: any) {
            f.processes.push({ sink: s });
            throw error;
        },
    };
    const owner = createVerifierCustody(ports),
        a = owner.begin(f.request);
    assert.equal((await a.completion).error, error);
    await held(owner, a);
    f.processes[0].sink.notStarted();
    await a.retirement;
});
for (const witness of [
    { pid: 999, disposition: 'normal', remaining: 0 },
    { pid: 123, disposition: 'forced', remaining: 0 },
    { pid: 123, disposition: 'normal', remaining: 1 },
    { pid: 123, disposition: 'normal', remaining: 0, hash: 'opaque' },
])
    test(
        'invalid independent group witness fails and holds ' + JSON.stringify(witness),
        async () => {
            const f = fixture();
            f.controls.automatic = false;
            const a = f.owner.begin(f.request);
            await f.waitForProcess();
            const p = f.processes[0];
            assert.equal(p.group(witness), false);
            assert.equal((await a.completion).status, 'failed');
            await held(f.owner, a);
        },
    );
test('nonzero process failure can retire after acknowledged unforced closure without trapping forever', async () => {
    const f = fixture();
    f.controls.dispatch = (p: any) => f.normal(p, 7);
    const a = f.owner.begin(f.request);
    assert.equal((await a.completion).status, 'failed');
    await a.retirement;
    assert.equal(f.owner.snapshot().blocked, false);
    assert.equal(f.processes.length, 1);
});
test('held observer unsubscribe blocks retirement and next command', async () => {
    const f = fixture(),
        d = deferred();
    f.controls.unsubscribe = () => d.promise;
    const a = f.owner.begin(f.request);
    await held(f.owner, a);
    assert.equal(f.processes.length, 1);
    f.controls.unsubscribe = null;
    d.resolve();
    assert.equal((await a.completion).status, 'completed-model-only');
    await a.retirement;
});
test('rejected observer unsubscribe retains custody and primary error; no disposal retry', async () => {
    const f = fixture();
    let count = 0;
    const error = Error('observer cleanup');
    f.controls.unsubscribe = () => {
        count++;
        throw error;
    };
    const a = f.owner.begin(f.request);
    assert.equal((await a.completion).error, error);
    await held(f.owner, a);
    f.normal(f.processes[0]);
    await held(f.owner, a);
    assert.equal(count, 1);
});
for (const ms of [30000, 35000, 180000])
    test('deadline ' + ms + ' fails honestly without signals, release or replay', async () => {
        const f = fixture();
        f.controls.automatic = false;
        const a = f.owner.begin(f.request);
        await f.waitForProcess();
        f.advance(ms);
        assert.equal((await a.completion).status, 'failed');
        await held(f.owner, a);
        f.normal(f.processes[0]);
        await a.retirement;
        assert.equal(f.processes.length, 1);
    });
test('late old process/group callbacks cannot affect a replacement owner', async () => {
    const f = fixture(),
        a = f.owner.begin(f.request);
    await a.retirement;
    const old = f.processes[0];
    f.controls.automatic = false;
    const b = f.owner.begin(f.request);
    await f.waitForProcess(2);
    await held(f.owner, b);
    assert.equal(old.group({ pid: old.pid, disposition: 'normal', remaining: 0 }), false);
    assert.equal(old.sink.failed(Error('stale')), false);
    assert.equal(b.snapshot().status, 'running-custody-held');
    b.cancel();
    f.normal(f.processes[2]);
    await b.retirement;
});
test('cancel does not signal or admit a replacement while process/group retirement pending', async () => {
    const f = fixture();
    f.controls.automatic = false;
    const a = f.owner.begin(f.request);
    await f.waitForProcess();
    a.cancel();
    assert.equal((await a.completion).status, 'failed');
    await held(f.owner, a);
    f.normal(f.processes[0]);
    await a.retirement;
    assert.equal(f.processes.length, 1);
});
test('output overflow drains without retaining extra bytes and keeps ownership until retirement', async () => {
    const f = fixture();
    f.controls.automatic = false;
    const a = f.owner.begin(f.request);
    await f.waitForProcess();
    const p = f.processes[0];
    p.sink.data('stdout', Buffer.alloc(4097));
    assert.equal((await a.completion).status, 'failed');
    await held(f.owner, a);
    f.normal(p);
    await a.retirement;
    assert.equal(f.processes.length, 1);
});
test('ordinary policy entry remains blocked before touching acquired data or ports', async () => {
    await assert.rejects(verifyLocalAttestation({}), /Live verifier blocked/);
    assert.throws(() => createVerifierCustody({} as any));
});

for (const pattern of ['absent-then-adopt', 'duplicate-adopt'])
    test('contradictory adoption cannot release process custody: ' + pattern, async () => {
        const f = fixture();
        let sink: any;
        const ports = {
            ...f.ports,
            dispatch(_command: any, s: any) {
                sink = s;
                if (pattern === 'absent-then-adopt') s.notStarted();
                else {
                    const p: any = { reference: {}, pid: 123 };
                    f.processes.push(p);
                    s.adopt(p.reference, 123);
                }
                assert.equal(s.adopt({}, 124), false);
            },
        };
        const owner = createVerifierCustody(ports),
            a = owner.begin(f.request);
        assert.equal((await a.completion).status, 'failed');
        await held(owner, a);
        sink.notStarted();
        await held(owner, a);
        assert.equal(a.snapshot().processesHeld, 1);
    });
for (const before of [false, true])
    test(
        'forced group contradiction stays blocked despite later normal witness: priorNormal=' +
            before,
        async () => {
            const f = fixture(),
                d = deferred();
            f.controls.automatic = false;
            f.controls.unsubscribe = () => d.promise;
            const a = f.owner.begin(f.request),
                p = await f.waitForProcess(),
                s = p.sink;
            s.spawned();
            s.streamClosed('stdout');
            s.streamClosed('stderr');
            s.exited(0, null);
            s.closed(0, null);
            if (before) p.group({ pid: p.pid, disposition: 'normal', remaining: 0 });
            assert.equal(p.group({ pid: p.pid, disposition: 'forced', remaining: 0 }), false);
            assert.equal(p.group({ pid: p.pid, disposition: 'normal', remaining: 0 }), false);
            d.resolve();
            assert.equal((await a.completion).status, 'failed');
            await held(f.owner, a);
        },
    );
test('premature group witness cannot later become a normal retirement proof', async () => {
    const f = fixture();
    f.controls.automatic = false;
    const a = f.owner.begin(f.request),
        p = await f.waitForProcess();
    assert.equal(p.group({ pid: p.pid, disposition: 'normal', remaining: 0 }), false);
    f.normal(p);
    assert.equal((await a.completion).status, 'failed');
    await held(f.owner, a);
});
test('empty and one-byte callbacks use bounded coalesced storage and preserve exact output', async () => {
    const f = fixture();
    f.controls.automatic = false;
    const a = f.owner.begin(f.request),
        p = await f.waitForProcess(),
        s = p.sink;
    s.spawned();
    for (let i = 0; i < 1000; i++) s.data('stdout', Buffer.alloc(0));
    assert.equal(a.snapshot().stdoutBufferBlocks, 0);
    const version = Buffer.from('gh version 2.103.3\n');
    for (const byte of version) s.data('stdout', Buffer.from([byte]));
    assert.equal(a.snapshot().stdoutBufferBlocks, 1);
    assert.equal(a.snapshot().stdoutBufferedBytes, version.length);
    f.controls.automatic = true;
    s.streamClosed('stdout');
    s.streamClosed('stderr');
    s.exited(0, null);
    s.closed(0, null);
    p.group({ pid: p.pid, disposition: 'normal', remaining: 0 });
    assert.equal((await a.completion).status, 'completed-model-only');
    await a.retirement;
});
test('known pre-dispatch clock refusal retires without inventing unknown process acquisition', async () => {
    const f = fixture(),
        set = f.ports.clock.set;
    let dispatches = 0;
    f.ports.clock.set = (fn: any, ms: number) => {
        if (ms === 30000) f.ports.clock.now = () => -1;
        return set(fn, ms);
    };
    const owner = createVerifierCustody({
            ...f.ports,
            dispatch() {
                dispatches++;
            },
        }),
        a = owner.begin(f.request);
    assert.equal((await a.completion).status, 'failed');
    await a.retirement;
    assert.equal(dispatches, 0);
    assert.equal(owner.snapshot().blocked, false);
});
test('held read cancellation retains the call, then closes its file without command replay', async () => {
    const f = fixture(),
        d = deferred();
    f.controls.read = () => d.promise;
    const a = f.owner.begin(f.request);
    await held(f.owner, a);
    a.cancel();
    await a.completion;
    await held(f.owner, a);
    d.resolve();
    await a.retirement;
    assert.equal(f.calls.filter((c) => c[0] === 'close').length, 1);
    assert.equal(f.processes.length, 0);
});
for (const kind of ['async-set', 'async-clear'])
    test('unsupported clock lifecycle stays fenced: ' + kind, async () => {
        const f = fixture();
        if (kind === 'async-set') f.ports.clock.set = () => Promise.resolve(99);
        else f.ports.clock.clear = () => Promise.resolve();
        const owner = createVerifierCustody(f.ports),
            a = owner.begin(f.request);
        assert.equal((await a.completion).status, 'failed');
        await held(owner, a);
        assert.equal(a.snapshot().clockCustodyUnknown, true);
    });
