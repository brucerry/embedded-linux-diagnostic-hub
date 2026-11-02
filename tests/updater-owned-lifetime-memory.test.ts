import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open as selectedOpen } from 'node:fs/promises';
import { open as memoryOpen, scope, type State } from './fixtures/update-owned-memory';
import { UpdateOwnership } from '../electron/update-ownership';
import { publishUpdateFile, hashUpdateFile } from '../electron/update-owned-file';
import { ReleaseUpdater } from '../electron/updates';
import { UpdateReports } from '../electron/update-reports';
import { UpdateReceipts } from '../electron/update-receipt';
import { UpdateCoordinator } from '../electron/update-coordinator';
import { createQuitController, runQuitCleanup } from '../shared/quit-cleanup';
const memoryOnly = selectedOpen === memoryOpen;
const options = { skip: memoryOnly ? false : 'Requires audited memory filesystem aliases' };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const rounds = async () => { for (let i = 0; i < 48; i++) await Promise.resolve(); };
const bytes = Buffer.from('MZsynthetic-portable-bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const root = 'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v0.2.0/';
function body(data: Uint8Array, controls: { read?: Promise<void>; cancel?: Promise<void>; cancelError?: unknown; releaseError?: unknown } = {}) {
    let read = false; const events: string[] = [];
    const reader = {
        async read() { events.push('read'); await controls.read; if (read) return { done: true }; read = true; return { done: false, value: data }; },
        async cancel() { events.push('cancel'); await controls.cancel; if (controls.cancelError) throw controls.cancelError; },
        releaseLock() { events.push('release'); if (controls.releaseError) throw controls.releaseError; },
    };
    return { events, body: { getReader: () => reader, cancel: reader.cancel } };
}
async function updater(s: State, owner: UpdateOwnership, payload?: ReturnType<typeof body>) {
    const request: typeof fetch = async input => {
        const url = String(input);
        if (url.startsWith('https://api.github.com/')) {
            assert.equal(url, 'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/releases?per_page=100');
            return { ok: true, body: body(Buffer.from(JSON.stringify([{ tag_name: 'v0.2.0', assets: [
                { name: 'Diagnostic-Hub.exe', size: bytes.length, browser_download_url: root + 'Diagnostic-Hub.exe' },
                { name: 'Diagnostic-Hub.exe.sha256', size: 100, browser_download_url: root + 'Diagnostic-Hub.exe.sha256' },
            ] }]))).body } as unknown as Response;
        }
        assert.ok([root + 'Diagnostic-Hub.exe', root + 'Diagnostic-Hub.exe.sha256'].includes(url));
        return { ok: true, body: url.endsWith('.sha256') ? body(Buffer.from(hash + '  Diagnostic-Hub.exe\n')).body : (payload ?? body(bytes)).body } as unknown as Response;
    };
    const u = new ReleaseUpdater('0.1.0', '/memory/updates', 'win32', 'x64', true, request, 'portable', owner);
    await owner.start(() => u.check(false)); return u;
}
async function within(run: (s: State) => Promise<void>) {
    assert.ok(memoryOnly, 'Never construct updater without memory aliases'); const s = scope();
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')!;
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: () => new AbortController().signal });
    try { await run(s); } finally { Object.defineProperty(AbortSignal, 'timeout', descriptor); }
}
const errors = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(errors) : [error];

