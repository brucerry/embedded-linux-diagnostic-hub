// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { challenge, recovered } from './fixtures/observation-repair-fixture.mts';
import {
    observationChallengeLines,
    readObservationChallenge,
    challengePrefix,
    challengeLineBytes,
} from '../scripts/lib/observation-challenge.mjs';
import {
    observationDigest,
    pollObservationApproval,
    observationAuthority,
} from '../scripts/lib/windows-observation-approval.mjs';
const render = (value) => challengePrefix + JSON.stringify(value);
const parse = (line) => JSON.parse(line.slice(challengePrefix.length));
function rebind(item) {
    item.approval.bindingSHA256 = observationDigest(item.binding);
    return item;
}
for (const padding of ['', '證據\n"\\😀'.repeat(2000)])
    test('recovered challenge/Unicode exact display roundtrip below1024-character live viewer including timestamp', () => {
        const item = challenge();
        if (padding) item.binding.displayTest = padding;
        rebind(item);
        const raw = JSON.stringify(item),
            lines = [...observationChallengeLines(item)];
        assert(Buffer.byteLength(raw) > 1024);
        assert.throws(() => JSON.parse(raw.slice(0, 1024)));
        assert(lines.every((line) => Buffer.byteLength(line) <= challengeLineBytes));
        const timestamp = '2026-10-20T01:08:35.2024523Z ';
        const visible = lines.map((line) => (timestamp + line).slice(0, 1024));
        assert.deepEqual(
            readObservationChallenge(visible, {
                run: item.binding.host.run,
                commit: item.binding.host.commit,
                sourceSHA256: item.binding.sourceSHA256,
                hostNowMs: item.binding.preparationDeadline - 1,
            }),
            item,
        );
        const manifest = parse(lines[0]);
        assert.equal(manifest.bytes, Buffer.byteLength(raw));
        assert.equal(manifest.identity.bindingSHA256, item.approval.bindingSHA256);
        assert.equal(manifest.identity.nonce, recovered.challenge.nonce);
        assert.throws(
            () => observationAuthority(item.binding, {}, item.approval, {}),
            /Authenticated manual approval/,
        );
    });
const mutations = {
    missing: (lines) => lines.splice(1, 1),
    reordered: (lines) => {
        [lines[1], lines[2]] = [lines[2], lines[1]];
    },
    duplicate: (lines) => lines.splice(1, 0, lines[1]),
    truncated: (lines) => (lines[1] = lines[1].slice(0, -1)),
    corrupt: (lines) => {
        const f = parse(lines[1]);
        f.base64 = 'A' + f.base64.slice(1);
        lines[1] = render(f);
    },
    'mixed-run': (lines) => {
        const f = parse(lines[0]);
        f.identity.run = '39351381523';
        lines[0] = render(f);
    },
    'mixed-nonce': (lines) => {
        const f = parse(lines[0]);
        f.identity.nonce = '11111111-1111-4111-8111-111111111111';
        lines[0] = render(f);
    },
    hash: (lines) => {
        const f = parse(lines[1]);
        f.sha256 = '0'.repeat(64);
        lines[1] = render(f);
    },
    count: (lines) => {
        const f = parse(lines[0]);
        f.frames++;
        lines[0] = render(f);
    },
    length: (lines) => {
        const f = parse(lines[0]);
        f.bytes++;
        lines[0] = render(f);
    },
    encoding: (lines) => {
        const f = parse(lines[1]);
        f.base64 += '!';
        lines[1] = render(f);
    },
    footer: (lines) => lines.pop(),
    extra: (lines) => lines.push(lines.at(-1)),
    schema: (lines) => {
        const f = parse(lines[0]);
        f.schema = 2;
        lines[0] = render(f);
    },
};
for (const [name, mutate] of Object.entries(mutations))
    test('challenge refuses ' + name + ' without approval authority', () => {
        const lines = [...observationChallengeLines(challenge())];
        mutate(lines);
        assert.throws(() => readObservationChallenge(lines));
    });
for (const expected of [
    { run: '39351381523' },
    { commit: '0'.repeat(40) },
    { sourceSHA256: '0'.repeat(64) },
    { hostNowMs: recovered.challenge.preparationDeadline },
    { hostNowMs: recovered.challenge.preparationDeadline + 1 },
    { unknown: true },
])
    test(
        'complete challenge rejects replay/expiration expectation ' + JSON.stringify(expected),
        () => {
            assert.throws(() =>
                readObservationChallenge([...observationChallengeLines(challenge())], expected),
            );
        },
    );
