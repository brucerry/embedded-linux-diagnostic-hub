import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { planLinuxReviewEnvelope } from '../scripts/lib/linux-setup-envelope.ts';
import { inspectLinuxArchiveTreeBinding, type LinuxBindingModelPorts } from '../scripts/lib/linux-envelope-binding.ts';
import { createLinuxReviewCapability } from '../scripts/lib/linux-review-package.mjs';
import packaging from '../scripts/lib/linux-review-after-pack.cjs';
const clone = <T>(x: T): T => structuredClone(x);
const hash = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
function fixture() {
    const entry = Buffer.from('/* synthetic code never executed */');
    const bodies: Record<string, Buffer> = { AppRun: Buffer.from('inert portable launcher'),
        'diagnostic-hub': Buffer.from('inert runtime bytes'), 'resources/app.asar': Buffer.from('inert ASAR marker'),
        'resources/linux-setup-review.cjs': entry,
        'resources/linux-setup-review.json': Buffer.from(JSON.stringify(createLinuxReviewCapability('0.6.0', entry)) + '\n') };
    const files = Object.keys(bodies).sort().map(path => ({ path, bytes: bodies[path].length,
        sha256: hash(bodies[path]), mode: ['AppRun', 'diagnostic-hub'].includes(path) ? 0o755 :
            path.endsWith('.json') ? 0o600 : 0o644 }));
    const input = { platform: 'linux', arch: 'x64', uid: 1000, euid: 1000, home: '/home/fixture',
        sourceRoot: '/home/fixture/flat', outputRoot: '/home/fixture/envelope', archivePath: '/home/fixture/input.tar.gz',
        archive: { asset: 'Diagnostic-Hub-linux-x64.tar.gz', bytes: 17, sha256: hash('synthetic-archive') },
        layout: 'flat-linux-portable', version: '0.6.0', sourceCommit: 'a'.repeat(40),
        files, inventorySHA256: hash(JSON.stringify(files)) };
    const plan = planLinuxReviewEnvelope(input);
    const regular = (ino: number, size: number) => ({ dev: 1, ino, uid: 1000, mode: 0o100600,
        nlink: 1, size, mtimeMs: 100, ctimeMs: 101 });
    const archiveStat = regular(10, input.archive.bytes), descriptorStat = regular(30, Buffer.byteLength(plan.descriptor));
    const treeStat = { ...regular(20, 4096), mode: 0o40700, nlink: 2 };
    const entries = [...files.map(file => ({ kind: 'file', ...file })),
        ...plan.directories.map(path => ({ kind: 'directory', path, mode: 0o700 }))];
    const request = { id: 'b'.repeat(32), startedMs: 1000, deadlineMs: 121000 };
    const observation = { schema: 1, requestId: request.id, observedMs: 1100,
        archive: { path: input.archivePath, bytes: input.archive.bytes, sha256: input.archive.sha256,
            before: clone(archiveStat), after: clone(archiveStat), entries: clone(entries) },
        tree: { root: input.outputRoot + '/app', before: clone(treeStat), after: clone(treeStat), entries: clone(entries) },
        descriptor: { path: input.outputRoot + '/diagnostic-hub-setup-payload.json', text: plan.descriptor,
            before: clone(descriptorStat), after: clone(descriptorStat) } };
    const calls: unknown[] = [];
    const ports: LinuxBindingModelPorts = { request, now: () => 1200,
        admit(value) { calls.push(clone(value)); return { scope: 'injected-source-model', ...value }; } };
    return { input, plan, observation, ports, calls };
}
test('LB1 complete matching archive tree descriptor facts bind only a nonlaunching source model', () => {
    const f = fixture(), result = inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports);
    assert.equal(result.status, 'source-model-bound'); assert.equal(result.handoffAllowed, false);
    assert.equal(result.qualification, 'unqualified'); assert.equal(result.mutation, false); assert.equal(result.nativeBinding, false);
    assert.equal(result.provenance, 'injected-model-only'); assert.equal(f.calls.length, 1);
    assert.equal(result.entry, '/home/fixture/envelope/app/resources/linux-setup-review.cjs');
    assert.match(result.bindingSHA256!, /^[a-f0-9]{64}$/);
});
test('LB2 default handoff refuses unavailable provenance including payload trust claims and extra verifier arguments', async () => {
    const f = fixture();
    for (const observation of [f.observation, { ...f.observation, provenance: true },
        { ...f.observation, provenance: { verified: true, signature: 'untrusted' } }]) {
        const result = inspectLinuxArchiveTreeBinding(f.input, observation);
        assert.equal(result.status, 'refused'); assert.equal(result.reason, 'provenance-unavailable');
        assert.equal(result.handoffAllowed, false);
        const actual = await Reflect.apply(packaging.reviewEnvelopeHandoff, undefined, [f.input, observation, f.ports]);
        assert.equal(actual.reason, 'provenance-unavailable'); assert.equal(actual.handoffAllowed, false);
    }
    assert.deepEqual(f.calls, []);
});
test('LB3 archive path hash or length mismatch refuses before admission lookup', () => {
    for (const delta of [{ path: '/home/fixture/other.tar.gz' }, { sha256: '0'.repeat(64) }, { bytes: 18 }]) {
        const f = fixture(); Object.assign(f.observation.archive, delta);
        const result = inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports);
        assert.equal(result.status, 'refused'); assert.equal(result.reason, 'archive-mismatch'); assert.equal(f.calls.length, 0);
    }
});
test('LB4 unsafe archive layouts aliases duplicate members links special modes and extras refuse', () => {
    for (const delta of [{ path: '../escape' }, { path: '/escape' }, { path: 'resources//alias' },
        { path: 'resources/../alias' }, { kind: 'link', target: 'outside' }, { kind: 'fifo' },
        { mode: 0o4755 }, { mode: 0o666 }]) {
        const f = fixture(); Object.assign(f.observation.archive.entries[0], delta);
        const result = inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports);
        assert.equal(result.status, 'refused'); assert.equal(f.calls.length, 0);
    }
    for (const kind of ['duplicate', 'missing', 'extra']) {
        const f = fixture(); const list = f.observation.archive.entries;
        if (kind === 'duplicate') list[1] = clone(list[0]);
        if (kind === 'missing') list.pop();
        if (kind === 'extra') list.push(clone(list[0]));
        assert.equal(inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports).status, 'refused');
        assert.equal(f.calls.length, 0);
    }
});
test('LB5 observed envelope root file hash length or mode mismatch cannot become binding evidence', () => {
    const f = fixture(); f.observation.tree.root = f.input.sourceRoot;
    assert.equal(inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports).reason, 'tree-mismatch');
    for (const delta of [{ sha256: 'f'.repeat(64) }, { bytes: 999 }, { mode: 0o700 }]) {
        const g = fixture(); Object.assign(g.observation.tree.entries[0], delta);
        const result = inspectLinuxArchiveTreeBinding(g.input, g.observation, g.ports);
        assert.equal(result.status, 'refused'); assert.equal(g.calls.length, 0);
    }
});
test('LB6 descriptor path text schema source or version mismatch refuses exact binding', () => {
    for (const change of ['path', 'text', 'schema', 'source', 'version']) {
        const f = fixture();
        if (change === 'path') f.observation.descriptor.path = f.input.outputRoot + '/other.json';
        else if (change === 'text') f.observation.descriptor.text += ' ';
        else {
            const d = JSON.parse(f.observation.descriptor.text);
            if (change === 'schema') d.schemaVersion = 2;
            if (change === 'source') d.sourceCommit = 'c'.repeat(40);
            if (change === 'version') d.version = '0.5.2';
            f.observation.descriptor.text = JSON.stringify(d, null, 2) + '\n';
        }
        const result = inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports);
        assert.equal(result.status, 'refused'); assert.equal(result.reason, 'descriptor-mismatch'); assert.equal(f.calls.length, 0);
    }
});
test('LB7 stale foreign unsafe or changed archive tree and descriptor identities refuse', () => {
    for (const slot of ['archive', 'tree', 'descriptor'] as const) {
        for (const delta of [{ dev: 9007199254740992 }, { ino: 1.5 }, { ino: 999 }, { uid: 0 },
            { mtimeMs: 999 }, { ctimeMs: 999 }]) {
            const f = fixture(); Object.assign(f.observation[slot].after, delta);
            const result = inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports);
            assert.equal(result.status, 'refused'); assert.equal(result.reason, 'stale-identity'); assert.equal(f.calls.length, 0);
        }
    }
    const f = fixture(); f.observation.descriptor.after.mode = 0o100644;
    assert.equal(inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports).reason, 'stale-identity');
});
test('LB8 old future expired mismatched request or backwards clock observations cannot qualify', () => {
    for (const delta of [{ observedMs: 999 }, { observedMs: 1201 }, { observedMs: NaN }, { requestId: 'c'.repeat(32) }]) {
        const f = fixture(); Object.assign(f.observation, delta);
        assert.equal(inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports).reason, 'stale-observation');
    }
    for (const values of [[121000], [NaN], [1200, 1199], [1200, 1200, 121000], [1200, 1200, 1199]]) {
        const f = fixture(); let at = 0; f.ports.now = () => values[Math.min(at++, values.length - 1)];
        assert.equal(inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports).reason, 'stale-observation');
    }
    const f = fixture(); f.ports.request.deadlineMs++;
    assert.equal(inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports).reason, 'stale-observation');
});
test('LB9 boolean malformed selfqualified and mismatched provenance admissions refuse', () => {
    for (const response of [null, false, true, {}, { scope: 'qualified' }, Promise.resolve(true)]) {
        const f = fixture(); f.ports.admit = () => response;
        const result = inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports);
        assert.equal(result.status, 'refused'); assert.equal(result.reason, 'untrusted-provenance');
    }
    for (const delta of [{ scope: 'qualified' }, { id: 'c'.repeat(32) }, { bindingSHA256: '0'.repeat(64) },
        { sourceCommit: 'c'.repeat(40) }, { deadlineMs: 120999 }]) {
        const f = fixture(); f.ports.admit = value => ({ scope: 'injected-source-model', ...value, ...delta });
        assert.equal(inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports).status, 'refused');
    }
});
test('LB10 admission fingerprint binds source cohort identities roots nonce and descriptor', () => {
    const original = fixture(); inspectLinuxArchiveTreeBinding(original.input, original.observation, original.ports);
    const first = clone(original.calls[0]) as Record<string, unknown>;
    for (const change of ['source', 'identity', 'nonce']) {
        const f = fixture();
        if (change === 'source') {
            f.input.sourceRoot = '/home/fixture/another-flat';
        } else if (change === 'identity') {
            f.observation.archive.before.ino = 11; f.observation.archive.after.ino = 11;
        } else { f.ports.request.id = 'c'.repeat(32); f.observation.requestId = f.ports.request.id; }
        f.ports.admit = () => ({ scope: 'injected-source-model', ...first });
        assert.equal(inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports).reason, 'provenance-mismatch');
    }
});
test('LB11 admission receives independent facts and cannot mutate comparison identities', () => {
    const f = fixture(); f.ports.admit = value => {
        value.bindingSHA256 = '0'.repeat(64); value.sourceCommit = 'c'.repeat(40);
        return { scope: 'injected-source-model', ...value };
    };
    assert.equal(inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports).reason, 'provenance-mismatch');
    assert.equal(f.input.sourceCommit, 'a'.repeat(40));
});
test('LB12 private authority errors untrusted payload fields and missing ports stay nonpassing without disclosure', () => {
    const f = fixture(); f.ports.admit = () => { throw Error('PRIVATE-CANARY credential-like private exception'); };
    const result = inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports);
    assert.equal(result.reason, 'provenance-unavailable'); assert.ok(!JSON.stringify(result).includes('PRIVATE-CANARY'));
    const g = fixture();
    const unsafe = inspectLinuxArchiveTreeBinding(g.input, { ...g.observation, provenance: { verified: true } }, g.ports);
    assert.equal(unsafe.status, 'refused'); assert.equal(g.calls.length, 0);
    assert.equal(inspectLinuxArchiveTreeBinding(g.input, g.observation, {} as never).status, 'refused');
});