test('owned task failure retires only acknowledged resources; stale lease cannot release a replacement', options, () => within(async () => {
    const owner = new UpdateOwnership(); const old = owner.hold('old', {}); old.acknowledge();
    const lease = owner.hold('current', {}); old.acknowledge(); assert.equal(owner.held, true);
    lease.acknowledge(); const failure = Error('work'); await assert.rejects(owner.start(async () => { throw failure; }), e => e === failure);
    await owner.shutdown(); assert.equal(owner.active, false); assert.throws(() => owner.start(async () => {}), /shutting down/);
}));
test('successful actual updater closes body/write/read custody before normal quit', options, () => within(async s => {
    const owner = new UpdateOwnership(); const u = await updater(s, owner);
    await owner.start(async () => { await u.download(); await u.executable(); });
    await owner.shutdown(); assert.equal(owner.active, false); assert.equal(s.handles.size, 0);
    assert.equal(owner.snapshot().publications.payload, 'published');
}));
test('pending payload close holds quit and admission until the same close acknowledgement', options, () => within(async s => {
    const owner = new UpdateOwnership(); const u = await updater(s, owner); const close = gate(); s.gates['close:wx'] = close.promise;
    const task = owner.start(() => u.download()); await rounds(); assert.equal(s.handles.size, 1);
    let retired = false; const quit = owner.shutdown().then(() => { retired = true; }); await rounds();
    assert.equal(retired, false); assert.throws(() => owner.start(async () => {}), /shutting down/);
    close.resolve(); await task; await quit; assert.equal(s.handles.size, 0);
}));
test('write failure plus rejected close/removal keeps primary and both cleanup errors with custody', options, () => within(async s => {
    const owner = new UpdateOwnership(); const u = await updater(s, owner); const write = Error('write'), close = Error('close'), remove = Error('remove');
    s.faults.write = write; s.faults['close:wx'] = close; s.faults.rm = remove;
    await assert.rejects(owner.start(() => u.download()), e => { assert.deepEqual(errors(e), [write, close, remove]); return true; });
    assert.equal(owner.snapshot().primary, write); assert.equal(s.handles.size, 1); assert.equal(owner.held, true);
    let retired = false; void owner.shutdown().then(() => { retired = true; }); await rounds(); assert.equal(retired, false);
}));
test('fully acknowledged write failure preserves error and allows explicit retry', options, () => within(async s => {
    const owner = new UpdateOwnership(); const u = await updater(s, owner); const failure = Error('write'); s.faults.write = failure;
    await assert.rejects(owner.start(() => u.download()), e => e === failure); assert.equal(owner.active, false); assert.equal(s.handles.size, 0);
    delete s.faults.write; await owner.start(() => u.download()); assert.equal(owner.active, false);
}));
test('HTTP error body cancellation is joined; rejected cancellation retains response custody', options, () => within(async () => {
    const owner = new UpdateOwnership(), cancel = gate(), failure = Error('cancel'); const response = body(Buffer.alloc(0), { cancel: cancel.promise, cancelError: failure });
    const u = new ReleaseUpdater('0.1.0', '/memory/updates', 'win32', 'x64', true, async () => ({ ok: false, status: 503, body: response.body }) as unknown as Response, 'portable', owner);
    const task = owner.start(() => u.check(false)); await rounds(); assert.deepEqual(response.events, ['cancel']);
    let retired = false; void owner.shutdown().then(() => { retired = true; }); await rounds(); assert.equal(retired, false);
    cancel.resolve(); await assert.rejects(task, e => { assert.match(String(errors(e)[0]), /503/); assert.equal(errors(e)[1], failure); return true; });
    await rounds(); assert.equal(retired, false); assert.match(owner.describe(), /cancel/);
}));
test('early payload failure cancels reader before descriptor retirement and preserves cancellation failure', options, () => within(async s => {
    const owner = new UpdateOwnership(), failure = Error('write'), cancel = Error('cancel');
    const response = body(bytes, { cancelError: cancel }); const u = await updater(s, owner, response); s.faults.write = failure;
    await assert.rejects(owner.start(() => u.download()), e => { assert.deepEqual(errors(e), [failure, cancel]); return true; });
    assert.deepEqual(response.events, ['read', 'cancel', 'release']); assert.equal(s.handles.size, 0); assert.equal(owner.held, true);
}));
test('reader release failure remains owned after successful EOF', options, () => within(async s => {
    const owner = new UpdateOwnership(), failure = Error('release'); const u = await updater(s, owner, body(bytes, { releaseError: failure }));
    await assert.rejects(owner.start(() => u.download()), e => e === failure); assert.equal(owner.held, true); assert.equal(s.handles.size, 0);
}));
test('verification read failure closes descriptor; close failure stays independently held', options, () => within(async s => {
    const owner = new UpdateOwnership(); s.files.set('/memory/file', bytes); const failure = Error('read'), close = Error('close');
    s.faults.read = failure; s.faults['close:r'] = close;
    await assert.rejects(owner.start(() => hashUpdateFile(owner, '/memory/file', 1024)), e => { assert.deepEqual(errors(e), [failure, close]); return true; });
    assert.equal(owner.held, true); assert.equal(s.handles.size, 1);
}));
test('published payload survives redundant temporary removal failure with truthful publication and no invented live temp', options, () => within(async s => {
    const owner = new UpdateOwnership(); const u = await updater(s, owner); const failure = Error('redundant removal'); s.faults.rm = failure;
    await assert.rejects(owner.start(() => u.download()), e => e === failure);
    assert.equal(owner.snapshot().publications.payload, 'published'); assert.equal(owner.active, false); assert.equal(s.handles.size, 0); await owner.shutdown();
}));
test('rename rejection records uncertain publication and blocks despite acknowledged temporary removal', options, () => within(async s => {
    const owner = new UpdateOwnership(); s.faults.rename = Error('rename');
    await assert.rejects(owner.start(() => publishUpdateFile(owner, 'marker', '/memory/temp', '/memory/marker', '{}', () => assert.fail('not acknowledged'))), /rename/);
    assert.equal(s.files.has('/memory/temp'), false); assert.equal(owner.held, true); assert.equal(owner.snapshot().publications.marker, 'uncertain');
}));
test('actual report marker publication remains discoverable after redundant cleanup rejects and coordinator disarms it', options, () => within(async s => {
    const owner = new UpdateOwnership(), reports = new UpdateReports('/memory/reports', owner);
    const saved = { id: '12345678-1234-1234-1234-123456789abc', mode: 'preserve' as const };
    const failure = Error('temporary cleanup'); s.faults.rm = failure;
    let disarmed = false;
    const coordinator = new UpdateCoordinator({ assertCanDownload() {}, async download() { return '/memory/exe'; }, async executable() { return '/memory/exe'; } }, {
        async save() { return saved; }, arm: value => reports.arm(value), isArmed: value => reports.isArmed(value),
        async acknowledge(id) { delete s.faults.rm; await reports.acknowledge(id); disarmed = true; },
    }, { isConnecting: () => false, isConnected: () => false, async waitForCollection() {}, latestSnapshot: () => null, disconnect() {}, progress() {}, restart() { assert.fail('failed marker cannot restart'); } });
    await assert.rejects(owner.start(() => coordinator.start({ mode: 'preserve' })), e => e === failure);
    assert.equal(disarmed, true); assert.equal(s.files.has('/memory/reports/pending.json'), false); assert.equal(owner.active, false);
}));
test('receipt publication is separate from rejected cleanup and close failure blocks quit', options, () => within(async s => {
    const owner = new UpdateOwnership(), receipts = new UpdateReceipts('/memory/updates', 'win32', owner);
    const input = { previousVersion: '0.1.0', version: '0.2.0', executable: '/memory/updates/0.2.0/Diagnostic-Hub.exe', hash, state: 'verified' as const };
    s.faults['close:wx'] = Error('receipt close');
    await assert.rejects(owner.start(() => receipts.write(input)), /receipt close/); assert.equal(owner.held, true); assert.equal(s.files.has('/memory/updates/handoff.json'), false);
}));
test('quit freezes admission and waits actual coordinator; queued restart never awaits its own quit', options, () => within(async s => {
    const owner = new UpdateOwnership(), u = await updater(s, owner), download = gate();
    const calls: string[] = []; let queued!: () => void;
    const quit = createQuitController(async () => runQuitCleanup({ joinUpdate: () => owner.shutdown(), cancelConnection() { calls.push('cancel'); }, clearHostVerification() {}, disconnect() {}, async prepareConsole() {}, async joinConnection() {}, async joinSsh() {}, async finishConsole() {}, async shutdownCapture() {} }));
    const coordinator = new UpdateCoordinator(u, { async save() { return null; }, async arm() {}, async acknowledge() {} }, {
        isConnecting: () => false, isConnected: () => false, async waitForCollection() { await download.promise; }, latestSnapshot: () => null, disconnect() {}, progress() {},
        restart() { calls.push('restart-requested'); queued = () => { void quit.begin(undefined); }; },
    });
    const task = owner.start(() => coordinator.start({ mode: 'clean' })); await rounds();
    const leaving = quit.begin(undefined); await rounds(); assert.equal(quit.phase, 'waiting'); assert.deepEqual(calls, []);
    download.resolve(); await task; queued(); assert.deepEqual(await leaving, { status: 'ready' }); assert.deepEqual(calls, ['restart-requested', 'cancel']);
}));
test('parallel metadata observations settle independently and block an exclusive replacement until both retire', options, () => within(async () => {
    const owner = new UpdateOwnership(), first = gate(), second = gate();
    const a = owner.observe(async () => { await first.promise; }); const b = owner.observe(async () => { await second.promise; });
    assert.throws(() => owner.start(async () => {}), /not retired/); first.resolve(); await a; assert.equal(owner.active, true);
    second.resolve(); await b; assert.equal(owner.active, false);
}));
test('cached check does not swallow failed verification closure or present a ready path', options, () => within(async s => {
    const owner = new UpdateOwnership(), u = await updater(s, owner); await owner.start(() => u.download());
    const failure = Error('cached close'); s.faults['close:r'] = failure;
    await assert.rejects(owner.observe(() => u.check(false)), e => e === failure); assert.equal(owner.blocked, true);
    assert.throws(() => owner.observe(async () => {}), /retirement unconfirmed/);
}));
test('receipt publication survives redundant cleanup failure as a publication fact, not an app boot claim', options, () => within(async s => {
    const owner = new UpdateOwnership(), receipts = new UpdateReceipts('/memory/updates', 'win32', owner);
    const failure = Error('receipt temporary'); s.faults.rm = failure;
    await assert.rejects(owner.start(() => receipts.write({ previousVersion: '0.1.0', version: '0.2.0', executable: '/memory/updates/0.2.0/Diagnostic-Hub.exe', hash, state: 'restart-requested' })), e => e === failure);
    assert.equal(owner.snapshot().publications['handoff receipt'], 'published'); assert.equal(owner.active, false);
    assert.equal(JSON.parse(s.files.get('/memory/updates/handoff.json')!.toString()).state, 'restart-requested');
}));
test('undefined cleanup rejection remains blocked and does not admit another observer', options, () => within(async () => {
    const owner = new UpdateOwnership(); const lease = owner.hold('unknown rejection', {}); lease.blocked(undefined);
    assert.equal(owner.blocked, true); assert.match(owner.describe(), /unknown rejection/); assert.throws(() => owner.observe(async () => {}), /retirement unconfirmed/);
}));

test('unprintable primary failure survives marker disarm failure without diagnostic conversion masking', options, () => within(async () => {
    const primary = { toString() { throw Error('conversion'); } }, cleanup = Error('disarm');
    const coordinator = new UpdateCoordinator({ assertCanDownload() {}, async download() { return '/memory/exe'; }, async executable() { return '/memory/exe'; } }, {
        async save() { return { id: '12345678-1234-1234-1234-123456789abc', mode: 'smart' }; }, async arm() {}, async acknowledge() { throw cleanup; },
    }, { isConnecting: () => false, isConnected: () => false, async waitForCollection() {}, latestSnapshot: () => null, disconnect() {}, progress() {}, restart() { throw primary; } });
    await assert.rejects(coordinator.start({ mode: 'clean' }), e => { assert.ok(e instanceof AggregateError); assert.deepEqual(e.errors, [primary, cleanup]); assert.equal(e.cause, primary); return true; });
}));
