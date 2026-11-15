import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'fflate';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { verifyGatewayArchiveReadback } from '../scripts/lib/gateway-archive-readback.mjs';
import {
    produceGatewayArchive,
    encodeGatewayTar,
    inspectOwnedGatewayTar,
} from '../scripts/lib/gateway-archive-producer.mjs';
import { validateProducerReceipt } from '../scripts/lib/staged-artifact-gate.mjs';
import { pipelineFixture } from './fixtures/gateway-producer-memory';

// Actual producer/readback functions with memory filesystem and child ports only.
// Synthetic compiler bytes are never executed. No disk, npm, service or receipt is published.
const canonical = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const identity = (name: string, bytes: Buffer) => ({
    name,
    bytes: bytes.length,
    sha256: sourceDigest(bytes),
});
async function fixture() {
    const f = pipelineFixture(),
        produced = await produceGatewayArchive(f.context, f.options, f.io),
        root = '/project/validation/gateway-test',
        record = structuredClone(produced.record),
        input = {
            recordBytes: f.filesystem.bytes(root + '/artifacts/gateway-build.json'),
            archiveBytes: f.filesystem.bytes(root + '/artifacts/' + record.archive.name),
            checksumBytes: f.filesystem.bytes(root + '/artifacts/' + record.checksum.name),
            sourcePackageBytes: Buffer.from(f.files.get('package.json')!),
            sourceLockBytes: Buffer.from(f.files.get('package-lock.json')!),
            compiledBytes: f.filesystem.bytes(root + '/build/main.cjs'),
        },
        expected = {
            context: structuredClone(f.context),
            buildRecord: identity('gateway-build.json', canonical(produced.record)),
            artifacts: [structuredClone(record.archive), structuredClone(record.checksum)],
        },
        members = new Map<string, Buffer>(
            record.payload.map((row: any) => [
                row.path,
                f.filesystem.bytes(root + '/stage/' + row.path),
            ]),
        );
    assert.equal(f.filesystem.handles.size, 0);
    return { input, expected, record, members };
}
const readback = (f: Awaited<ReturnType<typeof fixture>>) =>
    verifyGatewayArchiveReadback(f.input, f.expected);
function selectRecord(f: Awaited<ReturnType<typeof fixture>>) {
    f.input.recordBytes = canonical(f.record);
    f.expected.buildRecord = identity('gateway-build.json', f.input.recordBytes);
}
function repack(
    f: Awaited<ReturnType<typeof fixture>>,
    change: (members: Map<string, Buffer>) => void,
) {
    change(f.members);
    const raw = encodeGatewayTar(f.members);
    f.input.archiveBytes = Buffer.from(gzipSync(raw, { mtime: 0 }));
    f.record.payload = [...f.members]
        .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sourceDigest(bytes) }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    f.record.tarInventory = inspectOwnedGatewayTar(raw, f.members);
    f.record.preparedLockSHA256 = sourceDigest(f.members.get('package-lock.json')!);
    f.record.archive = identity(f.record.archive.name, f.input.archiveBytes);
    f.input.checksumBytes = Buffer.from(`${f.record.archive.sha256}  ${f.record.archive.name}\n`);
    f.record.checksum = identity(f.record.checksum.name, f.input.checksumBytes);
    f.expected.artifacts = [structuredClone(f.record.archive), structuredClone(f.record.checksum)];
    selectRecord(f);
}

test('producer memory output correlates without becoming authoritative qualification', async () => {
    const f = await fixture(),
        result = readback(f);
    assert.deepEqual(result, f.record);
    assert.notEqual(result, f.record);
    assert.equal(result.kind, 'gateway-source-build-archive');
    assert.equal(result.status, 'built');
    assert.equal(result.releaseAcceptance, false);
    for (const field of [
        'productRuntime',
        'loaderProvenance',
        'normalGC',
        'forcedGC',
        'retirement',
    ] as const)
        assert.equal(result[field], null);
    assert.throws(() => validateProducerReceipt(result, f.expected.context));
});

for (const [field, value] of [
    ['scope', 'web'],
    ['version', '0.6.1'],
    ['sourceCommit', 'f'.repeat(40)],
    ['sourceTree', 'e'.repeat(40)],
    ['runId', '124'],
    ['runAttempt', '2'],
    ['jobKey', 'other_job'],
] as const)
    test('independently selected ' + field + ' must match the producer', async () => {
        const f = await fixture();
        Object.assign(f.expected.context, { [field]: value });
        assert.throws(() => readback(f));
    });
