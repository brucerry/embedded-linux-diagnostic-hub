import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { before } from 'node:test';
import * as current from '../scripts/lib/staged-artifact-gate.mjs';

// Only regression sensitivity uses the exact restored original library. No product runs.
let gate: typeof current = current;
before(async () => {
    if (process.env.HUB_ORIGINAL_STAGED_GATE)
        gate = await import(pathToFileURL(process.env.HUB_ORIGINAL_STAGED_GATE).href);
});
const selected = {
    version: '0.6.0',
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    runId: '123',
    runAttempt: '2',
};
const blocked = /authoritative final-artifact.*schemas and producers are not implemented/;
async function fixture(scope = 'gateway') {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hub-synthetic-producer-'));
    const artifacts = gate.producerFiles(selected.version, scope).map((name: string) => ({
        name,
        bytes: 7,
        sha256: gate.digest('fixture'),
    }));
    const expected = { ...selected, scope, artifacts };
    const runtime = {
        platform: 'linux',
        arch: 'x64',
        osRelease: 'synthetic OS fixture',
        node: '24.19.0',
        executable: '/synthetic/node',
        executableSHA256: 'c'.repeat(64),
    };
    const documents: Record<string, unknown> = {
        // Existing harness policy shape, with synthetic budgets/hashes only. Not calibration.
        policy: {
            reviewed: true,
            identitySHA256: 'd'.repeat(64),
            roles: {
                synthetic: {
                    heapUsedBytes: {
                        maxDeltaBytes: 1,
                        maxSlopeBytesPerCycle: 0,
                        calibrationRuns: Array.from({ length: 10 }, (_, i) =>
                            gate.digest('synthetic-' + i),
                        ),
                    },
                },
            },
        },
        profile: { status: 'runtime-inspection', runtime, qualification: false },
        normal: { status: 'passed-reviewed-memory-scope', lane: 'gateway', gcMode: 'normal' },
        forced: { status: 'passed-reviewed-memory-scope', lane: 'gateway', gcMode: 'forced' },
        loader: { kind: 'ssh2-js-bundle', qualification: 'harness-only' },
    };
    const evidence: { path: string; bytes: number; sha256: string }[] = [];
    for (const [name, value] of Object.entries(documents)) {
        const bytes = JSON.stringify(value);
        await writeFile(path.join(root, name + '.json'), bytes);
        evidence.push({
            path: name + '.json',
            bytes: Buffer.byteLength(bytes),
            sha256: gate.digest(bytes),
        });
    }
    const hash = (name: string) => evidence.find((item) => item.path === name + '.json')!.sha256;
    const receipt = {
        schemaVersion: 1,
        kind: 'staged-artifact-producer',
        status: 'passed',
        ...expected,
        runtime,
        qualificationScope: 'full-product',
        reviewedPolicySHA256: hash('policy'),
        runtimeProfileSHA256: hash('profile'),
        normalGC: {
            status: 'passed',
            elapsedMs: 1800000,
            completedCycles: 100,
            receiptSHA256: hash('normal'),
        },
        forcedGC: {
            status: 'passed',
            elapsedMs: 1800000,
            completedCycles: 100,
            receiptSHA256: hash('forced'),
        },
        optionalNativeAddon: 'absent',
        loaderProvenanceSHA256: hash('loader'),
        electronVersion: '44.5.1',
        browserVersions: { chromium: 'synthetic', firefox: 'synthetic', webkit: 'synthetic' },
        cases: gate.producerCases(scope).map((id: string) => ({
            id,
            status: 'passed',
            command: ['synthetic-schema-fixture', id],
            exitCode: 0,
            signal: null,
            evidence: structuredClone(evidence),
        })),
    };
    const verify = () =>
        gate.verifyProducerEvidence
            ? gate.verifyProducerEvidence(root, receipt, expected)
            : Promise.resolve().then(() => {
                  gate.validateProducerReceipt(receipt, expected);
                  return gate.verifyEvidence(root, receipt.cases);
              });
    async function replace(name: string, value: unknown, raw = false) {
        const bytes = raw ? String(value) : JSON.stringify(value);
        await writeFile(path.join(root, name + '.json'), bytes);
        const oldHash = hash(name);
        const sha256 = gate.digest(bytes);
        for (const item of receipt.cases)
            for (const entry of item.evidence)
                if (entry.path === name + '.json')
                    Object.assign(entry, { bytes: Buffer.byteLength(bytes), sha256 });
        for (const key of [
            'reviewedPolicySHA256',
            'runtimeProfileSHA256',
            'loaderProvenanceSHA256',
        ] as const)
            if (receipt[key] === oldHash) receipt[key] = sha256;
        for (const lane of [receipt.normalGC, receipt.forcedGC])
            if (lane.receiptSHA256 === oldHash) lane.receiptSHA256 = sha256;
    }
    return {
        root,
        receipt,
        expected,
        verify,
        replace,
        documents,
        close: () => rm(root, { recursive: true }),
    };
}

