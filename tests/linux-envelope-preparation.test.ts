import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { planLinuxReviewEnvelope, prepareLinuxReviewEnvelope,
    type LinuxEnvelopeIO, type LinuxEnvelopePlan, type LinuxEnvelopeFile } from '../scripts/lib/linux-setup-envelope.ts';
import { createLinuxReviewCapability } from '../scripts/lib/linux-review-package.mjs';
import packaging from '../scripts/lib/linux-review-after-pack.cjs';
import { checkedLinuxEnvelopeIdentity, sameLinuxEnvelopeFileIdentity,
    sameLinuxEnvelopeDirectoryIdentity, cacheLinuxEnvelopeIdentity } from '../scripts/lib/linux-setup-envelope-disk.mjs';
const clone = <T>(x: T): T => structuredClone(x);
const hash = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
function fixture() {
    const entry = Buffer.from('/* inert synthetic review code */');
    const capability = Buffer.from(JSON.stringify(createLinuxReviewCapability('0.6.0', entry)) + '\n');
    const bodies: Record<string, Buffer> = { 'diagnostic-hub': Buffer.from('synthetic-ELF-fixture-only'),
        AppRun: Buffer.from('synthetic-launcher-never-executed'), 'resources/app.asar': Buffer.from('synthetic-ASAR-never-parsed'),
        'resources/linux-setup-review.cjs': entry, 'resources/linux-setup-review.json': capability };
    const files = Object.keys(bodies).sort().map(path => ({ path, bytes: bodies[path].length,
        sha256: hash(bodies[path]), mode: ['diagnostic-hub', 'AppRun'].includes(path) ? 0o755 :
            path.endsWith('.json') ? 0o600 : 0o644 }));
    const input = { platform: 'linux', arch: 'x64', uid: 1000, euid: 1000, home: '/home/fixture',
        sourceRoot: '/home/fixture/portable', outputRoot: '/home/fixture/prepared',
        archivePath: '/home/fixture/input.tar.gz', archive: { asset: 'Diagnostic-Hub-linux-x64.tar.gz',
            bytes: 17, sha256: hash('synthetic-archive') }, layout: 'flat-linux-portable', version: '0.6.0',
        sourceCommit: 'a'.repeat(40), files, inventorySHA256: hash(JSON.stringify(files)) };
    const calls: string[] = [], copied: LinuxEnvelopeFile[] = [], descriptors: Buffer[] = [];
    let fail = '', mutate = false, malformed = '';
    function event(name: string, plan: LinuxEnvelopePlan) {
        calls.push(name);
        if (mutate) { plan.version = '99.0.0'; plan.manifest.version = '99.0.0';
            plan.files[0].sha256 = '0'.repeat(64); plan.archive.sha256 = 'f'.repeat(64); }
        if (name === fail) throw Error('PRIVATE-CANARY: never publish this exception');
        return malformed === name ? false as never : undefined;
    }
    const io: LinuxEnvelopeIO = {
        async admit(p) { return event('admit', p); },
        async verifyInput(p) { return event('verifyInput', p); },
        async createRoot(p) { return event('createRoot', p); },
        async copyFile(p, f) { copied.push(clone(f)); const result = event('copy:' + f.path, p);
            if (mutate) f.bytes = 999; return result; },
        async writeDescriptor(p, bytes) { descriptors.push(Buffer.from(bytes)); event('writeDescriptor', p);
            const written = { bytes: bytes.length, sha256: hash(bytes) };
            if (mutate) bytes.fill(0); return written; },
        async verifyOutput(p) { return event('verifyOutput', p); },
    };
    return { input, bodies, io, calls, copied, descriptors,
        fail(name: string) { fail = name; }, mutate() { mutate = true; }, malformed(name: string) { malformed = name; } };
}
function rehash(input: ReturnType<typeof fixture>['input']) {
    input.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    input.inventorySHA256 = hash(JSON.stringify(input.files)); return input;
}
test('LE1 plan binds the existing Linux descriptor layout version commit and exact regular inventory', () => {
    const f = fixture(), plan = planLinuxReviewEnvelope(f.input);
    assert.equal(plan.manifest.layout, 'linux-folder'); assert.equal(plan.manifest.entryPoint, 'app/diagnostic-hub');
    assert.equal(plan.version, '0.6.0'); assert.equal(plan.sourceCommit, 'a'.repeat(40));
    assert.equal(plan.files.length, 5); assert.deepEqual(plan.directories, ['resources']);
    assert.equal(plan.descriptorSHA256, hash(plan.descriptor));
    assert.deepEqual(JSON.parse(plan.descriptor), plan.manifest);
    assert.ok(plan.manifest.files.every(file => file.kind === 'file' && file.path.startsWith('app/')));
    assert.equal(plan.inventorySHA256, f.input.inventorySHA256);
});
test('LE2 unsupported platform privilege or overlapping noncanonical roots refuse before IO', async () => {
    for (const delta of [{ platform: 'darwin' }, { arch: 'arm64' }, { uid: 0, euid: 0 }, { euid: 0 },
        { uid: 1.5 }, { outputRoot: '/tmp/elsewhere' }, { outputRoot: '/home/fixture' },
        { outputRoot: '/home/fixture/portable/sub' }, { outputRoot: '/home/fixture/../outside' },
        { outputRoot: '/home/fixture/.DiagnosticHub-work' }, { archivePath: '/home/fixture/prepared/archive' },
        { archivePath: '/home/fixture/portable/archive' }]) {
        const f = fixture(); await assert.rejects(prepareLinuxReviewEnvelope({ ...f.input, ...delta }, f.io));
        assert.deepEqual(f.calls, []);
    }
});
test('LE3 archive layout version source and inventory identity mismatches refuse before IO', async () => {
    for (const delta of [{ layout: 'linux-appimage' }, { version: 'invalid' }, { sourceCommit: 'not-a-commit' },
        { inventorySHA256: '0'.repeat(64) }, { extra: true },
        { archive: { asset: 'other.tar.gz', bytes: 17, sha256: 'a'.repeat(64) } },
        { archive: { asset: 'Diagnostic-Hub-linux-x64.tar.gz', bytes: 0, sha256: 'a'.repeat(64) } },
        { archive: { asset: 'Diagnostic-Hub-linux-x64.tar.gz', bytes: 17, sha256: 'BAD' } }]) {
        const f = fixture(); await assert.rejects(prepareLinuxReviewEnvelope({ ...f.input, ...delta }, f.io));
        assert.deepEqual(f.calls, []);
    }
});
test('LE4 unsafe aliases duplicate paths special modes and malformed regular facts are rejected', () => {
    for (const change of [ { path: '../escape' }, { path: '/absolute' }, { path: 'resources//alias' },
        { path: 'resources/../alias' }, { mode: 0o4755 }, { mode: 0o666 }, { mode: 0o000 },
        { bytes: -1 }, { bytes: 1.5 }, { sha256: 'x' }, { kind: 'link', target: 'elsewhere' } ]) {
        const f = fixture(); Object.assign(f.input.files[0], change);
        assert.throws(() => planLinuxReviewEnvelope(rehash(f.input)));
    }
    const f = fixture(); f.input.files.push(clone(f.input.files[0]));
    assert.throws(() => planLinuxReviewEnvelope(rehash(f.input)));
    const g = fixture(); g.input.files.push({ path: 'resources', bytes: 1, sha256: hash('x'), mode: 0o644 });
    assert.throws(() => planLinuxReviewEnvelope(rehash(g.input)));
});
test('LE5 missing runtime launcher ASAR capability or entry and reserved ownership records are refused', () => {
    for (const path of ['diagnostic-hub', 'AppRun', 'resources/app.asar',
        'resources/linux-setup-review.cjs', 'resources/linux-setup-review.json']) {
        const f = fixture(); f.input.files = f.input.files.filter(file => file.path !== path);
        assert.throws(() => planLinuxReviewEnvelope(rehash(f.input)));
    }
    for (const path of ['diagnostic-hub', 'AppRun', 'resources/linux-setup-review.json']) {
        const f = fixture(); f.input.files.find(file => file.path === path)!.mode = 0o644;
        assert.throws(() => planLinuxReviewEnvelope(rehash(f.input)));
    }
    for (const path of ['diagnostic-hub-setup-payload.json', '.diagnostic-hub-installation.json',
        '.diagnostic-hub-release.json', '.diagnostic-hub-ownership.json', '.DiagnosticHub-old/file']) {
        const f = fixture(); f.input.files.push({ path, bytes: 1, sha256: hash('x'), mode: 0o600 });
        assert.throws(() => planLinuxReviewEnvelope(rehash(f.input)));
    }
});
test('LE6 preparation orders verified input fresh root exclusive copies descriptor and final rechecks', async () => {
    const f = fixture(), result = await prepareLinuxReviewEnvelope(f.input, f.io), plan = planLinuxReviewEnvelope(f.input);
    assert.equal(result.status, 'prepared-read-only-envelope');
    assert.deepEqual(f.calls, ['admit', 'verifyInput', 'createRoot', ...plan.files.map(file => 'copy:' + file.path),
        'writeDescriptor', 'verifyOutput', 'verifyInput']);
    assert.deepEqual(f.copied, plan.files); assert.equal(f.descriptors.length, 1);
    assert.equal(f.descriptors[0].toString(), plan.descriptor);
    assert.equal(result.descriptorSHA256, plan.descriptorSHA256);
    assert.equal(result.qualification, 'unqualified'); assert.equal(result.mutation, false); assert.equal(result.nativeBinding, false);
});
test('LE7 admission or initial input failure never attempts allocation copy or descriptor effects', async () => {
    for (const stage of ['admit', 'verifyInput']) {
        const f = fixture(); f.fail(stage); const result = await prepareLinuxReviewEnvelope(f.input, f.io);
        assert.equal(result.status, 'refused'); assert.equal(result.stage, stage);
        assert.equal(result.rootCreationAttempted, false);
        assert.deepEqual(f.calls, stage === 'admit' ? ['admit'] : ['admit', 'verifyInput']);
    }
});
test('LE8 failed root creation stays UNKNOWN with attempted allocation and no later effects', async () => {
    const f = fixture(); f.fail('createRoot'); const result = await prepareLinuxReviewEnvelope(f.input, f.io);
    assert.equal(result.status, 'unknown'); assert.equal(result.rootCreationAttempted, true);
    assert.equal(result.rootCreationReturned, false); assert.equal(result.preserved, true);
    assert.deepEqual(f.calls, ['admit', 'verifyInput', 'createRoot']);
});
test('LE9 each copy failure retains UNKNOWN and stops before subsequent copies or publication', async () => {
    const expected = planLinuxReviewEnvelope(fixture().input).files;
    for (const file of expected) {
        const f = fixture(); f.fail('copy:' + file.path); const result = await prepareLinuxReviewEnvelope(f.input, f.io);
        assert.equal(result.status, 'unknown'); assert.equal(result.stage, 'copyFile');
        assert.equal(f.calls.at(-1), 'copy:' + file.path); assert.equal(f.descriptors.length, 0);
    }
});
test('LE10 descriptor failure malformed or mismatched acknowledgement forbids final verification', async () => {
    const variants: unknown[] = [null, false, {}, { bytes: 1, sha256: '0'.repeat(64) },
        { bytes: 1, sha256: '0'.repeat(64), extra: true }];
    for (const variant of variants) {
        const f = fixture(); f.io.writeDescriptor = async () => { f.calls.push('writeDescriptor'); return variant as never; };
        const result = await prepareLinuxReviewEnvelope(f.input, f.io);
        assert.equal(result.status, 'unknown'); assert.equal(result.stage, 'writeDescriptor');
        assert.equal(f.calls.at(-1), 'writeDescriptor');
    }
    const f = fixture(); f.fail('writeDescriptor');
    assert.equal((await prepareLinuxReviewEnvelope(f.input, f.io)).status, 'unknown');
    assert.equal(f.calls.at(-1), 'writeDescriptor');
});
test('LE11 output or final input recheck failure preserves prepared bytes and cannot report success', async () => {
    const f = fixture(); f.fail('verifyOutput');
    assert.equal((await prepareLinuxReviewEnvelope(f.input, f.io)).status, 'unknown');
    assert.equal(f.calls.at(-1), 'verifyOutput');
    const g = fixture(); let count = 0;
    g.io.verifyInput = async () => { g.calls.push('verifyInput'); if (++count === 2) throw Error('fake-change'); };
    const result = await prepareLinuxReviewEnvelope(g.input, g.io);
    assert.equal(result.status, 'unknown'); assert.equal(result.stage, 'verifyInput');
    assert.equal(g.descriptors.length, 1); assert.equal(g.calls.at(-1), 'verifyInput');
});
test('LE12 effect argument mutation cannot rewrite stable version inventory or descriptor comparisons', async () => {
    const f = fixture(), original = clone(f.input), plan = planLinuxReviewEnvelope(f.input); f.mutate();
    const result = await prepareLinuxReviewEnvelope(f.input, f.io);
    assert.equal(result.status, 'prepared-read-only-envelope'); assert.deepEqual(f.input, original);
    assert.deepEqual(f.copied, plan.files); assert.equal(f.descriptors[0].toString(), plan.descriptor);
    assert.equal(JSON.parse(f.descriptors[0].toString()).version, '0.6.0');
    assert.equal(result.descriptorSHA256, plan.descriptorSHA256);
});
test('LE13 nonvoid effect acknowledgements are never treated as successful completion', async () => {
    for (const stage of ['admit', 'verifyInput', 'createRoot', 'copy:AppRun', 'verifyOutput']) {
        const f = fixture(); f.malformed(stage); const result = await prepareLinuxReviewEnvelope(f.input, f.io);
        assert.notEqual(result.status, 'prepared-read-only-envelope'); assert.equal(f.calls.at(-1), stage);
        if (stage === 'createRoot') assert.equal(result.rootCreationReturned, true);
    }
});
test('LE14 existing packager exposes only the explicit envelope API and uses injected effects', async () => {
    const f = fixture(); const result = await packaging.prepareReviewEnvelope(f.input, f.io);
    assert.equal(result.status, 'prepared-read-only-envelope'); assert.equal(f.calls[0], 'admit');
    assert.equal(typeof packaging.createReviewPackager, 'function');
    assert.deepEqual(Object.keys(packaging).sort(), ['createReviewPackager', 'observeReviewEnvelope', 'prepareReviewEnvelope', 'reviewEnvelopeHandoff']);
});
test('LE15 preparation failure summary omits private exception details and never retries', async () => {
    const f = fixture(); f.fail('copy:AppRun'); const result = await prepareLinuxReviewEnvelope(f.input, f.io);
    const encoded = JSON.stringify(result); assert.ok(!encoded.includes('PRIVATE-CANARY'));
    assert.ok(!encoded.includes('never publish')); assert.equal(result.stage, 'copyFile');
    assert.equal(f.calls.filter(name => name === 'copy:AppRun').length, 1);
    assert.ok(!f.calls.some(name => /remove|delete|unlink|launch|extract|download|rollback|cleanup/i.test(name)));
});

