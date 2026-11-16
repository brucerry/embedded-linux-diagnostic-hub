import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { nativeBootstrapFixture } from './fixtures/gateway-native-bootstrap-memory';
const until = async (check: () => boolean) => {
    for (let n = 0; n < 10000 && !check(); n++) await Promise.resolve();
    assert.ok(check(), 'Expected bounded fake bootstrap phase.');
};
for (const [kind, layers] of [
    ['tag', 0],
    ['tag', 1],
    ['branch', 0],
] as const)
    test(`actual bootstrap orchestration reaches selector and canonical producer for ${kind}/${layers}`, async () => {
        const f = await nativeBootstrapFixture(kind, layers);
        const bootstrap = f.make();
        f.controls.output = () => {
            assert.equal(f.http.active.size, 0);
            assert.ok(f.http.requests.length >= 3);
        };
        const result = await bootstrap.run();
        assert.equal(result.coverage, kind === 'tag' ? 'tag-job' : 'branch-qualification');
        assert.equal(result.sourceSelection.objectID, f.top.oid);
        assert.equal(result.result.status, 'local-package-readback-complete');
        assert.deepEqual(
            f.events.filter((e) => e === 'build' || e === 'lock'),
            ['build', 'lock'],
        );
        assert.equal(f.f.handles.size, 0);
        assert.equal(f.dirs.size, 0);
        assert.equal(f.timers.size, 0);
        assert.equal(f.http.active.size, 0);
        assert.ok(f.children.every((c) => c.closed));
        assert.equal(result.nativeQualification, false);
        assert.equal(result.releaseAcceptance, false);
        assert.equal(result.jobAuthentication, null);
        assert.equal(result.uploadAttribution, null);
        assert.equal(bootstrap.snapshot().complete, true);
        assert.ok(
            f.f.records.has(
                '/project/validation/gateway-current-build/artifacts/gateway-build.json',
            ),
        );
        const bindingBytes = f.f.bytes('/project/validation/gateway-source-binding.json');
        const retained = JSON.parse(bindingBytes.toString());
        assert.equal(result.sourceBinding.sha256, sourceDigest(bindingBytes));
        assert.equal(
            retained.originalBuildRecord.sha256,
            sourceDigest(
                f.f.bytes('/project/validation/gateway-current-build/artifacts/gateway-build.json'),
            ),
        );
        assert.equal(retained.sourceSelection.objectID, f.top.oid);
        assert.ok(
            retained.sourceObservations.every(
                (row: any) => row.retired && row.tlsAuthorized && row.socketsClosed,
            ),
        );
        assert.equal(retained.originalEventObjectAuthentication, null);
        assert.equal(retained.releaseAcceptance, false);
        if (kind === 'tag') {
            assert.equal(result.result.binding.tag.objectID, f.top.oid);
            assert.equal(result.result.binding.tag.annotations, layers);
        } else {
            assert.equal(result.result.record.context.jobKey, 'gateway_build');
            assert.equal(result.result.binding, null);
            assert.ok(!f.children.some((c) => c.args.includes('show-ref')));
        }
        const requests = f.http.requests.length;
        await assert.rejects(bootstrap.run(), /one-shot/);
        assert.equal(f.http.requests.length, requests);
    });
for (const field of ['uid', 'platform', 'arch', 'version', 'execArgv', 'argv'])
    test(`native runtime guard ${field} is preserved before effects`, async () => {
        const f = await nativeBootstrapFixture();
        Object.assign(f.runtime, {
            [field]: (
                {
                    uid: 0,
                    platform: 'darwin',
                    arch: 'arm64',
                    version: 'v22.0.0',
                    execArgv: ['--trace-warnings'],
                    argv: ['node', 'unselected-entry'],
                } as any
            )[field],
        });
        const bootstrap = f.make();
        await assert.rejects(bootstrap.run());
        assert.equal(f.http.requests.length, 0);
        assert.equal(f.children.length, 0);
        assert.equal(bootstrap.snapshot().complete, false);
    });
