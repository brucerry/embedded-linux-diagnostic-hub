import test from 'node:test';
import assert from 'node:assert/strict';
import {
    inspectWebBaselineArchive,
    webBaselineBuildFailureOwner,
} from '../scripts/lib/web-baseline-archive.mjs';
import { WebBuildCustodyFailure } from '../scripts/lib/owned-web-build.mjs';
import { mainLocal } from '../scripts/produce-web-archive.mjs';
import { produceLocalWebArchive } from '../scripts/lib/web-archive-producer.mjs';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { localArchiveFixture } from './fixtures/local-web-startup-memory.ts';

// Existing source/build doubles and actual archive codecs/parsers only. No process,
// filesystem write, native build, server, browser, timer or network port is supplied.
const blocked = [
    'native-executor-group-and-profile-admission',
    'independent-service-build-provenance',
    'installed-toolchain-provenance',
    'product-runtime',
    'loader',
    'per-GC-policies-and-measurements',
    'normal-retirement',
];
async function fixture() {
    const f = localArchiveFixture();
    const record = await produceLocalWebArchive(f.context, f.source.provider, f.io);
    const environmentSHA256 = sourceDigest(Buffer.from('memory-only complete environment'));
    const input = {
        context: { ...f.context },
        observer: { diagnosticId: f.context.diagnosticId, toolingCommit: f.context.sourceCommit },
        archiveBytes: Buffer.from(f.files.get(record.archive.name)!),
        buildRecordBytes: Buffer.from(f.files.get('local-web-build.json')!),
        checksumBytes: Buffer.from(f.files.get(record.checksum.name)!),
    };
    const summary = {
        status: record.status,
        archive: { ...record.archive },
        completeChildEnvironmentSHA256: environmentSHA256,
        releaseAcceptance: false,
        blocked: [...blocked],
    };
    const stdout = () => Buffer.from(JSON.stringify(summary) + '\n');
    const inspect = () => inspectWebBaselineArchive(stdout(), input, f.context, environmentSHA256);
    return { ...f, record, environmentSHA256, input, summary, stdout, inspect };
}

test('memory archive inspection binds actual codec bytes to the retained model output without service admission', async () => {
    const f = await fixture();
    const binding = f.inspect();
    assert.equal(binding.archiveSHA256, sourceDigest(f.input.archiveBytes));
    assert.equal(binding.buildRecordSHA256, sourceDigest(f.input.buildRecordBytes));
    assert.equal(binding.checksumSHA256, sourceDigest(f.input.checksumBytes));
    assert.equal(binding.originalStdoutSHA256, sourceDigest(f.stdout()));
    assert.equal(binding.sourceCommit, f.context.sourceCommit);
    assert.equal(binding.sourceTree, f.context.sourceTree);
    assert.equal(binding.releaseAcceptance, false);
    assert.equal(Object.isFrozen(binding), true);
    assert.equal(Object.hasOwn(binding, 'jobId'), false);
    assert.equal(Object.hasOwn(binding, 'serviceProvenance'), false);
});

test('original output descriptor mismatch is rejected even when archive input remains internally consistent', async () => {
    for (const field of ['sha256', 'bytes', 'name']) {
        const f = await fixture();
        Object.assign(
            f.summary.archive,
            field === 'sha256'
                ? { sha256: '0'.repeat(64) }
                : field === 'bytes'
                  ? { bytes: f.record.archive.bytes + 1 }
                  : { name: 'replacement.zip' },
        );
        assert.throws(f.inspect);
    }
});

test('corrupted ZIP, checksum and record bytes each fail the existing strict reader contract', async () => {
    for (const key of ['archiveBytes', 'checksumBytes', 'buildRecordBytes'] as const) {
        const f = await fixture();
        f.input[key][0] ^= 1;
        assert.throws(f.inspect);
    }
});

test('source, diagnostic and observer identity cannot be rebound through the model output', async () => {
    for (const key of ['sourceCommit', 'sourceTree', 'diagnosticId']) {
        const f = await fixture();
        Object.assign(f.input.context, {
            [key]: key === 'diagnosticId' ? 'f'.repeat(32) : 'f'.repeat(40),
        });
        assert.throws(f.inspect);
    }
    const f = await fixture();
    f.input.observer.toolingCommit = 'f'.repeat(40);
    assert.throws(f.inspect);
    Object.assign(f.input.observer, { jobId: '1' });
    assert.throws(f.inspect);
});

