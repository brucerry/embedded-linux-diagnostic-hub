import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseFastPolicy, validateFastMemoryPolicy } from './fixtures/memory-resource-policy';
import { fastIdentity, validateFastIdentity } from './fixtures/memory-fast-identity';
import { validateFastCollection, rssEvidence } from './fixtures/memory-fast-receipt';
import { requireNegativeDetection } from './fixtures/memory-resource-verdict';
import { collectionFixture } from './fixtures/memory-fast-test-input';
import { sha256 } from './fixtures/memory-resource-identity';
import { readEvidence, syncCloseEvidence } from './fixtures/memory-resource-evidence';

test('exact-policy positive and all five specific negative receipt routes use no real memory child', () => {
    const sharedPolicySHA256 = collectionFixture().policySHA256;
    for (const control of ['none', 'js', 'buffer', 'listener', 'timer', 'pin']) {
        const f = collectionFixture(control);
        assert.equal(
            f.policySHA256,
            sharedPolicySHA256,
            'All detector receipts must use the same exact policy bytes.',
        );
        assert.equal(
            parseFastPolicy(f.json, f.policySHA256, f.config).policySHA256,
            f.policySHA256,
        );
        const result = validateFastCollection(f);
        assert.equal(
            result.verdict,
            control === 'none' ? 'FINITE_POLICY_PASS' : 'EXPECTED_NEGATIVE_DETECTED',
        );
        if (control !== 'none')
            requireNegativeDetection(
                control,
                f.lifecycle,
                {
                    ...f.lifecycle,
                    lifecycle: f.lifecycle,
                    evidenceClosed: true,
                    verdict: result.verdict,
                    policySHA256: f.policySHA256,
                    samplerFailure: null,
                    childExit: 'normal-failure',
                } as any,
                result.audit.failure!,
                /./,
                f.policySHA256,
            );
    }
});
test('policy bytes, review bit, every binding and every required source input fail closed', () => {
    const f = collectionFixture();
    assert.throws(() => parseFastPolicy(f.json + ' ', f.policySHA256, f.config), /bytes changed/);
    assert.throws(() => parseFastPolicy(f.json, '', f.config), /reviewed policy SHA/);
    assert.throws(() => validateFastMemoryPolicy({ ...f.policy, reviewed: false }, f.config));
    for (const key of ['protocol', 'files', 'ssh', 'observer', 'launchInputs']) {
        const policy = structuredClone(f.policy);
        (policy.contract as any)[key] = {};
        assert.throws(() => validateFastMemoryPolicy(policy, f.config));
        const config = structuredClone(f.config);
        delete (config.contract as any)[key];
        assert.throws(() => validateFastIdentity(config.contract));
    }
    for (const key of [
        'sourceSHA256',
        'runtimeIdentity',
        'observerMode',
        'gcMode',
        'payloadBytes',
        'profile',
    ])
        assert.throws(() =>
            validateFastMemoryPolicy({ ...f.policy, [key]: 'different' }, f.config),
        );
});
test('missing close, signal, code disagreement, collector failure and policy hash substitution cannot pass', () => {
    for (const change of [
        { closeObserved: false },
        { exitObserved: false },
        { spawnObserved: false },
        { signal: 'SIGTERM', closeSignal: 'SIGTERM' },
        { closeCode: 1 },
        { timedOut: true },
        { error: 'I/O error' },
    ]) {
        const f = collectionFixture();
        Object.assign(f.lifecycle, change);
        assert.throws(() => validateFastCollection(f));
    }
    const f = collectionFixture();
    assert.throws(() => validateFastCollection({ ...f, evidenceClosed: false }));
    assert.throws(() => validateFastCollection({ ...f, samplerFailure: 'failed RSS write' }));
    assert.throws(() => validateFastCollection({ ...f, policySHA256: '0'.repeat(64) }));
    assert.throws(() => validateFastCollection({ ...f, childEvidence: undefined }));
    assert.throws(() =>
        validateFastCollection({
            ...f,
            childEvidence: { ...f.childEvidence, timelineSynced: false },
        }),
    );
    const negative = collectionFixture('js');
    assert.throws(
        () => validateFastCollection({ ...negative, childLog: 'write failed after failure row' }),
        /Leaf log/,
    );
});
test('unusable RSS, malformed timing and nonfinite required memory fields reject; real zero stays zero', () => {
    assert.throws(() => rssEvidence([], true));
    assert.throws(
        () =>
            rssEvidence(
                [{ startedMs: 0, completedMs: 1, latencyMs: 1, rssBytes: null, unavailable: true }],
                true,
            ),
        /usable RSS/,
    );
    assert.equal(
        rssEvidence(
            [{ startedMs: 0, completedMs: 1, latencyMs: 1, rssBytes: 0, unavailable: false }],
            true,
        ).peak,
        0,
    );
    assert.throws(() =>
        rssEvidence(
            [{ startedMs: 2, completedMs: 1, latencyMs: -1, rssBytes: 1, unavailable: false }],
            true,
        ),
    );
    const wrongPID = collectionFixture();
    wrongPID.rss[0].pid = 43;
    assert.throws(() => validateFastCollection(wrongPID), /RSS PID/);
    for (const metric of ['heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'rss']) {
        for (const invalid of [undefined, null, NaN, Infinity, -1]) {
            const f = collectionFixture();
            (f.rows[1].data as any)[metric] = invalid;
            assert.throws(() => validateFastCollection(f), /required memory metric/);
        }
    }
});
test('checkpoint omissions, owner/disk residue and forged seed logs are not detector receipts', () => {
    const a = collectionFixture();
    a.rows.splice(80, 1);
    assert.throws(() => validateFastCollection(a));
    const b = collectionFixture();
    b.rows.find((r) => r.stage === 'after-teardown')!.data.detail.owners = [{ kind: 'pin' }];
    assert.throws(() => validateFastCollection(b));
    const c = collectionFixture();
    c.rows.find((r) => r.stage === 'after-teardown')!.data.detail.diskRecords = 1;
    assert.throws(() => validateFastCollection(c));
    const d = collectionFixture('js');
    for (const r of d.rows) if (r.stage === 'closed-cycle') r.data.heapUsed = 100;
    assert.throws(() => validateFastCollection(d), /no exact-policy/);
    const e = collectionFixture('buffer');
    e.ceilings = { heapUsed: 10, arrayBuffers: 20 };
    assert.throws(() => validateFastCollection(e), /exact-policy numerical/);
});
test('generated SSH/package/loader and all file-backed launch inputs are read and hash-bound', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'fast-identity-fixture-'));
    try {
        for (const name of [
            'tests/fixtures/memory-resource-regression.ts',
            'tests/fixtures/memory-resource-evidence.ts',
            'tests/fixtures/memory-fast-identity.ts',
            'scripts/memory-runtime.mjs',
            'scripts/lib/owned-child.mjs',
            'scripts/lib/resource-owner.mjs',
            'tests/fixtures/memory-resource-negative.ts',
            'tests/fixtures/memory-resource-policy.ts',
            'tests/fixtures/memory-fast-receipt.ts',
        ]) {
            await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
            await fs.writeFile(path.join(root, name), 'fixture:' + name);
        }
        const lock = 'fixture lock',
            preload = 'fixture preload',
            bundle = 'fixture bundle',
            loader = path.join(root, 'loader.mjs');
        await fs.writeFile(path.join(root, 'package-lock.json'), lock);
        await fs.writeFile(path.join(root, 'preload.cjs'), preload);
        await fs.writeFile(path.join(root, 'ssh2.cjs'), bundle);
        await fs.writeFile(loader, 'fixture loader');
        const core = {
            lockSHA256: sha256(lock),
            files: { 'preload.cjs': sha256(preload), 'ssh2.cjs': sha256(bundle) },
            packages: [],
            inputs: [],
            loaderInputs: [{ path: loader, sha256: sha256('fixture loader') }],
        };
        const manifestPath = path.join(root, 'manifest.json');
        await fs.writeFile(
            manifestPath,
            JSON.stringify({ ...core, id: sha256(JSON.stringify(core)) }),
        );
        const profile = { kind: 'ssh2-js-bundle', manifestPath };
        const identity = await fastIdentity(root, 'sampled', profile, [
            '--require',
            path.join(root, 'preload.cjs'),
            '--import=' + loader,
        ]);
        assert.equal(Object.keys(identity.launchInputs).length, 2);
        await fs.writeFile(loader, 'changed loader');
        await assert.rejects(
            fastIdentity(root, 'sampled', profile, ['--import', loader]),
            /input changed/,
        );
        await fs.writeFile(loader, 'fixture loader');
        await fs.writeFile(path.join(root, 'preload.cjs'), 'tampered');
        await assert.rejects(fastIdentity(root, 'sampled', profile, ['--import', loader]));
    } finally {
        await fs.rm(root, { recursive: true });
    }
});
test('all evidence sync/close operations run after faults and file reads enforce their byte bounds', async () => {
    const calls: string[] = [];
    const errors = await syncCloseEvidence(
        [0, 1].map((i) => ({
            async sync() {
                calls.push('sync' + i);
                if (i === 0) throw Error('failed fsync');
            },
            async close() {
                calls.push('close' + i);
                if (i === 1) throw Error('failed close');
            },
        })),
    );
    assert.equal(errors.length, 2);
    assert.deepEqual(calls.sort(), ['close0', 'close1', 'sync0', 'sync1']);
    const root = await fs.mkdtemp(path.join(tmpdir(), 'bounded-evidence-fixture-'));
    try {
        const file = path.join(root, 'row');
        await fs.writeFile(file, '12345');
        assert.equal(await readEvidence(file, 5), '12345');
        await assert.rejects(readEvidence(file, 4), /bound exceeded/);
        await assert.rejects(readEvidence(root, 100));
    } finally {
        await fs.rm(root, { recursive: true });
    }
});
