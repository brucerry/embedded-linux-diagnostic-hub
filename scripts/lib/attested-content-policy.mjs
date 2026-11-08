import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import path from 'node:path';
import { verifyLocalAttestation } from './attested-content-verifier.mjs';

export const CONTENT_PREDICATE = 'https://embedded-linux-diagnostic-hub.dev/attestation/content/v1';
export const CONTENT_REPOSITORY = 'brucerry/embedded-linux-diagnostic-hub';
export const CONTENT_RECORD_LIMIT = 1024 ** 2;
const repositoryURI = 'https://github.com/' + CONTENT_REPOSITORY;
const ownerURI = 'https://github.com/brucerry';
const issuer = 'https://token.actions.githubusercontent.com';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const decimal = /^[1-9][0-9]{0,19}$/;
function closed(value, fields) {
    assert.ok(
        value && typeof value === 'object' && !Array.isArray(value),
        'Expected content policy object.',
    );
    assert.deepEqual(
        Object.keys(value).sort(),
        [...fields].sort(),
        'Unknown/missing content policy field.',
    );
}
function text(value, maximum = 512) {
    assert.ok(
        typeof value === 'string' &&
            value.length > 0 &&
            Buffer.byteLength(value) <= maximum &&
            !/[\x00-\x1f\x7f]/.test(value),
        'Invalid bounded content policy text.',
    );
}
function workflowURI(value, reference) {
    text(value, 1024);
    assert.ok(value.startsWith(repositoryURI + '/.github/workflows/'));
    const suffix = value.slice((repositoryURI + '/.github/workflows/').length);
    const parts = suffix.split('@');
    assert.equal(parts.length, 2);
    assert.match(parts[0], /^[A-Za-z0-9_-]+\.ya?ml$/);
    assert.equal(parts[1], reference, 'Workflow URI differs from independently pinned reference.');
}
function subject(value, maximum) {
    closed(value, ['name', 'bytes', 'sha256']);
    text(value.name, 255);
    assert.match(value.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= maximum);
    assert.match(value.sha256, digest);
}
function application(value) {
    closed(value, ['commit', 'tree', 'sourceManifestSHA256']);
    assert.match(value.commit, commit);
    assert.match(value.tree, commit);
    assert.match(value.sourceManifestSHA256, digest);
}
function filePin(value, maximum) {
    closed(value, ['path', 'bytes', 'sha256']);
    assert.ok(typeof value.path === 'string' && path.isAbsolute(value.path));
    assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= maximum);
    assert.match(value.sha256, digest);
}
/** Trust selection comes from the operator/reviewer, never from the signed producer record. */
export function validateAttestedContentRequest(input) {
    const request = structuredClone(input);
    closed(request, ['policy', 'expected', 'files', 'verifier']);
    const { policy, expected, files, verifier } = request;
    closed(policy, [
        'schemaVersion',
        'kind',
        'repository',
        'version',
        'issuer',
        'predicateType',
        'signer',
        'source',
    ]);
    assert.equal(policy.schemaVersion, 1);
    assert.equal(policy.kind, 'diagnostic-hub-attested-content-policy');
    assert.equal(policy.repository, CONTENT_REPOSITORY);
    assert.equal(policy.version, '0.6.0');
    assert.equal(policy.issuer, issuer);
    assert.equal(policy.predicateType, CONTENT_PREDICATE);
    closed(policy.signer, ['workflowURI', 'commit']);
    assert.match(policy.signer.commit, commit);
    workflowURI(policy.signer.workflowURI, policy.signer.commit);
    closed(policy.source, [
        'commit',
        'ref',
        'repositoryID',
        'ownerID',
        'buildConfigURI',
        'buildTrigger',
    ]);
    assert.match(policy.source.commit, commit);
    text(policy.source.ref, 1024);
    assert.match(policy.source.ref, /^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/);
    assert.ok(
        !policy.source.ref.includes('..') &&
            !policy.source.ref.includes('//') &&
            !policy.source.ref.endsWith('/'),
    );
    assert.match(policy.source.repositoryID, decimal);
    assert.match(policy.source.ownerID, decimal);
    workflowURI(policy.source.buildConfigURI, policy.source.ref);
    assert.ok(
        ['workflow_dispatch', 'push'].includes(policy.source.buildTrigger),
        'Untrusted signing trigger.',
    );
    closed(expected, ['application', 'archive', 'record', 'run']);
    application(expected.application);
    subject(expected.archive, 2 * 1024 ** 3);
    subject(expected.record, CONTENT_RECORD_LIMIT);
    assert.ok(
        expected.archive.name !== expected.record.name &&
            expected.archive.sha256 !== expected.record.sha256,
    );
    closed(expected.run, ['id', 'attempt']);
    assert.match(expected.run.id, decimal);
    assert.match(expected.run.attempt, decimal);
    closed(files, ['archivePath', 'recordPath', 'bundle']);
    for (const name of ['archivePath', 'recordPath'])
        assert.ok(typeof files[name] === 'string' && path.isAbsolute(files[name]));
    filePin(files.bundle, 16 * 1024 ** 2);
    assert.equal(new Set([files.archivePath, files.recordPath, files.bundle.path]).size, 3);
    closed(verifier, ['tool', 'trustedRoot', 'configurationDirectory']);
    closed(verifier.tool, ['path', 'sha256', 'version']);
    assert.ok(typeof verifier.tool.path === 'string' && path.isAbsolute(verifier.tool.path));
    assert.match(verifier.tool.sha256, digest);
    assert.match(
        verifier.tool.version,
        /^2\.(?:10[2-9]|1[1-9][0-9]|[2-9][0-9]{2}|[1-9][0-9]{3,})\.[0-9]+$/,
    );
    filePin(verifier.trustedRoot, 4 * 1024 ** 2);
    assert.ok(
        typeof verifier.configurationDirectory === 'string' &&
            path.isAbsolute(verifier.configurationDirectory),
    );
    assert.equal(
        new Set([
            files.archivePath,
            files.recordPath,
            files.bundle.path,
            verifier.tool.path,
            verifier.trustedRoot.path,
            verifier.configurationDirectory,
        ]).size,
        6,
    );
    return request;
}
/** Fixed field order and LF; producer assertions are retained only as claims. */
export function canonicalContentRecord(value) {
    closed(value, [
        'schemaVersion',
        'kind',
        'repository',
        'version',
        'application',
        'archive',
        'producerClaims',
    ]);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.kind, 'diagnostic-hub-attested-content-record');
    assert.equal(value.repository, CONTENT_REPOSITORY);
    assert.equal(value.version, '0.6.0');
    application(value.application);
    subject(value.archive, 2 * 1024 ** 3);
    closed(value.producerClaims, ['buildID', 'buildRunID', 'buildRunAttempt', 'buildJobID']);
    for (const field of Object.keys(value.producerClaims)) text(value.producerClaims[field], 256);
    return Buffer.from(
        JSON.stringify({
            schemaVersion: 1,
            kind: 'diagnostic-hub-attested-content-record',
            repository: CONTENT_REPOSITORY,
            version: '0.6.0',
            application: {
                commit: value.application.commit,
                tree: value.application.tree,
                sourceManifestSHA256: value.application.sourceManifestSHA256,
            },
            archive: {
                name: value.archive.name,
                bytes: value.archive.bytes,
                sha256: value.archive.sha256,
            },
            producerClaims: {
                buildID: value.producerClaims.buildID,
                buildRunID: value.producerClaims.buildRunID,
                buildRunAttempt: value.producerClaims.buildRunAttempt,
                buildJobID: value.producerClaims.buildJobID,
            },
        }) + '\n',
    );
}
function recordBytes(bytes, request) {
    assert.ok(
        Buffer.isBuffer(bytes) &&
            bytes.length === request.expected.record.bytes &&
            bytes.length <= CONTENT_RECORD_LIMIT,
    );
    assert.equal(
        sha256(bytes),
        request.expected.record.sha256,
        'Canonical record digest differs from independent selection.',
    );
    const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    assert.ok(canonicalContentRecord(value).equals(bytes), 'Noncanonical content record.');
    assert.deepEqual(
        value.application,
        request.expected.application,
        'Producer application claim differs from independent source selection.',
    );
    assert.deepEqual(
        value.archive,
        request.expected.archive,
        'Record/archive independent selections differ.',
    );
    return value;
}
function verifiedStatement(proof, request, kind) {
    const selected = request.expected[kind];
    assert.deepEqual(
        proof.subject,
        { kind, ...selected },
        'Verifier observed a different subject.',
    );
    assert.deepEqual(
        proof.verifier,
        {
            toolSHA256: request.verifier.tool.sha256,
            toolVersion: request.verifier.tool.version,
            trustedRootSHA256: request.verifier.trustedRoot.sha256,
            bundleSHA256: request.files.bundle.sha256,
        },
        'Verifier execution pins differ.',
    );
    assert.ok(
        Array.isArray(proof.verificationResults) && proof.verificationResults.length === 1,
        'Require one unambiguous verified attestation.',
    );
    const entry = proof.verificationResults[0];
    closed(entry, ['attestation', 'verificationResult']);
    const result = entry.verificationResult;
    assert.ok(result && typeof result === 'object');
    assert.equal(
        result.mediaType,
        'application/vnd.dev.sigstore.verificationresult+json;version=0.1',
    );
    closed(result.signature, ['certificate']);
    const cert = result.signature.certificate;
    assert.ok(cert && typeof cert === 'object' && !Array.isArray(cert));
    const expectedCertificate = {
        issuer,
        subjectAlternativeName: request.policy.signer.workflowURI,
        buildSignerURI: request.policy.signer.workflowURI,
        buildSignerDigest: request.policy.signer.commit,
        runnerEnvironment: 'github-hosted',
        sourceRepositoryURI: repositoryURI,
        sourceRepositoryDigest: request.policy.source.commit,
        sourceRepositoryRef: request.policy.source.ref,
        sourceRepositoryIdentifier: request.policy.source.repositoryID,
        sourceRepositoryOwnerURI: ownerURI,
        sourceRepositoryOwnerIdentifier: request.policy.source.ownerID,
        buildConfigURI: request.policy.source.buildConfigURI,
        buildConfigDigest: request.policy.source.commit,
        buildTrigger: request.policy.source.buildTrigger,
        runInvocationURI: `${repositoryURI}/actions/runs/${request.expected.run.id}/attempts/${request.expected.run.attempt}`,
    };
    for (const [field, value] of Object.entries(expectedCertificate))
        assert.equal(cert[field], value, 'Verified certificate identity mismatch: ' + field);
    assert.ok(
        Array.isArray(result.verifiedTimestamps) &&
            result.verifiedTimestamps.length > 0 &&
            result.verifiedTimestamps.length <= 16,
        'Missing verified timestamp authority.',
    );
    for (const timestamp of result.verifiedTimestamps) {
        closed(timestamp, ['type', 'uri', 'timestamp']);
        assert.ok(
            ['Tlog', 'TimestampAuthority'].includes(timestamp.type),
            'Timestamp is not an independent verified authority.',
        );
        text(timestamp.uri, 2048);
        text(timestamp.timestamp, 64);
        assert.ok(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(timestamp.timestamp) &&
                Number.isFinite(Date.parse(timestamp.timestamp)),
            'Invalid verified timestamp.',
        );
    }
    const statement = result.statement;
    closed(statement, ['_type', 'subject', 'predicateType', 'predicate']);
    assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
    assert.equal(statement.predicateType, CONTENT_PREDICATE);
    assert.ok(
        Array.isArray(statement.subject) && statement.subject.length === 2,
        'Require exactly archive and canonical-record subjects.',
    );
    const subjects = statement.subject
        .map((item) => {
            closed(item, ['name', 'digest']);
            closed(item.digest, ['sha256']);
            assert.match(item.digest.sha256, digest);
            return { name: item.name, digest: item.digest.sha256 };
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const expectedSubjects = ['archive', 'record']
        .map((key) => ({ name: request.expected[key].name, digest: request.expected[key].sha256 }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    assert.deepEqual(
        subjects,
        expectedSubjects,
        'Verified attestation subjects differ from independently observed content.',
    );
    return { result, certificate: expectedCertificate };
}
/** Verification only: no signing, credentials, workflow dispatch, publication or existing-gate override. */
export async function verifyAttestedContent(input) {
    const request = validateAttestedContentRequest(input);
    const constraints = {
        repository: CONTENT_REPOSITORY,
        certificateIdentity: request.policy.signer.workflowURI,
        issuer,
        signerDigest: request.policy.signer.commit,
        sourceDigest: request.policy.source.commit,
        sourceRef: request.policy.source.ref,
        predicateType: CONTENT_PREDICATE,
    };
    const verify = (kind, file) =>
        verifyLocalAttestation({
            subject: { kind, path: file, ...request.expected[kind] },
            bundle: request.files.bundle,
            tool: request.verifier.tool,
            trustedRoot: request.verifier.trustedRoot,
            configurationDirectory: request.verifier.configurationDirectory,
            constraints,
        });
    const archiveProof = await verify('archive', request.files.archivePath);
    const archive = verifiedStatement(archiveProof, request, 'archive');
    const recordProof = await verify('record', request.files.recordPath);
    const record = verifiedStatement(recordProof, request, 'record');
    assert.deepEqual(
        archive.result,
        record.result,
        'Archive and canonical record were not verified from the same attestation.',
    );
    const content = recordBytes(recordProof.recordBytes, request);
    return Object.freeze({
        schemaVersion: 1,
        kind: 'diagnostic-hub-attested-content-policy-result',
        status: 'verified-attested-content-only',
        qualification: false,
        releaseAcceptance: false,
        compiledSourceProven: false,
        runtimeQualified: false,
        retirementQualified: false,
        policySHA256: sha256(JSON.stringify(request.policy)),
        archive: Object.freeze({ ...request.expected.archive }),
        record: Object.freeze({ ...request.expected.record }),
        certificateFacts: Object.freeze(archive.certificate),
        producerClaims: Object.freeze({ ...content.producerClaims }),
        applicationSourceClaim: Object.freeze({ ...content.application }),
        uploaderJob: Object.freeze({
            status: 'unknown',
            jobID: null,
            reason: 'Verified certificate identifies signer workflow run/attempt, not artifact uploader job.',
        }),
        scope: 'Signer association with independently selected archive and canonical record bytes only; all existing source/archive/retirement/runtime gates remain required.',
    });
}
