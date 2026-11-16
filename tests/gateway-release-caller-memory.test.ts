import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayProducerFailure } from '../scripts/lib/gateway-archive-producer.mjs';
import { createGatewayReleaseDraftCaller } from '../scripts/lib/gateway-release-caller.mjs';
import { parseGatewayArchiveBuildRecord } from '../scripts/lib/gateway-build-record.mjs';
import { validateProducerReceipt } from '../scripts/lib/staged-artifact-gate.mjs';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { pipelineFixture } from './fixtures/gateway-producer-memory';
import { tagReaderFixture } from './fixtures/gateway-tag-memory';

// Actual reader, canonical producer and semantic readback algorithms; all Git,
// files, build/lock children and tool inputs are authored memory ports only.
async function fixture(layers = 1) {
    const p = pipelineFixture();
    const [source] = await p.provider.objects([p.context.sourceCommit]);
    const tag = tagReaderFixture(layers, source);
    const controls: any = { factoryCalls: 0, settles: 0 };
    const selection = {
        repository: 'brucerry/embedded-linux-diagnostic-hub',
        tagRef: tag.selected.tagRef,
        tagObjectID: tag.selected.tagObjectID,
        context: structuredClone(p.context),
        options: structuredClone(p.options),
        git: {
            gitPath: tag.selected.gitPath,
            gitSHA256: tag.selected.gitSHA256,
            environment: structuredClone(tag.selected.environment),
        },
    };
    const build = {
        ...p.io,
        async sourceFactory(root: string) {
            controls.factoryCalls++;
            if (controls.factoryCalls === 2) await controls.readback?.();
            return controls.provider ?? p.io.sourceFactory(root);
        },
    };
    const ports = {
        build,
        tag: tag.ports,
        async assertSettled() {
            controls.settles++;
            if (controls.settle) return await controls.settle();
            assert.equal(p.filesystem.handles.size, 0);
            assert.equal(tag.fs.handles.size, 0);
            assert.equal(tag.timers.size, 0);
        },
    };
    const stage = '/project/validation/gateway-test';
    return {
        p,
        tag,
        controls,
        selection,
        ports,
        stage,
        caller: () => createGatewayReleaseDraftCaller(selection, ports),
    };
}
const until = async (check: () => boolean) => {
    for (let n = 0; n < 3000 && !check(); n++) await Promise.resolve();
    assert.ok(check(), 'Expected bounded in-memory phase.');
};
for (const layers of [0, 1])
    test(`single invocation verifies canonical package/readback through ${layers} tag layers`, async () => {
        const f = await fixture(layers),
            caller = f.caller();
        const result = await caller.run();
        assert.equal(result.status, 'local-package-readback-complete');
        assert.equal(result.local.sameInvocation, true);
        assert.equal(result.local.readersCompleted, 2);
        assert.equal(result.local.producerSealed, true);
        assert.equal(result.local.readbackVerified, true);
        assert.equal(result.local.portsAcknowledged, true);
        assert.equal(result.sameJobAuthentication, null);
        assert.equal(result.binding.status, 'bound-not-qualified');
        assert.ok(Object.values(result.binding.provenance).every((x) => x === null));
        assert.equal(result.releaseAcceptance, false);
        assert.equal(result.nativeQualification, false);
        assert.equal(f.p.plans.length, 2);
        assert.equal(f.controls.factoryCalls, 2);
        assert.equal(f.controls.settles, 1);
        assert.equal(f.tag.calls.length, layers ? 22 : 18);
        assert.equal(caller.snapshot().complete, true);
        const originalBytes = f.p.filesystem.bytes(f.stage + '/artifacts/gateway-build.json');
        assert.equal(result.binding.buildRecord.sha256, sourceDigest(originalBytes));
        assert.ok(
            Object.isFrozen(result) &&
                Object.isFrozen(result.local) &&
                Object.isFrozen(result.binding.context),
        );
        assert.throws(() => validateProducerReceipt(result, f.p.context));
        assert.ok(!JSON.stringify(result).includes('/project'));
        await assert.rejects(caller.run(), /one-shot/);
        assert.equal(f.p.plans.length, 2);
    });
for (const key of ['repository', 'tagRef', 'tagObjectID'])
    test(`bad selected ${key} refuses before any IO`, async () => {
        const f = await fixture();
        (f.selection as any)[key] = 'unsupported';
        assert.throws(f.caller);
        assert.equal(f.p.plans.length, 0);
        assert.equal(f.tag.calls.length, 0);
        assert.equal(f.controls.factoryCalls, 0);
    });
