import type { AutomationPlan, AutomationRecord } from '../../../../shared/automation';
import type { FlowState } from '../runner';
import type { ActiveFlow, FlowEvidence } from './types';

export interface FlowInspection {
    active: ActiveFlow;
    state: FlowState;
    evidence: readonly FlowEvidence[];
}
export function prepareInspection(plan: AutomationPlan): FlowInspection {
    return {
        active: { id: crypto.randomUUID(), plan: structuredClone(plan) },
        state: { state: 'waiting', message: 'Preparing flow; awaiting transport ownership.' },
        evidence: [],
    };
}
export function inspectionState(
    current: FlowInspection | null,
    id: string | null,
    state: FlowState,
) {
    return current && current.active.id === id ? { ...current, state: { ...state } } : current;
}
/** Call only after the existing durable result acknowledgement, without changing its return path. */
export function inspectionRecord(
    current: FlowInspection | null,
    id: string | null,
    record: Pick<
        AutomationRecord,
        'ordinal' | 'runId' | 'completion' | 'exitCode' | 'truncated' | 'termination'
    >,
): FlowInspection | null {
    if (!current || current.active.id !== id) return current;
    const evidence =
        current.evidence[0]?.runId === record.runId
            ? current.evidence.filter((item) => item.ordinal !== record.ordinal)
            : [];
    return {
        ...current,
        evidence: [
            ...evidence,
            {
                ordinal: record.ordinal,
                runId: record.runId,
                completion: record.completion,
                exitCode: record.exitCode,
                uncertain:
                    record.truncated ||
                    Boolean(record.termination) ||
                    (record.completion === 'exit' && record.exitCode === null),
            },
        ].slice(-20),
    };
}
