// @ts-nocheck
import assert from 'node:assert/strict';
import { assertProductNativeShutdown } from '../../tests/fixtures/memory-product-native-verdict.ts';
import { digest } from './product-collector-evidence.mjs';
const jsonl = (bytes) => {
    const text = bytes.toString();
    assert(text.endsWith('\n'));
    return text.trimEnd().split('\n').map(JSON.parse);
};
/** Ownership is evaluated independently of a successful calibration workload. */
export function inspectProductRaw(
    raw,
    { sourceSHA256, adapterSHA256, contractSHA256, job, parentLifecycle, noSampler },
) {
    let ownershipComplete = false;
    try {
        assert(
            parentLifecycle.spawnObserved &&
                parentLifecycle.exitObserved &&
                parentLifecycle.closeObserved,
        );
        assert.equal(parentLifecycle.code, parentLifecycle.closeCode);
        assert.equal(parentLifecycle.signal, null);
        assert.equal(parentLifecycle.closeSignal, null);
        const rows = jsonl(raw.timeline),
            stages = (name) => rows.filter((r) => r.stage === name).map((r) => r.data);
        const identity = stages('identity');
        assert.equal(identity.length, 1);
        assert.equal(identity[0].sourceSHA256, sourceSHA256);
        assert.equal(identity[0].adapterHash, adapterSHA256);
        assert.deepEqual(identity[0].productJob, job);
        assert.equal(identity[0].nativeCoverage.sha256, contractSHA256);
        assert.equal(
            identity[0].observer,
            noSampler ? 'disabled-matched-control' : 'serialized-250ms-target',
        );
        const receipt = stages('receipt');
        assert.equal(receipt.length, 1);
        const final = stages('shutdown-processes').filter((r) => r.phase === 'final-joined');
        assert.equal(final.length, 1);
        const observed = new Set(
            rows
                .flatMap((r) =>
                    r.stage === 'processes'
                        ? r.data
                        : r.stage === 'shutdown-processes'
                          ? r.data.processes
                          : [],
                )
                .map((p) => `${p.pid}/${p.created}`),
        );
        const ended = new Map(final[0].processes.map((p) => [`${p.pid}/${p.created}`, p]));
        assert(observed.size > 1 && observed.size <= 256);
        for (const key of observed) {
            const p = ended.get(key);
            assert(p, 'Owned process missing from final history.');
            assert(p.role === 'qualification-harness' || p.state === 'terminated');
            if (p.state === 'terminated')
                for (const metric of [
                    'heapUsedBytes',
                    'arrayBuffersBytes',
                    'externalBytes',
                    'rssBytes',
                ])
                    assert.equal(p[metric], null);
        }
        const owners = stages('owners').filter((r) => r.stage === 'full-teardown');
        assert.equal(owners.length, 1);
        assert(
            Object.keys(owners[0].counts).length > 0 &&
                Object.values(owners[0].counts).every((v) => v === 0),
        );
        for (const name of ['native-actual-exit', 'native-actual-close']) {
            const events = stages(name);
            assert.equal(events.length, 1);
            assert.deepEqual(events[0], { code: 0, signal: null });
        }
        const native = JSON.parse(raw.nativeExit.toString());
        assertProductNativeShutdown(native.snapshot, {
            captureExpected: true,
            downloads: native.downloads,
        });
        assert.equal(native.snapshot.versions.electron, '44.5.1');
        assert(stages('native-will-quit').length === 1);
        ownershipComplete = true;
        assert.equal(receipt[0].status, 'collected-product-calibration-evidence');
        assert.equal(receipt[0].failure, null);
        assert.equal(receipt[0].sourceSHA256, sourceSHA256);
        assert.equal(receipt[0].adapterHash, adapterSHA256);
        assert.equal(receipt[0].gcMode, 'normal');
        assert.equal(receipt[0].lane, 'desktop');
        assert(
            receipt[0].achievedWarmupMs >= 300000 &&
                receipt[0].achievedMeasuredMs >= 1500000 &&
                receipt[0].cycles >= 100,
        );
        assert.deepEqual(receipt[0].missing, []);
        assert.equal(receipt[0].policySHA256, null);
        assert.equal(receipt[0].memory.status, 'unreviewed-product-calibration');
        assert.equal(receipt[0].memory.thresholdsSelected, false);
        const contexts = stages('assessment-context');
        assert.equal(contexts.length, 1);
        for (const id of contexts[0].context.config.requirements.coverage)
            assert(receipt[0].coverage.includes(id), 'Missing required native coverage.');
        assert.equal(digest(JSON.stringify(contexts[0].context)), receipt[0].assessmentIdentity);
        const roles = Object.values(contexts[0].context.scope.runtimeIdentity);
        assert(roles.length > 0);
        for (const role of roles) {
            assert.equal(role.launch.harness.platform, 'win32');
            assert.match(role.executableSHA256, /^[a-f0-9]{64}$/);
        }
        return {
            valid: true,
            ownershipComplete,
            receipt: receipt[0],
            rawTimelineSHA256: digest(raw.timeline),
            nativeExitSHA256: digest(raw.nativeExit),
            policyQualified: false,
        };
    } catch (error) {
        return { valid: false, ownershipComplete, error: String(error).slice(0, 4096) };
    }
}
