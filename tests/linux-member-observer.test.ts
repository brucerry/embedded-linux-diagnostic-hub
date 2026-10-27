import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { LinuxTarCensus, LINUX_ARCHIVE_LIMITS, observeLinuxGzipTar,
    linuxObservationWindow } from '../scripts/lib/linux-archive-members.mjs';
import { planLinuxReviewEnvelope } from '../scripts/lib/linux-setup-envelope.ts';
import { validateLinuxObservationRecords, assertLinuxObservedMembers,
    assertLinuxObservedDescriptor, normalizeLinuxPackagerCensus } from '../scripts/lib/linux-release-observation.ts';
import { createLinuxReviewCapability } from '../scripts/lib/linux-review-package.mjs';
import packaging from '../scripts/lib/linux-review-after-pack.cjs';
const hash = (x: Buffer | string) => createHash('sha256').update(x).digest('hex');
function checksum(header: Buffer) {
    header.fill(32, 148, 156); let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii'); return header;
}
function header(name: string, size = 0, type = '0', mode = 0o644) {
    const h = Buffer.alloc(512); h.write(name, 0, 100, 'utf8');
    const octal = (at: number, length: number, value: number) =>
        h.write(value.toString(8).padStart(length - 1, '0') + '\0', at, length, 'ascii');
    octal(100, 8, mode); octal(108, 8, 1000); octal(116, 8, 1000);
    octal(124, 12, size); octal(136, 12, 1); h[156] = type.charCodeAt(0);
    h.write('ustar\0', 257, 6, 'ascii'); h.write('00', 263, 2, 'ascii'); return checksum(h);
}
function tar(items: { path: string; body?: Buffer; type?: string; mode?: number }[]) {
    const parts: Buffer[] = [];
    for (const item of items) {
        const bytes = item.body ?? Buffer.alloc(0), type = item.type ?? '0';
        parts.push(header(item.path, bytes.length, type, item.mode ?? (type === '5' ? 0o755 : 0o644)), bytes,
            Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    parts.push(Buffer.alloc(1024)); return Buffer.concat(parts);
}
function parse(bytes: Buffer, chunk = 17) {
    const parser = new LinuxTarCensus();
    for (let at = 0; at < bytes.length; at += chunk) parser.push(bytes.subarray(at, at + chunk));
    return parser.finish();
}
async function* pieces(bytes: Buffer, chunk = 31) {
    for (let at = 0; at < bytes.length; at += chunk) yield bytes.subarray(at, at + chunk);
}
function window(now = () => 1000) {
    return linuxObservationWindow({ requestId: 'a'.repeat(32), startedMs: 0, deadlineMs: 120000, now });
}
function fixture() {
    const code = Buffer.from('/* inert review fixture */');
    const bodies: Record<string, Buffer> = { AppRun: Buffer.from('inert portable AppRun'),
        'diagnostic-hub': Buffer.from('inert runtime'), 'resources/app.asar': Buffer.from('inert ASAR'),
        'resources/linux-setup-review.cjs': code,
        'resources/linux-setup-review.json': Buffer.from(JSON.stringify(createLinuxReviewCapability('0.6.0', code)) + '\n') };
    const files = Object.keys(bodies).sort().map(path => ({ path, bytes: bodies[path].length, sha256: hash(bodies[path]),
        mode: ['AppRun', 'diagnostic-hub'].includes(path) ? 0o755 : path.endsWith('.json') ? 0o600 : 0o644 }));
    const raw = tar([{ path: 'resources/', type: '5', mode: 0o700 },
        ...files.map(file => ({ path: file.path, body: bodies[file.path], mode: file.mode }))]);
    const compressed = gzipSync(raw), archive = { asset: 'Diagnostic-Hub-linux-x64.tar.gz', bytes: compressed.length, sha256: hash(compressed) };
    const input = { platform: 'linux', arch: 'x64', uid: 1000, euid: 1000, home: '/home/fixture',
        sourceRoot: '/home/fixture/flat', outputRoot: '/home/fixture/envelope', archivePath: '/home/fixture/input.tar.gz',
        layout: 'flat-linux-portable', version: '0.6.0', sourceCommit: 'b'.repeat(40), archive, files,
        inventorySHA256: hash(JSON.stringify(files)) };
    const plan = planLinuxReviewEnvelope(input), base = 'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases';
    const release = { tag_name: 'v0.6.0', target_commitish: input.sourceCommit, draft: false, prerelease: false,
        html_url: base + '/tag/v0.6.0', assets: [{ name: archive.asset, browser_download_url: base + '/download/v0.6.0/' + archive.asset }] };
    const build = { version: '0.6.0', commit: input.sourceCommit, platform: 'linux', arch: 'x64',
        assets: { 'Diagnostic-Hub-linux-x64.AppImage': 'c'.repeat(64), 'Diagnostic-Hub-linux-x64.tar.gz': archive.sha256 },
        validation: 'Synthetic metadata only; no app was executed.' };
    const releaseBytes = Buffer.from(JSON.stringify(release)), buildBytes = Buffer.from(JSON.stringify(build));
    const selection = { repository: 'brucerry/embedded-linux-diagnostic-hub', tag: 'v0.6.0', version: '0.6.0',
        sourceCommit: input.sourceCommit, archiveSHA256: archive.sha256, archiveBytes: archive.bytes,
        releaseRecordSHA256: hash(releaseBytes), buildRecordSHA256: hash(buildBytes) };
    return { bodies, files, raw, compressed, archive, input, plan, release, build, releaseBytes, buildBytes, selection };
}
test('AO1 strict ustar derives actual body hashes and canonical census across byte boundaries', () => {
    const f = fixture();
    for (const chunk of [1, 17, 511, 512, 65536]) {
        const census = parse(f.raw, chunk);
        assert.equal(census.files, 5); assert.equal(census.directories, 1);
        assert.equal(census.payloadBytes, f.files.reduce((n, file) => n + file.bytes, 0));
        assertLinuxObservedMembers(f.plan, census.entries);
    }
});
test('AO2 gzip observer hashes exact compressed chunks and validates complete decoded census', async () => {
    const f = fixture();
    for (const chunk of [1, 31, 65536]) {
        const census = await observeLinuxGzipTar(pieces(f.compressed, chunk), f.archive, window());
        assert.equal(census.compressedBytes, f.compressed.length); assert.equal(census.compressedSHA256, hash(f.compressed));
        assertLinuxObservedMembers(f.plan, census.entries);
    }
});
test('AO3 malformed tar checksum numeric fields magic version or reserved header bytes refuse', () => {
    const mutations = [
        (h: Buffer) => { h[0] ^= 1; },
        (h: Buffer) => { h[124] = 0x80; checksum(h); },
        (h: Buffer) => { h.write('-1\0', 124); checksum(h); },
        (h: Buffer) => { h.write('9', 100); checksum(h); },
        (h: Buffer) => { h.write('ustar ', 257); checksum(h); },
        (h: Buffer) => { h.write('01', 263); checksum(h); },
        (h: Buffer) => { h[500] = 1; checksum(h); },
    ];
    for (const mutate of mutations) { const h = header('file'); mutate(h); assert.throws(() => parse(Buffer.concat([h, Buffer.alloc(1024)]))); }
});
test('AO4 traversal UTF8 path aliases duplicates and file-directory collisions refuse without normalization bypass', () => {
    for (const name of ['../escape', '/absolute', 'a//b', 'a/../b', 'C:/drive', 'back\\slash'])
        assert.throws(() => parse(tar([{ path: name }])));
    const h = header('file'); h[0] = 0xff; checksum(h);
    assert.throws(() => parse(Buffer.concat([h, Buffer.alloc(1024)])), /TAR_UTF8/);
    for (const items of [[{ path: 'same' }, { path: 'same' }], [{ path: 'a' }, { path: 'a/b' }],
        [{ path: 'a/b' }, { path: 'a' }], [{ path: '\u00e9' }, { path: 'e\u0301' }]])
        assert.throws(() => parse(tar(items)));
    const bom = parse(tar([{ path: '\ufefffile' }])); assert.equal(bom.entries[0].path, '\ufefffile');
});
test('AO5 unsupported tar links extensions special modes directory bodies and absent parents refuse', () => {
    for (const type of ['1', '2', '3', '4', '6', 'L', 'K', 'x', 'g', 'S'])
        assert.throws(() => parse(tar([{ path: 'file', type }])));
    for (const mode of [0o4755, 0o2755, 0o777, 0o000])
        assert.throws(() => parse(tar([{ path: 'file', mode }])));
    assert.throws(() => parse(tar([{ path: 'directory/', type: '5', body: Buffer.from('x') }])));
    assert.throws(() => parse(tar([{ path: 'missing/file' }])) , /TAR_DIRECTORY_MISSING/);
});
test('AO6 missing ends truncated bodies nonzero padding or trailing data and excessive zero tails refuse', () => {
    const raw = tar([{ path: 'file', body: Buffer.from('abc') }]);
    for (const bytes of [raw.subarray(0, 512 + 2), raw.subarray(0, raw.length - 512),
        Buffer.concat([raw, Buffer.alloc(512, 1)]), Buffer.concat([raw, Buffer.alloc(10240)])])
        assert.throws(() => parse(bytes));
    const padding = Buffer.from(raw); padding[515] = 1; assert.throws(() => parse(padding), /TAR_PADDING/);
});
test('AO7 payload byte cap refuses before body allocation', () => {
    const oversized = header('file', LINUX_ARCHIVE_LIMITS.payload + 1);
    assert.throws(() => parse(Buffer.concat([oversized, Buffer.alloc(1024)])), /TAR_PAYLOAD_CAP/);
});
test('AO19 file count cap reports TAR_COUNT at the unchanged boundary independently', () => {
    const parser = new LinuxTarCensus(); let refused = false;
    for (let n = 0; n <= 20000; n++) {
        try { parser.push(header('entry' + n, 0, '0', 0o600)); }
        catch (error) { assert.match(String(error), /TAR_COUNT/); refused = true; break; }
    }
    assert.equal(refused, true);
});
test('AO20 directory count cap reports TAR_COUNT at the unchanged boundary independently', () => {
    const parser = new LinuxTarCensus(); let refused = false;
    for (let n = 0; n <= 20000; n++) {
        try { parser.push(header('entry' + n + '/', 0, '5', 0o700)); }
        catch (error) { assert.match(String(error), /TAR_COUNT/); refused = true; break; }
    }
    assert.equal(refused, true);
});
test('AO21 census control cap reports TAR_CONTROL_CAP independently of count assertions', () => {
    const parser = new LinuxTarCensus(); let control = false;
    for (let n = 0; n < 20000; n++) {
        try { parser.push(header(('long' + n).padEnd(100, 'x'), 0, '0', 0o600)); }
        catch (error) { assert.match(String(error), /TAR_CONTROL_CAP/); control = true; break; }
    }
    assert.equal(control, true);
});
test('AO8 malformed truncated gzip CRC or size trailers refuse despite matching expected compressed hash', async () => {
    const f = fixture(), crc = Buffer.from(f.compressed), size = Buffer.from(f.compressed), magic = Buffer.from(f.compressed);
    crc[crc.length - 8] ^= 1; size[size.length - 4] ^= 1; magic[0] = 0;
    for (const bytes of [crc, size, magic, f.compressed.subarray(0, 5), f.compressed.subarray(0, f.compressed.length - 1)])
        await assert.rejects(observeLinuxGzipTar(pieces(bytes), { bytes: bytes.length, sha256: hash(bytes) }, window()));
});
test('AO9 gzip concatenated members and trailing garbage or zeros cannot pass full consumption policy', async () => {
    const f = fixture();
    for (const tail of [gzipSync(Buffer.alloc(0)), gzipSync(Buffer.from('extra')), Buffer.from('junk'), Buffer.alloc(8)]) {
        const bytes = Buffer.concat([f.compressed, tail]);
        await assert.rejects(observeLinuxGzipTar(pieces(bytes), { bytes: bytes.length, sha256: hash(bytes) }, window()));
    }
});
test('AO10 compressed identity chunk overflow and mutated expected arguments never alter private comparisons', async () => {
    const f = fixture();
    for (const expected of [{ bytes: f.compressed.length - 1, sha256: hash(f.compressed) },
        { bytes: f.compressed.length + 1, sha256: hash(f.compressed) }, { bytes: f.compressed.length, sha256: '0'.repeat(64) }])
        await assert.rejects(observeLinuxGzipTar(pieces(f.compressed), expected, window()));
    const large = Buffer.alloc(65537);
    await assert.rejects(observeLinuxGzipTar(pieces(large, large.length), { bytes: large.length, sha256: hash(large) }, window()));
    const expected = { bytes: f.compressed.length, sha256: hash(f.compressed) };
    const pending = observeLinuxGzipTar(pieces(f.compressed), expected, window());
    expected.bytes++; expected.sha256 = '0'.repeat(64);
    assert.equal((await pending).compressedSHA256, hash(f.compressed));
});
test('AO11 original window failures input exceptions and late returned chunks stop without private error disclosure', async () => {
    const f = fixture(); let reads = 0, clocks = 0;
    const expired = window(() => ++clocks < 4 ? 1000 : 120000);
    const input = { [Symbol.asyncIterator]() { return { async next() { reads++; return { done: false, value: f.compressed }; } }; } };
    await assert.rejects(observeLinuxGzipTar(input, f.archive, expired)); assert.ok(reads <= 1);
    async function* failed() { yield f.compressed.subarray(0, 1); throw Error('PRIVATE-CANARY sensitive provider error'); }
    await assert.rejects(observeLinuxGzipTar(failed(), f.archive, window()), error => {
        assert.ok(!String(error).includes('PRIVATE-CANARY')); return true;
    });
    const reverse = linuxObservationWindow({ requestId: 'a'.repeat(32), startedMs: 1, deadlineMs: 120001, now: () => 0 });
    assert.throws(() => reverse.check(), /OBSERVATION_DEADLINE/);
});
test('AO12 actual record bytes bind selected repository tag source archive and digests without invented signing', () => {
    const f = fixture(), result = validateLinuxObservationRecords(f.plan, f.selection, f.releaseBytes, f.buildBytes);
    assert.equal(result.archiveSHA256, hash(f.compressed)); assert.equal(result.sourceCommit, 'b'.repeat(40));
    assert.ok(result.provenance === 'selected-unsigned-release-integrity');
    assert.equal(result.releaseRecordSHA256, hash(f.releaseBytes)); assert.equal(result.buildRecordSHA256, hash(f.buildBytes));
    assert.equal(result.provenance, 'selected-unsigned-release-integrity'); assert.equal(result.compiledSourceProven, false);
});
test('AO13 mismatched missing oversized duplicate or unresolved release and build facts refuse', () => {
    const f = fixture();
    for (const delta of [{ repository: 'foreign/repo' }, { tag: 'v0.5.2' }, { sourceCommit: 'main' },
        { archiveSHA256: '0'.repeat(64) }, { archiveBytes: f.archive.bytes + 1 }, { releaseRecordSHA256: '0'.repeat(64) }])
        assert.throws(() => validateLinuxObservationRecords(f.plan, { ...f.selection, ...delta }, f.releaseBytes, f.buildBytes));
    for (const release of [{ ...f.release, target_commitish: 'main' }, { ...f.release, draft: true },
        { ...f.release, assets: [] }, { ...f.release, assets: [...f.release.assets, ...f.release.assets] },
        { ...f.release, tag_name: 'v0.5.2' }]) {
        const bytes = Buffer.from(JSON.stringify(release));
        assert.throws(() => validateLinuxObservationRecords(f.plan, { ...f.selection, releaseRecordSHA256: hash(bytes) }, bytes, f.buildBytes));
    }
    const build = Buffer.from(JSON.stringify({ ...f.build, platform: 'win32' }));
    assert.throws(() => validateLinuxObservationRecords(f.plan, { ...f.selection, buildRecordSHA256: hash(build) }, f.releaseBytes, build));
    assert.throws(() => validateLinuxObservationRecords(f.plan, f.selection, Buffer.alloc(65537), f.buildBytes));
});
test('AO14 observed archive and prepared tree bodies modes inventory or descriptor mismatches refuse', () => {
    const f = fixture(), census = parse(f.raw);
    assertLinuxObservedMembers(f.plan, census.entries); assertLinuxObservedDescriptor(f.plan, Buffer.from(f.plan.descriptor));
    for (const delta of [{ sha256: '0'.repeat(64) }, { bytes: 999 }, { mode: 0o777 }, { path: '../escape' }, { kind: 'link' }]) {
        const entries = structuredClone(census.entries), file = entries.find(entry => entry.kind === 'file')!;
        Object.assign(file, delta); assert.throws(() => assertLinuxObservedMembers(f.plan, entries));
    }
    const coercion = structuredClone(census.entries), file = coercion.find(entry => entry.kind === 'file')!;
    const originalBytes = file.bytes; file.bytes = { toJSON: () => originalBytes };
    assert.throws(() => assertLinuxObservedMembers(f.plan, coercion));
    assert.throws(() => assertLinuxObservedMembers(f.plan, census.entries.slice(1)));
    assert.throws(() => assertLinuxObservedDescriptor(f.plan, Buffer.from(f.plan.descriptor + ' ')));
});
test('AO15 real helper handoff still refuses and explicit observer export is never invoked by defaults', async () => {
    assert.equal(typeof packaging.observeReviewEnvelope, 'function');
    const f = fixture(), refused = await packaging.reviewEnvelopeHandoff(f.input, {});
    assert.equal(refused.reason, 'provenance-unavailable'); assert.equal(refused.handoffAllowed, false);
    assert.deepEqual(Object.keys(packaging).sort(), ['createReviewPackager', 'observeReviewEnvelope', 'prepareReviewEnvelope', 'reviewEnvelopeHandoff']);
});

// Hand-encoded fixtures mirror reviewed node-tar portable header omissions; no writer is invoked.
function portableHeader(name: string, size = 0, type = '0', mode = 0o644) {
    const h = header(name, size, type, mode);
    h.fill(0, 108, 124); // Optional UID/GID omitted by portable:true.
    if (type === '5') h.fill(0, 136, 148); // Only directory mtime is omitted.
    return checksum(h);
}
function packagerFixture() {
    const f = fixture(), root = f.archive.asset.slice(0, -'.tar.gz'.length), parts: Buffer[] = [];
    parts.push(portableHeader(root + '/', 0, '5', 0o755));
    parts.push(portableHeader(root + '/resources/', 0, '5', 0o700));
    for (const file of f.files) {
        const bytes = f.bodies[file.path];
        parts.push(portableHeader(root + '/' + file.path, bytes.length, '0', file.mode), bytes,
            Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    parts.push(Buffer.alloc(1024));
    const raw = Buffer.concat(parts), compressed = gzipSync(raw),
        archive = { ...f.archive, bytes: compressed.length, sha256: hash(compressed) };
    const input = { ...f.input, archive }, plan = planLinuxReviewEnvelope(input);
    const build = { ...f.build, assets: { ...f.build.assets, 'Diagnostic-Hub-linux-x64.tar.gz': archive.sha256 } },
        buildBytes = Buffer.from(JSON.stringify(build));
    const selection = { ...f.selection, archiveSHA256: archive.sha256, archiveBytes: archive.bytes,
        buildRecordSHA256: hash(buildBytes) };
    const census = { ...parse(raw), compressedBytes: compressed.length, compressedSHA256: archive.sha256 };
    return { ...f, root, raw, compressed, archive, input, plan, build, buildBytes, selection, census };
}
test('AO16 R1R2 established portable headers and fixed wrapper map actual gzip body facts to flat payload', async () => {
    const f = packagerFixture(), census = await observeLinuxGzipTar(pieces(f.compressed), f.archive, window());
    const before = JSON.stringify(census), mapped = normalizeLinuxPackagerCensus(census, f.archive.asset);
    assert.equal(mapped.rootName, 'Diagnostic-Hub-linux-x64'); assert.equal(mapped.archiveRoot.kind, 'directory');
    assert.equal(mapped.archiveRoot.path, f.root); assert.deepEqual(mapped.actualEntries, census.entries);
    assert.equal(census.files, 5); assert.equal(census.directories, 2);
    assert.equal(mapped.archiveDirectories, 2); assert.equal(mapped.directories, 1);
    assert.equal(mapped.payloadEntries.length + 1, census.entries.length);
    assertLinuxObservedMembers(f.plan, mapped.payloadEntries);
    assert.equal(mapped.actualEntriesSHA256, hash(JSON.stringify(mapped.actualEntries)));
    assert.equal(mapped.payloadEntriesSHA256, hash(JSON.stringify(mapped.payloadEntries)));
    assert.equal(JSON.stringify(census), before); // Mapping preserves actual archive facts/counters.
    assert.equal(census.expandedBytes, f.raw.length); assert.equal(census.compressedBytes, f.compressed.length);
    validateLinuxObservationRecords(f.plan, f.selection, f.releaseBytes, f.buildBytes);
});
test('AO17 R1 only omitted portable metadata accepts NUL while required or malformed numeric fields refuse', () => {
    const numericFields = [{ at: 108, length: 8, directory: false }, { at: 116, length: 8, directory: false },
        { at: 136, length: 12, directory: true }];
    for (const field of numericFields) {
        for (const bad of ['space', 'mixed', 'signed', 'base256', 'non-octal']) {
            const name = field.directory ? 'dir/' : 'file', type = field.directory ? '5' : '0';
            const h = portableHeader(name, 0, type, field.directory ? 0o700 : 0o600);
            if (bad === 'space') h.fill(32, field.at, field.at + field.length);
            else if (bad === 'mixed') h[field.at] = 32;
            else if (bad === 'signed') h.write('-1', field.at, 2, 'ascii');
            else if (bad === 'base256') h[field.at] = 128;
            else h.write('8', field.at, 1, 'ascii');
            checksum(h);
            const child = field.directory ? portableHeader('dir/file', 0, '0', 0o600) : Buffer.alloc(0);
            assert.throws(() => parse(Buffer.concat([h, child, Buffer.alloc(1024)])), /TAR_NUMBER/);
        }
    }
    for (const [at, length] of [[100, 8], [124, 12], [148, 8], [136, 12]]) {
        const h = portableHeader('file', 0, '0', 0o600); h.fill(0, at, at + length);
        if (at !== 148) checksum(h); // Blank checksum itself must never be repaired by this fixture.
        assert.throws(() => parse(Buffer.concat([h, Buffer.alloc(1024)])), /TAR_NUMBER/);
    }
});
test('AO18 R2 wrong mixed sibling or aliased wrappers and mapped extra content refuse without cap expansion', () => {
    const f = packagerFixture();
    type Census = typeof f.census;
    const recount = (c: Census) => {
        c.files = c.entries.filter(entry => entry.kind === 'file').length;
        c.directories = c.entries.length - c.files;
        c.payloadBytes = c.entries.reduce((n, entry) => n + (entry.kind === 'file' ? entry.bytes : 0), 0);
    };
    const check = (c: Census) => {
        const mapped = normalizeLinuxPackagerCensus(c, f.archive.asset);
        assertLinuxObservedMembers(f.plan, mapped.payloadEntries);
    };
    const mutations: ((c: Census) => void)[] = [
        c => { for (const entry of c.entries) entry.path = entry.path.replace(f.root, 'Wrong-root'); },
        c => { c.entries.push({ kind: 'file', path: 'orphan', mode: 0o600, bytes: 0, sha256: hash('') }); },
        c => { c.entries.push({ kind: 'directory', path: 'Sibling-root', mode: 0o700 }); },
        c => { c.entries.find(entry => entry.kind === 'file')!.path = f.root + '/../escape'; },
        c => { c.entries.push(structuredClone(c.entries.find(entry => entry.path === f.root)!)); },
        c => { c.entries.push({ kind: 'file', path: f.root + '/unexpected', mode: 0o600, bytes: 0, sha256: hash('') }); },
        c => { c.entries.push({ kind: 'directory', path: f.root + '/empty-extra', mode: 0o700 }); },
        c => { const root = c.entries.find(entry => entry.path === f.root)!;
            Object.assign(root, { kind: 'file', mode: 0o600, bytes: 0, sha256: hash('') }); },
        c => { c.entries.push({ kind: 'file', path: f.root + '/\u00e9', mode: 0o600, bytes: 0, sha256: hash('') },
            { kind: 'file', path: f.root + '/e\u0301', mode: 0o600, bytes: 0, sha256: hash('') }); },
        c => { c.entries.push({ kind: 'file', path: f.root + '/collision', mode: 0o600, bytes: 0, sha256: hash('') },
            { kind: 'file', path: f.root + '/collision/leaf', mode: 0o600, bytes: 0, sha256: hash('') }); },
    ];
    for (const mutate of mutations) {
        const c = structuredClone(f.census); mutate(c); recount(c); assert.throws(() => check(c));
    }
    const flat = fixture(), flatCensus = { ...parse(flat.raw), compressedBytes: flat.compressed.length, compressedSHA256: flat.archive.sha256 };
    assert.throws(() => normalizeLinuxPackagerCensus(flatCensus, flat.archive.asset));
    assert.throws(() => normalizeLinuxPackagerCensus(f.census, 'Other-linux-x64.tar.gz'));
    for (const delta of [{ directories: 20001 }, { files: 20001 }, { expandedBytes: Number.MAX_SAFE_INTEGER }])
        assert.throws(() => normalizeLinuxPackagerCensus({ ...f.census, ...delta }, f.archive.asset));
    assert.equal(LINUX_ARCHIVE_LIMITS.directories, 20000); assert.equal(LINUX_ARCHIVE_LIMITS.entries, 40000);
});