test('sealed request and fresh PTY scope/policy/source remain mandatory for reconstructed approval', () => {
    const item = challenge(),
        b = item.binding,
        request = {
            sourceSHA256: b.sourceSHA256,
            policySHA256: b.policySHA256,
            coverageSHA256: b.coverageSHA256,
            pty: { scopeSHA256: b.freshPty.scopeSHA256, policySHA256: b.freshPty.policySHA256 },
        };
    assert.deepEqual(
        readObservationChallenge([...observationChallengeLines(item)], { request }),
        item,
    );
    request.pty.scopeSHA256 = '0'.repeat(64);
    assert.throws(() =>
        readObservationChallenge([...observationChallengeLines(item)], { request }),
    );
});
test('display total byte bound does not grow with repeated/oversized publication', () => {
    const item = challenge();
    item.binding.extra = 'x'.repeat(65536);
    rebind(item);
    assert.throws(() => [...observationChallengeLines(item)]);
});
for (const abortAt of [
    'before-fetch',
    'after-fetch',
    'body',
    'wait',
    'run-body',
    'download',
    'archive-body',
])
    test(
        'actual approval poller stops cancellation/expiry at async boundary ' + abortAt,
        async () => {
            const item = challenge(),
                b = item.binding;
            let aborted = false,
                fetches = 0,
                receipts = 0;
            const artifact = {
                id: 7,
                name: 'windows-observation-approval-' + b.host.run + '-' + observationDigest(b),
                expired: false,
                size_in_bytes: 1024,
                workflow_run: { id: 456 },
            };
            const run = {
                id: 456,
                path: '.github/workflows/windows-portable.yml',
                event: 'workflow_dispatch',
                run_attempt: 1,
                status: 'completed',
                conclusion: 'success',
                actor: { login: 'brucerry' },
                triggering_actor: { login: 'brucerry' },
                head_sha: b.host.commit,
                repository: { full_name: b.host.repository },
                created_at: b.createdUTC,
            };
            const stream = (text, where) =>
                new Response(
                    new ReadableStream({
                        start(c) {
                            c.enqueue(new TextEncoder().encode(text));
                            if (abortAt === where) aborted = true;
                            c.close();
                        },
                    }),
                );
            if (abortAt === 'before-fetch') aborted = true;
            await assert.rejects(
                pollObservationApproval(b, 'never-log', {
                    check() {
                        assert(!aborted, 'cancelled/expired');
                    },
                    guard() {
                        assert(!aborted, 'cancelled/expired');
                    },
                    record() {
                        receipts++;
                    },
                    wait() {
                        aborted = true;
                    },
                    fetchPort: async (url) => {
                        fetches++;
                        if (abortAt === 'after-fetch') aborted = true;
                        if (url.includes('/actions/artifacts?'))
                            return stream(
                                JSON.stringify({ artifacts: abortAt === 'wait' ? [] : [artifact] }),
                                'body',
                            );
                        if (url.endsWith('/actions/runs/456'))
                            return stream(JSON.stringify(run), 'run-body');
                        if (url.endsWith('/actions/artifacts/7/zip'))
                            return new Response(null, {
                                status: 302,
                                headers: { location: 'https://fixture.invalid/download' },
                            });
                        if (abortAt === 'download') aborted = true;
                        return stream('{}', 'archive-body');
                    },
                }),
                /cancelled\/expired/,
            );
            assert.equal(receipts, 0);
            if (abortAt === 'before-fetch') assert.equal(fetches, 0);
        },
    );
for (const variant of ['stale', 'incomplete', 'collision', 'too-many'])
    test('actual poller candidate ' + variant + ' cannot mint approval', async () => {
        const item = challenge(),
            b = item.binding;
        let calls = 0;
        const artifact = {
            id: 7,
            name: 'windows-observation-approval-' + b.host.run + '-' + observationDigest(b),
            expired: variant === 'stale',
            size_in_bytes: 1024,
            workflow_run: { id: 456 },
        };
        await assert.rejects(
            pollObservationApproval(b, 'never-log', {
                guard() {},
                check() {
                    assert(++calls < 30, 'bounded stop');
                },
                wait() {
                    throw Error('incomplete stop');
                },
                fetchPort: async (url) => {
                    if (url.includes('/actions/artifacts?'))
                        return new Response(
                            JSON.stringify({
                                artifacts:
                                    variant === 'too-many'
                                        ? Array(11).fill(artifact)
                                        : variant === 'collision'
                                          ? [{ ...artifact, name: 'wrong' }]
                                          : [artifact],
                            }),
                        );
                    return new Response(
                        JSON.stringify({
                            status: variant === 'incomplete' ? 'in_progress' : 'completed',
                        }),
                    );
                },
            }),
        );
    });
for (const delta of [-1, 0, 1])
    test('exact65536-byte challenge publication boundary ' + delta, () => {
        const item = challenge();
        item.binding.extra = '';
        rebind(item);
        const fixed = Buffer.byteLength(JSON.stringify(item));
        item.binding.extra = 'x'.repeat(65536 - fixed + delta);
        rebind(item);
        assert.equal(Buffer.byteLength(JSON.stringify(item)), 65536 + delta);
        if (delta > 0) assert.throws(() => [...observationChallengeLines(item)]);
        else assert.deepEqual(readObservationChallenge([...observationChallengeLines(item)]), item);
    });
