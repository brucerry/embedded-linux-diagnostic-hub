import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import {
    captureGatewayPackageHandoff,
    parseGatewayPackageHandoff,
} from '../scripts/lib/gateway-package-handoff.mjs';
import { checkGatewayRuntimePackage } from '../scripts/check-gateway-runtime-package.mjs';
import { nativeBootstrapFixture } from './fixtures/gateway-native-bootstrap-memory';
import { createOwnedWebFiles } from '../scripts/lib/owned-web-files.mjs';

// Entire source/job/tool/child/filesystem/HTTP environment is authored memory data.
// No native entry, package, Gateway, socket or filesystem deletion is performed.
async function fixture(kind: 'branch' | 'tag' = 'branch') {
    const f = await nativeBootstrapFixture(kind, kind === 'tag' ? 1 : 0);
    const produced = await f.make().run();
    const bytes = captureGatewayPackageHandoff(produced.result);
    const originalHash = sourceDigest(bytes);
    const source = {
        sourceCommit: f.runtime.environment.GITHUB_SHA,
        sourceTree: f.p.context.sourceTree,
    };
    const owned = createOwnedWebFiles(f.ports.filesystem);
    const check = (body = bytes, hash = originalHash, selected = source, fs = owned.filesystem) =>
        checkGatewayRuntimePackage(body, hash, selected, '/project', fs, 1000);
    return { f, produced, bytes, originalHash, source, check, owned };
}
for (const kind of ['branch', 'tag'] as const) {
    test(`original ${kind} producer return reaches separate inert runtime readback`, async () => {
        const x = await fixture(kind);
        const selected = parseGatewayPackageHandoff(x.bytes);
        assert.deepEqual(selected.buildRecord, x.produced.result.originalBuildRecord);
        assert.deepEqual(await x.check(), selected);
        assert.equal(selected.context.sourceCommit, x.source.sourceCommit);
        assert.equal(x.f.f.handles.size, 0);
        assert.equal(x.f.timers.size, 0);
        assert.ok(!x.bytes.includes(Buffer.from('/project')));
        assert.ok(!x.bytes.includes(Buffer.from('builder')));
    });
}
test('original output hash mismatch refuses before reading any package input', async () => {
    const x = await fixture();
    let reads = 0;
    await assert.rejects(
        x.check(Buffer.from(x.bytes.toString() + ' '), x.originalHash, x.source, {
            ...x.owned.filesystem,
            async lstat() {
                reads++;
                throw Error('No read should be attempted.');
            },
        }),
    );
    assert.equal(reads, 0);
});
test('archive mismatch refuses without a runtime capability', async () => {
    const x = await fixture();
    const file =
        '/project/validation/gateway-current-build/artifacts/Diagnostic-Hub-Gateway-0.6.0.tar.gz';
    const altered = x.f.f.bytes(file);
    altered[altered.length - 1] ^= 1;
    x.f.f.write(file, altered);
    await assert.rejects(
        x.check(),
        (error: any) =>
            error.actual === sourceDigest(altered) &&
            error.expected === parseGatewayPackageHandoff(x.bytes).artifacts[0].sha256,
    );
    assert.equal(x.f.f.handles.size, 0);
});
test('missing package input refuses and closes already-read handles', async () => {
    const x = await fixture();
    let missingAttempted = false;
    const fs = {
        ...x.f.ports.filesystem,
        async lstat(file: string) {
            if (file.endsWith('.tar.gz')) {
                missingAttempted = true;
                throw Object.assign(Error('Authored missing input.'), { code: 'ENOENT' });
            }
            return x.f.ports.filesystem.lstat(file);
        },
    };
    const owned = createOwnedWebFiles(fs);
    await assert.rejects(x.check(x.bytes, x.originalHash, x.source, owned.filesystem));
    assert.equal(missingAttempted, true);
    assert.equal(x.f.f.handles.size, 0);
});
test('another independently selected source cannot consume a matching package', async () => {
    const x = await fixture();
    await assert.rejects(
        x.check(x.bytes, x.originalHash, { ...x.source, sourceCommit: 'f'.repeat(40) }),
        (error: any) => error.actual === x.source.sourceCommit && error.expected === 'f'.repeat(40),
    );
    assert.equal(x.f.f.handles.size, 0);
});
test('failed producer state cannot emit a success handoff', async () => {
    const x = await fixture();
    assert.throws(() =>
        captureGatewayPackageHandoff({
            ...x.produced.result,
            local: { ...x.produced.result.local, readbackVerified: false },
        }),
    );
});
test('changed in-memory branch record cannot redefine the original producer hash', async () => {
    const x = await fixture();
    const record = structuredClone(x.produced.result.record);
    record.archive.sha256 = 'a'.repeat(64);
    assert.throws(() => captureGatewayPackageHandoff({ ...x.produced.result, record }));
});
test('tag binding must retain the original record descriptor', async () => {
    const x = await fixture('tag');
    const binding = structuredClone(x.produced.result.binding);
    binding.buildRecord.sha256 = 'a'.repeat(64);
    assert.throws(() => captureGatewayPackageHandoff({ ...x.produced.result, binding }));
});
test('missing, oversized and extra-field handoffs are refused', async () => {
    const x = await fixture();
    assert.throws(() => parseGatewayPackageHandoff(Buffer.alloc(0)));
    assert.throws(() => parseGatewayPackageHandoff(Buffer.alloc(16385)));
    assert.throws(() =>
        parseGatewayPackageHandoff(
            Buffer.from(
                JSON.stringify({ ...parseGatewayPackageHandoff(x.bytes), claim: 'qualified' }),
            ),
        ),
    );
});
