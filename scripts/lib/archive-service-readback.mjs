import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sourceDigest } from './committed-source-bridge.mjs';
import { parseWebArchiveBuildRecord, WEB_ARCHIVE_LIMITS } from './web-archive-producer.mjs';
import { parseGatewayArchiveBuildRecord } from './gateway-build-record.mjs';
import { inspectArtifactCarrier, CARRIER_LIMIT } from './artifact-carrier-zip.mjs';
import { inspectInnerArchive } from './inner-archive-inspection.mjs';

const retained = new Set(),
    issued = new WeakMap(),
    activeReaders = new Map();
const id = /^[1-9][0-9]{0,31}$/;
function keys(v, fields) {
    assert.ok(v && typeof v === 'object' && !Array.isArray(v));
    assert.deepEqual(Object.keys(v).sort(), [...fields].sort());
}
function json(bytes, cap) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= cap);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
        value = JSON.parse(text);
    assert.equal(text, JSON.stringify(value) + '\n', 'Noncanonical observation bytes.');
    return value;
}
function input(v) {
    keys(v, ['context', 'service', 'reader']);
    keys(v.context, [
        'scope',
        'version',
        'sourceCommit',
        'sourceTree',
        'runId',
        'runAttempt',
        'jobKey',
    ]);
    assert.ok(['web', 'gateway'].includes(v.context.scope));
    assert.ok(
        typeof v.context.version === 'string' &&
            v.context.version.length <=
                200 -
                    '.sha256'.length -
                    (v.context.scope === 'web'
                        ? 'Diagnostic-Hub-Web-'.length + '.zip'.length
                        : 'Diagnostic-Hub-Gateway-'.length + '.tar.gz'.length),
    );
    assert.match(
        v.context.version,
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?$/,
    );
    for (const field of ['sourceCommit', 'sourceTree'])
        assert.match(v.context[field], /^[a-f0-9]{40}$/);
    for (const field of ['runId', 'runAttempt']) assert.match(v.context[field], id);
    assert.match(v.context.jobKey, /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/);
    keys(v.service, [
        'repository',
        'repositoryId',
        'workflowId',
        'workflowPath',
        'jobId',
        'jobName',
        'artifactId',
        'artifactName',
    ]);
    assert.equal(v.service.repository, 'brucerry/embedded-linux-diagnostic-hub');
    for (const field of ['repositoryId', 'workflowId', 'jobId', 'artifactId'])
        assert.match(v.service[field], id);
    assert.match(v.service.workflowPath, /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/);
    for (const field of ['jobName', 'artifactName'])
        assert.ok(
            typeof v.service[field] === 'string' &&
                v.service[field].length > 0 &&
                Buffer.byteLength(v.service[field]) <= 200 &&
                !/[\x00-\x1f\x7f]/.test(v.service[field]),
        );
    keys(v.reader, ['runId', 'runAttempt', 'jobId', 'toolingCommit']);
    for (const field of ['runId', 'runAttempt', 'jobId']) assert.match(v.reader[field], id);
    assert.match(v.reader.toolingCommit, /^[a-f0-9]{40}$/);
    assert.notEqual(v.reader.jobId, v.service.jobId, 'Producer and reader jobs must be separate.');
    return structuredClone(v);
}
export function validateArchiveReadbackSelection(value) {
    return input(value);
}
/** Strict projection contract, not a claim that a JSON object authenticates GitHub. */
export function validateArchiveServiceObservation(v, expected) {
    expected = input(expected);
    keys(v, ['apiOrigin', 'repository', 'repositoryId', 'run', 'job', 'artifact']);
    assert.equal(v.apiOrigin, 'https://api.github.com');
    assert.equal(v.repository, expected.service.repository);
    assert.equal(v.repositoryId, expected.service.repositoryId);
    keys(v.run, ['id', 'attempt', 'headSHA', 'workflowId', 'workflowPath', 'status', 'conclusion']);
    assert.deepEqual(v.run, {
        id: expected.context.runId,
        attempt: expected.context.runAttempt,
        headSHA: expected.context.sourceCommit,
        workflowId: expected.service.workflowId,
        workflowPath: expected.service.workflowPath,
        status: 'completed',
        conclusion: 'success',
    });
    keys(v.job, ['id', 'runId', 'runAttempt', 'headSHA', 'name', 'status', 'conclusion']);
    assert.deepEqual(v.job, {
        id: expected.service.jobId,
        runId: expected.context.runId,
        runAttempt: expected.context.runAttempt,
        headSHA: expected.context.sourceCommit,
        name: expected.service.jobName,
        status: 'completed',
        conclusion: 'success',
    });
    keys(v.artifact, ['id', 'name', 'runId', 'headSHA', 'sizeInBytes', 'digest', 'expired']);
    const a = v.artifact;
    for (const [key, want] of Object.entries({
        id: expected.service.artifactId,
        name: expected.service.artifactName,
        runId: expected.context.runId,
        headSHA: expected.context.sourceCommit,
        expired: false,
    }))
        assert.equal(a[key], want);
    assert.ok(
        Number.isSafeInteger(a.sizeInBytes) && a.sizeInBytes > 0 && a.sizeInBytes <= CARRIER_LIMIT,
    );
    assert.match(a.digest, /^sha256:[a-f0-9]{64}$/);
    // Artifact metadata has run association, not an authoritative job/attempt attribution.
    return structuredClone(v);
}
/** Projection of the real REST run/attempt, job and artifact field families. It is not authentication.
 * Extra raw API fields are ignored, never copied into evidence or used as a job attribution. */
