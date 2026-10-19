// @ts-nocheck
import assert from 'node:assert/strict';
import { assertProductNativeShutdown } from '../../tests/fixtures/memory-product-native-verdict.ts';
import {
    SoakDecoder,
    boundedJSON,
    soakEvidenceContract,
    soakEvidenceContractSHA256,
} from './soak-evidence.mjs';
import { MatchedCheckpoints, SamplingWindows } from './soak-measurement.mjs';
import {
    startupIdentityDecoder,
    identityManifestStage,
    identityPartStage,
    losslessReportStages,
} from './startup-identity-report.mjs';
import { artifactLines, smallArtifact, digest } from './product-collector-evidence.mjs';
import { observationOutcome } from './observation-outcome.mjs';
/** Ownership is evaluated independently of a successful calibration workload. */
export function inspectProductRaw(
    raw,
    {
        sourceSHA256,
        adapterSHA256,
        contractSHA256,
        job,
        parentLifecycle,
        noSampler,
        evidenceFormat = 'legacy-logical-v1',
        evidenceContractSHA256,
    },
) {
    let ownershipComplete = false;
    let integrity, receiptValue;
    try {
        assert(
            parentLifecycle.spawnObserved &&
                parentLifecycle.exitObserved &&
                parentLifecycle.closeObserved,
        );
        assert.equal(parentLifecycle.code, parentLifecycle.closeCode);
        assert.equal(parentLifecycle.signal, null);
        assert.equal(parentLifecycle.closeSignal, null);
        assert(
            ['legacy-logical-v1', 'finite-multipart-v1', soakEvidenceContract.format].includes(
                evidenceFormat,
            ),
            'Unknown collection evidence format',
        );
        if (evidenceFormat === soakEvidenceContract.format)
            assert(evidenceContractSHA256 === soakEvidenceContractSHA256);
        let state = {
            retained: new Map(),
            observed: new Set(),
            matched: null,
            samplingWindows: new SamplingWindows(),
        };
        const once = new Set([
            'identity',
            'receipt',
            'assessment-context',
            'native-actual-exit',
            'native-actual-close',
            'native-will-quit',
        ]);
        const consume = (state, { stage, data }) => {
            const { retained, observed, samplingWindows } = state;
            let { matched } = state;
            if (once.has(stage)) {
                assert(!retained.has(stage), 'Duplicate final/identity record: ' + stage);
                retained.set(stage, [data]);
                if (
                    stage === 'assessment-context' &&
                    evidenceFormat === soakEvidenceContract.format
                )
                    matched = state.matched = new MatchedCheckpoints(data.context.scope.roles);
            }
            if (stage === 'processes' || stage === 'shutdown-processes') {
                const processes = stage === 'processes' ? data : data.processes;
                assert(Array.isArray(processes) && processes.length <= 256);
                for (const p of processes) {
                    observed.add(`${p.pid}/${p.created}`);
                    assert(observed.size <= 256, 'Process identity history bound');
                }
                if (stage === 'shutdown-processes' && data.phase === 'final-joined') {
                    assert(!retained.has('final-joined'));
                    retained.set('final-joined', [data]);
                }
            }
            if (stage === 'owners' && data.stage === 'full-teardown') {
                assert(!retained.has('final-owners'));
                retained.set('final-owners', [data]);
            }
            if (
                stage === 'quiescent-checkpoint' &&
                evidenceFormat === soakEvidenceContract.format
            ) {
                assert(matched, 'Checkpoint before assessment context');
                matched.visit(data.processes, data.stateKey, data.phase, data.window);
            }
            if (stage === 'sampling-window') samplingWindows.accept(data);
        };
        const record = (event) => consume(state, event);
        const beginTransaction = () => {
            const next = {
                retained: new Map(state.retained),
                observed: new Set(state.observed),
                matched: state.matched?.fork() ?? null,
                samplingWindows: state.samplingWindows.fork(),
            };
            return {
                record: (event) => consume(next, event),
                commit: () => {
                    state = next;
                },
            };
        };
        if (evidenceFormat === soakEvidenceContract.format) {
            const decoder = new SoakDecoder({ sourceSHA256, nonce: job.nonce, beginTransaction });
            for (const line of artifactLines(raw.timeline)) decoder.accept(line);
            integrity = decoder.finish();
            decoder.dictionary.clear();
        } else {
            const decoder = startupIdentityDecoder();
            for (const line of artifactLines(raw.timeline)) {
                const row = boundedJSON(line.subarray(0, -1), 1048576);
                if (row.stage === identityManifestStage || row.stage === identityPartStage) {
                    assert(
                        evidenceFormat === 'finite-multipart-v1',
                        'Mixed local/multipart report form',
                    );
                    const value = decoder.accept(row.stage, row.data);
                    if (value) record(value);
                } else {
                    decoder.assertComplete();
                    assert(
                        evidenceFormat !== 'finite-multipart-v1' ||
                            !losslessReportStages.includes(row.stage),
                        'Multipart report bypass',
                    );
                    record(row);
                }
            }
            decoder.assertComplete();
        }
        const { retained, observed, matched, samplingWindows } = state;
        const stages = (name) => retained.get(name) ?? [];
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
        receiptValue = receipt[0];
        const final = stages('final-joined');
        assert.equal(final.length, 1);
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
        const owners = stages('final-owners');
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
        const native = boundedJSON(smallArtifact(raw.nativeExit));
        assertProductNativeShutdown(native.snapshot, {
            captureExpected: true,
            downloads: native.downloads,
        });
        assert.equal(native.snapshot.versions.electron, '44.5.1');
        assert(stages('native-will-quit').length === 1);
        const quit = stages('native-will-quit')[0];
        assertProductNativeShutdown(quit.snapshot, {
            captureExpected: true,
            downloads: quit.downloads,
        });
        assert.deepEqual(quit.snapshot, native.snapshot);
        assert.deepEqual(quit.downloads, native.downloads);
        ownershipComplete = true;
        assert(
            integrity?.complete !== false,
            'Soak workload incomplete; teardown is independently proved',
        );
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
        if (evidenceFormat === soakEvidenceContract.format) {
            const completeness = matched.finish();
            assert(receipt[0].checkpointCompleteness?.complete);
            assert.deepEqual(receipt[0].checkpointCompleteness, completeness);
            samplingWindows.finish(receipt[0].samplingCounts);
        }
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
            rawTimelineSHA256: Buffer.isBuffer(raw.timeline)
                ? digest(raw.timeline)
                : raw.timeline.sha256,
            localIntegrity: integrity ?? null,
            nativeExitSHA256: Buffer.isBuffer(raw.nativeExit)
                ? digest(raw.nativeExit)
                : raw.nativeExit.sha256,
            policyQualified: false,
            observation: observationOutcome({
                ownershipComplete,
                complete: true,
                receipt: receipt[0],
            }),
        };
    } catch (error) {
        return {
            valid: false,
            ownershipComplete,
            receipt: receiptValue ?? null,
            localIntegrity: integrity ?? null,
            error: String(error).slice(0, 4096),
            observation: observationOutcome({
                ownershipComplete,
                complete: false,
                failure: integrity?.workFailure ?? receiptValue?.failure ?? String(error),
                receipt: receiptValue,
            }),
        };
    }
}