function identityFixture() {
    return { dev: 1, ino: 2, uid: 1000, mode: 0o100600, nlink: 1, size: 7, mtimeMs: 10, ctimeMs: 11 };
}
test('LE16 E1 unsafe nonintegral missing negative and coerced stat identities refuse exact-domain admission', () => {
    const roundedA = Number(9007199254740992n), roundedB = Number(9007199254740993n);
    assert.equal(roundedA, roundedB); // Equal rounded Numbers are not usable identity proof.
    for (const field of ['dev', 'ino']) {
        for (const value of [roundedA, roundedB, Number.MAX_SAFE_INTEGER + 1, 1.25, NaN,
            Infinity, -Infinity, -1, '1', 1n, undefined, null])
            assert.throws(() => checkedLinuxEnvelopeIdentity({ ...identityFixture(), [field]: value }),
                /LINUX_ENVELOPE_IDENTITY/);
    }
    for (const value of [null, false, {}, { dev: 1 }, { ino: 1 }, { dev: 1, ino: 0 }])
        assert.throws(() => checkedLinuxEnvelopeIdentity(value), /LINUX_ENVELOPE_IDENTITY/);
    const boundary = { ...identityFixture(), dev: 0, ino: Number.MAX_SAFE_INTEGER };
    assert.equal(checkedLinuxEnvelopeIdentity(boundary), boundary);
    assert.equal(checkedLinuxEnvelopeIdentity({ ...boundary, dev: Number.MAX_SAFE_INTEGER }).dev,
        Number.MAX_SAFE_INTEGER);
});
test('LE17 E1 invalid identity refuses before cache set and preserves previous cached facts', () => {
    const prior = identityFixture(), cache = new Map([['owned', prior]]); let writes = 0;
    const observedCache = { set(key: string, value: ReturnType<typeof identityFixture>) {
        writes++; cache.set(key, value);
    } };
    for (const delta of [{ dev: 9007199254740992 }, { ino: 9007199254740992 },
        { dev: 0.5 }, { ino: 0.5 }]) {
        assert.throws(() => cacheLinuxEnvelopeIdentity(observedCache, 'owned', { ...prior, ...delta }),
            /LINUX_ENVELOPE_IDENTITY/);
        assert.equal(writes, 0); assert.equal(cache.get('owned'), prior);
    }
    const next = { ...prior, ino: 3 }; cacheLinuxEnvelopeIdentity(observedCache, 'owned', next);
    assert.equal(writes, 1); assert.equal(cache.get('owned'), next);
});
test('LE18 E1 both comparison operands and later samples validate before ancillary field comparison', () => {
    const privateAncillary = () => Object.defineProperty(identityFixture(), 'uid', {
        get() { throw Error('PRIVATE-CANARY ancillary comparison ran too early'); },
    });
    for (const compare of [sameLinuxEnvelopeFileIdentity, sameLinuxEnvelopeDirectoryIdentity]) {
        for (const delta of [{ dev: 9007199254740992 }, { ino: 9007199254740992 },
            { dev: 0.5 }, { ino: 0.5 }]) {
            assert.throws(() => compare({ ...identityFixture(), ...delta }, privateAncillary()),
                /LINUX_ENVELOPE_IDENTITY/);
            assert.throws(() => compare(privateAncillary(), { ...identityFixture(), ...delta }),
                /LINUX_ENVELOPE_IDENTITY/);
        }
        const prior = identityFixture(), next = { ...prior }; assert.equal(compare(prior, next), true);
        next.ino = 9007199254740992;
        assert.throws(() => compare(prior, next), /LINUX_ENVELOPE_IDENTITY/);
        prior.dev = 1.5;
        assert.throws(() => compare(prior, identityFixture()), /LINUX_ENVELOPE_IDENTITY/);
        assert.equal(compare(identityFixture(), { ...identityFixture(), ino: 3 }), false);
    }
});