export function projectGitHubArchiveServiceObservation(raw, selected) {
    const expected = input(selected);
    keys(raw, ['run', 'job', 'artifact']);
    const integer = (value) => {
        if (typeof value === 'number') {
            assert.ok(Number.isSafeInteger(value) && value > 0);
            return String(value);
        }
        assert.match(value, id);
        return value;
    };
    const run = raw.run,
        job = raw.job,
        artifact = raw.artifact;
    assert.ok(
        run && job && artifact && run.repository && run.head_repository && artifact.workflow_run,
    );
    assert.equal(run.repository.full_name, expected.service.repository);
    assert.equal(run.head_repository.full_name, expected.service.repository);
    assert.equal(integer(run.repository.id), expected.service.repositoryId);
    assert.equal(integer(run.head_repository.id), expected.service.repositoryId);
    assert.equal(integer(artifact.workflow_run.repository_id), expected.service.repositoryId);
    assert.equal(integer(artifact.workflow_run.head_repository_id), expected.service.repositoryId);
    assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0);
    return validateArchiveServiceObservation(
        {
            apiOrigin: 'https://api.github.com',
            repository: run.repository.full_name,
            repositoryId: integer(run.repository.id),
            run: {
                id: integer(run.id),
                attempt: integer(run.run_attempt),
                headSHA: run.head_sha,
                workflowId: integer(run.workflow_id),
                workflowPath: run.path,
                status: run.status,
                conclusion: run.conclusion,
            },
            job: {
                id: integer(job.id),
                runId: integer(job.run_id),
                runAttempt: integer(job.run_attempt),
                headSHA: job.head_sha,
                name: job.name,
                status: job.status,
                conclusion: job.conclusion,
            },
            artifact: {
                id: integer(artifact.id),
                name: artifact.name,
                runId: integer(artifact.workflow_run.id),
                headSHA: artifact.workflow_run.head_sha,
                sizeInBytes: artifact.size_in_bytes,
                digest: artifact.digest,
                expired: artifact.expired,
            },
        },
        expected,
    );
}