test('LB13 B1 negative and high-bit stat modes refuse before truncating masks for equal snapshot pairs', () => {
    for (const slot of ['archive', 'tree', 'descriptor'] as const) {
        for (const offset of [-(2 ** 32), 2 ** 32, 2 ** 40]) {
            const f = fixture(), mode = f.observation[slot].before.mode + offset;
            assert.equal(Number.isSafeInteger(mode), true);
            // Equal malformed pairs bypass a mere before/after equality check in the predecessor.
            f.observation[slot].before.mode = mode; f.observation[slot].after.mode = mode;
            const result = inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports);
            assert.equal(result.status, 'refused'); assert.equal(result.reason, 'stale-identity');
            assert.equal(result.handoffAllowed, false); assert.equal(f.calls.length, 0);
        }
        for (const mode of [-1, 0o200000, 1.5, NaN, Infinity]) {
            const f = fixture(); f.observation[slot].before.mode = mode; f.observation[slot].after.mode = mode;
            assert.equal(inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports).status, 'refused');
            assert.equal(f.calls.length, 0);
        }
    }
});
test('LB14 runtime narrowing guards reject nonarray entries nonstring paths and request IDs before admission', () => {
    for (const entries of [null, false, 0, {}, 'not-an-array']) {
        const f = fixture(), observation = { ...f.observation, archive: { ...f.observation.archive, entries } };
        const result = inspectLinuxArchiveTreeBinding(f.input, observation, f.ports);
        assert.equal(result.reason, 'unsafe-layout'); assert.equal(result.handoffAllowed, false);
        assert.deepEqual(f.calls, []);
    }
    for (const path of [null, false, 0, {}, []]) {
        const f = fixture(), entries = f.observation.archive.entries.map((entry, index) =>
            index === 0 ? { ...entry, path } : entry);
        const result = inspectLinuxArchiveTreeBinding(f.input,
            { ...f.observation, archive: { ...f.observation.archive, entries } }, f.ports);
        assert.equal(result.reason, 'unsafe-layout'); assert.equal(result.handoffAllowed, false);
        assert.deepEqual(f.calls, []);
    }
    for (const id of [null, false, 0, {}, []]) {
        const f = fixture(); Object.assign(f.ports.request, { id });
        const result = inspectLinuxArchiveTreeBinding(f.input, f.observation, f.ports);
        assert.equal(result.reason, 'stale-observation'); assert.equal(result.handoffAllowed, false);
        assert.deepEqual(f.calls, []);
    }
});
