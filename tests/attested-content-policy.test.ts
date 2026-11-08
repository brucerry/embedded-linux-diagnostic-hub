import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const filename = path.resolve('scripts/lib/attested-content-policy.mjs');
const source = fs.readFileSync(filename, 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
    },
}).outputText;
const realRequire = createRequire(import.meta.url);
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const gitID = (text: string) => createHash('sha1').update(text).digest('hex');
const repository = 'brucerry/embedded-linux-diagnostic-hub';
const repositoryURI = 'https://github.com/' + repository;
const predicateType = 'https://embedded-linux-diagnostic-hub.dev/attestation/content/v1';
const mediaType = 'application/vnd.dev.sigstore.verificationresult+json;version=0.1';

/** Only this literal verifier dependency is replaced; production policy has no test switch. */
function policy(backend: (request: any) => Promise<any>) {
    const module = { exports: {} as any };
    vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, {
        filename: filename + ':synthetic-policy-test',
    })(
        (id: string) => {
            if (id === './attested-content-verifier.mjs')
                return { verifyLocalAttestation: backend };
            assert.ok(
                ['node:assert/strict', 'node:crypto', 'node:util', 'node:path'].includes(id),
                'Unexpected policy dependency: ' + id,
            );
            return realRequire(id);
        },
        module,
        module.exports,
    );
    return module.exports;
}