test('positive summary schemas and exact retained bytes cannot close the missing semantic contract', async () => {
    for (const scope of ['web', 'gateway', 'desktop-linux-x64']) {
        const f = await fixture(scope);
        try {
            assert.equal(gate.validateProducerReceipt(f.receipt, f.expected), f.receipt);
            await gate.verifyEvidence(f.root, f.receipt.cases);
            await assert.rejects(f.verify(), blocked);
        } finally {
            await f.close();
        }
    }
});

for (const [label, role, value] of [
    [
        'foreign source',
        'normal',
        { status: 'passed-reviewed-memory-scope', sourceCommit: 'f'.repeat(40) },
    ],
    [
        'foreign runtime',
        'profile',
        { status: 'passed', runtime: { node: '22.0.0', executableSHA256: 'f'.repeat(64) } },
    ],
    ['unreviewed policy', 'policy', { reviewed: false }],
    ['failed receipt', 'normal', { status: 'failed', failure: 'synthetic failed control' }],
    ['calibration-only receipt', 'normal', { status: 'collected-product-calibration-evidence' }],
    ['component receipt', 'normal', { status: 'passed-component-reviewed-memory' }],
    ['swapped GC payload', 'normal', { status: 'passed-reviewed-memory-scope', gcMode: 'forced' }],
    ['malformed JSON payload', 'normal', '{synthetic-invalid-json'],
] as const) {
    test(label + ' with honest retained hashes cannot qualify', async () => {
        const f = await fixture();
        try {
            await f.replace(role, value, label === 'malformed JSON payload');
            // The old consumer accepts all of these: summaries and honest hashes still match.
            gate.validateProducerReceipt(f.receipt, f.expected);
            await gate.verifyEvidence(f.root, f.receipt.cases);
            await assert.rejects(f.verify(), blocked);
        } finally {
            await f.close();
        }
    });
}

test('GC payload reuse is refused even when both summary results claim separate passes', async () => {
    const f = await fixture();
    try {
        f.receipt.forcedGC.receiptSHA256 = f.receipt.normalGC.receiptSHA256;
        gate.validateProducerReceipt(f.receipt, f.expected);
        await gate.verifyEvidence(f.root, f.receipt.cases);
        await assert.rejects(f.verify(), /must not reuse/);
    } finally {
        await f.close();
    }
});

test('a hash resolving to two distinct retained paths is ambiguous', async () => {
    const f = await fixture();
    try {
        const original = f.receipt.cases[0].evidence.find(
            (item: { path: string }) => item.path === 'policy.json',
        )!;
        await writeFile(
            path.join(f.root, 'policy-copy.json'),
            await readFile(path.join(f.root, original.path)),
        );
        f.receipt.cases[0].evidence.push({ ...original, path: 'policy-copy.json' });
        await assert.rejects(f.verify(), /ambiguous retained reviewed policy/);
    } finally {
        await f.close();
    }
});

for (const mode of ['missing reference', 'missing file', 'changed bytes', 'wrong length']) {
    test(mode + ' is refused before the unsupported-contract block', async () => {
        const f = await fixture();
        try {
            if (mode === 'missing reference')
                for (const item of f.receipt.cases)
                    item.evidence = item.evidence.filter(
                        (entry: { path: string }) => entry.path !== 'normal.json',
                    );
            if (mode === 'missing file') await rm(path.join(f.root, 'normal.json'));
            if (mode === 'changed bytes')
                await writeFile(path.join(f.root, 'normal.json'), 'changed');
            if (mode === 'wrong length') f.receipt.cases[0].evidence[0].bytes++;
            await assert.rejects(f.verify(), (error: Error) => !blocked.test(error.message));
        } finally {
            await f.close();
        }
    });
}

test('all three real consumer paths require the publication boundary verifier', async () => {
    const source = await readFile('scripts/staged-artifact-gate.mjs', 'utf8');
    assert.match(
        source,
        /await verifyProducerEvidence\(output, receipt, \{ \.\.\.selected, scope, artifacts: expected \}\)/,
    );
    assert.match(
        source,
        /await verifyProducerEvidence\(path\.dirname\(productInput\), product, \{/,
    );
    assert.match(source, /await verifyProducerEvidence\(productRoot, receipt\.product, \{/);
    assert.doesNotMatch(source, /validateProducerReceipt\(/);
});
