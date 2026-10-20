import assert from 'node:assert/strict';
import { digest } from './product-collector-evidence.mjs';
import { validateObservationBinding, observationDigest } from './windows-observation-approval.mjs';
export const challengePrefix = 'OBSERVATION_CHALLENGE ';
export const challengeLineBytes = 900;
const maximumBytes = 65536,
    chunkBytes = 384;
function validate(item, expected = {}) {
    assert.deepEqual(Object.keys(item).sort(), ['approval', 'binding', 'status']);
    assert.equal(item.status, 'AWAITING_SAME_HOST_HUMAN_APPROVAL');
    const b = validateObservationBinding(item.binding);
    assert(typeof b.hostname === 'string' && /^[a-zA-Z0-9._-]{1,255}$/.test(b.hostname));
    assert.deepEqual(item.approval, {
        schema: 1,
        decision: 'approve-one-normal-pair',
        parentRun: b.host.run,
        bindingSHA256: observationDigest(b),
        sourceSHA256: b.sourceSHA256,
        commit: b.host.commit,
    });
    for (const [key, value] of Object.entries(expected)) {
        if (key === 'run') assert.equal(b.host.run, value);
        else if (key === 'commit') assert.equal(b.host.commit, value);
        else if (key === 'sourceSHA256') assert.equal(b.sourceSHA256, value);
        else if (key === 'request') {
            for (const field of ['sourceSHA256', 'policySHA256', 'coverageSHA256'])
                assert.equal(b[field], value[field]);
            assert(b.freshPty?.closed === true && b.freshPty.durable === true);
            assert.equal(b.freshPty.sourceSHA256, value.sourceSHA256);
            assert.equal(b.freshPty.scopeSHA256, value.pty.scopeSHA256);
            assert.equal(b.freshPty.policySHA256, value.pty.policySHA256);
        } else if (key === 'hostNowMs')
            assert(
                Number.isSafeInteger(value) && value < b.preparationDeadline,
                'Expired challenge cannot admit approval',
            );
        else assert.fail('Unknown challenge expectation');
    }
    return item;
}
const line = (value) => {
    const text = challengePrefix + JSON.stringify(value);
    assert(Buffer.byteLength(text) <= challengeLineBytes);
    return text;
};
/** Display transport only. It never creates an approval receipt or live authority. */
export function* observationChallengeLines(item) {
    validate(item);
    const raw = Buffer.from(JSON.stringify(item));
    assert(raw.length <= maximumBytes);
    const sha256 = digest(raw),
        frames = Math.ceil(raw.length / chunkBytes);
    const identity = {
        run: item.binding.host.run,
        attempt: item.binding.host.attempt,
        nonce: item.binding.nonce,
        bindingSHA256: observationDigest(item.binding),
        decisionSHA256: observationDigest(item.approval),
    };
    yield line({ kind: 'start', schema: 1, bytes: raw.length, frames, sha256, identity });
    for (let sequence = 0; sequence < frames; sequence++)
        yield line({
            kind: 'chunk',
            schema: 1,
            sha256,
            sequence,
            base64: raw
                .subarray(sequence * chunkBytes, (sequence + 1) * chunkBytes)
                .toString('base64'),
        });
    yield line({ kind: 'end', schema: 1, bytes: raw.length, frames, sha256, identity });
}
/** Reconstruct only a complete ordered transaction, then validate the full binding/decision.
 * Pass hostNowMs only from the bound host clock; local wall time is not that clock. */
export function readObservationChallenge(lines, expected = {}) {
    let start,
        sequence = 0,
        offset = 0,
        raw,
        complete = false;
    for (const text of lines) {
        const at = text.indexOf(challengePrefix);
        if (at < 0) continue;
        const payload = text.slice(at);
        assert(Buffer.byteLength(payload) <= challengeLineBytes);
        const frame = JSON.parse(payload.slice(challengePrefix.length));
        assert(!complete && frame.schema === 1);
        if (!start) {
            assert.deepEqual(Object.keys(frame).sort(), [
                'bytes',
                'frames',
                'identity',
                'kind',
                'schema',
                'sha256',
            ]);
            assert.equal(frame.kind, 'start');
            assert(
                Number.isSafeInteger(frame.bytes) && frame.bytes > 0 && frame.bytes <= maximumBytes,
            );
            assert.equal(frame.frames, Math.ceil(frame.bytes / chunkBytes));
            assert(/^[a-f0-9]{64}$/.test(frame.sha256));
            start = frame;
            raw = Buffer.alloc(frame.bytes);
        } else if (frame.kind === 'chunk') {
            assert.deepEqual(Object.keys(frame).sort(), [
                'base64',
                'kind',
                'schema',
                'sequence',
                'sha256',
            ]);
            assert.equal(frame.sequence, sequence++);
            assert.equal(frame.sha256, start.sha256);
            assert(sequence <= start.frames && typeof frame.base64 === 'string');
            const bytes = Buffer.from(frame.base64, 'base64');
            assert.equal(bytes.toString('base64'), frame.base64);
            assert.equal(bytes.length, Math.min(chunkBytes, raw.length - offset));
            raw.set(bytes, offset);
            offset += bytes.length;
        } else {
            assert.deepEqual(frame, { ...start, kind: 'end' });
            assert.equal(sequence, start.frames);
            assert.equal(offset, raw.length);
            assert.equal(digest(raw), start.sha256);
            complete = true;
        }
    }
    assert(complete, 'Incomplete challenge display');
    const item = JSON.parse(raw.toString());
    assert(Buffer.from(JSON.stringify(item)).equals(raw), 'Noncanonical challenge payload');
    validate(item, expected);
    assert.deepEqual(start.identity, {
        run: item.binding.host.run,
        attempt: item.binding.host.attempt,
        nonce: item.binding.nonce,
        bindingSHA256: observationDigest(item.binding),
        decisionSHA256: observationDigest(item.approval),
    });
    return item;
}