function fixture() {
    // Opaque synthetic content: never an actual package, signed bundle, trust root or executable.
    const archiveBytes = Buffer.from('synthetic opaque archive bytes\n');
    const archive = {
        name: 'diagnostic-hub-0.6.0.zip',
        bytes: archiveBytes.length,
        sha256: sha256(archiveBytes),
    };
    const application = {
        commit: gitID('synthetic application commit'),
        tree: gitID('synthetic application tree'),
        sourceManifestSHA256: sha256('synthetic source inventory'),
    };
    const signerCommit = gitID('synthetic independently reviewed reusable signer');
    const sourceCommit = gitID('synthetic initiating workflow commit');
    const sourceRef = 'refs/tags/v0.6.0';
    const value = {
        schemaVersion: 1,
        kind: 'diagnostic-hub-attested-content-record',
        repository,
        version: '0.6.0',
        application,
        archive,
        producerClaims: {
            buildID: 'synthetic-build',
            buildRunID: '71',
            buildRunAttempt: '2',
            buildJobID: 'unverified-producer-job',
        },
    };
    let recordBytes = Buffer.from(JSON.stringify(value) + '\n');
    const request = {
        policy: {
            schemaVersion: 1,
            kind: 'diagnostic-hub-attested-content-policy',
            repository,
            version: '0.6.0',
            issuer: 'https://token.actions.githubusercontent.com',
            predicateType,
            signer: {
                workflowURI: `${repositoryURI}/.github/workflows/attest-content.yml@${signerCommit}`,
                commit: signerCommit,
            },
            source: {
                commit: sourceCommit,
                ref: sourceRef,
                repositoryID: '123456',
                ownerID: '654321',
                buildConfigURI: `${repositoryURI}/.github/workflows/release.yml@${sourceRef}`,
                buildTrigger: 'workflow_dispatch',
            },
        },
        expected: {
            application: structuredClone(application),
            archive: { ...archive },
            record: {
                name: 'attested-content-record.json',
                bytes: recordBytes.length,
                sha256: sha256(recordBytes),
            },
            run: { id: '1701', attempt: '3' },
        },
        files: {
            archivePath: '/synthetic/archive.zip',
            recordPath: '/synthetic/record.json',
            bundle: {
                path: '/synthetic/bundle.jsonl',
                bytes: Buffer.byteLength('synthetic unsigned bundle bytes\n'),
                sha256: sha256('synthetic unsigned bundle bytes\n'),
            },
        },
        verifier: {
            tool: {
                path: '/synthetic/trusted-gh',
                sha256: sha256('synthetic never-executed gh selection'),
                version: '2.103.3',
            },
            trustedRoot: {
                path: '/synthetic/independently-selected-root.jsonl',
                bytes: 25,
                sha256: sha256('synthetic trusted root pin'),
            },
            configurationDirectory: '/synthetic/private-empty-config',
        },
    };
    const certificate: Record<string, string> = {
        issuer: request.policy.issuer,
        subjectAlternativeName: request.policy.signer.workflowURI,
        buildSignerURI: request.policy.signer.workflowURI,
        buildSignerDigest: signerCommit,
        runnerEnvironment: 'github-hosted',
        sourceRepositoryURI: repositoryURI,
        sourceRepositoryDigest: sourceCommit,
        sourceRepositoryRef: sourceRef,
        sourceRepositoryIdentifier: request.policy.source.repositoryID,
        sourceRepositoryOwnerURI: 'https://github.com/brucerry',
        sourceRepositoryOwnerIdentifier: request.policy.source.ownerID,
        buildConfigURI: request.policy.source.buildConfigURI,
        buildConfigDigest: sourceCommit,
        buildTrigger: 'workflow_dispatch',
        runInvocationURI: `${repositoryURI}/actions/runs/1701/attempts/3`,
    };
    const requests: any[] = [];
    function proof(kind: 'archive' | 'record') {
        return {
            subject: { kind, ...request.expected[kind] },
            verificationResults: [
                {
                    attestation: { synthetic: true },
                    verificationResult: {
                        mediaType,
                        signature: { certificate: structuredClone(certificate) },
                        // Exact sigstore-go v1.4.0 labels: signed_entity.go lines 795, 818, 841.
                        verifiedTimestamps: [
                            {
                                type: 'Tlog',
                                uri: 'synthetic-authority',
                                timestamp: '2026-11-05T00:00:00Z',
                            },
                        ],
                        statement: {
                            _type: 'https://in-toto.io/Statement/v1',
                            subject: ['archive', 'record'].map((key) => ({
                                name: request.expected[key as 'archive' | 'record'].name,
                                digest: {
                                    sha256: request.expected[key as 'archive' | 'record'].sha256,
                                },
                            })),
                            predicateType,
                            predicate: {
                                synthetic: true,
                                producerClaims: structuredClone(value.producerClaims),
                            },
                        },
                    },
                },
            ],
            verifier: {
                toolSHA256: request.verifier.tool.sha256,
                toolVersion: request.verifier.tool.version,
                trustedRootSHA256: request.verifier.trustedRoot.sha256,
                bundleSHA256: request.files.bundle.sha256,
            },
            ...(kind === 'record' ? { recordBytes: Buffer.from(recordBytes) } : {}),
        };
    }
    let transform: (proof: any, call: number) => any = (value) => value;
    const loaded = policy(async (selected) => {
        requests.push(structuredClone(selected));
        assert.equal(selected.subject.kind, requests.length === 1 ? 'archive' : 'record');
        return transform(proof(selected.subject.kind), requests.length);
    });
    function replaceRecord(bytes: Buffer, repin = true) {
        recordBytes = Buffer.from(bytes);
        if (repin)
            request.expected.record = {
                ...request.expected.record,
                bytes: bytes.length,
                sha256: sha256(bytes),
            };
    }
    return {
        request,
        value,
        certificate,
        archiveBytes,
        requests,
        loaded,
        proof,
        transform: (fn: typeof transform) => {
            transform = fn;
        },
        replaceRecord,
        recordBytes: () => Buffer.from(recordBytes),
    };
}
const result = (proof: any) => proof.verificationResults[0].verificationResult;

