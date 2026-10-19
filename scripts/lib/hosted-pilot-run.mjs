import assert from 'node:assert/strict';
import { SameJobPilotCustody } from './hosted-pilot-custody.mjs';
import { closeEntries } from './product-collector-evidence.mjs';
import { pilotStages } from './hosted-pilot-contract.mjs';
/** Shared production final-receipt/log/process validation, including exceptional waits. */
export async function joinPilotStage(child, { state, startup, cancel, observe }) {
    const logs = closeEntries(state.logs);
    assert.equal(logs.complete, true);
    assert(
        state.final?.startup?.complete === true &&
            state.final.descendantsClosed === true &&
            state.final.leafReceiptsClosed === true,
        'Required stage-final/startup/descendant/leaf closure missing.',
    );
    assert.equal(state.final.stage, state.stage);
    if (state.final.passed !== true) cancel('Owned stage reported failure');
    await startup.joinChild(child);
    observe('post-close');
    return {
        descendantsClosed: true,
        leafReceiptsClosed: true,
        logsClosed: true,
        final: state.final,
    };
}
/** Production owner orchestration. Ports expose concrete OS ownership, not trusted no-child booleans. */
export async function runHostedPilot(binding, ports) {
    const owner = new SameJobPilotCustody(binding, ports);
    ports.onOwner?.(owner);
    let failure;
    try {
        const token = await owner.acquireAndVerify();
        for (const stage of pilotStages(owner.binding)) {
            owner.check();
            await ports.beforeStage(stage);
            owner.check();
            const child = owner.start(stage, token, binding, () => ports.spawnStage(stage, owner));
            await ports.waitStage(child, owner);
            await owner.joinStage((child, b) => ports.joinStage(child, b));
            if (owner.cancelled) break;
        }
    } catch (e) {
        failure = e;
        if (owner.state !== 'held') owner.cancel(e);
    }
    if (owner.state === 'held') throw failure ?? Error('Pilot ownership remains unknown');
    try {
        await owner.prepareCleanup((child, b) => ports.joinStage(child, b));
        const inputsUnchanged = await ports.recheckInputs();
        owner.checkCleanup();
        assert.equal(inputsUnchanged, true, 'Inputs changed before root cleanup.');
        const rootsCleanupClosed = await ports.cleanupRoots();
        ports.record('pilot-result', {
            bindingSHA256: owner.hash,
            passed: !failure && !owner.cancelled,
            reason: String(failure ?? owner.cancelled ?? '').slice(0, 1024),
            collectionApproval: false,
            capacityQualifiedForFullPair: false,
        });
        await owner.release({ inputsUnchanged, rootsCleanupClosed, resultClosed: true });
    } catch (e) {
        owner.hold(e);
        throw e;
    }
    return {
        state: owner.state,
        passed: owner.verdict === 'passed',
        stages: owner.stages,
        collectionApproval: false,
        capacityQualifiedForFullPair: false,
    };
}
