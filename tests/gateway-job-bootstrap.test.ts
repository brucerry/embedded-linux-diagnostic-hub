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

test('afterReadback receives original same-job binding only after its source record was reread', async () => {
    const f = await nativeBootstrapFixture('branch', 0);
    let bindingReads = 0,
        calls = 0;
    f.f.hooks.read = (file: string) => {
        if (file === '/project/validation/gateway-source-binding.json') bindingReads++;
    };
    const bootstrap = f.make();
    f.ports.afterReadback = async (handoff: any) => {
        calls++;
        assert.ok(bindingReads > 0);
        assert.equal(bootstrap.snapshot().callbackActive, true);
        assert.equal(bootstrap.snapshot().complete, false);
        assert.equal(bootstrap.quiescent(), false);
        const original = f.f.bytes(
            '/project/validation/gateway-current-build/artifacts/gateway-build.json',
        );
        assert.equal(handoff.originalBuildRecord.sha256, sourceDigest(original));
        assert.equal(handoff.sourceRoot, '/project');
        assert.equal(handoff.context.sourceCommit, f.p.context.sourceCommit);
        assert.equal(handoff.record.context.jobKey, 'gateway_build');
        const binding = JSON.parse(
            f.f.bytes('/project/validation/gateway-source-binding.json').toString(),
        );
        assert.deepEqual(binding.originalBuildRecord, handoff.originalBuildRecord);
        assert.ok(
            (
                await handoff.readFile(
                    '/project/validation/gateway-current-build/artifacts/gateway-build.json',
                    16 * 1024 ** 2,
                )
            ).equals(original),
        );
        return { status: 'authored-memory-callback-only', releaseAcceptance: false };
    };
    const result = await bootstrap.run();
    assert.equal(calls, 1);
    assert.equal(result.healthSmoke.status, 'authored-memory-callback-only');
    assert.equal(result.nativeQualification, false);
    assert.equal(bootstrap.quiescent(), true);
});

test('producer readback failure cannot invoke a health callback', async () => {
    const f = await nativeBootstrapFixture('branch', 0);
    let calls = 0;
    f.ports.afterReadback = () => {
        calls++;
        assert.fail('No callback after refused producer readback');
    };
    f.controls.stat = (file: string) =>
        file.endsWith('/artifacts/gateway-build.json') ? { mode: 0o100666 } : {};
    const bootstrap = f.make();
    await assert.rejects(bootstrap.run());
    assert.equal(calls, 0);
    assert.equal(bootstrap.snapshot().failed, true);
    assert.equal(bootstrap.snapshot().callbackActive, false);
});

test('a deferred afterReadback remains nonquiescent until the actual callback returns', async () => {
    const f = await nativeBootstrapFixture('branch', 0);
    let entered!: () => void, release!: () => void;
    const callbackEntered = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const callbackRelease = new Promise<void>((resolve) => {
        release = resolve;
    });
    f.ports.afterReadback = async () => {
        entered();
        await callbackRelease;
        return { status: 'authored-delayed-memory-only' };
    };
    const bootstrap = f.make(),
        work = bootstrap.run();
    await Promise.race([
        callbackEntered,
        work.then(() => {
            throw Error('Callback milestone was not reached.');
        }),
    ]);
    assert.equal(bootstrap.snapshot().callbackActive, true);
    assert.equal(bootstrap.quiescent(), false);
    assert.equal(f.f.handles.size, 0);
    assert.ok(f.children.every((child) => child.closed));
    release();
    await work;
    assert.equal(bootstrap.snapshot().callbackActive, false);
    assert.equal(bootstrap.quiescent(), true);
});

test('failed callback with known closed producer owners can be quiescent without becoming success', async () => {
    const f = await nativeBootstrapFixture('branch', 0);
    f.ports.afterReadback = () => {
        throw undefined;
    };
    const bootstrap = f.make();
    const error: any = await bootstrap.run().catch((value: unknown) => value);
    assert.equal(error.cause, undefined);
    assert.equal(error.owner, bootstrap);
    assert.equal(bootstrap.snapshot().failed, true);
    assert.equal(bootstrap.snapshot().complete, false);
    assert.equal(bootstrap.snapshot().callbackActive, false);
    assert.equal(f.f.handles.size, 0);
    assert.equal(f.dirs.size, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.http.active.size, 0);
    assert.ok(f.children.every((child) => child.closed));
    assert.equal(bootstrap.quiescent(), true);
});

test('callback source reread refuses bytes that drifted from the canonical producer inventory', async () => {
    const f = await nativeBootstrapFixture('branch', 0);
    let reads = 0;
    f.ports.afterReadback = async (handoff: any) => {
        const original = await handoff.sourceFile('package.json');
        reads++;
        assert.ok(original.equals(f.f.bytes('/project/package.json')));
        f.f.write(
            '/project/package.json',
            Buffer.from('changed authored memory source; never executed'),
        );
        return handoff.sourceFile('package.json');
    };
    const bootstrap = f.make();
    await assert.rejects(bootstrap.run());
    assert.equal(reads, 1);
    assert.equal(bootstrap.snapshot().failed, true);
    assert.equal(bootstrap.snapshot().complete, false);
    assert.equal(bootstrap.snapshot().callbackActive, false);
    assert.equal(f.f.handles.size, 0);
    assert.equal(bootstrap.quiescent(), true);
});
