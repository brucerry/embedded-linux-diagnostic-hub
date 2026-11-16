import assert from 'node:assert/strict';
import { TextDecoder } from 'node:util';
import { valid } from 'semver';
import { gitObjectID, sourceDigest, SOURCE_LIMITS } from './committed-source-bridge.mjs';
import { verifyGatewayArchiveReadback } from './gateway-archive-readback.mjs';

export const GATEWAY_RELEASE_BINDING_LIMITS = Object.freeze({
    annotations: 8,
    tagBytes: 64 * 1024,
    tagHeaderBytes: 8192,
    commitBytes: SOURCE_LIMITS.commit,
    totalObjectBytes: 8 * 64 * 1024 + SOURCE_LIMITS.commit,
});
const oid = /^[a-f0-9]{40}$/;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function keys(value, wanted) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...wanted].sort());
}
function header(bytes, maximum) {
    const end = bytes.indexOf('\n\n');
    assert.ok(end > 0 && end <= maximum, 'Missing or unsupported Git object header.');
    const text = decoder.decode(bytes.subarray(0, end));
    assert.ok(!/[\x00\r]/.test(text), 'Unsupported Git object header encoding.');
    return text.split('\n');
}
function freeze(value) {
    for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
    return Object.freeze(value);
}

/** Pure raw-object parser shared by the inert binder and exact-ref reader. */
export function inspectGatewayReleaseObject(object) {
    keys(object, ['oid', 'type', 'bytes']);
    assert.match(object.oid, oid);
    assert.ok(['tag', 'commit'].includes(object.type), 'Unsupported release target type.');
    assert.ok(Buffer.isBuffer(object.bytes) && object.bytes.length > 0);
    assert.ok(
        object.bytes.length <=
            (object.type === 'tag'
                ? GATEWAY_RELEASE_BINDING_LIMITS.tagBytes
                : GATEWAY_RELEASE_BINDING_LIMITS.commitBytes),
        'Release object byte bound exceeded.',
    );
    const bytes = Buffer.from(object.bytes);
    assert.equal(gitObjectID(object.type, bytes), object.oid, 'Git object identity differs.');
    const identity = {
        oid: object.oid,
        type: object.type,
        bytes: bytes.length,
        sha256: sourceDigest(bytes),
    };
    if (object.type === 'tag') {
        const lines = header(bytes, GATEWAY_RELEASE_BINDING_LIMITS.tagHeaderBytes);
        const target = /^object ([a-f0-9]{40})$/.exec(lines[0]);
        const type = /^type (tag|commit)$/.exec(lines[1]);
        assert.ok(target && type && /^tag [^\x00-\x20\x7f]+$/.test(lines[2] ?? ''));
        assert.equal(lines.filter((line) => line.startsWith('object ')).length, 1);
        assert.equal(lines.filter((line) => line.startsWith('type ')).length, 1);
        return { identity, target: target[1], targetType: type[1] };
    }
    const lines = header(bytes, GATEWAY_RELEASE_BINDING_LIMITS.commitBytes);
    assert.match(lines[0], /^tree [a-f0-9]{40}$/);
    assert.equal(lines.filter((line) => line.startsWith('tree ')).length, 1);
    return { identity, tree: lines[0].slice(5) };
}

/** Local consistency contract, not a service or execution authority.
 * The caller must independently select the intended tag/ref object, source and
 * producer-record identity and own the original reads. Supplied snapshots, raw
 * object hashes and a matching receipt do not authenticate those observations.
 * No IO, Git invocation, build, workflow activation or receipt admission occurs.
 * Neither the existing branch-only caller nor release gates use this draft.
 */
export function bindGatewayReleaseProducer(input, expected) {
    keys(input, ['build', 'refBefore', 'refAfter', 'objects']);
    keys(expected, ['repository', 'tagRef', 'tagObjectID', 'build']);
    const selected = structuredClone(expected);
    assert.equal(selected.repository, 'brucerry/embedded-linux-diagnostic-hub');
    assert.match(selected.tagObjectID, oid);
    const record = verifyGatewayArchiveReadback(input.build, selected.build);
    assert.equal(valid(record.context.version), record.context.version);
    assert.equal(selected.tagRef, `refs/tags/v${record.context.version}`);
    assert.match(selected.tagRef, /^refs\/tags\/v\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
    assert.ok(selected.tagRef.length <= 255);
    for (const snapshot of [input.refBefore, input.refAfter]) {
        keys(snapshot, ['ref', 'objectID']);
        assert.equal(snapshot.ref, selected.tagRef);
        assert.equal(snapshot.objectID, selected.tagObjectID, 'Selected release tag changed.');
    }
    assert.ok(
        Array.isArray(input.objects) &&
            input.objects.length > 0 &&
            input.objects.length <= GATEWAY_RELEASE_BINDING_LIMITS.annotations + 1,
    );
    let wanted = selected.tagObjectID,
        wantedType = null,
        annotations = 0,
        complete = false,
        totalBytes = 0;
    const seen = new Set(),
        chain = [];
    for (let i = 0; i < input.objects.length; i++) {
        const object = input.objects[i];
        keys(object, ['oid', 'type', 'bytes']);
        assert.match(object.oid, oid);
        assert.equal(object.oid, wanted, 'Missing or reordered release tag object.');
        assert.ok(!complete && !seen.has(object.oid), 'Unused or repeated release tag object.');
        seen.add(object.oid);
        if (wantedType !== null) assert.equal(object.type, wantedType);
        assert.ok(Buffer.isBuffer(object.bytes));
        totalBytes += object.bytes.length;
        assert.ok(totalBytes <= GATEWAY_RELEASE_BINDING_LIMITS.totalObjectBytes);
        const parsed = inspectGatewayReleaseObject(object);
        chain.push(parsed.identity);
        if (object.type === 'tag') {
            assert.ok(++annotations <= GATEWAY_RELEASE_BINDING_LIMITS.annotations);
            wanted = parsed.target;
            wantedType = parsed.targetType;
        } else {
            assert.equal(object.oid, record.context.sourceCommit, 'Tag targets another source.');
            assert.ok(
                parsed.tree === record.context.sourceTree,
                'Observed commit tree differs from the selected build tree.',
            );
            assert.equal(i, input.objects.length - 1, 'Unconsumed release object observations.');
            complete = true;
        }
    }
    assert.ok(complete, 'No observed peeled source commit.');
    return freeze({
        schemaVersion: 1,
        kind: 'gateway-release-producer-binding',
        status: 'bound-not-qualified',
        repository: selected.repository,
        tag: {
            ref: selected.tagRef,
            objectID: selected.tagObjectID,
            form: annotations ? 'annotated' : 'lightweight',
            annotations,
            chain,
            sourceCommit: record.context.sourceCommit,
            sourceTree: record.context.sourceTree,
        },
        context: structuredClone(record.context),
        buildRecord: structuredClone(selected.build.buildRecord),
        sourceBridgeSHA256: record.sourceBridgeSHA256,
        artifacts: [structuredClone(record.archive), structuredClone(record.checksum)],
        provenance: {
            tagRefAuthentication: null,
            serviceAuthentication: null,
            jobAttribution: null,
            uploadAttribution: null,
            readerCustody: null,
        },
        nativeQualification: false,
        releaseAcceptance: false,
    });
}
