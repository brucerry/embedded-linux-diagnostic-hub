import assert from 'node:assert/strict';
import {
    startupIdentityDecoder,
    startupIdentityStages,
    identityManifestStage,
    identityPartStage,
    identityReportLimits,
    identityFrameCharge,
} from './startup-identity-report.mjs';

/** Exact production parent receiver: validate, durably append, then grant one ACK. */
export function pilotEvidenceReceiver({
    nonce,
    bindingSHA256,
    stage,
    state,
    record,
    reserve,
    recordReserved,
    send,
    hold,
    clock,
}) {
    let failed,
        reservedRows = 0,
        rows = 0;
    const identities = startupIdentityDecoder({
        reserve: (budget) => {
            assert(rows + budget.rows <= identityReportLimits.rows, 'Parent stage diagnostic rows');
            reserve(budget.chargedBytes);
            reservedRows = budget.rows;
        },
    });
    return {
        receive(message) {
            try {
                if (failed) throw failed;
                assert(message && typeof message === 'object' && !Array.isArray(message));
                assert.deepEqual(
                    Object.keys(message).sort(),
                    ['kind', 'nonce', 'bindingSHA256', 'sequence', 'stage', 'data'].sort(),
                    'Pilot evidence schema',
                );
                assert(
                    message.kind === 'pilot-evidence' &&
                        message.nonce === nonce &&
                        message.bindingSHA256 === bindingSHA256,
                    'Pilot evidence binding',
                );
                assert(
                    Number.isSafeInteger(message.sequence) && message.sequence === state.sequence,
                    'Pilot evidence sequence',
                );
                assert(
                    Buffer.byteLength(JSON.stringify(message)) <= 65536,
                    'Complete pilot frame bound',
                );
                assert(
                    typeof message.stage === 'string' && message.stage.length <= 128,
                    'Pilot evidence stage',
                );
                assert(!state.final, 'Evidence after stage final');
                const multipart =
                    message.stage === identityManifestStage || message.stage === identityPartStage;
                if (multipart) {
                    identities.accept(message.stage, message.data);
                    assert(reservedRows > 0, 'Unreserved identity frame');
                    // The plan includes full wire/journal overhead and original logical bytes.
                    assert(
                        identityFrameCharge(message.stage, message.data) <=
                            identityReportLimits.frameBytes,
                    );
                    recordReserved(stage + ':' + message.stage, message.data);
                    reservedRows--;
                } else {
                    identities.assertComplete();
                    assert(
                        !startupIdentityStages.includes(message.stage),
                        'Identity must use lossless bounded reporting',
                    );
                    assert(
                        rows + reservedRows < identityReportLimits.rows,
                        'Parent stage diagnostic rows',
                    );
                    record(stage + ':' + message.stage, message.data);
                }
                state.sequence++;
                rows++;
                if (message.stage === 'runtime-ready') {
                    assert(
                        clock() < state.runtimeDeadline,
                        'Late runtime readiness cannot reopen admission',
                    );
                    state.runtimeReady = true;
                }
                if (message.stage === 'stage-held')
                    hold(message.data.reason ?? 'Stage startup held');
                if (message.stage === 'stage-final') {
                    identities.assertComplete();
                    assert(reservedRows === 0);
                    state.final = message.data;
                }
                send(
                    { kind: 'pilot-durable-ack', nonce, bindingSHA256, sequence: message.sequence },
                    (error) => {
                        if (error) hold(error);
                    },
                );
                return true;
            } catch (error) {
                failed ??= error;
                hold(error);
                return false;
            }
        },
        assertComplete() {
            if (failed) throw failed;
            identities.assertComplete();
            assert(reservedRows === 0);
        },
    };
}
