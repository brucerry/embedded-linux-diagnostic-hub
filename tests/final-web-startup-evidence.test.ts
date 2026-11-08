import { stagedGCFixture, gcHash } from './fixtures/staged-gc-evidence-memory.mjs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import test, { before } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    consumeFinalWebStartupEvidence,
    validateFinalWebStartupObservation,
} from '../scripts/lib/final-web-startup-evidence.mjs';
import { verifyProducerEvidence, producerCases } from '../scripts/lib/staged-artifact-gate.mjs';
import { startupEvidenceFixture, canonical, sha } from './fixtures/final-web-startup-memory.mjs';

let publicationVerifier = verifyProducerEvidence;
before(async () => {
    if (process.env.HUB_ORIGINAL_STAGED_GATE)
        publicationVerifier = (
            await import(pathToFileURL(process.env.HUB_ORIGINAL_STAGED_GATE).href)
        ).verifyProducerEvidence;
});

const consume = (f: any) => consumeFinalWebStartupEvidence(f.receipt, f.expected, f.read);
function replace(f: any, file: string, update: (value: any) => void, encode = canonical) {
    const value = JSON.parse(f.files.get(file).toString());
    update(value);
    const bytes = encode(value);
    f.files.set(file, bytes);
    const reference = f.receipt.cases
        .flatMap((row: any) => row.evidence)
        .find((row: any) => row.path === file);
    Object.assign(reference, { bytes: bytes.length, sha256: sha(bytes) });
}
test('actual startup emitter bytes for all three engines reach the retained semantic consumer', async () => {
    const f = await startupEvidenceFixture();
    assert.deepEqual(await consume(f), {
        status: 'startup-observations-correlated-unqualified',
        releaseAcceptance: false,
    });
});

test('actual emitter retains repeated resource counts and exact body totals', async () => {
    const f = await startupEvidenceFixture({ repeat: true });
    for (const engine of ['chromium', 'firefox', 'webkit']) {
        const record = await f.read('web/' + engine + '-startup.json');
        assert.equal(record.observations.responseObjectsRead, 3);
        assert.equal(
            record.observations.resources.find((row: any) => row.path === 'assets/main.js')
                .responses,
            2,
        );
    }
    assert.equal((await consume(f)).releaseAcceptance, false);
});

test('consumer preserves all three observer ID bounds even when independent selections match', async () => {
    const f = await startupEvidenceFixture();
    for (const field of ['runId', 'runAttempt', 'jobId']) {
        const value = await f.read('web/chromium-startup.json');
        value.observer[field] = '1'.repeat(33);
        assert.throws(() =>
            validateFinalWebStartupObservation(value, f.record, {
                ...f.expected,
                [field]: value.observer[field],
                engine: 'chromium',
                browserVersion: f.receipt.browserVersions.chromium,
                buildRecordSHA256: sha(f.files.get('web/web-build.json')),
            }),
        );
    }
});

for (const [label, update] of [
    [
        'foreign source',
        (v: any) => {
            v.selectedSource.commit = 'f'.repeat(40);
        },
    ],
    [
        'foreign tree',
        (v: any) => {
            v.selectedSource.tree = 'f'.repeat(40);
        },
    ],
    [
        'foreign build',
        (v: any) => {
            v.selectedSource.buildRecordSHA256 = 'f'.repeat(64);
        },
    ],
    [
        'foreign archive',
        (v: any) => {
            v.archive.sha256 = 'f'.repeat(64);
        },
    ],
    [
        'foreign run',
        (v: any) => {
            v.observer.runId = '124';
        },
    ],
    [
        'foreign attempt',
        (v: any) => {
            v.observer.runAttempt = '2';
        },
    ],
    [
        'swapped engine',
        (v: any) => {
            v.observer.engineReported = 'firefox';
        },
    ],
    [
        'foreign browser version',
        (v: any) => {
            v.observer.browserVersionReported = 'foreign';
        },
    ],
    [
        'failed UI',
        (v: any) => {
            v.observations.startupControlsVisible = false;
        },
    ],
    [
        'pending callbacks',
        (v: any) => {
            v.observations.observerCallbacksJoined = false;
        },
    ],
    [
        'private hooks',
        (v: any) => {
            v.observations.adapterInstalledHooks = ['synthetic'];
        },
    ],
    [
        'changed resource',
        (v: any) => {
            v.observations.resources[0].sha256 = 'f'.repeat(64);
        },
    ],
    [
        'duplicate resource',
        (v: any) => {
            v.observations.resources.push(v.observations.resources[0]);
        },
    ],
    [
        'missing navigation',
        (v: any) => {
            v.observations.resources.pop();
        },
    ],
    [
        'wrong navigation digest',
        (v: any) => {
            v.observations.navigationDocumentSHA256 = 'f'.repeat(64);
        },
    ],
    [
        'impossible body total',
        (v: any) => {
            v.observations.responseBodyBytes = 0;
        },
    ],
    [
        'impossible repeated-body total',
        (v: any) => {
            v.observations.responseObjectsRead = 3;
            v.observations.responseBodyBytes = 140;
            v.observations.resources[0].responses = 2;
        },
    ],
    [
        'unmatched repeated count',
        (v: any) => {
            v.observations.responseObjectsRead = 3;
        },
    ],
    [
        'fractional repeated count',
        (v: any) => {
            v.observations.resources[0].responses = 1.5;
        },
    ],
    [
        'missing repeated count',
        (v: any) => {
            delete v.observations.resources[0].responses;
        },
    ],
    [
        'response bound exceeded',
        (v: any) => {
            v.observations.responseObjectsRead = 4097;
        },
    ],
    [
        'foreign origin',
        (v: any) => {
            v.host.origin = 'https://example.invalid';
        },
    ],
    [
        'acceptance relabeling',
        (v: any) => {
            v.releaseAcceptance = true;
        },
    ],
    [
        'invented GC',
        (v: any) => {
            v.normalGC = { status: 'passed' };
        },
    ],
    [
        'invented retirement',
        (v: any) => {
            v.processRetirement = 'closed';
        },
    ],
    [
        'unknown field',
        (v: any) => {
            v.newClaim = true;
        },
    ],
] as const)
    test(
        'honestly rehashed ' + label + ' cannot satisfy the web observation consumer',
        async () => {
            const f = await startupEvidenceFixture();
            replace(f, 'web/chromium-startup.json', update);
            await assert.rejects(consume(f));
        },
    );

