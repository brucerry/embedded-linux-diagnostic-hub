// Verbatim runner-state callback; memory state setters are injected, not React-mounted.
import { inspectionState, type FlowInspection } from '../../src/features/automation/flow/inspection';
import type { FlowState } from '../../src/features/automation/runner';
export function bindPageRunnerChanged(context: {
    flowInspectionId: { current: string | null };
    latest: { current: { onBusy(value: boolean): void } };
    setState(value: FlowState): void;
    setFlowInspection(value: FlowInspection | null | ((current: FlowInspection | null) => FlowInspection | null)): void;
    setRunning(value: boolean): void;
}) {
    const { flowInspectionId, latest, setState, setFlowInspection, setRunning } = context;
    const callbacks: ((next: FlowState) => void)[] = [
            (next) => {
                const inspected = flowInspectionId.current;
                setState(next);
                setFlowInspection((current) => inspectionState(current, inspected, next));
                const active =
                    Boolean(next.cleanupPending) ||
                    ['waiting', 'running', 'delaying'].includes(next.state);
                setRunning(active);
                latest.current.onBusy(active);
            },
    ];
    return callbacks[0];
}