for (const key of ['version', 'runId', 'runAttempt', 'jobKey', 'sourceCommit', 'sourceTree'])
    test(`missing selected context ${key} refuses before any IO`, async () => {
        const f = await fixture();
        delete (f.selection.context as any)[key];
        assert.throws(f.caller);
        assert.equal(f.tag.calls.length, 0);
    });
for (const key of ['sourceFactory', 'execute', 'observeToolchain'])
    test(`missing build port ${key} cannot use native fallback`, async () => {
        const f = await fixture();
        delete (f.ports.build as any)[key];
        assert.throws(f.caller);
        assert.equal(f.tag.calls.length, 0);
    });
test('version mismatch refuses before reader or producer allocation', async () => {
    const f = await fixture();
    f.selection.context.version = '0.6.1';
    assert.throws(f.caller);
    assert.equal(f.tag.calls.length, 0);
    assert.equal(f.p.plans.length, 0);
});
test('pre-producer ref mismatch never allocates a build stage', async () => {
    const f = await fixture();
    f.tag.controls.response = (c: any, r: any) =>
        c.tail[0] === 'show-ref' ? { ...r, out: Buffer.from('f'.repeat(40) + '\n') } : r;
    const caller = f.caller();
    await assert.rejects(caller.run());
    assert.equal(f.p.plans.length, 0);
    assert.equal(f.p.filesystem.records.has(f.stage), false);
    assert.equal(caller.snapshot().producerSealed, false);
    assert.equal(f.controls.settles, 0);
});
test('post-producer tag mismatch refuses with original staged files retained', async () => {
    const f = await fixture();
    let refs = 0;
    f.tag.controls.response = (c: any, r: any) =>
        c.tail[0] === 'show-ref' && ++refs > 2
            ? { ...r, out: Buffer.from('f'.repeat(40) + '\n') }
            : r;
    const caller = f.caller();
    await assert.rejects(caller.run());
    assert.equal(caller.snapshot().producerSealed, true);
    assert.equal(caller.snapshot().complete, false);
    assert.equal(f.controls.settles, 0);
    assert.ok(f.p.filesystem.records.has(f.stage + '/artifacts/gateway-build.json'));
});
for (const name of [
    'gateway-build.json',
    'Diagnostic-Hub-Gateway-0.6.0.tar.gz',
    'Diagnostic-Hub-Gateway-0.6.0.tar.gz.sha256',
])
    test(`missing staged ${name} is refused without retry or cleanup`, async () => {
        const f = await fixture();
        f.controls.readback = () => {
            f.p.filesystem.records.delete(f.stage + '/artifacts/' + name);
        }; // Memory Map only.
        const caller = f.caller();
        await assert.rejects(caller.run());
        assert.equal(caller.snapshot().complete, false);
        assert.equal(f.p.plans.length, 2);
        assert.equal(f.controls.settles, 0);
        assert.equal(caller.snapshot().readersCompleted, 1);
        await assert.rejects(caller.run(), /one-shot/);
        assert.equal(f.p.plans.length, 2);
    });
test('plausible rewritten record cannot replace the original producer return', async () => {
    const f = await fixture();
    let changed: Buffer | undefined;
    f.controls.readback = () => {
        const file = f.stage + '/artifacts/gateway-build.json';
        const record = JSON.parse(f.p.filesystem.bytes(file).toString());
        record.builder.npmVersion = '11.0.1';
        changed = Buffer.from(JSON.stringify(record) + '\n');
        parseGatewayArchiveBuildRecord(changed, f.p.context);
        f.p.filesystem.write(file, changed);
    };
    await assert.rejects(f.caller().run(), (e: any) =>
        /differs from the original producer return/.test(e.cause.message),
    );
    assert.ok(changed);
    assert.equal(f.controls.settles, 0);
});
for (const name of [
    'Diagnostic-Hub-Gateway-0.6.0.tar.gz',
    'Diagnostic-Hub-Gateway-0.6.0.tar.gz.sha256',
    '../build/main.cjs',
])
    test(`mismatched readback ${name} never completes`, async () => {
        const f = await fixture();
        f.controls.readback = () => {
            const file =
                name === '../build/main.cjs'
                    ? f.stage + '/build/main.cjs'
                    : f.stage + '/artifacts/' + name;
            f.p.filesystem.write(file, Buffer.from('Different inert bytes.\n'));
        };
        const caller = f.caller();
        await assert.rejects(caller.run());
        assert.equal(caller.snapshot().readbackVerified, false);
        assert.equal(f.controls.settles, 0);
    });
