/** Raw collection never selects memory thresholds or grants a memory pass. */
export function observationOutcome({
    ownershipComplete,
    durable = true,
    complete,
    failure,
    receipt,
}) {
    if (!durable || !ownershipComplete)
        return { status: 'INVALID_UNKNOWN_CLOSURE_OR_DURABILITY', memoryQualified: false };
    const reason = String(failure ?? receipt?.failure ?? '');
    const requirementsMet =
        receipt?.achievedWarmupMs >= 300000 &&
        receipt?.achievedMeasuredMs >= 1500000 &&
        receipt?.cycles >= 100 &&
        Array.isArray(receipt?.missing) &&
        receipt.missing.length === 0;
    if (
        complete &&
        !reason &&
        requirementsMet &&
        receipt?.status === 'collected-product-calibration-evidence'
    )
        return { status: 'COMPLETE_RAW_OBSERVATION', memoryQualified: false };
    if (
        /Soak lifetime budget:|Soak physical |pre-write bound|[Dd]eadline|QualificationBlocked|unsupported|unqualified/i.test(
            reason,
        ) ||
        (!requirementsMet && receipt?.failure == null)
    )
        return { status: 'INCOMPLETE_UNQUALIFIED_OBSERVATION', memoryQualified: false };
    return { status: 'PRODUCT_OWNERSHIP_INTEGRITY_FAILURE', memoryQualified: false };
}