test('two fresh verifications bind the exact same bundle and both subjects without qualifying content', async () => {
    const f = fixture();
    assert.ok(
        f.loaded.canonicalContentRecord(f.value).equals(f.recordBytes()),
        'Independent fixed-order fixture differs from canonical record contract.',
    );
    const observed = await f.loaded.verifyAttestedContent(f.request);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].subject.path, f.request.files.archivePath);
    assert.equal(f.requests[1].subject.path, f.request.files.recordPath);
    assert.deepEqual(f.requests[0].bundle, f.request.files.bundle);
    assert.deepEqual(f.requests[1].bundle, f.request.files.bundle);
    assert.deepEqual(f.requests[0].constraints, f.requests[1].constraints);
    assert.deepEqual(f.requests[0].tool, f.request.verifier.tool);
    assert.deepEqual(f.requests[0].trustedRoot, f.request.verifier.trustedRoot);
    assert.equal(observed.status, 'verified-attested-content-only');
    for (const field of [
        'qualification',
        'releaseAcceptance',
        'compiledSourceProven',
        'runtimeQualified',
        'retirementQualified',
    ])
        assert.equal(observed[field], false);
    assert.equal(observed.uploaderJob.status, 'unknown');
    assert.equal(observed.uploaderJob.jobID, null);
    assert.equal(observed.producerClaims.buildJobID, 'unverified-producer-job');
    assert.deepEqual(observed.applicationSourceClaim, f.request.expected.application);
    assert.notEqual(
        observed.applicationSourceClaim.commit,
        observed.certificateFacts.sourceRepositoryDigest,
    );
    assert.equal(Object.isFrozen(observed), true);
    assert.equal(Object.isFrozen(observed.certificateFacts), true);
    assert.equal(Object.isFrozen(observed.producerClaims), true);
    assert.equal(f.loaded.verifyAttestedContent.length, 1);
});

for (const field of Object.keys(fixture().certificate)) {
    for (const failure of ['missing', 'foreign']) {
        test(
            'verified certificate refuses ' +
                failure +
                ' ' +
                field +
                ' despite matching producer claims',
            async () => {
                const f = fixture();
                f.transform((proof) => {
                    const verified = result(proof);
                    verified.statement.predicate.certificate = structuredClone(f.certificate);
                    if (failure === 'missing') delete verified.signature.certificate[field];
                    else verified.signature.certificate[field] += '-foreign';
                    return proof;
                });
                await assert.rejects(f.loaded.verifyAttestedContent(f.request));
            },
        );
    }
}

for (const uri of [
    `${repositoryURI}/actions/runs/1701/attempts/30`,
    `${repositoryURI}/actions/runs/17010/attempts/3`,
    `${repositoryURI}/actions/runs/1701/attempts/3?job=claimed`,
    `${repositoryURI}/actions/runs/1701/attempts/03`,
    `${repositoryURI}/actions/runs/1701/attempts/3/jobs/99`,
    'https://github.com/foreign/repo/actions/runs/1701/attempts/3',
])
    test('invocation matching refuses a prefix, alias or foreign run URI ' + uri, async () => {
        const f = fixture();
        f.transform((proof) => {
            result(proof).signature.certificate.runInvocationURI = uri;
            return proof;
        });
        await assert.rejects(f.loaded.verifyAttestedContent(f.request));
    });

for (const failure of [
    'empty',
    'current-time',
    'unknown',
    'invalid',
    'non-rfc3339',
    'missing-uri',
    'extra',
    'too-many',
]) {
    test('verified observer timestamp refuses ' + failure, async () => {
        const f = fixture();
        f.transform((proof) => {
            const verified = result(proof),
                timestamp = verified.verifiedTimestamps[0];
            if (failure === 'empty') verified.verifiedTimestamps = [];
            if (failure === 'current-time') timestamp.type = 'CurrentTime';
            if (failure === 'unknown') timestamp.type = 'producer-says-verified';
            if (failure === 'invalid') timestamp.timestamp = 'not-a-timestamp';
            if (failure === 'non-rfc3339') timestamp.timestamp = '2026';
            if (failure === 'missing-uri') delete timestamp.uri;
            if (failure === 'extra') timestamp.verified = true;
            if (failure === 'too-many')
                verified.verifiedTimestamps = Array.from({ length: 17 }, () => ({ ...timestamp }));
            return proof;
        });
        await assert.rejects(f.loaded.verifyAttestedContent(f.request));
    });
}
test('actual TimestampAuthority observer label is supported without inventing an HTTPS URI', async () => {
    const f = fixture();
    f.transform((proof) => {
        result(proof).verifiedTimestamps[0].type = 'TimestampAuthority';
        return proof;
    });
    assert.equal((await f.loaded.verifyAttestedContent(f.request)).qualification, false);
});

