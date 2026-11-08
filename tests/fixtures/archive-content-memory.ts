import assert from 'node:assert/strict';
import { readbackFixture } from './archive-readback-memory.ts';
import { sourceFixture } from './gateway-producer-memory.ts';

/** Independently authored source-provider DATA matching the existing producer fixtures.
 * Actual existing producer functions create the archives with recording IO, never a real build. */
export async function archiveContentMemory(scope: 'web' | 'gateway') {
    const produced = await readbackFixture(scope);
    const source = sourceFixture(
        scope === 'web'
            ? new Map([
                  [
                      'vite.config.mts',
                      Buffer.from('synthetic shipping Vite config, never executed'),
                  ],
              ])
            : new Map(),
    );
    assert.equal(source.context.sourceCommit, produced.record.context.sourceCommit);
    assert.equal(source.context.sourceTree, produced.record.context.sourceTree);
    const recordName = scope === 'web' ? 'web-build.json' : 'gateway-build.json';
    const input = {
        context: structuredClone(produced.record.context),
        archiveBytes: Buffer.from(produced.files.get(produced.record.archive.name)!),
        buildRecordBytes: Buffer.from(produced.files.get(recordName)!),
        checksumBytes: Buffer.from(produced.files.get(produced.record.checksum.name)!),
        producerJobID: '700',
    };
    return { ...source, input, produced };
}