for (const field of [
    'GITHUB_REF',
    'GITHUB_SHA',
    'GITHUB_WORKFLOW_SHA',
    'GITHUB_JOB',
    'GITHUB_REPOSITORY',
    'GITHUB_RUN_ATTEMPT',
])
    test(`tag job guard ${field} stops before metadata/build`, async () => {
        const f = await nativeBootstrapFixture();
        f.runtime.environment[field] = 'mismatch';
        await assert.rejects(f.make().run());
        assert.equal(f.http.requests.length, 0);
        assert.equal(f.children.length, 0);
    });
test('real branch labels require the explicit qualification mode, never a fabricated tag', async () => {
    const f = await nativeBootstrapFixture('branch', 0);
    f.runtime.argv.pop();
    await assert.rejects(f.make().run());
    assert.equal(f.http.requests.length, 0);
    assert.equal(f.children.length, 0);
});
test('independent ref mismatch blocks every local Git/build dispatch and fresh output creation', async () => {
    const f = await nativeBootstrapFixture();
    f.http.controls.plans = [
        {
            body: Buffer.from(
                JSON.stringify({
                    ref: f.runtime.environment.GITHUB_REF,
                    object: { type: 'commit', sha: 'f'.repeat(40) },
                }),
            ),
        },
    ];
    const bootstrap = f.make();
    await assert.rejects(bootstrap.run());
    assert.equal(f.children.length, 0);
    assert.equal(f.f.records.has('/project/validation'), false);
    assert.equal(bootstrap.snapshot().failed, true);
});
test('independent source tree must match local raw source before output creation', async () => {
    const f = await nativeBootstrapFixture('branch', 0);
    f.http.controls.plan = (n: number) =>
        n === 1
            ? {
                  body: Buffer.from(
                      JSON.stringify({
                          sha: f.p.context.sourceCommit,
                          tree: { sha: 'b'.repeat(40) },
                      }),
                  ),
              }
            : {};
    await assert.rejects(f.make().run());
    assert.ok(f.children.length > 0);
    assert.ok(!f.events.includes('build'));
    assert.equal(f.f.records.has('/project/validation'), false);
});
test('HTTP response completion cannot launch Git while source socket custody is held', async () => {
    const f = await nativeBootstrapFixture();
    f.http.controls.plans = [{ holdSocketClose: true }];
    const bootstrap = f.make();
    const work = bootstrap.run();
    await until(() => f.http.requests[0]?.responseEnded);
    assert.equal(f.children.length, 0);
    assert.equal(bootstrap.snapshot().phase, 'independent-source');
    f.http.requests[0].releaseSocketClose();
    await work;
    assert.equal(bootstrap.snapshot().complete, true);
});
test('native UID/mode readback policy remains stronger than a matching receipt hash', async () => {
    const f = await nativeBootstrapFixture();
    f.controls.stat = (file: string) =>
        file.endsWith('/artifacts/gateway-build.json') ? { mode: 0o100666 } : {};
    const bootstrap = f.make();
    await assert.rejects(bootstrap.run());
    assert.ok(f.events.includes('lock'));
    assert.equal(bootstrap.snapshot().complete, false);
    assert.ok(
        f.f.records.has('/project/validation/gateway-current-build/artifacts/gateway-build.json'),
    );
});
test('an occupied validation slot is refused without adoption or cleanup', async () => {
    const f = await nativeBootstrapFixture();
    await f.f.fs.mkdir('/project/validation');
    f.f.write('/project/validation/retained', Buffer.from('Keep memory fixture data.'));
    await assert.rejects(f.make().run());
    assert.equal(f.f.bytes('/project/validation/retained').toString(), 'Keep memory fixture data.');
    assert.ok(!f.events.includes('build'));
});

test('native CLI import defines the real entry without invoking it', async () => {
    const entry = await import('../scripts/build-gateway-tag-archive.mjs');
    assert.equal(typeof entry.buildGatewayArchiveFromSelectedJob, 'function');
});
test('the retained source-binding record is reread under the native file policy', async () => {
    const f = await nativeBootstrapFixture('branch', 0);
    f.controls.stat = (file: string) =>
        file.endsWith('/gateway-source-binding.json') ? { mode: 0o100666 } : {};
    const bootstrap = f.make();
    await assert.rejects(bootstrap.run());
    assert.equal(bootstrap.snapshot().complete, false);
    assert.ok(f.events.includes('lock'));
    assert.ok(
        f.f.records.has('/project/validation/gateway-current-build/artifacts/gateway-build.json'),
    );
});
