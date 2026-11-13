/** Pure captured-data validator controls. Authored bytes below are not installed,
 * runtime or release evidence. No archive extraction, native operation or mutation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
    fixtureA,
    fixtureB,
    fixtureC,
    fixtureArguments,
    fixtureReview,
    fixtureCompact,
    fixtureEnvelopeInventory,
    fixturePublishedSeal,
    fixtureRemovalRecords,
    fixtureLedgerFiles,
    fixtureRecordedEntry,
    type FixtureLedger,
} from '../scripts/lib/linux-owned-fixture-records.ts';
import {
    runFixedCurrentC,
    type FixedCurrentCOperations,
} from '../scripts/lib/linux-owned-current-c.ts';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const raw = (value: unknown) => Buffer.from(JSON.stringify(value));
const root = '/memory/installed',
    uid = 1000,
    installationId = '11111111-1111-4111-8111-111111111111';
const tx = (digit: string) =>
    digit.repeat(8) +
    '-' +
    digit.repeat(4) +
    '-4' +
    digit.repeat(3) +
    '-8' +
    digit.repeat(3) +
    '-' +
    digit.repeat(12);
const journal = (transactionId: string) => ({
    root,
    uid,
    installationId,
    transactionId,
    phase: 'candidate-active',
});
function ledger(
    transactionId: string,
    completed: Buffer,
    offset: number,
    parent?: FixtureLedger,
    parentSnapshot?: Buffer,
) {
    const candidate = raw(journal(transactionId)),
        confirmed = raw({ ...journal(transactionId), phase: 'candidate-confirmed' });
    const base = (ino: number, mode = 0o100600) => ({ dev: 1, ino, uid, mode });
    const snap: any = {
        schemaVersion: 1,
        configuration: { root, host: { uid }, installationId, transactionId },
        initial: {
            journal: JSON.parse(candidate.toString()),
            history: {
                journalOriginal: { base64: candidate.toString('base64'), sha256: hash(candidate) },
                completed: { base64: completed.toString('base64'), sha256: hash(completed) },
                ...(parent
                    ? {
                          cleanup: {
                              snapshotSHA256: hash(parentSnapshot!),
                              initial: { history: {} },
                          },
                      }
                    : {}),
            },
        },
        entries: [{ path: 'source', kind: 'file' }],
        originals: [],
        ...(parent ? { parent } : {}),
    };
    const snapshot = raw(snap),
        state = raw({
            schemaVersion: 1,
            snapshotSHA256: hash(snapshot),
            phase: 'complete',
            index: 1,
            leaf: 'source',
        });
    const anchor = {
        entry: fixtureRecordedEntry(
            parent ? 'journal.json' : 'completed-journal.json',
            base(offset + 10),
            confirmed,
        ),
        raw: confirmed,
    };
    const original = fixtureRecordedEntry('journal.json', base(offset + 6), candidate);
    const intent = raw({
        schemaVersion: 1,
        root,
        installationId,
        transactionId,
        uid,
        snapshotSHA256: hash(snapshot),
        original,
        staged: { ...anchor.entry, path: 'confirmed-journal.json' },
    });
    const records = {
        'original-completed-journal.json': completed,
        'original-journal.json': candidate,
        'seal-intent.json': intent,
        'snapshot.json': snapshot,
        'state.json': state,
        'unconfirmed-journal.json': candidate,
    };
    const entries = fixtureLedgerFiles.map((name, at) =>
        fixtureRecordedEntry(
            name,
            at === 0 && parent ? parent.anchor : base(offset + at + 1),
            records[name],
        ),
    );
    entries.push(
        fixtureRecordedEntry('disposal', base(offset + 7, 0o40700)),
        fixtureRecordedEntry('', base(offset + 8, 0o40700)),
    );
    return {
        records,
        entries,
        anchor,
        root,
        uid,
        installationId,
        transactionId,
        candidate,
        completed,
        parent,
        parentSnapshotSHA256: parentSnapshot ? hash(parentSnapshot) : undefined,
    };
}
function pair() {
    const b = ledger(tx('2'), raw(journal(tx('1'))), 100),
        parent = fixturePublishedSeal(b);
    const c = ledger(tx('3'), b.anchor.raw, 200, parent, b.records['snapshot.json']);
    return { b, parent, c, current: fixturePublishedSeal(c) };
}
test('fixed C grammar is additive and rejects C inputs outside its explicit scenario', () => {
    const old = [
        '--a-appdir',
        '/memory/a',
        '--a-archive',
        '/memory/a.tar',
        '--b-appdir',
        '/memory/b',
        '--b-archive',
        '/memory/b.tar',
        '--fixture-root',
        '/memory/run',
    ];
    assert.equal(fixtureArguments(old).scenario, undefined);
    assert.equal(fixtureArguments([...old, '--scenario', 'current-b']).scenario, 'current-b');
    const c = [
        ...old,
        '--c-appdir',
        '/memory/c',
        '--c-archive',
        '/memory/c.tar',
        '--scenario',
        'current-b-with-c',
    ];
    assert.equal(fixtureArguments(c)['c-appdir'], '/memory/c');
    for (const invalid of [
        [...old, '--scenario', 'current-b-with-c'],
        c.slice(0, -2),
        [...c, '--c-archive', '/memory/other'],
        [...old, '--scenario', 'current-c'],
    ])
        assert.throws(() => fixtureArguments(invalid), /FIXTURE_ARGUMENT/);
    assert.equal(fixtureA, '0.6.0-qualification.0');
    assert.equal(fixtureB, '0.6.0');
    assert.equal(fixtureC, '0.6.1-qualification.0');
});
test('fixed review matcher distinguishes B-to-C update from A-to-B without granting consent', () => {
    const text = (version: string, installed: string) =>
        '\nDiagnostic Hub Linux setup\nOperation: update\nApplication: ' +
        root +
        '\nCandidate version: ' +
        version +
        '\nInstalled version: ' +
        installed +
        '\nSettings/reports: /memory/config/DiagnosticHub/profiles/' +
        installationId +
        '\nPrevious payloads are retained. No Finalize or removal is performed.\nType "apply menu" or "apply no-menu" to apply this operation; Enter/cancel leaves everything unchanged: ';
    assert.equal(
        fixtureReview(text(fixtureC, fixtureB), 'update', root, fixtureC, '/memory/config'),
        true,
    );
    assert.equal(
        fixtureReview(text(fixtureB, fixtureA), 'update', root, fixtureB, '/memory/config'),
        true,
    );
    assert.equal(
        fixtureReview(text(fixtureC, fixtureA), 'update', root, fixtureC, '/memory/config'),
        false,
    );
    assert.equal(
        fixtureReview(
            text(fixtureC, fixtureB) + 'extra',
            'update',
            root,
            fixtureC,
            '/memory/config',
        ),
        false,
    );
});
test('envelope inventory checks exact matching payload bytes modes count and ordering', () => {
    const descriptor = '{}',
        plan = {
            files: [{ path: 'diagnostic-hub', bytes: 7, sha256: 'a'.repeat(64), mode: 0o700 }],
            descriptor,
            descriptorSHA256: hash(Buffer.from(descriptor)),
        };
    const files = [
        { path: 'app/diagnostic-hub', bytes: 7, sha256: 'a'.repeat(64), mode: 0o700 },
        {
            path: 'diagnostic-hub-setup-payload.json',
            bytes: 2,
            sha256: plan.descriptorSHA256,
            mode: 0o600,
        },
    ];
    fixtureEnvelopeInventory(plan, { files });
    for (const change of [
        (v: any[]) => {
            v[0].sha256 = 'b'.repeat(64);
        },
        (v: any[]) => {
            v[0].mode = 0o777;
        },
        (v: any[]) => {
            v.reverse();
        },
        (v: any[]) => {
            v.push(v[0]);
        },
    ]) {
        const copy = structuredClone(files);
        change(copy);
        assert.throws(
            () => fixtureEnvelopeInventory(plan, { files: copy }),
            /FIXTURE_RETAINED_COPY_CHANGED/,
        );
    }
});
test('compact records reject partial noncanonical duplicate-key and oversized bytes', () => {
    assert.deepEqual(fixtureCompact(raw({ ready: true }), 64), { ready: true });
    for (const value of [
        Buffer.from('{'),
        Buffer.from('{"a":1,"a":2}'),
        Buffer.from('{"a":1}\n'),
        Buffer.alloc(0),
        raw({ a: 'x'.repeat(70) }),
    ])
        assert.throws(() => fixtureCompact(value, 64));
});
test('published C validator binds both ledgers original bytes and the moved B anchor', () => {
    const { c, parent, current } = pair();
    assert.equal(current.entries.length, 8);
    assert.equal(current.anchor.path, 'journal.json');
    assert.equal(current.entries[0].ino, parent.anchor.ino);
    for (const change of [
        (v: typeof c) => {
            v.entries[0].ino++;
        },
        (v: typeof c) => {
            v.entries[0].path = '../journal.json';
        },
        (v: typeof c) => {
            v.anchor.raw = v.candidate;
        },
        (v: typeof c) => {
            v.entries[4].ino = v.entries[3].ino;
        },
        (v: typeof c) => {
            v.parentSnapshotSHA256 = 'f'.repeat(64);
        },
        (v: typeof c) => {
            v.records['original-journal.json'] = Buffer.from('wrong');
        },
    ]) {
        const v = {
            ...c,
            records: { ...c.records },
            entries: structuredClone(c.entries),
            anchor: { ...c.anchor, entry: { ...c.anchor.entry } },
        };
        change(v);
        assert.throws(() => fixturePublishedSeal(v), /FIXTURE_SEAL_/);
    }
});
test('removal validator requires completed progress exact C originals and retained parent descriptor', () => {
    const { c, current, parent } = pair();
    const manifest = Buffer.from('manifest'),
        record = Buffer.from('record'),
        owner = Buffer.from('owner');
    const originals = [
        ['.diagnostic-hub-release.json', manifest],
        ['.diagnostic-hub-installation.json', record],
        ['.diagnostic-hub-ownership.json', owner],
    ].map(([name, b]) => ({
        path: name,
        base64: (b as Buffer).toString('base64'),
        sha256: hash(b as Buffer),
    }));
    const saved = {
        schemaVersion: 1,
        root,
        host: { uid },
        removalOwner: {},
        initial: { journal: JSON.parse(c.anchor.raw.toString()) },
        entries: [{ path: 'source' }],
        maintenance: {},
        originals,
        confirmedCleanup: { ...current, parent },
    };
    const snapshot = raw(saved),
        progress = {
            schemaVersion: 1,
            snapshotSHA256: hash(snapshot),
            phase: 'complete',
            index: 1,
            leaf: 'source',
        };
    const expected = {
        root,
        uid,
        transactionId: c.transactionId,
        confirmed: c.anchor.raw,
        current,
        parent,
        manifest,
        record,
        owner,
    };
    assert.equal(
        fixtureRemovalRecords(snapshot, raw(progress), expected).snapshotSHA256,
        hash(snapshot),
    );
    for (const drift of [
        { phase: 'deleting' },
        { index: 0 },
        { leaf: 'app' },
        { snapshotSHA256: 'a'.repeat(64) },
    ])
        assert.throws(
            () => fixtureRemovalRecords(snapshot, raw({ ...progress, ...drift }), expected),
            /FIXTURE_C_UNINSTALL_RECORD/,
        );
    const bad = structuredClone(saved);
    bad.originals[0].base64 = Buffer.from('replacement').toString('base64');
    const badRaw = raw(bad);
    assert.throws(
        () =>
            fixtureRemovalRecords(
                badRaw,
                raw({ ...progress, snapshotSHA256: hash(badRaw) }),
                expected,
            ),
        /FIXTURE_C_UNINSTALL_ORIGINALS/,
    );
});

function continuation() {
    const { b, c, current, parent } = pair(),
        events: string[] = [];
    const oldPayload = {
            originalManifest: Buffer.from('B-manifest'),
            originalRecord: Buffer.from('B-record'),
            originalOwner: Buffer.from('B-owner'),
        },
        newPayload = {
            originalManifest: Buffer.from('C-manifest'),
            originalRecord: Buffer.from('C-record'),
            originalOwner: Buffer.from('C-owner'),
        };
    const state = {
        updated: false,
        booted: false,
        removed: false,
        frozen: false,
        failure: undefined as unknown,
        profile: '[{"settings":"original"}]',
        drift: '',
        updatePromise: null as Promise<any> | null,
    };
    const gate = () => {
        if (state.frozen) throw state.failure;
    };
    const originalRecord = (name: string, value: Buffer) => ({
        path: name,
        base64: value.toString('base64'),
        sha256: hash(value),
    });
    const saved = {
        schemaVersion: 1,
        root,
        host: { uid },
        removalOwner: {},
        initial: { journal: JSON.parse(c.anchor.raw.toString()) },
        entries: [{ path: 'source' }],
        maintenance: {},
        originals: [
            originalRecord('.diagnostic-hub-release.json', newPayload.originalManifest),
            originalRecord('.diagnostic-hub-installation.json', newPayload.originalRecord),
            originalRecord('.diagnostic-hub-ownership.json', newPayload.originalOwner),
        ],
        confirmedCleanup: { ...current, parent },
    };
    const snapshot = raw(saved),
        progress = raw({
            schemaVersion: 1,
            snapshotSHA256: hash(snapshot),
            phase: 'complete',
            index: 1,
            leaf: 'source',
        });
    const updated = {
        ...newPayload,
        installationId,
        journal: {
            transactionId: c.transactionId,
            previousSHA256: hash(oldPayload.originalManifest),
        },
    };
    const ports: FixedCurrentCOperations = {
        root,
        uid,
        installationId,
        transactionB: b.transactionId,
        checked(call) {
            gate();
            const result = call();
            gate();
            return result;
        },
        copies() {
            gate();
            events.push('copies');
        },
        originals() {
            gate();
            return { a: b.completed, b: b.candidate, c: state.updated ? c.candidate : null };
        },
        readSeal(group) {
            gate();
            events.push(group);
            if (group.startsWith('c-')) assert.equal(state.booted, true);
            const capture = group.startsWith('b-') ? b : c;
            if (state.drift === group)
                return { ...capture, anchor: { ...capture.anchor, raw: Buffer.from('changed') } };
            return capture;
        },
        profile() {
            gate();
            return state.profile;
        },
        maintenance(group) {
            gate();
            assert.equal(state.booted, true);
            if (group === 'removed') assert.equal(state.removed, true);
            return {
                files: [{ path: 'journal.json' }],
                directories: [],
                identity: { dev: 1, ino: 42, uid, gid: 1000, mode: 0o40700, nlink: 2 },
            };
        },
        payload(group) {
            gate();
            if (group === 'previous-b') assert.equal(state.updated, true);
            return group === 'c' ? newPayload : oldPayload;
        },
        update() {
            gate();
            events.push('update');
            state.updated = true;
            return state.updatePromise ?? Promise.resolve(updated);
        },
        removalReadback() {
            gate();
            assert.equal(state.removed, true);
            return { snapshot, state: progress };
        },
        writeBinding(value) {
            gate();
            events.push('binding');
            return value;
        },
        writePublished(value) {
            gate();
            events.push('published');
            return value;
        },
        writeFinal(value) {
            gate();
            events.push('final');
            return { path: '/memory/final', bytes: value.length, sha256: hash(value) };
        },
    };
    return { ports, oldPayload, state, events, updated };
}
test('fixed C continuation checks B before update and keeps boot/profile/removal observations distinct', async () => {
    const f = continuation(),
        context = await runFixedCurrentC(f.ports, f.oldPayload);
    assert.ok(f.events.indexOf('b-live') < f.events.indexOf('update'));
    assert.ok(f.events.indexOf('b-completed') > f.events.indexOf('update'));
    assert.throws(() => context.revalidateAfterUninstall(), /FIXTURE_C_PUBLISHED_REQUIRED/);
    f.state.booted = true;
    f.state.profile = '[{"settings":"boot-wrote-real-settings"}]';
    context.capturePublishedC();
    assert.throws(() => context.capturePublishedC(), /FIXTURE_C_CAPTURE_ONCE/);
    assert.throws(
        () => context.writeSecondSealUninstallRecord(Buffer.from('record')),
        /FIXTURE_C_UNINSTALL_REQUIRED/,
    );
    f.state.removed = true;
    context.revalidateAfterUninstall();
    context.revalidateAfterUninstall();
    context.writeSecondSealUninstallRecord(Buffer.from('record'));
    assert.equal(f.events.filter((s) => s === 'published').length, 1);
    assert.equal(f.events.at(-1), 'final');
});
test('fixed C continuation preserves rejected/late update errors without binding or later readbacks', async () => {
    for (const failure of [undefined, null, false]) {
        const f = continuation();
        f.state.updatePromise = Promise.reject(failure);
        let caught = false;
        try {
            await runFixedCurrentC(f.ports, f.oldPayload);
        } catch (error) {
            caught = true;
            assert.equal(error, failure);
        }
        assert.equal(caught, true);
        assert.equal(f.events.includes('binding'), false);
    }
    const f = continuation();
    let resolve!: (value: any) => void;
    f.state.updatePromise = new Promise((done) => {
        resolve = done;
    });
    const pending = runFixedCurrentC(f.ports, f.oldPayload);
    f.state.frozen = true;
    f.state.failure = Error('original-owner-deadline');
    resolve(f.updated);
    await assert.rejects(pending, (error) => error === f.state.failure);
    assert.equal(f.events.includes('binding'), false);
});
test('fixed C continuation refuses moved-parent anchor and changed post-boot profile without final output', async () => {
    const parent = continuation();
    parent.state.drift = 'b-completed';
    await assert.rejects(runFixedCurrentC(parent.ports, parent.oldPayload), /FIXTURE_SEAL_ANCHOR/);
    assert.equal(parent.events.includes('binding'), false);
    const f = continuation(),
        context = await runFixedCurrentC(f.ports, f.oldPayload);
    f.state.booted = true;
    context.capturePublishedC();
    f.state.removed = true;
    f.state.profile = '[]';
    assert.throws(() => context.revalidateAfterUninstall(), /FIXTURE_C_PROFILE_CHANGED/);
    assert.equal(f.events.includes('final'), false);
});