export class ArchiveReadbackFailure extends Error {
    constructor(cause, owner) {
        super('Archive readback failed; uncertain response custody retained.', { cause });
        this.owner = owner;
    }
}
class ResponseOwner {
    #pending = new Map();
    #ordinal = 0;
    #failure = null;
    constructor() {
        Object.defineProperty(this, 'token', { value: randomBytes(16).toString('hex') });
    }
    snapshot() {
        return {
            owner: this.token,
            failed: this.#failure !== null,
            pending: [...this.#pending].map(([id, row]) => ({
                id,
                kind: row.kind,
                state: row.state,
            })),
        };
    }
    fail(error) {
        this.#failure ??= error;
        if (this.#pending.size) retained.add(this);
        else retained.delete(this);
    }
    async read(kind, resource, cap, open) {
        assert.equal(this.#failure, null);
        assert.equal(this.#pending.size, 0);
        const request = Object.freeze({ owner: this.token, id: ++this.#ordinal, kind, resource }),
            row = { kind, state: 'acquiring', handle: null };
        this.#pending.set(request.id, row);
        retained.add(this);
        let handle;
        try {
            handle = await open(request);
            row.handle = handle;
            keys(handle, ['owner', 'id', 'kind', 'resource', 'read', 'close']);
            for (const field of ['owner', 'id', 'kind', 'resource'])
                assert.equal(handle[field], request[field], 'Stale/foreign readback response.');
            assert.equal(typeof handle.read, 'function');
            assert.equal(typeof handle.close, 'function');
            row.state = 'reading';
        } catch (error) {
            row.state = 'acquisition-unproved';
            this.fail(error);
            throw error;
        }
        let value;
        const errors = [];
        try {
            let total = 0;
            const output = Buffer.alloc(cap);
            for (;;) {
                const chunk = await handle.read(65536);
                if (chunk === null) break;
                assert.ok(
                    chunk instanceof Uint8Array &&
                        chunk.byteLength > 0 &&
                        chunk.byteLength <= 65536 &&
                        total + chunk.byteLength <= cap,
                );
                output.set(chunk, total);
                total += chunk.byteLength;
            }
            value = output.subarray(0, total);
        } catch (error) {
            errors.push(error);
        }
        row.state = 'closing';
        try {
            await handle.close();
            this.#pending.delete(request.id);
            if (!this.#pending.size) retained.delete(this);
        } catch (error) {
            row.state = 'close-unproved';
            errors.push(error);
        }
        if (errors.length) {
            const error =
                errors.length === 1
                    ? errors[0]
                    : new AggregateError(errors, 'Readback read/close failed.', {
                          cause: errors[0],
                      });
            this.fail(error);
            throw error;
        }
        return value;
    }
}
/** Real byte/schema correlation sequence. Explicit ports only; no service/network/decoder authentication is inferred. */
export async function observeArchiveReadback(selection, ports) {
    const expected = input(selection);
    assert.ok(
        ports &&
            typeof ports.openService === 'function' &&
            typeof ports.openArtifact === 'function',
    );
    const readerKey = expected.reader.jobId; // Immutable job identity cannot be relabeled by run/attempt.
    assert.ok(!activeReaders.has(readerKey), 'Reader custody remains active or unproved.');
    const owner = new ResponseOwner();
    activeReaders.set(readerKey, owner);
    try {
        const beforeBytes = await owner.read(
                'service',
                'selected-service-observation',
                1024 ** 2,
                ports.openService,
            ),
            before = validateArchiveServiceObservation(json(beforeBytes, 1024 ** 2), expected);
        const carrier = await owner.read(
            'artifact',
            expected.service.artifactId,
            before.artifact.sizeInBytes,
            ports.openArtifact,
        );
        assert.equal(carrier.length, before.artifact.sizeInBytes);
        assert.equal('sha256:' + sourceDigest(carrier), before.artifact.digest);
        const scope = expected.context.scope,
            name = `Diagnostic-Hub-${scope === 'web' ? 'Web' : 'Gateway'}-${expected.context.version}.${scope === 'web' ? 'zip' : 'tar.gz'}`,
            recordName = scope + '-build.json',
            files = inspectArtifactCarrier(
                carrier,
                new Map([
                    [name, WEB_ARCHIVE_LIMITS.archive],
                    [name + '.sha256', 256],
                    [recordName, 16 * 1024 ** 2],
                ]),
            ),
            recordBytes = files.get(recordName),
            record =
                scope === 'web'
                    ? parseWebArchiveBuildRecord(recordBytes, expected.context)
                    : parseGatewayArchiveBuildRecord(recordBytes, expected.context),
            archive = files.get(name),
            checksum = files.get(name + '.sha256');
        assert.equal(archive.length, record.archive.bytes);
        assert.equal(sourceDigest(archive), record.archive.sha256);
        assert.ok(checksum.equals(Buffer.from(`${record.archive.sha256}  ${name}\n`)));
        assert.equal(checksum.length, record.checksum.bytes);
        assert.equal(sourceDigest(checksum), record.checksum.sha256);
        const innerArchiveInspection = inspectInnerArchive(archive, record, scope);
        const afterBytes = await owner.read(
                'service',
                'selected-service-observation',
                1024 ** 2,
                ports.openService,
            ),
            after = validateArchiveServiceObservation(json(afterBytes, 1024 ** 2), expected);
        assert.deepEqual(after, before, 'Service metadata changed during readback.');
        assert.deepEqual(owner.snapshot().pending, []);
        const facts = {
            schemaVersion: 1,
            kind: 'archive-service-readback',
            status: 'correlated-unqualified',
            selection: expected,
            owner: owner.token,
            service: before,
            serviceObservations: {
                before: { bytes: beforeBytes.length, sha256: sourceDigest(beforeBytes) },
                after: { bytes: afterBytes.length, sha256: sourceDigest(afterBytes) },
            },
            carrier: { bytes: carrier.length, sha256: sourceDigest(carrier) },
            record: {
                name: recordName,
                bytes: recordBytes.length,
                sha256: sourceDigest(recordBytes),
            },
            archive: record.archive,
            checksum: record.checksum,
            sourceBridgeSHA256: record.sourceBridgeSHA256,
            serviceAuthentication: null,
            artifactJobAttribution: null,
            workflowJobKeyAssociation: null,
            innerArchiveInspection,
            readerTerminalStatus: null,
            productRuntime: null,
            releaseAcceptance: false,
        };
        const capability = Object.freeze({
            kind: 'archive-readback-capability',
            owner: owner.token,
        });
        issued.set(capability, structuredClone(facts));
        return capability;
    } catch (error) {
        owner.fail(error);
        throw new ArchiveReadbackFailure(error, owner);
    } finally {
        if (!owner.snapshot().pending.length && activeReaders.get(readerKey) === owner)
            activeReaders.delete(readerKey);
    }
}
export function archiveReadbackSnapshot(capability) {
    assert.ok(issued.has(capability), 'Unissued readback capability.');
    return structuredClone(issued.get(capability));
}
/** No implementation can presently authenticate service custody or establish upload-job attribution. */
export function requireArchiveReleaseProvenance(capability) {
    archiveReadbackSnapshot(capability);
    throw Error(
        'Authenticated service transport, artifact-to-job attribution and terminal reader evidence are not implemented; producer-inventory byte consistency does not establish provenance and release remains blocked.',
    );
}
