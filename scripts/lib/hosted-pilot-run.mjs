import assert from 'node:assert/strict';
import { SameJobPilotCustody } from './hosted-pilot-custody.mjs';
/** Production owner orchestration. Ports expose concrete OS ownership, not trusted no-child booleans. */
export async function runHostedPilot(binding, ports) {
    const owner = new SameJobPilotCustody(binding, ports);
    ports.onOwner?.(owner);
    let failure;
    try {
        const token = await owner.acquireAndVerify();
        for (const stage of ['real-os-pty', 'native-electron-store']) {
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
        owner.check(binding, true);
        const inputsUnchanged = await ports.recheckInputs();
        owner.check(binding, true);
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
