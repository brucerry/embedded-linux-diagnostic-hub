/** A workload refusal may coexist with positive footer/fsync/close proof. Never absorb an I/O or closure failure. */
export async function finishObservationTimeline(timeline, owner) {
    try {
        return await timeline.finish();
    } catch (error) {
        const closure = timeline.closureProof();
        if (error === timeline.workFailure && timeline.workFailure && closure.complete)
            return { complete: false, workFailure: String(error), closure };
        owner.hold(error);
        throw error;
    }
}
