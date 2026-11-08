import type { AutomationPlan, Completion } from '../../../../shared/automation';
import type { FlowState } from '../runner';

export interface FlowEvidence {
    ordinal: number;
    runId: string;
    completion: Completion;
    exitCode: number | null;
    uncertain: boolean;
}
export interface ActiveFlow {
    id: string;
    plan: AutomationPlan;
}
export interface FlowInput {
    draft: AutomationPlan;
    draftTiming?: string;
    active: ActiveFlow | null;
    busy: boolean;
    state: FlowState;
    evidence: readonly FlowEvidence[];
}
export interface FlowNode {
    id: string;
    ordinal: number;
    name: string;
    command: string;
    enabled: boolean;
    intent: string;
    criterion?: string;
    delay: string;
    status: string;
}
export interface FlowSnapshot {
    identity: string;
    kind: 'Draft' | 'Active snapshot';
    capturedAt: string;
    summary: string;
    timing: string;
    completion: string;
    nodes: readonly FlowNode[];
}
export interface Point {
    x: number;
    y: number;
}
export type Positions = Record<string, Point>;
export interface SceneNode extends FlowNode, Point {}
export interface SceneEdge {
    from: string;
    to: string;
    points: [Point, Point, Point, Point];
}
export interface Scene {
    snapshot: FlowSnapshot;
    width: number;
    height: number;
    graphHeight: number;
    nodes: SceneNode[];
    edges: SceneEdge[];
    details: string[];
    text?: { header: TextRun[]; cards: TextRun[]; details: TextRun[] };
}
export interface TextRun {
    text: string;
    x: number;
    y: number;
    size: number;
    tone: 'ink' | 'muted' | 'edge';
    role: string;
    ordinal?: number;
    bounds: { x: number; y: number; width: number; height: number };
}
export interface FlowExportResult {
    blob: Blob;
    width: number;
    height: number;
}
export type FlowExportFormat = 'svg' | 'png' | 'pdf';
