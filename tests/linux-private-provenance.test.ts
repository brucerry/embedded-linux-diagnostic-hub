import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createLinuxBuildRecord, validatePrivateLinuxSource, validatePrivateLinuxBuild,
    assertPublishedLinuxMetadataMode, linuxBuildJSON } from '../scripts/lib/linux-build-record.mjs';
import { validateLinuxObservationRecords, linuxObservationRecordPaths } from '../scripts/lib/linux-release-observation.ts';
import type { LinuxEnvelopePlan } from '../scripts/lib/linux-setup-envelope.ts';
import { recordLinuxBuild, linuxBuildArguments } from '../scripts/record-linux-build.mjs';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
type PrivateBuild = { schema: number; kind: string; version: string; commit: string; platform: string; arch: string;
    assets: Record<string, string>; sourceTree: string; sourceManifestSHA256: string; buildId: string;
    sourceRecordSHA256: string; archiveBytes: number; validation: { status: string; resultSHA256: string | null } };
type PublishedBuild = { version: string; commit: string; platform: string; arch: string;
    assets: Record<string, string>; validation: string };
function privateBuild(input: unknown): PrivateBuild {
    const result = createLinuxBuildRecord(input);
    assert.ok('kind' in result && result.kind === 'private-linux-build');
    return result as PrivateBuild;
}
function publishedBuild(input: unknown): PublishedBuild {
    const result = createLinuxBuildRecord(input);
    assert.equal(typeof result.validation, 'string');
    return result as PublishedBuild;
}
function fixture() {
    const source = { schema: 1, kind: 'private-linux-build-source', repository: 'brucerry/embedded-linux-diagnostic-hub',
        version: '0.6.0', commit: 'a'.repeat(40), tree: 'b'.repeat(40), sourceManifestSHA256: 'c'.repeat(64), buildId: 'd'.repeat(32) };
    const sourceBytes = encode(source), sourceRecordSHA256 = hash(sourceBytes);
    const archive = { asset: 'Diagnostic-Hub-linux-x64.tar.gz', bytes: 123, sha256: 'e'.repeat(64) };
    const assets = { 'Diagnostic-Hub-linux-x64.AppImage': 'f'.repeat(64), [archive.asset]: archive.sha256 };
    const input = { mode: 'private-build', version: source.version, commit: source.commit, assets,
        archiveBytes: archive.bytes, source, sourceRecordSHA256, validationEvidence: null };
    const build = privateBuild(input), buildBytes = encode(build);
    // The record validator consumes only these plan fields. No archive/tree/planner or IO is invoked.
    const plan = { version: source.version, sourceCommit: source.commit, archive } as LinuxEnvelopePlan;
    const selection = { mode: 'private-build', repository: source.repository, version: source.version,
        sourceCommit: source.commit, sourceTree: source.tree, sourceManifestSHA256: source.sourceManifestSHA256,
        buildId: source.buildId, archiveSHA256: archive.sha256, archiveBytes: archive.bytes,
        sourceRecordSHA256, buildRecordSHA256: hash(buildBytes) };
    const base = 'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases';
    const release = { tag_name: 'v0.6.0', target_commitish: source.commit, draft: false, prerelease: false,
        html_url: base + '/tag/v0.6.0', assets: [{ name: archive.asset, browser_download_url: base + '/download/v0.6.0/' + archive.asset }] };
    const releaseBytes = encode(release), published = publishedBuild({ ...input,
        mode: 'published-release', source: null, sourceRecordSHA256: null }), publishedBytes = encode(published);
    const publishedSelection = { repository: source.repository, tag: 'v0.6.0', version: source.version,
        sourceCommit: source.commit, archiveSHA256: archive.sha256, archiveBytes: archive.bytes,
        releaseRecordSHA256: hash(releaseBytes), buildRecordSHA256: hash(publishedBytes) };
    return { source, sourceBytes, sourceRecordSHA256, input, build, buildBytes, assets, archive, plan,
        selection, release, releaseBytes, published, publishedBytes, publishedSelection };
}
function evidence(f: ReturnType<typeof fixture>, status = 'passed', privateBuild = true) {
    const result = { schema: 1, kind: 'linux-packaged-loopback-ssh', status, version: f.source.version,
        commit: f.source.commit, buildId: privateBuild ? f.source.buildId : null, assets: f.assets };
    const bytes = encode(result); return { result, bytes, sha256: hash(bytes) };
}
test('PV1 private source and build bind exact identities without published release fields', () => {
    const f = fixture(), result = validateLinuxObservationRecords(f.plan, f.selection, f.sourceBytes, f.buildBytes);
    assert.equal(result.provenance, 'selected-unsigned-private-build-integrity');
    assert.equal(result.compiledSourceProven, false); assert.ok('sourceTree' in result);
    assert.equal(result.sourceTree, f.source.tree); assert.equal(result.buildId, f.source.buildId);
    for (const key of ['tag', 'html_url', 'draft', 'releaseRecordSHA256']) assert.equal(key in result, false);
    assert.deepEqual(f.build.validation, { status: 'unperformed', resultSHA256: null });
});
test('PV2 legacy published validation remains compatible and rejects unresolved draft duplicate or wrong URL facts', () => {
    const f = fixture();
    assert.equal(validateLinuxObservationRecords(f.plan, f.publishedSelection, f.releaseBytes, f.publishedBytes).provenance,
        'selected-unsigned-release-integrity');
    for (const delta of [{ draft: true }, { target_commitish: 'main' }, { assets: [...f.release.assets, ...f.release.assets] },
        { html_url: 'https://foreign.invalid/release' }, { tag_name: 'v0.5.2' }]) {
        const bytes = encode({ ...f.release, ...delta });
        assert.throws(() => validateLinuxObservationRecords(f.plan,
            { ...f.publishedSelection, releaseRecordSHA256: hash(bytes) }, bytes, f.publishedBytes));
    }
});
test('PV3 private and published record or selection substitutions refuse in both directions', () => {
    const f = fixture();
    assert.throws(() => validateLinuxObservationRecords(f.plan, f.selection, f.releaseBytes, f.publishedBytes));
    assert.throws(() => validateLinuxObservationRecords(f.plan, f.publishedSelection, f.sourceBytes, f.buildBytes));
    assert.throws(() => validateLinuxObservationRecords(f.plan, { ...f.selection, tag: 'v0.6.0' }, f.sourceBytes, f.buildBytes));
    assert.throws(() => validateLinuxObservationRecords(f.plan, { ...f.publishedSelection, mode: 'private-build' }, f.releaseBytes, f.publishedBytes));
    assert.throws(() => createLinuxBuildRecord({ ...f.input, mode: 'published-release' }));
    assert.throws(() => assertPublishedLinuxMetadataMode(f.build), /LINUX_PRIVATE_METADATA_NOT_RELEASE/);
    assert.doesNotThrow(() => assertPublishedLinuxMetadataMode(f.published));
    const { validation: ignored, ...historical } = f.published;
    assert.doesNotThrow(() => assertPublishedLinuxMetadataMode(historical)); // Existing five-key release fixtures stay accepted.
});
test('PV4 stale selected commit tree manifest build ID archive hash or length refuses', () => {
    const f = fixture();
    for (const delta of [{ sourceCommit: '1'.repeat(40) }, { sourceTree: '2'.repeat(40) },
        { sourceManifestSHA256: '3'.repeat(64) }, { buildId: '4'.repeat(32) },
        { archiveSHA256: '5'.repeat(64) }, { archiveBytes: f.archive.bytes + 1 }])
        assert.throws(() => validateLinuxObservationRecords(f.plan, { ...f.selection, ...delta }, f.sourceBytes, f.buildBytes));
});
test('PV5 rehashed stale private build or source facts do not bypass the independent selection', () => {
    const f = fixture();
    for (const delta of [{ commit: '1'.repeat(40) }, { sourceTree: '2'.repeat(40) },
        { sourceManifestSHA256: '3'.repeat(64) }, { buildId: '4'.repeat(32) },
        { sourceRecordSHA256: '5'.repeat(64) }, { archiveBytes: 124 }, { platform: 'darwin' },
        { assets: { ...f.assets, [f.archive.asset]: '6'.repeat(64) } }]) {
        const bytes = encode({ ...f.build, ...delta });
        assert.throws(() => validateLinuxObservationRecords(f.plan,
            { ...f.selection, buildRecordSHA256: hash(bytes) }, f.sourceBytes, bytes));
    }
    const bytes = encode({ ...f.source, buildId: '9'.repeat(32) });
    assert.throws(() => validateLinuxObservationRecords(f.plan,
        { ...f.selection, sourceRecordSHA256: hash(bytes) }, bytes, f.buildBytes));
});
test('PV6 independent record digests caps and closed private source grammar refuse malformed metadata', () => {
    const f = fixture();
    for (const delta of [{ sourceRecordSHA256: '0'.repeat(64) }, { buildRecordSHA256: '0'.repeat(64) }])
        assert.throws(() => validateLinuxObservationRecords(f.plan, { ...f.selection, ...delta }, f.sourceBytes, f.buildBytes));
    assert.throws(() => validateLinuxObservationRecords(f.plan, f.selection, Buffer.alloc(65537), f.buildBytes));
    for (const delta of [{ tree: 'main' }, { sourceManifestSHA256: 'not-a-hash' }, { buildId: '' }, { draft: false }])
        assert.throws(() => validatePrivateLinuxSource({ ...f.source, ...delta }));
    assert.throws(() => linuxBuildJSON(Buffer.alloc(0))); assert.throws(() => linuxBuildJSON(Buffer.from('{')));
});
test('PV7 absent failed and unperformed validation never becomes a verified smoke claim', () => {
    const f = fixture();
    assert.deepEqual(f.build.validation, { status: 'unperformed', resultSHA256: null });
    assert.match(f.published.validation, /^unperformed:/);
    for (const status of ['failed', 'unperformed']) {
        const e = evidence(f, status), build = privateBuild({ ...f.input, validationEvidence: { bytes: e.bytes, sha256: e.sha256 } });
        assert.equal(build.validation.status, status); assert.notEqual(build.validation.status, 'verified');
        assert.doesNotThrow(() => validatePrivateLinuxBuild(build, f.source, f.sourceRecordSHA256));
    }
});
test('PV8 verified validation requires separately selected matching result bytes for this artifact and build', () => {
    const f = fixture(), e = evidence(f), build = privateBuild({ ...f.input,
        validationEvidence: { bytes: e.bytes, sha256: e.sha256 } });
    assert.deepEqual(build.validation, { status: 'verified', resultSHA256: e.sha256 });
    const p = evidence(f, 'passed', false), published = publishedBuild({ ...f.input, mode: 'published-release',
        source: null, sourceRecordSHA256: null, validationEvidence: { bytes: p.bytes, sha256: p.sha256 } });
    assert.match(published.validation, /^verified:/); assert.ok(published.validation.includes(p.sha256));
    for (const value of [{ bytes: e.bytes }, { bytes: e.bytes, sha256: '0'.repeat(64) },
        { bytes: Buffer.alloc(65537), sha256: hash(Buffer.alloc(65537)) }])
        assert.throws(() => createLinuxBuildRecord({ ...f.input, validationEvidence: value }));
});
test('PV9 rehashed stale or cross-mode validation result refuses instead of inheriting a pass', () => {
    const f = fixture(), e = evidence(f);
    for (const delta of [{ commit: '1'.repeat(40) }, { buildId: '2'.repeat(32) }, { buildId: null },
        { version: '0.5.2' }, { assets: { ...f.assets, [f.archive.asset]: '3'.repeat(64) } }, { status: 'verified' }]) {
        const bytes = encode({ ...e.result, ...delta });
        assert.throws(() => createLinuxBuildRecord({ ...f.input, validationEvidence: { bytes, sha256: hash(bytes) } }));
    }
    assert.throws(() => validatePrivateLinuxBuild({ ...f.build, validation: { status: 'verified', resultSHA256: null } }, f.source, f.sourceRecordSHA256));
});
test('PV10 record slots select source versus release explicitly before IO and reject mixed path grammar', () => {
    const f = fixture();
    assert.equal(linuxObservationRecordPaths({ sourcePath: '/in/source', buildPath: '/in/build', selection: f.selection }).primaryKind, 'source');
    assert.equal(linuxObservationRecordPaths({ releasePath: '/in/release', buildPath: '/in/build', selection: f.publishedSelection }).primaryKind, 'release');
    assert.throws(() => linuxObservationRecordPaths({ releasePath: '/in/release', buildPath: '/in/build', selection: f.selection }));
    assert.throws(() => linuxObservationRecordPaths({ sourcePath: '/in/source', buildPath: '/in/build', selection: f.publishedSelection }));
});
function fakeIO(f: ReturnType<typeof fixture>, extra: Record<string, Buffer> = {}) {
    const calls: string[] = [], writes: { file: string; bytes: Buffer }[] = [];
    const records = { 'package.json': encode({ version: f.source.version }), '/source': f.sourceBytes, ...extra };
    return { calls, writes, async readSmall(file: string, cap: number) {
        calls.push('read:' + file); assert.equal(cap, 65536);
        const bytes = records[file as keyof typeof records]; if (!bytes) throw Error('inert missing input'); return Buffer.from(bytes);
    }, async hashAsset(file: string) {
        calls.push('hash:' + file); const name = file.slice('release/'.length);
        return { bytes: file.endsWith('.tar.gz') ? f.archive.bytes : 234, sha256: f.assets[name] };
    }, async writeRecord(file: string, bytes: Buffer) { calls.push('write:' + file); writes.push({ file, bytes: Buffer.from(bytes) }); } };
}
test('PV11 recorder import help bad arguments and missing commit cause zero injected effects', async () => {
    const f = fixture(), io = fakeIO(f);
    assert.deepEqual(await recordLinuxBuild(['--help'], {}, io), { help: true });
    for (const args of [['--unknown=x'], ['--mode=private-build'], ['--mode=private-build', '--mode=published-release'],
        ['--validation-result=/result'], ['--mode=published-release', '--source-record=/source']]) {
        assert.throws(() => linuxBuildArguments(args)); await assert.rejects(recordLinuxBuild(args, {}, io));
    }
    await assert.rejects(recordLinuxBuild([], { GITHUB_SHA: 'main' }, io)); assert.deepEqual(io.calls, []);
});
test('PV12 recorder produces truthful published default and exact private metadata using memory effects only', async () => {
    const f = fixture(), io = fakeIO(f);
    const published = await recordLinuxBuild([], { GITHUB_SHA: f.source.commit }, io);
    assert.ok('validation' in published && typeof published.validation === 'string');
    assert.match(published.validation, /^unperformed:/); assert.equal(io.writes.length, 1);
    const p = fakeIO(f), result = await recordLinuxBuild(['--mode=private-build', '--source-record=/source',
        '--source-record-sha256=' + f.sourceRecordSHA256], { GITHUB_SHA: f.source.commit }, p);
    assert.deepEqual(result, f.build); assert.equal(p.writes.length, 1);
    assert.equal(p.writes[0].file, 'release/linux-build-info.json'); assert.deepEqual(JSON.parse(p.writes[0].bytes.toString()), f.build);
    assert.equal(validateLinuxObservationRecords(f.plan, { ...f.selection, buildRecordSHA256: hash(p.writes[0].bytes) }, f.sourceBytes, p.writes[0].bytes).compiledSourceProven, false);
});
test('PV13 recorder rejects stale source or validation before publication and stops after a write failure', async () => {
    const f = fixture(), args = ['--mode=private-build', '--source-record=/source', '--source-record-sha256=' + '0'.repeat(64)];
    const io = fakeIO(f); await assert.rejects(recordLinuxBuild(args, { GITHUB_SHA: f.source.commit }, io));
    assert.deepEqual(io.calls, ['read:package.json', 'read:/source']); assert.equal(io.writes.length, 0);
    const e = evidence(f), p = fakeIO(f, { '/result': e.bytes });
    await assert.rejects(recordLinuxBuild(['--validation-result=/result', '--validation-sha256=' + e.sha256],
        { GITHUB_SHA: f.source.commit }, p)); // A private result cannot attest the published-mode null buildId.
    assert.equal(p.writes.length, 0);
    const q = fakeIO(f); let writes = 0;
    q.writeRecord = async () => { writes++; throw Error('inert write failure'); };
    await assert.rejects(recordLinuxBuild([], { GITHUB_SHA: f.source.commit }, q)); assert.equal(writes, 1);
    assert.equal(q.calls.filter(x => x.startsWith('hash:')).length, 2);
});
test('PV14 stable private comparison facts survive caller mutation and malformed acknowledgements refuse', async () => {
    const f = fixture(), saved = privateBuild(f.input); f.source.tree = '9'.repeat(40);
    f.input.assets[f.archive.asset] = '8'.repeat(64);
    assert.equal(saved.sourceTree, 'b'.repeat(40)); assert.equal(saved.assets[f.archive.asset], 'e'.repeat(64));
    const g = fixture(), io = fakeIO(g);
    const malformed = { ...io, writeRecord: async () => true };
    await assert.rejects(recordLinuxBuild([], { GITHUB_SHA: g.source.commit }, malformed), /LINUX_BUILD_WRITE_ACK/);
});
test('PV15 recorder links independently selected passed or failed private result without running a smoke test', async () => {
    for (const status of ['passed', 'failed']) {
        const f = fixture(), e = evidence(f, status), io = fakeIO(f, { '/result': e.bytes });
        await recordLinuxBuild(['--mode=private-build', '--source-record=/source',
            '--source-record-sha256=' + f.sourceRecordSHA256, '--validation-result=/result',
            '--validation-sha256=' + e.sha256], { GITHUB_SHA: f.source.commit }, io);
        assert.equal(io.writes.length, 1);
        const record = JSON.parse(io.writes[0].bytes.toString());
        assert.equal(record.validation.status, status === 'passed' ? 'verified' : 'failed');
        assert.equal(record.validation.resultSHA256, e.sha256);
        const selected = validateLinuxObservationRecords(f.plan,
            { ...f.selection, buildRecordSHA256: hash(io.writes[0].bytes) }, f.sourceBytes, io.writes[0].bytes);
        assert.equal(selected.provenance, 'selected-unsigned-private-build-integrity');
        assert.equal(selected.compiledSourceProven, false);
        assert.equal(io.calls.filter(x => x.startsWith('hash:')).length, 2);
    }
});
test('PV16 declared SHA256 option names parse with exact values while mode and pairing checks remain enforced', () => {
    const sourceHash = 'a'.repeat(64), validationHash = 'b'.repeat(64);
    assert.deepEqual(linuxBuildArguments(['--mode=private-build', '--source-record=/source',
        '--source-record-sha256=' + sourceHash, '--validation-result=/result', '--validation-sha256=' + validationHash]),
        { mode: 'private-build', 'source-record': '/source', 'source-record-sha256': sourceHash,
            'validation-result': '/result', 'validation-sha256': validationHash });
    assert.deepEqual(linuxBuildArguments(['--validation-result=/result', '--validation-sha256=' + validationHash]),
        { mode: 'published-release', 'validation-result': '/result', 'validation-sha256': validationHash });
    for (const args of [['--mode=private-build', '--source-record=/source'],
        ['--mode=private-build', '--source-record-sha256=' + sourceHash],
        ['--source-record=/source', '--source-record-sha256=' + sourceHash],
        ['--validation-sha256=' + validationHash], ['--mode=unknown']])
        assert.throws(() => linuxBuildArguments(args), /LINUX_BUILD_ARGUMENTS/);
});
test('PV17 digit token support does not accept unknown malformed duplicate or invalid hash options', () => {
    const good = ['--mode=private-build', '--source-record=/source', '--source-record-sha256=' + 'a'.repeat(64)];
    for (const arg of ['--unknown256=value', '--source-record-sha257=' + 'a'.repeat(64),
        '--source_record_sha256=' + 'a'.repeat(64), '--SOURCE-record=value', '--source-record-sha256',
        '--source-record-sha256=', '--source-record-sha256 =value', '--=value', 'source-record=value'])
        assert.throws(() => linuxBuildArguments([arg]), /LINUX_BUILD_ARGUMENTS/);
    for (const args of [[...good, '--source-record=/other'], [...good, '--source-record-sha256=' + 'b'.repeat(64)],
        ['--mode=private-build', '--source-record=/source', '--source-record-sha256=' + 'A'.repeat(64)],
        ['--mode=private-build', '--source-record=/source', '--source-record-sha256=' + 'a'.repeat(63)],
        ['--validation-result=/result', '--validation-sha256=' + 'z'.repeat(64)]])
        assert.throws(() => linuxBuildArguments(args), /LINUX_BUILD_ARGUMENTS/);
});