for (const failure of [
    'missing',
    'extra',
    'duplicate',
    'wrong-name',
    'wrong-hash',
    'extra-algorithm',
    'wrong-statement',
    'wrong-predicate',
    'missing-results',
    'extra-results',
    'missing-certificate',
    'public-key-only',
    'wrong-media-type',
]) {
    test('verified statement refuses ' + failure, async () => {
        const f = fixture();
        f.transform((proof) => {
            const verified = result(proof),
                subjects = verified.statement.subject;
            if (failure === 'missing') subjects.pop();
            if (failure === 'extra')
                subjects.push({ name: 'foreign', digest: { sha256: sha256('foreign') } });
            if (failure === 'duplicate') subjects[1] = structuredClone(subjects[0]);
            if (failure === 'wrong-name') subjects[0].name = 'different.zip';
            if (failure === 'wrong-hash') subjects[1].digest.sha256 = sha256('different record');
            if (failure === 'extra-algorithm') subjects[0].digest.sha512 = 'a'.repeat(128);
            if (failure === 'wrong-statement')
                verified.statement._type = 'https://in-toto.io/Statement/v0.1';
            if (failure === 'wrong-predicate')
                verified.statement.predicateType = 'https://slsa.dev/provenance/v1';
            if (failure === 'missing-results') proof.verificationResults = [];
            if (failure === 'extra-results')
                proof.verificationResults.push(structuredClone(proof.verificationResults[0]));
            if (failure === 'missing-certificate') delete verified.signature.certificate;
            if (failure === 'public-key-only') verified.signature = { publicKeyId: 'synthetic' };
            if (failure === 'wrong-media-type') verified.mediaType = 'claimed-verification';
            return proof;
        });
        await assert.rejects(f.loaded.verifyAttestedContent(f.request));
    });
}

test('producer claims and deprecated certificate fields cannot establish missing modern certificate identity', async () => {
    const f = fixture();
    f.transform((proof) => {
        const verified = result(proof),
            cert = verified.signature.certificate;
        cert.githubWorkflowSHA = f.request.policy.source.commit;
        cert.githubWorkflowRepository = repository;
        verified.statement.predicate = {
            runner_environment: 'github-hosted',
            sourceRepositoryDigest: f.request.policy.source.commit,
            buildSignerDigest: f.request.policy.signer.commit,
            invocationId: f.certificate.runInvocationURI,
            jobID: 'producer-claimed-signer-job',
        };
        delete cert.buildSignerDigest;
        return proof;
    });
    await assert.rejects(f.loaded.verifyAttestedContent(f.request));
});

test('arbitrary producer predicate assertions remain claims and cannot grant release or uploader status', async () => {
    const f = fixture();
    f.transform((proof) => {
        result(proof).statement.predicate = {
            qualification: true,
            releaseAcceptance: true,
            compiledSourceProven: true,
            uploaderJobID: '99',
            runnerEnvironment: 'github-hosted',
        };
        return proof;
    });
    const observed = await f.loaded.verifyAttestedContent(f.request);
    assert.equal(observed.releaseAcceptance, false);
    assert.equal(observed.compiledSourceProven, false);
    assert.equal(observed.uploaderJob.status, 'unknown');
});

