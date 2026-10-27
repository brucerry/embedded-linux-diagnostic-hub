import assert from 'node:assert/strict';
import test from 'node:test';
import { LINUX_CI_SOURCE, LINUX_CI_LIMITS, LINUX_CI_ASSETS, LINUX_CI_METADATA,
    validateLinuxCIInput, artifactOnlyDispatch, requireLinuxCISpace,
    accountLinuxCIUpload, verifyLinuxCIUploadReadback, inventoryLinuxCIFlat, privateLinuxCIRecord, ciJSON, ciHash } from '../scripts/lib/linux-artifact-ci.mjs';
import { linuxCIPhase } from '../scripts/linux-artifact-ci.mjs';
const input = () => ({ event: 'workflow_dispatch', artifactOnly: true,
    repository: 'brucerry/embedded-linux-diagnostic-hub', appSHA: 'a'.repeat(40),
    workflowSHA: 'b'.repeat(40), buildId: 'c'.repeat(32), runId: '1234', runAttempt: '1' });
const entries = () => [...LINUX_CI_ASSETS, ...Object.keys(LINUX_CI_METADATA)]
    .map(name => ({ name, bytes: 100, sha256: 'd'.repeat(64) }));
test('AC1 only explicit manual artifact mode admits the new path without normal-event fallback', () => {
    assert.equal(artifactOnlyDispatch('workflow_dispatch', true), true);
    for (const event of ['push', 'pull_request', 'workflow_call', 'unknown']) assert.equal(artifactOnlyDispatch(event, true), false);
    for (const flag of [false, undefined, 'true', 1]) assert.equal(artifactOnlyDispatch('workflow_dispatch', flag), false);
    assert.deepEqual(validateLinuxCIInput(input()), input());
});
test('AC2 commit separation first-attempt identity repository and fixed source cohort fail closed', () => {
    for (const delta of [{ appSHA: 'b'.repeat(40) }, { appSHA: 'main' }, { workflowSHA: 'main' },
        { runAttempt: '2' }, { repository: 'foreign/repo' }, { runId: 1234 }, { runId: '../x' },
        { buildId: '../../other' }, { artifactOnly: false }, { event: 'push' }])
        assert.throws(() => validateLinuxCIInput({ ...input(), ...delta }), /CI_INPUT/);
    assert.equal(LINUX_CI_SOURCE.files, 709); assert.equal(LINUX_CI_SOURCE.bytes, 7203931);
    assert.equal(LINUX_CI_SOURCE.sha256, 'f6e61516aad735db21487bcef0ce6a25ea70874c0916e3e44b4d3dec6e735ef3');
});
test('AC3 dependency and package headroom use exact bigint comparisons and reject insufficient or malformed capacity', () => {
    for (const [phase, cap] of [['dependencies', LINUX_CI_LIMITS.beforeDependencies], ['package', LINUX_CI_LIMITS.beforePackage]] as const) {
        assert.equal(requireLinuxCISpace(BigInt(cap), phase).requiredBytes, cap);
        assert.throws(() => requireLinuxCISpace(BigInt(cap) - 1n, phase), /CI_SPACE/);
    }
    for (const value of [-1n, 16, NaN, '17179869184']) assert.throws(() => requireLinuxCISpace(value, 'dependencies'), /CI_SPACE/);
    assert.throws(() => requireLinuxCISpace(99n, 'unknown'), /CI_SPACE/);
});
test('AC4 asset staging requires actual copy bytes plus preserved reserve and metadata allowance', () => {
    const assets = 2 * LINUX_CI_LIMITS.asset, required = assets + LINUX_CI_LIMITS.copyReserve + LINUX_CI_LIMITS.metadata;
    assert.equal(requireLinuxCISpace(BigInt(required), 'copy', assets).requiredBytes, required);
    assert.throws(() => requireLinuxCISpace(BigInt(required) - 1n, 'copy', assets), /CI_SPACE/);
    for (const n of [-1, 1.5, assets + 1]) assert.throws(() => requireLinuxCISpace(BigInt(required), 'copy', n), /CI_SPACE/);
});
test('AC5 every asset has an exact finite two-GiB cap without allocating payload buffers', () => {
    const files = entries(); files[0].bytes = LINUX_CI_LIMITS.asset; files[1].bytes = LINUX_CI_LIMITS.asset;
    assert.equal(accountLinuxCIUpload(files).assetBytes, 2 * LINUX_CI_LIMITS.asset);
    for (const n of [0, -1, 1.5, LINUX_CI_LIMITS.asset + 1, Number.MAX_SAFE_INTEGER]) {
        const bad = entries(); bad[0].bytes = n; assert.throws(() => accountLinuxCIUpload(bad));
    }
});
test('AC6 per-metadata limits include the whole serialized accounting file and exact aggregate totals', () => {
    const files = entries(), record = accountLinuxCIUpload(files);
    assert.equal(record.metadataBytes, Object.keys(LINUX_CI_METADATA).length * 100);
    assert.equal(record.totalBytes, files.length * 100);
    for (const [name, cap] of Object.entries(LINUX_CI_METADATA)) {
        const bad = entries(); bad.find(v => v.name === name)!.bytes = cap + 1;
        assert.throws(() => accountLinuxCIUpload(bad), /CI_METADATA_CAP/);
    }
    const noAccounting = files.filter(v => v.name !== 'upload-accounting.json');
    assert.equal(accountLinuxCIUpload(noAccounting, true).files.length + 1, files.length);
    assert.throws(() => accountLinuxCIUpload(noAccounting));
});
test('AC7 unknown missing duplicate case-alias or traversal upload names cannot enter an allowlisted cohort', () => {
    for (const name of ['../secret', '.hidden', 'unknown.json', 'diagnostic-hub-linux-x64.tar.gz']) {
        const bad = entries(); bad[0].name = name; assert.throws(() => accountLinuxCIUpload(bad), /CI_UPLOAD/);
    }
    assert.throws(() => accountLinuxCIUpload(entries().slice(1)), /CI_UPLOAD/);
    assert.throws(() => accountLinuxCIUpload([...entries(), entries()[0]]), /CI_UPLOAD/);
    const bad = entries(); bad[0].sha256 = 'not-a-hash'; assert.throws(() => accountLinuxCIUpload(bad), /CI_UPLOAD/);
});
test('AC8 CI private metadata never manufactures release fields or smoke verification', () => {
    const source = { schema: 1, kind: 'private-linux-build-source', repository: input().repository,
        version: '0.6.0', commit: input().appSHA, tree: 'e'.repeat(40),
        sourceManifestSHA256: 'f'.repeat(64), buildId: input().buildId };
    const record = privateLinuxCIRecord(source, { [LINUX_CI_ASSETS[0]]: '1'.repeat(64), [LINUX_CI_ASSETS[1]]: '2'.repeat(64) }, 123, ciJSON(source));
    assert.ok('kind' in record && record.kind === 'private-linux-build');
    assert.ok('sourceRecordSHA256' in record);
    assert.deepEqual(record.validation, { status: 'unperformed', resultSHA256: null });
    assert.equal('tag' in record, false); assert.equal('draft' in record, false); assert.equal('releaseRecordSHA256' in record, false);
    assert.equal(record.sourceRecordSHA256, ciHash(ciJSON(source)));
});
test('AC9 importing the CLI exposes only explicit phases and selects no real IO', () => {
    for (const phase of ['admit', 'pre-package', 'finalize', '--help']) assert.equal(linuxCIPhase([phase]), phase);
    for (const args of [[], ['install'], ['finalize', '--launch'], ['--help', 'admit']]) assert.throws(() => linuxCIPhase(args), /CI_PHASE/);
});
function fakeTree() {
    const hashes: string[] = [];
    return { hashes, io: {
        async children(_root: string, relative: string) { return relative === '' ? ['dir', 'file'] : ['inner']; },
        async inspect(_root: string, n: string) { return n === 'dir' ? { kind: 'directory', mode: 0o700 } :
            { kind: 'file', mode: 0o600, bytes: 2 }; },
        async hash(_root: string, n: string) { hashes.push(n); return 'a'.repeat(64); } } };
}
test('AC10 flat inventory is generated from finite fake observations and deterministic body hashes', async () => {
    const f = fakeTree(), result = await inventoryLinuxCIFlat('/inert', f.io);
    assert.deepEqual(result.directories, ['dir']); assert.equal(result.files.length, 2); assert.equal(result.payloadBytes, 4);
    assert.deepEqual(f.hashes, ['dir/inner', 'file']); assert.equal(result.inventorySHA256, ciHash(Buffer.from(JSON.stringify(result.files))));
});
test('AC11 unsupported links unsafe modes malformed sizes and traversal refuse before a fake body hash', async () => {
    for (const delta of [{ kind: 'link' }, { mode: 0o777 }, { mode: 0o4755 }, { mode: -1 }, { bytes: 1.5 },
        { bytes: LINUX_CI_LIMITS.payload + 1 }]) {
        const f = fakeTree(), io = { ...f.io, children: async () => ['file'],
            inspect: async () => ({ kind: 'file', mode: 0o600, bytes: 2, ...delta }) };
        await assert.rejects(inventoryLinuxCIFlat('/inert', io), /CI_PAYLOAD/); assert.deepEqual(f.hashes, []);
    }
    const f = fakeTree(); await assert.rejects(inventoryLinuxCIFlat('/inert', { ...f.io, children: async () => ['../escape'] }), /CI_PAYLOAD/);
    assert.deepEqual(f.hashes, []);
});
test('AC12 NFC aliases and malformed hash acknowledgements remain nonpassing with retained fake facts', async () => {
    const f = fakeTree();
    await assert.rejects(inventoryLinuxCIFlat('/inert', { ...f.io, children: async () => ['é', 'e\u0301'] }), /CI_PAYLOAD/);
    assert.equal(f.hashes.length, 1);
    const g = fakeTree(); await assert.rejects(inventoryLinuxCIFlat('/inert', { ...g.io,
        children: async () => ['file'], hash: async () => 'invalid' }), /CI_PAYLOAD/);
});
function readbackFixture() {
    const retained = entries().filter(v => v.name !== 'upload-accounting.json'),
        bytes = ciJSON({ schema: 1, files: retained, accountingFileExcludedFromHashList: true }),
        accounting = { bytes: bytes.length, sha256: ciHash(bytes) };
    return { retained, accounting, final: [...structuredClone(retained), { name: 'upload-accounting.json', ...accounting }] };
}
test('AC13 final readback equals all retained facts and exact serialized accounting identity independent of order', () => {
    const f = readbackFixture(), before = JSON.stringify(f);
    const result = verifyLinuxCIUploadReadback(f.retained, f.accounting, [...f.final].reverse());
    assert.equal(result.files.length, 14); assert.equal(JSON.stringify(f), before);
    assert.equal(result.metadataBytes, accountLinuxCIUpload(f.final).metadataBytes);
});
test('AC14 same-name same-size asset or metadata digest drift refuses despite valid caps', () => {
    for (const name of [LINUX_CI_ASSETS[0], 'source-manifest.json', 'linux-build-info.json']) {
        const f = readbackFixture(), changed = structuredClone(f.final);
        changed.find(v => v.name === name)!.sha256 = 'e'.repeat(64);
        assert.doesNotThrow(() => accountLinuxCIUpload(changed));
        assert.throws(() => verifyLinuxCIUploadReadback(f.retained, f.accounting, changed), /CI_CHANGED/);
    }
});
test('AC15 changed lengths missing extra or duplicate entries cannot pass final cohort comparison', () => {
    const f = readbackFixture(), changed = structuredClone(f.final);
    changed.find(v => v.name === 'source-manifest.json')!.bytes++;
    assert.doesNotThrow(() => accountLinuxCIUpload(changed));
    assert.throws(() => verifyLinuxCIUploadReadback(f.retained, f.accounting, changed), /CI_CHANGED/);
    for (const files of [f.final.slice(1), [...f.final, { name: 'extra.json', bytes: 1, sha256: 'a'.repeat(64) }],
        [...f.final, structuredClone(f.final[0])]])
        assert.throws(() => verifyLinuxCIUploadReadback(f.retained, f.accounting, files), /CI_UPLOAD/);
});
test('AC16 accounting-file content or length drift refuses against the prepublication serialized identity', () => {
    const f = readbackFixture();
    for (const delta of [{ sha256: '0'.repeat(64) }, { bytes: f.accounting.bytes + 1 }]) {
        const files = structuredClone(f.final); Object.assign(files.find(v => v.name === 'upload-accounting.json')!, delta);
        assert.doesNotThrow(() => accountLinuxCIUpload(files));
        assert.throws(() => verifyLinuxCIUploadReadback(f.retained, f.accounting, files), /CI_CHANGED/);
    }
});
