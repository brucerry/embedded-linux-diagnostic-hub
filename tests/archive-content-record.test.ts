import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { prepareArchiveContentRecord } from '../scripts/lib/archive-content-record.mjs';
import { canonicalContentRecord } from '../scripts/lib/attested-content-policy.mjs';
import { observeSourceBridge } from '../scripts/lib/committed-source-bridge.mjs';
import { sourceFixture } from './fixtures/gateway-producer-memory.ts';
import { archiveContentMemory } from './fixtures/archive-content-memory.ts';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');

for (const scope of ['web', 'gateway'] as const) {
    test(
        scope +
            ' actual producer bytes reach the existing canonical policy record after independent Git observation',
        async () => {
            const f = await archiveContentMemory(scope),
                out = await prepareArchiveContentRecord(f.input, f.provider);
            const value = JSON.parse(out.contentBytes.toString());
            assert.deepEqual(canonicalContentRecord(value), out.contentBytes);
            assert.equal(out.content.name, scope + '-content.json');
            assert.equal(out.content.sha256, hash(out.contentBytes));
            assert.deepEqual(out.archive, f.produced.record.archive);
            assert.deepEqual(out.application, {
                commit: f.context.sourceCommit,
                tree: f.context.sourceTree,
                sourceManifestSHA256: hash(out.sourceManifestBytes),
            });
            const inventory = JSON.parse(out.sourceManifestBytes.toString());
            assert.deepEqual(
                inventory.map((r: any) => r.path),
                [...f.files.keys()].sort(),
            );
            for (const row of inventory) assert.equal(row.sha256, hash(f.files.get(row.path)!));
            assert.deepEqual(value.producerClaims, {
                buildID: 'sha256:' + hash(f.input.buildRecordBytes),
                buildRunID: '123',
                buildRunAttempt: '1',
                buildJobID: '700',
            });
            assert.deepEqual(out.subjects, [
                { name: out.archive.name, digest: { sha256: out.archive.sha256 } },
                { name: out.content.name, digest: { sha256: out.content.sha256 } },
            ]);
            assert.equal(out.signerRun, null);
            assert.equal(out.authenticatedProvenance, null);
            assert.equal(out.compiledSourceProven, false);
            assert.equal(out.releaseAcceptance, false);
        },
    );
    for (const mode of [
        'archive',
        'checksum',
        'failed-build',
        'foreign-run',
        'foreign-tree',
        'extra-input',
    ])
        test(scope + ' refuses ' + mode + ' before source-provider access', async () => {
            const f = await archiveContentMemory(scope),
                record = JSON.parse(f.input.buildRecordBytes.toString());
            if (mode === 'archive') f.input.archiveBytes[0] ^= 1;
            if (mode === 'checksum') f.input.checksumBytes[0] ^= 1;
            if (mode === 'failed-build') {
                if (scope === 'web') record.build.exitCode = 1;
                else record.build.lifecycle.code = 1;
                f.input.buildRecordBytes = encode(record);
            }
            if (mode === 'foreign-run') f.input.context.runId = '124';
            if (mode === 'foreign-tree') f.input.context.sourceTree = 'f'.repeat(40);
            if (mode === 'extra-input') (f.input as any).releaseAcceptance = true;
            let accesses = 0;
            const denied = Object.fromEntries(
                ['state', 'objects', 'entries', 'file'].map((name) => [
                    name,
                    () => {
                        accesses++;
                        assert.fail('No source access admitted');
                    },
                ]),
            );
            await assert.rejects(prepareArchiveContentRecord(f.input, denied));
            assert.equal(accesses, 0);
        });
    test(
        scope +
            ' refuses a structurally valid forged source bridge against the independent original checkout',
        async () => {
            const f = await archiveContentMemory(scope),
                foreign = sourceFixture(
                    new Map([
                        ...(scope === 'web'
                            ? [
                                  [
                                      'vite.config.mts',
                                      Buffer.from('synthetic shipping Vite config, never executed'),
                                  ] as [string, Buffer],
                              ]
                            : []),
                        ['foreign-file.txt', Buffer.from('extra authored source')],
                    ]),
                );
            const bridge = await observeSourceBridge(
                    {
                        sourceCommit: foreign.context.sourceCommit,
                        sourceTree: foreign.context.sourceTree,
                    },
                    foreign.provider,
                ),
                record = JSON.parse(f.input.buildRecordBytes.toString());
            record.context.sourceCommit = bridge.sourceCommit;
            record.context.sourceTree = bridge.sourceTree;
            record.sourceBridge = bridge;
            record.sourceBridgeSHA256 = hash(encode(bridge));
            f.input.context = structuredClone(record.context);
            f.input.buildRecordBytes = encode(record);
            // A real object store may retain both commits. Make foreign objects readable,
            // while the independently observed HEAD/index/worktree remain the original.
            const provider = {
                ...f.provider,
                objects: async (ids: string[]) =>
                    Promise.all(
                        ids.map(async (id) => {
                            try {
                                return (await f.provider.objects([id]))[0];
                            } catch {
                                return (await foreign.provider.objects([id]))[0];
                            }
                        }),
                    ),
            };
            await assert.rejects(
                prepareArchiveContentRecord(f.input, provider),
                /Checkout HEAD differs from frozen source/,
            );
        },
    );
    test(
        scope + ' snapshots caller-owned archive and context before independent asynchronous reads',
        async () => {
            const f = await archiveContentMemory(scope),
                expected = f.produced.record.archive.sha256;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const provider = {
                ...f.provider,
                state: async () => {
                    await gate;
                    return f.provider.state();
                },
            };
            const work = prepareArchiveContentRecord(f.input, provider);
            f.input.archiveBytes.fill(0);
            f.input.context.sourceTree = 'f'.repeat(40);
            f.input.producerJobID = '999';
            release();
            const out = await work;
            assert.equal(out.archive.sha256, expected);
            assert.equal(JSON.parse(out.contentBytes.toString()).producerClaims.buildJobID, '700');
        },
    );
}
for (const job of ['', '0', '-1', '1e3', '700\n', '7'.repeat(21)])
    test(
        'unresolved or malformed numeric producer job refuses: ' + JSON.stringify(job),
        async () => {
            const f = await archiveContentMemory('web');
            f.input.producerJobID = job;
            await assert.rejects(prepareArchiveContentRecord(f.input, f.provider));
        },
    );
test('source mutation during the final independent observation cannot emit a completed handoff', async () => {
    const f = await archiveContentMemory('web');
    let states = 0;
    const provider = {
        ...f.provider,
        state: async () => {
            states++;
            if (states === 4) f.files.set('package.json', Buffer.from('dirty source'));
            return f.provider.state();
        },
    };
    await assert.rejects(prepareArchiveContentRecord(f.input, provider), /Dirty source/);
});