for (const mode of [
    'missing',
    'duplicate',
    'wrong-case',
    'summary-only',
    'noncanonical',
    'duplicate-key',
])
    test('fixed retained producer linkage rejects ' + mode, async () => {
        const f = await startupEvidenceFixture(),
            item = f.receipt.cases[1];
        if (mode === 'missing') item.evidence = [];
        if (mode === 'duplicate') item.evidence.push({ ...item.evidence[0] });
        if (mode === 'wrong-case') {
            const moved = item.evidence.pop();
            assert.ok(moved);
            f.receipt.cases[2].evidence.push(moved);
        }
        if (mode === 'summary-only') f.read = async () => ({ status: 'passed' });
        if (mode === 'noncanonical')
            replace(
                f,
                'web/chromium-startup.json',
                () => {},
                (v: any) => Buffer.from(JSON.stringify(v, null, 2) + '\n'),
            );
        if (mode === 'duplicate-key')
            replace(
                f,
                'web/chromium-startup.json',
                () => {},
                (v: any) =>
                    Buffer.from(JSON.stringify(v).replace('{', '{"schemaVersion":0,') + '\n'),
            );
        await assert.rejects(consume(f));
    });

test('selected final archive/checksum and build source context are both consumed', async () => {
    for (const mode of ['archive', 'checksum', 'build-source', 'build-qualification']) {
        const f = await startupEvidenceFixture();
        if (mode === 'archive')
            f.expected.artifacts[0] = { ...f.expected.artifacts[0], sha256: 'f'.repeat(64) };
        if (mode === 'checksum') f.expected.artifacts[1] = { ...f.expected.artifacts[1], bytes: 1 };
        if (mode === 'build-source')
            replace(f, 'web/web-build.json', (v: any) => {
                v.context.sourceCommit = 'f'.repeat(40);
            });
        if (mode === 'build-qualification')
            replace(f, 'web/web-build.json', (v: any) => {
                v.releaseAcceptance = true;
            });
        await assert.rejects(consume(f));
    }
});

test('actual publication boundary consumes fixed startup files and still rejects full-product promotion', async () => {
    const f = await startupEvidenceFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'hub-web-startup-memory-'));
    try {
        const references: { path: string; bytes: number; sha256: string }[] = [];
        const gc = stagedGCFixture('web');
        for (const [file, bytes] of gc.files) {
            f.files.set(file, bytes);
            references.push({ path: file, bytes: bytes.length, sha256: gcHash(bytes) });
        }
        for (const role of ['profile']) {
            const bytes = canonical({ kind: 'synthetic-unqualified-' + role });
            f.files.set(role + '.json', bytes);
            references.push({ path: role + '.json', bytes: bytes.length, sha256: sha(bytes) });
        }
        f.receipt.cases[4].evidence.push(...references);
        const hash = (role: string) =>
            references.find((row) => row.path === role + '.json')!.sha256;
        Object.assign(f.receipt, {
            schemaVersion: 2,
            kind: 'staged-artifact-producer',
            status: 'passed',
            ...f.expected,
            qualificationScope: 'full-product',
            runtime: {
                platform: 'linux',
                arch: 'x64',
                osRelease: 'synthetic',
                node: '24.19.0',
                executable: '/synthetic/node',
                executableSHA256: 'c'.repeat(64),
            },
            runtimeProfileSHA256: hash('profile'),
            normalGC: structuredClone(gc.normalGC),
            forcedGC: structuredClone(gc.forcedGC),
        });
        assert.deepEqual(
            f.receipt.cases.map((row) => row.id),
            producerCases('web'),
        );
        for (const item of f.receipt.cases)
            Object.assign(item, {
                status: 'passed',
                exitCode: 0,
                signal: null,
                command: ['synthetic-control-never-launched', item.id],
            });
        for (const [file, bytes] of f.files) {
            await mkdir(path.dirname(path.join(root, file)), { recursive: true });
            await writeFile(path.join(root, file), bytes, { flag: 'wx' });
        }
        await assert.rejects(
            publicationVerifier(root, f.receipt, f.expected),
            /authoritative final-artifact.*schemas and producers are not implemented/,
        );
        replace(f, 'web/chromium-startup.json', (v: any) => {
            v.observer.engineReported = 'firefox';
        });
        const changed = f.files.get('web/chromium-startup.json');
        assert.ok(changed);
        await writeFile(path.join(root, 'web/chromium-startup.json'), changed);
        await assert.rejects(
            publicationVerifier(root, f.receipt, f.expected),
            (error) =>
                error instanceof Error &&
                'code' in error &&
                error.code === 'ERR_ASSERTION' &&
                /firefox/.test(error.message),
        );
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('hub-web-startup-memory-'));
        await rm(root, { recursive: true });
    }
});
