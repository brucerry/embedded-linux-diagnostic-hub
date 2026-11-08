import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { before } from 'node:test';
import * as current from '../scripts/lib/staged-artifact-gate.mjs';
import { stagedGCFixture, gcJSON } from './fixtures/staged-gc-evidence-memory.mjs';

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
    const gc = stagedGCFixture(scope);
    const documents: Record<string, any> = {
        profile: { status: 'runtime-inspection', runtime, qualification: false },
        loader: { kind: 'ssh2-js-bundle', qualification: 'harness-only' },
        'normal-policy': JSON.parse(gc.files.get('normal-policy.json')!.toString()),
        'forced-policy': JSON.parse(gc.files.get('forced-policy.json')!.toString()),
        normal: gc.timelines.normal,
        forced: gc.timelines.forced,
    };
    const filename = (name: string) =>
        name + (name === 'normal' || name === 'forced' ? '.jsonl' : '.json');
    const encode = (name: string, value: any) =>
        name === 'normal' || name === 'forced' ? Buffer.concat(value.map(gcJSON)) : gcJSON(value);
    const evidence: { path: string; bytes: number; sha256: string }[] = [];
    for (const [name, value] of Object.entries(documents)) {
        const bytes = encode(name, value);
        await writeFile(path.join(root, filename(name)), bytes);
        evidence.push({ path: filename(name), bytes: bytes.length, sha256: gate.digest(bytes) });
    }
    const hash = (name: string) => evidence.find((item) => item.path === filename(name))!.sha256;
    const receipt = {
        schemaVersion: 2,
        kind: 'staged-artifact-producer',
        status: 'passed',
        ...expected,
        runtime,
        qualificationScope: 'full-product',
        runtimeProfileSHA256: hash('profile'),
        normalGC: structuredClone(gc.normalGC),
        forcedGC: structuredClone(gc.forcedGC),
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
    async function replace(name: string, value: any, raw = false) {
        if (!raw && (name === 'normal' || name === 'forced') && !Array.isArray(value)) {
            const rows = structuredClone(documents[name]);
            Object.assign(rows.at(-1).data, value);
            value = rows;
        }
        const bytes = raw ? Buffer.from(String(value)) : encode(name, value);
        const oldHash = hash(name),
            sha256 = gate.digest(bytes);
        await writeFile(path.join(root, filename(name)), bytes);
        for (const item of receipt.cases)
            for (const entry of item.evidence)
                if (entry.path === filename(name))
                    Object.assign(entry, { bytes: bytes.length, sha256 });
        for (const key of ['runtimeProfileSHA256', 'loaderProvenanceSHA256'] as const)
            if (receipt[key] === oldHash) receipt[key] = sha256;
        for (const lane of [receipt.normalGC, receipt.forcedGC]) {
            if (lane.receiptSHA256 === oldHash) lane.receiptSHA256 = sha256;
            if (lane.policySHA256 === oldHash) lane.policySHA256 = sha256;
        }
    }
    return {
        root,
        receipt,
        expected,
        verify,
        replace,
        documents,
        close: async () => {
            assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
            assert.ok(path.basename(root).startsWith('hub-synthetic-producer-'));
            await rm(root, { recursive: true });
        },
    };
}

test('positive summary schemas and exact retained bytes cannot close the missing semantic contract', async () => {
    for (const scope of ['web', 'gateway', 'desktop-linux-x64']) {
        const f = await fixture(scope);
        try {
            assert.equal(gate.validateProducerReceipt(f.receipt, f.expected), f.receipt);
            await gate.verifyEvidence(f.root, f.receipt.cases);
            await assert.rejects(f.verify(), scope === 'web' ? /fixed web evidence path/ : blocked);
        } finally {
            await f.close();
        }
    }
});

for (const [label, role, value] of [
    [
        'foreign source',
        'normal',
        { status: 'passed-reviewed-memory-scope', sourceSHA256: 'f'.repeat(64) },
    ],
    [
        'foreign runtime',
        'profile',
        { status: 'passed', runtime: { node: '22.0.0', executableSHA256: 'f'.repeat(64) } },
    ],
    ['unreviewed policy', 'normal-policy', { reviewed: false }],
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
            if (role === 'profile') await assert.rejects(f.verify(), blocked);
            else await assert.rejects(f.verify(), (error: Error) => !blocked.test(error.message));
        } finally {
            await f.close();
        }
    });
}

test('GC payload reuse is refused even when both summary results claim separate passes', async () => {
    const f = await fixture();
    try {
        f.receipt.forcedGC.receiptSHA256 = f.receipt.normalGC.receiptSHA256;
        assert.throws(() => gate.validateProducerReceipt(f.receipt, f.expected), /must not reuse/);
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
            (item: { path: string }) => item.path === 'normal-policy.json',
        )!;
        await writeFile(
            path.join(f.root, 'normal-policy-copy.json'),
            await readFile(path.join(f.root, original.path)),
        );
        f.receipt.cases[0].evidence.push({ ...original, path: 'normal-policy-copy.json' });
        await assert.rejects(f.verify(), /ambiguous retained normal GC policy/);
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
                        (entry: { path: string }) => entry.path !== 'normal.jsonl',
                    );
            if (mode === 'missing file') await rm(path.join(f.root, 'normal.jsonl'));
            if (mode === 'changed bytes')
                await writeFile(path.join(f.root, 'normal.jsonl'), 'changed');
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