test('summary claims cannot promote this local archive to runtime or release acceptance', async () => {
    for (const change of ['status', 'release', 'blocked', 'service', 'environment']) {
        const f = await fixture();
        if (change === 'status') f.summary.status = 'runtime-passed';
        if (change === 'release') Object.assign(f.summary, { releaseAcceptance: true });
        if (change === 'blocked') f.summary.blocked = [];
        if (change === 'service') Object.assign(f.summary, { jobId: '1' });
        if (change === 'environment') f.summary.completeChildEnvironmentSHA256 = '0'.repeat(64);
        assert.throws(f.inspect);
    }
});

test('original summary must be finite canonical JSON, not a truncated or combined stream', async () => {
    const f = await fixture();
    for (const bytes of [
        Buffer.from('{'),
        f.stdout().subarray(0, -1),
        Buffer.concat([f.stdout(), f.stdout()]),
        Buffer.from(' ' + f.stdout().toString()),
        Buffer.alloc(4097, 32),
    ])
        assert.throws(() =>
            inspectWebBaselineArchive(bytes, f.input, f.context, f.environmentSHA256),
        );
});

test('inspection result does not grant authority to a changed input or expose mutable originals', async () => {
    const f = await fixture();
    const binding = f.inspect();
    f.input.archiveBytes[0] ^= 1;
    assert.throws(f.inspect);
    assert.equal(binding.archiveSHA256, f.record.archive.sha256);
    assert.equal(
        Object.values(binding).some((value) => Buffer.isBuffer(value)),
        false,
    );
});

test('local summary port rejects invalid callers before any source-owned capability is required', async () => {
    for (const output of [null, {}, 1, 'stdout'])
        await assert.rejects(mainLocal([], undefined, output), { name: 'AssertionError' });
    let emitted = false;
    await assert.rejects(
        mainLocal([], undefined, () => {
            emitted = true;
        }),
        /source-owned Git\/file\/environment capabilities required/,
    );
    assert.equal(emitted, false);
});

test('source build failure retains the exact original live compiler owner and its eventual join', async () => {
    let acknowledge!: (value: object) => void;
    let closed = false;
    const closure = new Promise<object>((resolve) => {
        acknowledge = resolve;
    });
    const original = Object.freeze({
        snapshot: () => ({
            childAcquired: true,
            childClosed: closed,
            stdoutClosed: closed,
            stderrClosed: closed,
        }),
        waitForDirectClosure: () => closure,
    });
    const failure = new WebBuildCustodyFailure('memory deferred compiler', original);
    const retained = webBaselineBuildFailureOwner(failure);
    assert.equal(retained, original);
    assert.equal(retained.snapshot().childClosed, false);
    assert.equal(retained.waitForDirectClosure(), closure);
    closed = true;
    const acknowledged = {
        childAcquired: true,
        childClosed: true,
        stdoutClosed: true,
        stderrClosed: true,
    };
    acknowledge(acknowledged);
    assert.equal(await retained.waitForDirectClosure(), acknowledged);
});

test('counts, unknown failures, proxies and accessor owners cannot replace actual compiler custody', () => {
    assert.equal(webBaselineBuildFailureOwner(undefined), null);
    assert.equal(webBaselineBuildFailureOwner(Error('opaque failure')), null);
    assert.equal(
        webBaselineBuildFailureOwner({ owner: { snapshot: () => ({ pending: 0, handles: 0 }) } }),
        null,
    );
    let reads = 0;
    const failure = new WebBuildCustodyFailure('memory owner getter', null);
    Object.defineProperty(failure, 'owner', {
        get() {
            reads++;
            return {};
        },
    });
    assert.equal(webBaselineBuildFailureOwner(failure), null);
    assert.equal(reads, 0);
    assert.equal(
        webBaselineBuildFailureOwner(
            new Proxy(failure, {
                get() {
                    reads++;
                    throw Error('must not read');
                },
            }),
        ),
        null,
    );
    assert.equal(reads, 0);
});