test('missing job selection is refused rather than copied from the producer', async () => {
    const f = await fixture();
    Reflect.deleteProperty(f.expected.context, 'jobKey');
    assert.throws(() => readback(f));
});
test('build record bytes must match their separately selected identity', async () => {
    const f = await fixture();
    f.record.builder.npmVersion = '11.0.1';
    f.input.recordBytes = canonical(f.record);
    assert.throws(() => readback(f));
});
for (const index of [0, 1])
    for (const field of ['bytes', 'sha256'] as const)
        test(`selected artifact ${index} ${field} cannot be substituted`, async () => {
            const f = await fixture();
            Object.assign(f.expected.artifacts[index], {
                [field]: field === 'bytes' ? f.expected.artifacts[index].bytes + 1 : 'f'.repeat(64),
            });
            assert.throws(() => readback(f));
        });
test('duplicate or missing selected sidecar identity is refused', async () => {
    const f = await fixture();
    f.expected.artifacts[1] = structuredClone(f.expected.artifacts[0]);
    assert.throws(() => readback(f));
});
for (const suffix of ['', '\r\n', '\nextra'])
    test('sidecar requires exact canonical bytes: ' + JSON.stringify(suffix), async () => {
        const f = await fixture();
        f.input.checksumBytes = Buffer.from(f.input.checksumBytes.toString().trimEnd() + suffix);
        assert.throws(() => readback(f));
    });
test('bounded snapshot rejects an oversized sidecar', async () => {
    const f = await fixture();
    f.input.checksumBytes = Buffer.alloc(1025);
    assert.throws(() => readback(f));
});
for (const field of ['sourcePackageBytes', 'sourceLockBytes', 'compiledBytes'] as const)
    test('independently read input bytes remain bound: ' + field, async () => {
        const f = await fixture();
        f.input[field] = Buffer.concat([f.input[field], Buffer.from('\n')]);
        assert.throws(() => readback(f));
    });
for (const name of [
    '.env.gateway.example',
    'LICENSE',
    'docs/gateway.md',
    'gateway/Caddyfile.example',
])
    test(
        'coherent archive/record hashes cannot replace selected source member ' + name,
        async () => {
            const f = await fixture();
            repack(f, (members) =>
                members.set(name, Buffer.from('different memory-only source bytes')),
            );
            assert.throws(() => readback(f));
        },
    );
for (const name of ['README.md', 'dist-gateway/main.cjs'])
    test('coherent archive/record hashes cannot replace ' + name, async () => {
        const f = await fixture();
        repack(f, (members) => members.set(name, Buffer.from('different memory-only output')));
        assert.throws(() => readback(f));
    });
test('archived manifest semantics must equal the selected canonical projection', async () => {
    const f = await fixture();
    repack(f, (members) => {
        const value = JSON.parse(members.get('package.json')!.toString());
        value.scripts.start = 'node different-memory-entry.cjs';
        members.set('package.json', canonical(value));
    });
    assert.throws(() => readback(f));
});
test('prepared lock cannot change a source-pinned dependency even with coherent hashes', async () => {
    const f = await fixture();
    repack(f, (members) => {
        const value = JSON.parse(members.get('package-lock.json')!.toString());
        value.packages['node_modules/dep'].version = '1.0.1';
        members.set('package-lock.json', canonical(value));
    });
    assert.throws(() => readback(f));
});
test('record projection hash must be derived from independently read source lock bytes', async () => {
    const f = await fixture();
    f.record.projectedLockSHA256 = 'f'.repeat(64);
    selectRecord(f);
    assert.throws(() => readback(f));
});
test('trailing compressed data fails even when the outer identities are updated', async () => {
    const f = await fixture();
    f.input.archiveBytes = Buffer.concat([f.input.archiveBytes, Buffer.from([0])]);
    f.record.archive = identity(f.record.archive.name, f.input.archiveBytes);
    f.input.checksumBytes = Buffer.from(`${f.record.archive.sha256}  ${f.record.archive.name}\n`);
    f.record.checksum = identity(f.record.checksum.name, f.input.checksumBytes);
    f.expected.artifacts = [structuredClone(f.record.archive), structuredClone(f.record.checksum)];
    selectRecord(f);
    assert.throws(() => readback(f));
});
for (const field of ['releaseAcceptance', 'productRuntime', 'normalGC', 'forcedGC', 'retirement'])
    test('a model cannot promote its partial producer field ' + field, async () => {
        const f = await fixture();
        Object.assign(f.record, { [field]: true });
        selectRecord(f);
        assert.throws(() => readback(f));
    });
