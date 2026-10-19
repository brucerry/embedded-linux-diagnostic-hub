import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
    inspectOwnedArtifact,
    inspectViewerArtifact,
    artifactReaderState,
    assertArtifactReadersClosed,
} from '../scripts/lib/owned-artifact-stream.mjs';
async function file(t: any, size = 131089) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hub-artifact-stream-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'owned');
    await fsp.writeFile(file, Buffer.alloc(size, 120));
    return { file, root };
}
test('owner cancellation stops the next read, closes its descriptor and preserves the file', async (t) => {
    const f = await file(t),
        controller = new AbortController();
    await assert.rejects(
        inspectOwnedArtifact(
            f.file,
            async (chunks) => {
                for await (const ignored of chunks) {
                    void ignored;
                    controller.abort(Error('controlled owner cancellation'));
                }
                return true;
            },
            { signal: controller.signal },
        ),
        /owner cancellation/,
    );
    assertArtifactReadersClosed();
    assert((await fsp.stat(f.file)).isFile());
});
test('owned artifact consumes one64-KiB buffer and acknowledges only exact EOF plus actual close', async (t) => {
    const f = await file(t);
    let maximum = 0,
        count = 0;
    const result = await inspectOwnedArtifact(f.file, async (chunks) => {
        const hash = createHash('sha256');
        for await (const chunk of chunks) {
            maximum = Math.max(maximum, chunk.length);
            count += chunk.length;
            hash.update(chunk);
        }
        return hash.digest('hex');
    });
    assert.equal(result.bytes, count);
    assert.equal(result.sha256, result.result);
    assert.equal(maximum, 65536);
    assert.equal(result.descriptorClosed, true);
    assert.equal(result.wholeFileMaterialized, false);
    assert.deepEqual(artifactReaderState(), []);
    assertArtifactReadersClosed();
    const viewer = await inspectViewerArtifact(f.file, count);
    assert.equal(viewer.prefix.length, 64);
    assert.equal(viewer.bytes, count);
});
test('early semantic success, receipt mismatch, aliases and invalid size cannot retire evidence', async (t) => {
    const f = await file(t);
    await assert.rejects(
        inspectOwnedArtifact(f.file, async () => true),
        /before exact.*EOF/,
    );
    assertArtifactReadersClosed();
    await assert.rejects(
        inspectOwnedArtifact(f.file, async () => true, { expectedBytes: 1 }),
        /receipt/,
    );
    await assert.rejects(
        inspectOwnedArtifact(f.file, async () => true, { limit: 1 }),
        /oversized/,
    );
    const alias = path.join(f.root, 'alias');
    await fsp.symlink(f.file, alias);
    await assert.rejects(inspectViewerArtifact(alias, 131089), /invalid/);
    assert((await fsp.stat(f.file)).isFile());
});
test('path rebound and same-size mutation during validation refuse while still closing descriptor', async (t) => {
    for (const change of ['rename', 'mutate']) {
        const f = await file(t);
        await assert.rejects(
            inspectOwnedArtifact(f.file, async (chunks) => {
                let changed = false;
                for await (const ignored of chunks) {
                    void ignored;
                    if (!changed) {
                        changed = true;
                        if (change === 'rename') {
                            await fsp.rename(f.file, f.file + '.retained');
                            await fsp.writeFile(f.file, Buffer.alloc(131089, 120));
                        } else {
                            const handle = await fsp.open(f.file, 'r+');
                            try {
                                await handle.write(Buffer.from('y'), 0, 1, 131088);
                            } finally {
                                await handle.close();
                            }
                        }
                    }
                }
                return true;
            }),
            /mutated/,
        );
        assertArtifactReadersClosed();
    }
});
test('real descriptor close refusal retains an uncertain owner and blocks next-file admission', async (t) => {
    const f = await file(t);
    const isolatedURL = new URL('../scripts/lib/owned-artifact-stream.mjs', import.meta.url);
    isolatedURL.search = 'close-failure-control';
    const isolated = await import(isolatedURL.href);
    let actual: any;
    const io = {
        ...fsp,
        async open(...args: any[]) {
            actual = await (fsp.open as any)(...args);
            return {
                stat: (...a: any[]) => actual.stat(...a),
                read: (...a: any[]) => actual.read(...a),
                async close() {
                    throw Error('controlled close refusal');
                },
            };
        },
    };
    try {
        await assert.rejects(
            isolated.inspectOwnedArtifact(
                f.file,
                async (chunks: any) => {
                    for await (const ignored of chunks) void ignored;
                    return true;
                },
                { io },
            ),
            /close refusal/,
        );
        assert.equal(isolated.artifactReaderState()[0].phase, 'close-failed');
        assert.throws(() => isolated.assertArtifactReadersClosed(), /open\/uncertain/);
        await assert.rejects(isolated.inspectViewerArtifact(f.file, 131089), /open\/uncertain/);
        assert((await fsp.stat(f.file)).isFile());
    } finally {
        await actual?.close();
    }
    // The isolated module retains its uncertainty even after test-only external descriptor cleanup.
    assert.throws(() => isolated.assertArtifactReadersClosed(), /uncertain/);
});
