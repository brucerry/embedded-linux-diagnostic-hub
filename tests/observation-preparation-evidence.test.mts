// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { fixture, recovered, challenge } from './fixtures/observation-repair-fixture.mts';
import {
    readPreparationEvidence,
    provedPreparationRefusal,
    preparationEvidenceLimits,
} from '../scripts/lib/observation-preparation-evidence.mjs';
import {
    pollObservationApproval,
    approvalName,
    observationDigest,
} from '../scripts/lib/windows-observation-approval.mjs';
import { refuseObservationPreparation } from '../scripts/windows-observation-pair.mts';
import {
    observationSharedCredits,
    admitObservationShared,
} from '../scripts/lib/observation-accounting.mjs';
const collect = (f) => [...readPreparationEvidence(f.prep)];
const fail = (fn) => {
    try {
        fn();
        assert.fail('Expected refusal');
    } catch (error) {
        assert.notEqual(error.message, 'Expected refusal');
        return error;
    }
};
test('recovered214-query raw input/output/closure transcripts reconstruct byte-for-byte after durable encoding/reference', () => {
    const f = fixture();
    try {
        const expected = recovered.records.map((i) => recovered.dictionary[i]);
        for (const [s, d] of expected) f.record(s, d);
        assert.deepEqual(
            collect(f).map((r) => [r.stage, r.data]),
            expected,
        );
        const snapshot = f.ledger.snapshot();
        assert(snapshot.bytes < 150000);
        assert.equal(snapshot.rows, 642);
        assert(snapshot.dictionaryBytes <= 262144 && snapshot.dictionaryRows <= 256);
        assert(
            fs
                .readdirSync(f.prep)
                .some((n) =>
                    Object.hasOwn(
                        JSON.parse(fs.readFileSync(path.join(f.prep, n), 'utf8')),
                        'reference',
                    ),
                ),
        );
    } finally {
        f.close();
    }
});
for (const lateApproval of [false, true])
    test(
        'actual poller + security adapter + durable logger + lease completes virtual20-minute ' +
            (lateApproval ? 'latest valid approval' : 'no approval') +
            ' path',
        async (t) => {
            const f = fixture();
            let lease;
            try {
                const adapter = f.adapter();
                const files = Array.from({ length: 32 }, (_, i) =>
                    path.join(f.out, 'retained-pty-' + i),
                );
                for (const file of files) fs.writeFileSync(file, 'fixture');
                // Retained prerequisite/runtime evidence shares the real physical parent credit.
                fs.writeFileSync(
                    path.join(f.out, 'other-retained-evidence'),
                    Buffer.alloc(1200000),
                );
                f.ledger.admitApprovalWait({ ptyFiles: files.length, ptyPasses: 2 });
                lease = f.lease(adapter.ownerCheck);
                lease.acquire();
                for (const [stage, data] of recovered.setup) f.record(stage, data);
                const recheckPty = () => {
                    adapter.ownerCheck(f.out);
                    for (let i = 0; i < files.length; i += 16)
                        adapter.ownerCheck.many(files.slice(i, i + 16));
                    adapter.ownerCheck.many([f.tmp, f.tmp]);
                };
                recheckPty();
                const envelope = f.ledger.admitApprovalWait({ ptyFiles: 32 });
                assert.equal(envelope.polls, 120);
                assert.equal(envelope.ptyQueries, 14);
                const item = challenge(),
                    b = item.binding;
                let polls = 0;
                const artifact = {
                    id: 7,
                    name: approvalName(b),
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
                const fetchPort = async (url) => {
                    if (url.includes('/actions/artifacts?')) {
                        polls++;
                        return new Response(
                            JSON.stringify({
                                artifacts: lateApproval && polls === 120 ? [artifact] : [],
                            }),
                        );
                    }
                    if (url.endsWith('/actions/runs/456')) return new Response(JSON.stringify(run));
                    if (url.endsWith('/actions/artifacts/7/zip'))
                        return new Response(null, {
                            status: 302,
                            headers: { location: 'https://fixture.invalid/archive' },
                        });
                    return new Response(
                        zipSync({ 'approval.json': strToU8(JSON.stringify(item.approval)) }),
                    );
                };
                const task = pollObservationApproval(b, 'fixture-never-log-token', {
                    fetchPort,
                    check() {
                        f.guard();
                        lease.check();
                    },
                    guard: f.guard,
                    record: f.record,
                    wait(ms) {
                        f.now += ms;
                    },
                });
                if (lateApproval) {
                    const approval = await task;
                    assert.equal(approval.bindingSHA256, observationDigest(b));
                    assert.equal(f.now, 1190000);
                    // Same max3 grouping count as production PTY revalidation, with fresh real queries.
                    recheckPty();
                    f.record('preparation-closed', { approval });
                    const e = Error('Local failed outcome before payload; no workload authorized');
                    f.ledger.beginFailure(e);
                    await refuseObservationPreparation(e, {
                        lease,
                        verifySource: async () => true,
                        check: f.guard,
                        record: f.record,
                        resourceStates: () => ({ electron: 'closed', runtime: 'closed' }),
                        evidenceComplete: () => f.ledger.complete(),
                    });
                    assert.equal(lease.state().released, true);
                    assert(!f.held);
                } else {
                    await assert.rejects(task, /Absolute preparation deadline/);
                    assert.equal(f.now, 1200000);
                    const e = Error('Absolute preparation deadline');
                    f.ledger.beginFailure(e);
                    await assert.rejects(
                        refuseObservationPreparation(e, {
                            lease,
                            verifySource: async () => true,
                            check: f.guard,
                            record: f.record,
                            resourceStates: () => ({ electron: 'closed', runtime: 'closed' }),
                            evidenceComplete: () => f.ledger.complete(),
                        }),
                    );
                    const hold = f.retain({
                        phase: 'deadline-release-unknown',
                        firstError: f.ledger.snapshot().firstError,
                    });
                    assert(hold.handle.referenced);
                    assert.equal(lease.state().released, false);
                    assert.equal(
                        await Promise.race([hold.outcome.then(() => true), Promise.resolve(false)]),
                        false,
                    );
                }
                const state = f.ledger.snapshot();
                assert(state.bytes <= preparationEvidenceLimits.bytes);
                assert(state.rows <= 2048);
                assert(f.calls >= 360);
                assert.equal(collect(f).length, state.rows);
                assert(!JSON.stringify(collect(f)).includes('fixture-never-log-token'));
                t.diagnostic(
                    JSON.stringify({
                        kind: 'full-window-evidence',
                        lateApproval,
                        bytes: state.bytes,
                        rows: state.rows,
                        queries: f.calls,
                        elapsedMs: f.now,
                        markerReleased: lease.state().released,
                        held: !!f.held,
                        envelope,
                    }),
                );
            } finally {
                f.close();
            }
        },
    );
for (const delta of [-1, 0, 1])
    test(
        'exact ordinary byte boundary ' +
            delta +
            ' refuses before any descriptor or ordinal reservation',
        () => {
            const f = fixture({ limits: { terminalBytes: 327680 } });
            try {
                const data = { v: 'short' },
                    size = Buffer.byteLength(
                        JSON.stringify({ schema: 1, sequence: 0, stage: 'ordinary', data }) + '\n',
                    );
                f.ledger.bytes =
                    preparationEvidenceLimits.bytes -
                    preparationEvidenceLimits.terminalBytes -
                    size +
                    delta;
                const before = f.opens;
                if (delta <= 0) {
                    f.record('ordinary', data);
                    assert.equal(f.opens, before + 1);
                } else {
                    const error = fail(() => f.record('ordinary', data));
                    assert(provedPreparationRefusal(error));
                    assert.equal(f.opens, before);
                    assert.equal(f.ledger.rows, 0);
                    assert(f.ledger.complete());
                }
            } finally {
                f.close();
            }
        },
    );
for (const delta of [-1, 0, 1])
    test('exact row boundary ' + delta, () => {
        const f = fixture();
        try {
            f.ledger.rows = 2048 - 32 + delta;
            if (delta < 0) f.record('ordinary', {});
            else {
                const before = f.opens;
                assert(provedPreparationRefusal(fail(() => f.record('ordinary', {}))));
                assert.equal(f.opens, before);
            }
        } finally {
            f.close();
        }
    });
for (const delta of [-1, 0, 1])
    test('per-record UTF8/escaping boundary ' + delta, () => {
        const f = fixture();
        try {
            const data = { v: '證據"\\\n' },
                bytes = Buffer.byteLength(
                    JSON.stringify({ schema: 1, sequence: 0, stage: 'ordinary', data }) + '\n',
                );
            f.ledger.limits.rowBytes = bytes + delta;
            if (delta < 0) {
                const opens = f.opens;
                assert(provedPreparationRefusal(fail(() => f.record('ordinary', data))));
                assert.equal(f.opens, opens);
            } else {
                f.record('ordinary', data);
                assert.equal(f.ledger.bytes, bytes);
            }
        } finally {
            f.close();
        }
    });
test('legacy1047801 plus1452 is refused before input/provider and preserves original cause using terminal reserve', async () => {
    const f = fixture();
    try {
        const adapter = f.adapter(),
            lease = f.lease(adapter.ownerCheck);
        lease.acquire();
        const row = f.ledger.rows,
            opens = f.writerOpens,
            calls = f.calls;
        f.ledger.bytes = 1047801;
        const error = fail(() => adapter.ownerCheck(lease.file));
        assert(provedPreparationRefusal(error));
        assert.equal(f.calls, calls);
        assert.equal(f.writerOpens, opens);
        assert.equal(f.ledger.rows, row);
        assert(f.ledger.complete());
        assert.equal(provedPreparationRefusal(Error(error.message)), null);
        assert.equal(provedPreparationRefusal(JSON.parse(JSON.stringify(error))), null);
        // That legacy prefix has consumed the NEW terminal reserve: it cannot be laundered into safe cleanup.
        f.ledger.beginFailure(error);
        assert.equal(f.ledger.snapshot().firstError.error, String(error));
        assert(f.held);
        assert.equal(lease.state().released, false);
    } finally {
        f.close();
    }
});
test('safe pre-query refusal with intact reserved prefix permits positive real lease cleanup', async () => {
    const f = fixture();
    try {
        const adapter = f.adapter(),
            lease = f.lease(adapter.ownerCheck);
        lease.acquire();
        f.ledger.bytes =
            preparationEvidenceLimits.bytes - preparationEvidenceLimits.terminalBytes - 10;
        const calls = f.calls,
            error = fail(() => adapter.ownerCheck(lease.file));
        assert.equal(f.calls, calls);
        assert(provedPreparationRefusal(error));
        f.ledger.beginFailure(error);
        await refuseObservationPreparation(error, {
            lease,
            verifySource: async () => true,
            check: f.guard,
            record: f.record,
            resourceStates: () => ({ electron: 'closed', runtime: 'closed' }),
            evidenceComplete: () => f.ledger.complete(),
        });
        assert(lease.state().released);
        assert(!f.held);
        assert.equal(
            collect(f).find((r) => r.stage === 'preparation-error').data.error,
            String(error),
        );
    } finally {
        f.close();
    }
});
for (const fault of ['open', 'write', 'zero', 'sync', 'close', 'short'])
    test('actual descriptor ' + fault + ' preserves uncertainty/short-write draining', async () => {
        const f = fixture({ faultAt: 1, fault });
        try {
            if (fault === 'short') {
                f.record('ordinary', { unicode: '證據'.repeat(30) });
                assert.equal(collect(f)[0].data.unicode, '證據'.repeat(30));
                assert(!f.held);
            } else {
                const error = fail(() => f.record('ordinary', { v: 1 }));
                assert.equal(provedPreparationRefusal(error), null);
                assert(!f.ledger.complete());
                assert(f.held.handle.referenced);
                assert(f.ledger.rows >= 1);
                assert(f.ledger.snapshot().firstError);
                if (fault === 'close') assert(f.live.size > 0);
                assert.equal(
                    await Promise.race([f.held.outcome.then(() => true), Promise.resolve(false)]),
                    false,
                );
            }
        } finally {
            f.close();
        }
    });
test('post-provider output refusal remains held despite opaque pre-open record proof', () => {
    const f = fixture();
    try {
        const query = f.ledger.securityQuery((_s, _p, _raw, options) => {
            f.record('security-input', {});
            options.onProcessState({ attempted: true, closed: true });
            f.ledger.bytes =
                preparationEvidenceLimits.bytes - preparationEvidenceLimits.terminalBytes;
            f.record('security-output', { v: 1 });
        });
        const error = fail(() => query('', '', '', {}));
        assert(provedPreparationRefusal(error));
        assert(f.held);
        assert(!f.ledger.complete());
        assert.equal(f.ledger.snapshot().firstError.charges.query.attempted, true);
    } finally {
        f.close();
    }
});
for (const mutation of [
    'hash',
    'length',
    'forward',
    'cycle',
    'foreign',
    'corrupt',
    'missing',
    'rebound',
])
    test('reference reader rejects ' + mutation, () => {
        const f = fixture();
        try {
            f.record('security-input', { v: '證據'.repeat(100) });
            f.record('security-input', { v: '證據'.repeat(100) });
            const file = path.join(f.prep, '000001.json'),
                row = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (mutation === 'hash') row.reference.dataSHA256 = '0'.repeat(64);
            if (mutation === 'length') row.reference.bytes++;
            if (['forward', 'cycle'].includes(mutation)) row.reference.sequence = 1;
            if (mutation === 'foreign') row.stage = 'security-output';
            if (mutation === 'corrupt') fs.writeFileSync(path.join(f.prep, '000000.json'), '{}\n');
            if (mutation === 'missing') fs.unlinkSync(path.join(f.prep, '000000.json'));
            if (mutation === 'rebound') {
                const old = path.join(f.prep, '000000.json');
                fs.renameSync(old, old + '.moved');
                fs.symlinkSync(old + '.moved', old);
            }
            fs.writeFileSync(file, JSON.stringify(row) + '\n');
            assert.throws(() => collect(f));
        } finally {
            f.close();
        }
    });
for (const boundary of ['source', 'marker', 'ancestor', 'resources', 'evidence'])
    test('missing ' + boundary + ' proof retains disposable lease', async () => {
        const f = fixture();
        try {
            const adapter = f.adapter(),
                lease = f.lease(adapter.ownerCheck);
            lease.acquire();
            const error = Error('first failure');
            f.ledger.beginFailure(error);
            if (boundary === 'marker') fs.writeFileSync(lease.file, 'changed');
            await assert.rejects(
                refuseObservationPreparation(error, {
                    lease,
                    verifySource: async () => boundary !== 'source',
                    check() {
                        if (boundary === 'ancestor') throw Error('Ancestor changed');
                    },
                    record: f.record,
                    resourceStates: () => ({
                        electron: boundary === 'resources' ? 'unknown' : 'closed',
                        runtime: 'closed',
                    }),
                    evidenceComplete: () => boundary !== 'evidence',
                }),
            );
            const hold = f.retain({
                phase: 'release-unproved',
                firstError: f.ledger.snapshot().firstError,
            });
            assert(hold.handle.referenced);
            assert(!lease.state().released);
        } finally {
            f.close();
        }
    });
for (const delta of [-1, 0, 1])
    test('actual shared parent credit boundary ' + delta, () => {
        const f = fixture();
        try {
            fs.writeFileSync(
                path.join(f.out, 'other'),
                Buffer.alloc(observationSharedCredits.parent - 327680 - 100 + delta),
            );
            if (delta <= 0) admitObservationShared(f.out, [], 'parent', 327780);
            else
                assert.throws(
                    () => admitObservationShared(f.out, [], 'parent', 327780),
                    /shared credit/,
                );
        } finally {
            f.close();
        }
    });
for (const stage of ['preparation-error', 'preparation-refused', 'ownership-held.json'])
    for (const fault of ['open', 'partial', 'sync', 'close'])
        test(
            'terminal ' + stage + ' ' + fault + ' cannot erase first cause or release held marker',
            async () => {
                const f = fixture();
                try {
                    const adapter = f.adapter(),
                        lease = f.lease(adapter.ownerCheck);
                    lease.acquire();
                    const original = Error('First failure ' + '證'.repeat(3000));
                    if (stage !== 'preparation-error') f.ledger.beginFailure(original);
                    f.setFault(fault);
                    if (stage === 'preparation-error') f.ledger.beginFailure(original);
                    else if (stage === 'ownership-held.json')
                        f.retain({
                            phase: 'test-real-hold',
                            firstError: f.ledger.snapshot().firstError,
                        });
                    else
                        assert.throws(() =>
                            f.record(stage, { error: 'secondary cleanup failure' }),
                        );
                    if (!f.held)
                        f.retain({
                            phase: 'persistence-unknown',
                            firstError: f.ledger.snapshot().firstError,
                        });
                    assert(f.held.handle.referenced);
                    assert(!lease.state().released);
                    const first = f.ledger.snapshot().firstError.error;
                    assert(Buffer.byteLength(first) <= 2048);
                    assert(String(original).startsWith(first));
                    f.cancel();
                    f.now = 1200000;
                    assert.equal(
                        await Promise.race([
                            f.held.outcome.then(() => true),
                            Promise.resolve(false),
                        ]),
                        false,
                    );
                } finally {
                    f.close();
                }
            },
        );
for (const stageOffset of [1, 2])
    for (const fault of ['open', 'partial', 'sync', 'close'])
        test(
            'real provider ' +
                (stageOffset === 1 ? 'output' : 'closed receipt') +
                ' ' +
                fault +
                ' holds after process attempt',
            () => {
                const f = fixture();
                try {
                    const adapter = f.adapter(),
                        lease = f.lease(adapter.ownerCheck);
                    lease.acquire();
                    const calls = f.calls;
                    f.ledger.dictionary.clear();
                    f.ledger.dictionaryBytes = 0;
                    f.setFault(fault, f.opens + 1 + stageOffset);
                    assert.throws(() => adapter.ownerCheck(lease.file));
                    assert.equal(f.calls, calls + 1);
                    assert(f.held.handle.referenced);
                    assert(!f.ledger.complete());
                    assert(!lease.state().released);
                } finally {
                    f.close();
                }
            },
        );
for (const fault of ['corrupt', 'close'])
    test('writer verifies durable reference origin before acknowledgment: ' + fault, () => {
        const f = fixture();
        try {
            const data = { v: 'same exact query' };
            f.record('security-input', data);
            if (fault === 'corrupt') fs.writeFileSync(path.join(f.prep, '000000.json'), '{}\n');
            else f.setFault('close');
            assert.throws(() => f.record('security-input', data));
            assert(f.held);
            assert(!f.ledger.complete());
        } finally {
            f.close();
        }
    });
test('setup time consumes original preparation clock instead of restarting wait', async () => {
    const f = fixture();
    try {
        f.now = 1190000;
        let fetches = 0;
        await assert.rejects(
            pollObservationApproval(challenge().binding, 'fixture', {
                check: f.guard,
                guard: f.guard,
                fetchPort: async () => {
                    fetches++;
                    return new Response('{"artifacts":[]}');
                },
                wait(ms) {
                    f.now += ms;
                },
            }),
            /Absolute preparation deadline/,
        );
        assert.equal(fetches, 1);
        assert.equal(f.now, 1200000);
        assert.equal(f.ledger.admitApprovalWait({ remainingMs: 10000 }).polls, 1);
    } finally {
        f.close();
    }
});
test('unsupported272-file routine envelope refuses before observation lease admission', () => {
    const f = fixture();
    try {
        const error = fail(() => f.ledger.admitApprovalWait({ ptyFiles: 272, ptyPasses: 2 }));
        assert(provedPreparationRefusal(error));
        assert(f.ledger.complete());
        assert.equal(f.calls, 0);
        assert.equal(f.writerOpens, 0);
        assert(!fs.existsSync(path.join(f.tmp, 'fixture.lock')));
    } finally {
        f.close();
    }
});