for (const failure of [
    'bytes',
    'no-bytes',
    'no-lf',
    'whitespace',
    'duplicate-key',
    'BOM',
    'invalid-UTF8',
    'application',
    'archive',
    'unknown-claim',
]) {
    test(
        'canonical record refuses ' +
            failure +
            ' even when its altered bytes are the signed subject',
        async () => {
            const f = fixture();
            const changed = structuredClone(f.value);
            if (failure === 'application')
                changed.application.commit = gitID('foreign application');
            if (failure === 'archive') changed.archive.sha256 = sha256('foreign archive');
            if (failure === 'unknown-claim') (changed.producerClaims as any).qualification = true;
            let bytes = Buffer.from(JSON.stringify(changed) + '\n');
            if (failure === 'bytes') {
                f.transform((proof) => {
                    if (proof.subject.kind === 'record')
                        proof.recordBytes = Buffer.from('foreign bytes');
                    return proof;
                });
            } else if (failure === 'no-bytes')
                f.transform((proof) => {
                    delete proof.recordBytes;
                    return proof;
                });
            else {
                if (failure === 'no-lf') bytes = bytes.subarray(0, bytes.length - 1);
                if (failure === 'whitespace')
                    bytes = Buffer.from(JSON.stringify(changed, null, 2) + '\n');
                if (failure === 'duplicate-key')
                    bytes = Buffer.from(
                        bytes
                            .toString()
                            .replace('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,'),
                    );
                if (failure === 'BOM')
                    bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
                if (failure === 'invalid-UTF8') bytes = Buffer.from([0xff]);
                f.replaceRecord(bytes);
            }
            await assert.rejects(f.loaded.verifyAttestedContent(f.request));
        },
    );
}

for (const failure of [
    'subject',
    'tool',
    'tool-version',
    'root',
    'bundle',
    'second-predicate',
    'second-timestamp',
    'throw-first',
    'throw-second',
    'undefined-first',
    'undefined-second',
]) {
    test('fresh verifier boundary refuses ' + failure, async () => {
        const f = fixture();
        f.transform((proof, call) => {
            if (failure === 'subject') proof.subject.sha256 = sha256('different observed subject');
            if (failure === 'tool') proof.verifier.toolSHA256 = sha256('foreign verifier');
            if (failure === 'tool-version') proof.verifier.toolVersion = '2.101.0';
            if (failure === 'root') proof.verifier.trustedRootSHA256 = sha256('foreign root');
            if (failure === 'bundle') proof.verifier.bundleSHA256 = sha256('foreign bundle');
            if (call === 2 && failure === 'second-predicate')
                result(proof).statement.predicate.changed = true;
            if (call === 2 && failure === 'second-timestamp')
                result(proof).verifiedTimestamps[0].timestamp = '2026-11-05T00:00:01Z';
            if (failure === 'throw-first' || (call === 2 && failure === 'throw-second'))
                throw Error('Synthetic cryptographic verifier refusal.');
            if (failure === 'undefined-first' || (call === 2 && failure === 'undefined-second'))
                return undefined;
            return proof;
        });
        await assert.rejects(f.loaded.verifyAttestedContent(f.request));
    });
}

for (const field of [
    'verificationResults',
    'verifiedJSON',
    'mock',
    'testMode',
    'backend',
    'resultPath',
]) {
    test(
        'unsigned supplied verification or test activation field is rejected: ' + field,
        async () => {
            const f = fixture();
            (f.request as any)[field] = f.proof('archive');
            await assert.rejects(f.loaded.verifyAttestedContent(f.request));
            assert.equal(f.requests.length, 0);
        },
    );
}
test('production policy contains no environment, CLI or exported verifier-toggle path', () => {
    const loaded = policy(async () => {
        throw Error('Synthetic backend must not run here.');
    });
    assert.equal(loaded.verifyAttestedContent.length, 1);
    assert.ok(!/process\.(?:env|argv)|globalThis|eval\(|import\(/.test(source));
    assert.ok(
        !Object.keys(loaded).some((name) =>
            /^(?:mock|test)|Mock|Test|Factory|setVerifier|configure/.test(name),
        ),
    );
    assert.match(
        source,
        /import\s*\{\s*verifyLocalAttestation\s*\}\s*from\s*['"]\.\/attested-content-verifier\.mjs['"]/,
    );
});