for (const name of ['package.json', 'package-lock.json'])
    test(`missing original source ${name} cannot become a readback success`, async () => {
        const f = await fixture();
        f.controls.readback = () => {
            f.p.files.delete(name);
        }; // Source fixture Map only.
        await assert.rejects(f.caller().run());
        assert.equal(f.controls.settles, 0);
    });
test('source state changed after producer seal is refused before success', async () => {
    const f = await fixture();
    f.controls.readback = () => {
        f.controls.provider = {
            ...f.p.provider,
            async state() {
                return { ...(await f.p.provider.state()), sourceCommit: 'f'.repeat(40) };
            },
        };
    };
    const caller = f.caller();
    await assert.rejects(caller.run());
    assert.equal(caller.snapshot().producerSealed, true);
    assert.equal(caller.snapshot().readbackVerified, false);
});
for (const role of ['build', 'lock'])
    test(`failed ${role} remains retained and cannot restart`, async () => {
        const f = await fixture();
        const failure = Error('Authored memory command failure.');
        f.p.controls.throwRole = role;
        f.p.controls.failure = failure;
        const caller = f.caller();
        await assert.rejects(caller.run(), (e: any) => e.cause.cause === failure);
        assert.equal(caller.snapshot().failed, true);
        assert.equal(caller.snapshot().producerSealed, false);
        assert.equal(f.controls.settles, 0);
        const count = f.p.plans.length;
        await assert.rejects(caller.run(), /one-shot/);
        assert.equal(f.p.plans.length, count);
    });
test('falsey producer failure still fails the caller and preserves its cause', async () => {
    const f = await fixture();
    f.p.controls.throwRole = 'build';
    f.p.controls.failure = undefined;
    const caller = f.caller();
    await assert.rejects(
        caller.run(),
        (e: any) =>
            e.cause instanceof GatewayProducerFailure &&
            Object.hasOwn(e.cause, 'cause') &&
            e.cause.cause === undefined,
    );
    assert.equal(f.p.plans.length, 1);
    assert.equal(f.p.plans[0].role, 'build');
    assert.equal(caller.snapshot().failed, true);
    assert.equal(caller.snapshot().complete, false);
});
test('custody acknowledgement must complete before a successful result', async () => {
    const f = await fixture();
    let release!: () => void;
    f.controls.settle = () =>
        new Promise<void>((resolve) => {
            release = resolve;
        });
    const caller = f.caller();
    let completed = false;
    const running = caller.run().then((result) => {
        completed = true;
        return result;
    });
    await until(() => caller.snapshot().phase === 'settling' && Boolean(release));
    assert.equal(completed, false);
    assert.equal(caller.snapshot().complete, false);
    assert.equal(caller.snapshot().portsAcknowledged, false);
    release();
    assert.equal((await running).status, 'local-package-readback-complete');
    assert.equal(f.controls.settles, 1);
});
for (const cause of [undefined, null, 0])
    test(`falsey final acknowledgement failure ${String(cause)} stays nonpassing`, async () => {
        const f = await fixture();
        f.controls.settle = async () => {
            throw cause;
        };
        const caller = f.caller();
        await assert.rejects(caller.run(), (e: any) => e.cause === cause);
        assert.equal(caller.snapshot().failed, true);
        assert.equal(caller.snapshot().portsAcknowledged, false);
        assert.equal(caller.snapshot().complete, false);
        assert.equal(caller.snapshot().readbackVerified, true);
    });
test('a non-void custody result is not an acknowledgement', async () => {
    const f = await fixture();
    f.controls.settle = async () => true;
    const caller = f.caller();
    await assert.rejects(caller.run());
    assert.equal(caller.snapshot().complete, false);
});
test('one-shot reservation is made before callback reentrancy', async () => {
    const f = await fixture(),
        caller = f.caller();
    let nested: Promise<void> | undefined;
    f.tag.controls.beforeLaunch = () => {
        if (!nested) nested = assert.rejects(caller.run(), /one-shot/);
    };
    assert.equal((await caller.run()).status, 'local-package-readback-complete');
    await nested;
    assert.equal(f.p.plans.length, 2);
    assert.equal(f.controls.settles, 1);
});
test('selection snapshots cannot be retargeted through caller inputs', async () => {
    const f = await fixture(),
        caller = f.caller();
    f.selection.tagRef = 'refs/tags/v0.7.0';
    f.selection.context.runId = '999';
    const result = await caller.run();
    assert.equal(result.binding.tag.ref, 'refs/tags/v0.6.0');
    assert.equal(result.binding.context.runId, '123');
});
