import assert from 'node:assert/strict';
import test from 'node:test';
import { createLinuxReviewCapability, validateLinuxReviewCapability, reviewBundleHash,
    linuxReviewHelperDecision, assertLinuxReviewManifestEntry, LINUX_REVIEW_ENTRY,
    MAX_LINUX_REVIEW_BUNDLE } from '../scripts/lib/linux-review-package.mjs';
import packaging from '../scripts/lib/linux-review-after-pack.cjs';
const bundle = Buffer.from('/* synthetic review entry; never executed */');
const version = '0.6.0';
const capability = () => createLinuxReviewCapability(version, bundle);
const decisionInput = () => ({ platform: 'linux', arch: 'x64', intent: 'review',
    envelope: 'explicit-linux-folder', version, capability: capability(),
    entryBytes: bundle.length, entrySHA256: reviewBundleHash(bundle) });
function fakePackager(failAt = '') {
    const calls: string[] = [], files = new Map<string, Buffer>(), modes = new Map<string, number>();
    const pack = packaging.createReviewPackager({
        async readBundle(file: string, limit: number) {
            calls.push('read:' + file); assert.equal(limit, MAX_LINUX_REVIEW_BUNDLE);
            if (failAt === 'read') throw Error('fake-read');
            return Buffer.from(bundle);
        },
        async publish(file: string, bytes: Buffer, mode: number) {
            calls.push('publish:' + file);
            if (files.has(file)) throw Error('fake-exclusive');
            // Persist even the injected partial failure: no deletion/fallback occurs.
            files.set(file, Buffer.from(bytes)); modes.set(file, mode);
            if (failAt && file.endsWith(failAt)) throw Error('fake-publication');
        },
    });
    const input = { electronPlatformName: 'linux', arch: 'x64', appOutDir: '/fresh/linux-unpacked',
        version, source: '/source/dist-electron/linux-setup-review.cjs' };
    return { pack, input, calls, files, modes };
}
test('LP1 capability declares only read-only consistency with no provenance qualification', () => {
    const value = capability();
    assert.deepEqual(validateLinuxReviewCapability(JSON.parse(JSON.stringify(value)), version), value);
    assert.equal(value.entry, LINUX_REVIEW_ENTRY); assert.equal(value.mutation, false);
    assert.equal(value.nativeBinding, false); assert.equal(value.provenance, 'unverified');
    assert.ok(Object.isFrozen(value));
});
test('LP2 capability rejects missing extra malformed and mutation-enabling fields', () => {
    const missing = { ...capability() }; delete (missing as Partial<typeof missing>).sha256;
    for (const value of [null, false, [], missing, { ...capability(), extra: true },
        { ...capability(), schema: 2 }, { ...capability(), mutation: true },
        { ...capability(), nativeBinding: true }, { ...capability(), provenance: 'qualified' },
        { ...capability(), entry: '../review.cjs' }, { ...capability(), platform: 'win32' },
        { ...capability(), arch: 'arm64' }, { ...capability(), sha256: 'A'.repeat(64) }])
        assert.throws(() => validateLinuxReviewCapability(value, version), /LINUX_REVIEW_CAPABILITY/);
});
test('LP3 capability enforces version and complete bounded entry identities', () => {
    for (const length of [0, MAX_LINUX_REVIEW_BUNDLE + 1])
        assert.throws(() => createLinuxReviewCapability(version, Buffer.alloc(length)));
    assert.throws(() => createLinuxReviewCapability('not-a-version', bundle));
    assert.throws(() => validateLinuxReviewCapability(capability(), '0.5.2'));
    for (const bytes of [0, -1, 1.5, NaN, MAX_LINUX_REVIEW_BUNDLE + 1])
        assert.throws(() => validateLinuxReviewCapability({ ...capability(), bytes }, version));
    assert.equal(createLinuxReviewCapability(version, Buffer.alloc(MAX_LINUX_REVIEW_BUNDLE)).bytes,
        MAX_LINUX_REVIEW_BUNDLE);
});
test('LP4 helper decision admits only explicit complete-folder read-only review', () => {
    const result = linuxReviewHelperDecision(decisionInput());
    assert.deepEqual(result, { status: 'read-only-review', entry: LINUX_REVIEW_ENTRY,
        mutation: false, nativeBinding: false, provenance: 'unverified' });
    assert.ok(Object.isFrozen(result));
});
test('LP5 historical flat portable and unsupported platforms never become setup dispatch', () => {
    for (const envelope of [undefined, 'portable', 'AppImage', 'flat-archive'])
        assert.deepEqual(linuxReviewHelperDecision({ ...decisionInput(), envelope }),
            { status: 'refused', reason: 'complete-folder-required' });
    for (const delta of [{ platform: 'darwin' }, { platform: 'win32' }, { arch: 'arm64' }])
        assert.deepEqual(linuxReviewHelperDecision({ ...decisionInput(), ...delta }),
            { status: 'refused', reason: 'unsupported-platform' });
});
test('LP6 helper refuses all mutation launch and rollback intents without fallback', () => {
    for (const intent of ['install', 'repair', 'update', 'launch', 'rollback', '', undefined])
        assert.deepEqual(linuxReviewHelperDecision({ ...decisionInput(), intent }),
            { status: 'refused', reason: 'mutation-unqualified' });
});
test('LP7 helper entry hash length or metadata mismatch cannot admit review', () => {
    for (const delta of [{ entryBytes: bundle.length + 1 }, { entrySHA256: 'f'.repeat(64) },
        { capability: null }, { version: '0.5.2' }])
        assert.throws(() => linuxReviewHelperDecision({ ...decisionInput(), ...delta }));
});
test('LP8 payload manifest must bind exactly one regular review entry', () => {
    const entry = { kind: 'file', path: LINUX_REVIEW_ENTRY, bytes: bundle.length, sha256: reviewBundleHash(bundle) };
    assert.doesNotThrow(() => assertLinuxReviewManifestEntry([entry], capability()));
    for (const files of [[], [entry, entry], [{ ...entry, kind: 'symlink' }],
        [{ ...entry, bytes: entry.bytes + 1 }], [{ ...entry, sha256: '0'.repeat(64) }],
        [{ ...entry, path: 'resources/linux-setup-review.cjs' }]])
        assert.throws(() => assertLinuxReviewManifestEntry(files, capability()));
});
test('LP9 packager emits physical entry then private consistency metadata using injected IO', async () => {
    const f = fakePackager(), result = await f.pack(f.input);
    assert.equal(result.status, 'read-only-entry-packaged');
    const entry = '/fresh/linux-unpacked/resources/linux-setup-review.cjs';
    const metadata = '/fresh/linux-unpacked/resources/linux-setup-review.json';
    assert.deepEqual(f.calls, ['read:' + f.input.source, 'publish:' + entry, 'publish:' + metadata]);
    assert.deepEqual(f.files.get(entry), bundle); assert.equal(f.modes.get(entry), 0o644);
    assert.equal(f.modes.get(metadata), 0o600);
    assert.deepEqual(JSON.parse(f.files.get(metadata)!.toString()), capability());
});
test('LP10 non-Linux package hooks have no IO and unsupported Linux fails before IO', async () => {
    for (const electronPlatformName of ['darwin', 'win32']) {
        const f = fakePackager(); assert.equal((await f.pack({ ...f.input, electronPlatformName })).status, 'not-applicable');
        assert.deepEqual(f.calls, []);
    }
    for (const delta of [{ arch: 'arm64' }, { appOutDir: 'relative' }, { appOutDir: '/fresh/../other' }]) {
        const f = fakePackager(); await assert.rejects(f.pack({ ...f.input, ...delta }));
        assert.deepEqual(f.calls, []);
    }
});
test('LP11 failed entry publication retains partial input and forbids metadata publication', async () => {
    const f = fakePackager('linux-setup-review.cjs');
    await assert.rejects(f.pack(f.input), /fake-publication/);
    assert.equal(f.calls.length, 2); assert.equal(f.files.size, 1);
    assert.deepEqual(f.files.get('/fresh/linux-unpacked/resources/linux-setup-review.cjs'), bundle);
});
test('LP12 failed metadata publication retains both new files and no retry occurs', async () => {
    const f = fakePackager('linux-setup-review.json');
    await assert.rejects(f.pack(f.input), /fake-publication/);
    assert.equal(f.calls.length, 3); assert.equal(f.files.size, 2);
});
test('LP13 read refusal and existing entry stop publication without overwrite or cleanup', async () => {
    const f = fakePackager('read'); await assert.rejects(f.pack(f.input));
    assert.equal(f.calls.length, 1); assert.equal(f.files.size, 0);
    const g = fakePackager();
    const file = '/fresh/linux-unpacked/resources/linux-setup-review.cjs';
    const preimage = Buffer.from('retained-preimage'); g.files.set(file, preimage);
    await assert.rejects(g.pack(g.input), /fake-exclusive/);
    assert.deepEqual(g.files.get(file), preimage); assert.equal(g.calls.length, 2);
});
