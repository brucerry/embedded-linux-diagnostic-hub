import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { LinuxTransactionModel, linuxModelReviewSHA256, type LinuxModelPlan,
    type LinuxModelView, type LinuxModelPayload, type LinuxMemoryEffects,
    type LinuxModelKernel, type LinuxReservationIdentity } from '../electron/linux-transaction-model.ts';
import { desiredLinuxMenu, prepareLinuxMenuJournal, checkedLinuxMenuRecord,
    checkedLinuxMenuView, checkedLinuxMenuChoice, assertLinuxMenuPhase,
    type LinuxMenuFile } from '../electron/linux-menu-ownership.ts';
import { validateInstallationManifest, INSTALLATION_PRODUCT } from '../shared/installation.ts';
import { linuxReviewArguments, runLinuxGuidedReview, type LinuxReviewSnapshot } from '../electron/linux-setup-ui.ts';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const hash = (x: string) => createHash('sha256').update(x).digest('hex');
const id = '11111111-1111-4111-8111-111111111111';
const transaction = '22222222-2222-4222-8222-222222222222';
const oldTransaction = '33333333-3333-4333-8333-333333333333';
const token = '44444444-4444-4444-8444-444444444444';
function fixture(installed = false, selected = true) {
    const host = { platform: 'linux', arch: 'x64', uid: 1000, euid: 1000,
        home: '/home/test', appData: '/home/test/config', sourceRoot: '/home/test/source', version: '0.6.0' };
    const root = '/home/test/installed', profile = host.appData + '/DiagnosticHub/profiles/' + id;
    const manifest = (version: string) => validateInstallationManifest({ schemaVersion: 1,
        product: INSTALLATION_PRODUCT, platform: 'linux', arch: 'x64', layout: 'linux-folder',
        version, sourceCommit: 'a'.repeat(40), entryPoint: 'app/diagnostic-hub',
        files: [{ kind: 'file', path: 'app/diagnostic-hub', bytes: 7, sha256: hash('fixture') }] });
    const context = { host, root, installationId: id, menu: { dataHome: '/home/test/xdg', selected } };
    const desired = desiredLinuxMenu(context), oldText = desired.text.replace('Name=Diagnostic Hub', 'Name=Prior Diagnostic Hub');
    const oldRecord = { ...desired.record, bytes: Buffer.byteLength(oldText), sha256: hash(oldText) };
    const parents = ['/', '/home', host.home, host.appData, host.sourceRoot, '/home/test/xdg', '/home/test/xdg/applications']
        .sort().map((path, at) => ({ path, uid: path.startsWith(host.home) ? 1000 : 0, dev: 1, ino: at + 1, mode: 0o40700 }));
    const sourceParent = parents.find((x) => x.path === host.sourceRoot)!;
    const owned: LinuxModelPayload = { identity: { uid: 1000, dev: 1, ino: 30 },
        manifest: manifest('0.5.2'), verifiedManifestSHA256: hash(JSON.stringify(manifest('0.5.2'))),
        installationId: id, transactionId: oldTransaction, root, profile, menu: oldRecord };
    const oldFile: LinuxMenuFile = { identity: { uid: 1000, dev: 1, ino: 50 }, bytes: oldRecord.bytes, sha256: oldRecord.sha256 };
    let world: LinuxModelView = { parents, source: { identity: { uid: 1000, dev: 1, ino: sourceParent.ino },
        manifest: manifest('0.6.0'), verifiedManifestSHA256: hash(JSON.stringify(manifest('0.6.0'))) },
        activity: { root: 'inactive', stage: 'inactive', previous: 'inactive' }, root: installed ? owned : null,
        stage: null, previous: null, journal: null, menu: { current: installed ? oldFile : null, candidate: null, previous: null } };
    let inode = 100, lease: LinuxReservationIdentity | null = null;
    const handle = {}, calls: string[] = [], stagedRecords: unknown[] = [];
    let hook: (event: string) => void = () => {};
    const plan = (action: LinuxModelPlan['action'] = installed ? 'update' : 'install'): LinuxModelPlan => ({ ...clone(context),
        action, transactionId: transaction, owner: { pid: 777, startTicks: '9999', executable: host.sourceRoot + '/app/diagnostic-hub' },
        consent: true, review: clone(world), reviewSHA256: linuxModelReviewSHA256(world) });
    const kernel: LinuxModelKernel = {
        async acquire(wanted) { calls.push('reserve'); hook('reserve'); lease = { ...clone(wanted), token }; return { handle, identity: clone(lease) }; },
        async current(found) { calls.push('current'); assert.equal(found, handle); hook('current'); return clone(lease!); },
        async release(found, expected) { calls.push('release'); assert.equal(found, handle); assert.deepEqual(expected, lease); lease = null; return true; },
    };
    const effects: LinuxMemoryEffects = {
        kind: 'injected-memory-effects',
        async observe() { calls.push('observe'); hook('observe'); return clone(world); },
        async journal(_scope, guard, next) { calls.push('journal:' + next.phase + ':' + next.menu?.phase); assert.deepEqual(guard, world); hook('journal'); world.journal = clone(next); return clone(world); },
        async stage(_scope, guard, payload) { calls.push('stage'); assert.deepEqual(guard, world); stagedRecords.push(clone(payload.menu ?? null)); hook('stage'); world.stage = { ...clone(payload), identity: { dev: 1, ino: inode++, uid: 1000 } }; return clone(world); },
        async move(_scope, guard, from, to) { calls.push('move:' + from + ':' + to); assert.deepEqual(guard, world); hook('move'); world[to] = world[from]; world[from] = null; return clone(world); },
        async menuStage(_scope, guard, record, text) { calls.push('menu-stage'); assert.deepEqual(guard, world); assert.deepEqual(record, desired.record); assert.equal(hash(text), record.sha256); hook('menu-stage'); world.menu!.candidate = { identity: { dev: 1, ino: inode++, uid: 1000 }, bytes: record.bytes, sha256: record.sha256 }; return clone(world); },
        async menuMove(_scope, guard, from, to) { calls.push('menu-move:' + from + ':' + to); assert.deepEqual(guard, world); hook('menu-move'); world.menu![to] = world.menu![from]; world.menu![from] = null; return clone(world); },
    };
    return { context, desired, oldRecord, oldFile, profile, plan, kernel, effects, calls, stagedRecords,
        world: () => clone(world), edit(fn: (value: LinuxModelView) => void) { fn(world); },
        hook(fn: typeof hook) { hook = fn; } };
}
test('MO1 new menu record binds UUID root UID path bytes and hash without granting publication', () => {
    const f = fixture(), record = checkedLinuxMenuRecord(f.desired.record, f.context);
    assert.deepEqual(record, f.desired.record);
    assert.equal(record.path, '/home/test/xdg/applications/diagnostic-hub-' + id + '.desktop');
    assert.deepEqual(prepareLinuxMenuJournal(f.context, null, null), { action: 'create', before: null, after: record, beforeFile: null, phase: 'pending' });
});
test('MO2 matching foreign desktop bytes never establish ownership and deselection retains them', () => {
    const f = fixture(), file = { identity: { uid: 1000, dev: 1, ino: 70 }, bytes: f.desired.record.bytes, sha256: f.desired.record.sha256 };
    assert.throws(() => prepareLinuxMenuJournal(f.context, null, file));
    assert.equal(prepareLinuxMenuJournal({ ...f.context, menu: { ...f.context.menu, selected: false } }, null, file).action, 'retain-foreign');
});
test('MO3 malformed menu choices records aliases and nonnull falsy slots refuse', () => {
    const f = fixture();
    for (const value of [false, 0, '', null, {}, { dataHome: '/home/test/xdg', selected: 'yes' }])
        assert.throws(() => checkedLinuxMenuChoice({ ...f.context, menu: value as never }));
    for (const delta of [{ uid: 0 }, { root: '/other' }, { path: '/home/test/foreign.desktop' }, { installationId: oldTransaction }, { bytes: 8193 }])
        assert.throws(() => checkedLinuxMenuRecord({ ...f.desired.record, ...delta }, f.context));
    for (const slot of [false, 0, '', {}]) assert.throws(() => checkedLinuxMenuView({ current: slot, candidate: null, previous: null }, 1000));
    assert.throws(() => checkedLinuxMenuView({ current: f.oldFile, candidate: f.oldFile, previous: null }, 1000));
});
test('MO4 journal cannot acknowledge applied or restored menu effects whose exact files are absent', () => {
    const f = fixture(), journal = prepareLinuxMenuJournal(f.context, null, null);
    assert.throws(() => assertLinuxMenuPhase({ current: null, candidate: null, previous: null }, { ...journal, phase: 'applied' }, f.context));
    assert.throws(() => assertLinuxMenuPhase({ current: null, candidate: null, previous: null }, { ...journal, phase: 'restored' }, f.context));
});
test('MO5 model creates menu only after journal and payload ownership declarations', async () => {
    const f = fixture(), result = await new LinuxTransactionModel(f.kernel, f.effects).run(f.plan());
    assert.equal(result.verdict, 'ACTIVE_PREVIOUS_RETAINED'); assert.equal(result.reservation, 'released');
    assert.deepEqual(f.stagedRecords, [f.desired.record]); assert.deepEqual(f.world().root!.menu, f.desired.record);
    assert.equal(f.world().journal!.menu!.phase, 'applied'); assert.equal(f.world().menu!.current!.sha256, f.desired.record.sha256);
    assert.ok(f.calls.indexOf('journal:copying:pending') < f.calls.indexOf('stage'));
    assert.ok(f.calls.indexOf('stage') < f.calls.indexOf('menu-stage'));
    assert.equal(f.world().root!.profile, f.profile);
});
test('MO6 model replacement retains prior menu and explicit rollback restores exact identity and profile', async () => {
    const f = fixture(true); assert.equal((await new LinuxTransactionModel(f.kernel, f.effects).run(f.plan())).verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.deepEqual(f.world().menu!.previous, f.oldFile);
    const result = await new LinuxTransactionModel(f.kernel, f.effects).run(f.plan('rollback'));
    assert.equal(result.verdict, 'ROLLED_BACK_RETAINED'); assert.deepEqual(f.world().menu!.current, f.oldFile);
    assert.equal(f.world().menu!.candidate!.sha256, f.desired.record.sha256); assert.equal(f.world().menu!.previous, null);
    assert.deepEqual(f.world().root!.menu, f.oldRecord); assert.equal(f.world().root!.profile, f.profile);
    assert.equal(f.world().journal!.menu!.phase, 'restored');
});
test('MO7 model deselection retains owned menu bytes and rollback restores them without deletion', async () => {
    const f = fixture(true, false); assert.equal((await new LinuxTransactionModel(f.kernel, f.effects).run(f.plan())).verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(f.world().root!.menu, undefined); assert.equal(f.world().menu!.current, null); assert.deepEqual(f.world().menu!.previous, f.oldFile);
    assert.equal((await new LinuxTransactionModel(f.kernel, f.effects).run(f.plan('rollback'))).verdict, 'ROLLED_BACK_RETAINED');
    assert.deepEqual(f.world().menu!.current, f.oldFile); assert.equal(f.world().root!.profile, f.profile);
    assert.equal(f.calls.some((name) => /unlink|delete|cleanup/.test(name)), false);
});
test('MO8 menu effect failure or malformed return retains UNKNOWN and performs no release or later effect', async () => {
    for (const malformed of [false, true]) {
        const f = fixture();
        f.effects.menuStage = async () => { f.calls.push('refused-menu-stage'); if (!malformed) throw Error('private-menu-canary'); return false as never; };
        const result = await new LinuxTransactionModel(f.kernel, f.effects).run(f.plan());
        assert.equal(result.verdict, 'RETAINED_UNKNOWN'); assert.notEqual(result.reservation, 'released');
        assert.equal(f.calls.at(-1), 'refused-menu-stage'); assert.doesNotMatch(JSON.stringify(result), /canary/);
    }
});
test('MO9 changed menu bytes or inode after review stops before menu actuation', async () => {
    for (const kind of ['bytes', 'inode'] as const) {
        const f = fixture(true);
        f.hook((event) => { if (event === 'observe') f.edit((world) => { if (kind === 'bytes') world.menu!.current!.sha256 = 'f'.repeat(64); else world.menu!.current!.identity.ino++; }); });
        const result = await new LinuxTransactionModel(f.kernel, f.effects).run(f.plan());
        assert.equal(result.verdict, 'RETAINED_UNKNOWN'); assert.equal(f.calls.some((name) => name.startsWith('menu-') || name.startsWith('journal:')), false);
    }
});
test('MO10 absent menu capability or omitted menu review cannot discard existing ownership', async () => {
    const f = fixture(true), plan = f.plan(); delete plan.menu; delete plan.review.menu;
    plan.review.parents = plan.review.parents.filter((x) => !x.path.startsWith('/home/test/xdg'));
    plan.reviewSHA256 = linuxModelReviewSHA256(plan.review);
    assert.equal((await new LinuxTransactionModel(f.kernel, f.effects).run(plan)).verdict, 'REFUSED'); assert.deepEqual(f.calls, []);
    const g = fixture(); delete g.effects.menuMove;
    assert.equal((await new LinuxTransactionModel(g.kernel, g.effects).run(g.plan())).verdict, 'REFUSED'); assert.deepEqual(g.calls, []);
});
test('MO11 frontend keeps existing declared menu choice unless explicitly changed by the reviewed flag', async () => {
    const f = fixture(true), snapshot: LinuxReviewSnapshot = { root: f.context.root, state: 'owned', installedVersion: '0.5.2', candidateVersion: '0.6.0',
        actions: [], proposedActions: ['launch', 'update'], profile: f.profile, reviewToken: 'a'.repeat(64), options: { startMenu: true, desktop: false, launch: false }, needsRepair: false,
        qualification: 'source-review-only', message: 'fixture' };
    for (const flags of [[], ['--no-menu']]) {
        const choices = linuxReviewArguments(['--version', '0.6.0', '--install-directory', f.context.root, ...flags]); let seen: boolean | null = null;
        const result = await runLinuxGuidedReview(f.context.host, choices, f.context.menu.dataHome, { inspect: async () => clone(snapshot), now: () => 0, newId: () => id,
            gui: { hasPending: () => false, review: async (request) => { seen = request.menu; return { status: 'confirmed', menu: request.menu }; } },
            terminal: { hasPending: () => false, review: async () => { throw Error('no TTY fallback'); } } });
        assert.equal(result.status, 'review-only'); assert.equal(seen, flags.length === 0); assert.equal(result.menuWritten, false);
    }
});
test('MO12 unsupported platform or root UID cannot prepare an owned menu record', () => {
    const f = fixture();
    for (const host of [{ ...f.context.host, platform: 'darwin' }, { ...f.context.host, uid: 0, euid: 0 }])
        assert.throws(() => desiredLinuxMenu({ ...f.context, host }));
});

test('MO13 M2 invalid reviewed app rollback preimages cannot mutate menu app journal or reservation', async () => {
    for (const problem of ['missing-previous', 'wrong-previous-hash', 'wrong-candidate-hash', 'wrong-candidate-transaction', 'occupied-stage', 'wrong-previous-transaction', 'phase-mismatch'] as const) {
        const f = fixture(true);
        assert.equal((await new LinuxTransactionModel(f.kernel, f.effects).run(f.plan())).verdict, 'ACTIVE_PREVIOUS_RETAINED');
        f.edit((world) => {
            if (problem === 'missing-previous') world.previous = null;
            if (problem === 'wrong-previous-hash') world.journal!.previousSHA256 = 'e'.repeat(64);
            if (problem === 'wrong-candidate-hash') world.journal!.candidateSHA256 = 'e'.repeat(64);
            if (problem === 'wrong-candidate-transaction') world.root!.transactionId = oldTransaction;
            if (problem === 'occupied-stage') world.stage = { ...clone(world.root!), identity: { uid: 1000, dev: 1, ino: 9999 } };
            if (problem === 'wrong-previous-transaction') world.previous!.transactionId = transaction;
            if (problem === 'phase-mismatch') { world.stage = world.root; world.root = null; world.journal!.phase = 'candidate-retained'; }
        });
        const before = f.world(), count = f.calls.length;
        const result = await new LinuxTransactionModel(f.kernel, f.effects).run(f.plan('rollback'));
        assert.equal(result.verdict, 'REFUSED');
        assert.equal(f.calls.length, count);
        assert.deepEqual(f.world(), before);
    }
});
test('MO14 M2 app preimage change during fresh reservation guard stops before all rollback mutations', async () => {
    const f = fixture(true);
    assert.equal((await new LinuxTransactionModel(f.kernel, f.effects).run(f.plan())).verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const plan = f.plan('rollback'), beforeMenu = f.world().menu, count = f.calls.length;
    f.hook((event) => { if (event === 'reserve') f.edit((world) => { world.previous = null; }); });
    const result = await new LinuxTransactionModel(f.kernel, f.effects).run(plan);
    assert.equal(result.verdict, 'RETAINED_UNKNOWN');
    const afterCalls = f.calls.slice(count);
    assert.equal(afterCalls.some((name) => /^(journal:|menu-|move:|stage$|release$)/.test(name)), false);
    assert.deepEqual(f.world().menu, beforeMenu);
    assert.notEqual(result.reservation, 'released');
});
