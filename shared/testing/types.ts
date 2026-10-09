export const PROFILE_BYTES = 128 * 1024;
export const INVENTORY_BYTES = 2 * 1024 * 1024;
export const CASE_BYTES = 64 * 1024;
export const RUN_BYTES = 4 * 1024 * 1024;
export const REPORT_BYTES = 16 * 1024 * 1024;
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;
export const DOMAINS = [
    'led',
    'uart',
    'i2c',
    'gpio',
    'spi',
    'pcie',
    'lan',
    'wlan',
    'hdmi',
    'watchdog',
] as const;
export type Domain = (typeof DOMAINS)[number];
export type Verdict = 'Pass' | 'Fail' | 'Blocked' | 'Skipped' | 'Inconclusive';
export type AdapterId = 'led.pattern' | 'uart.loopback' | 'i2c.identity';
export interface Resource {
    id: string;
    domain: Domain;
    name: string;
    path: string;
    ofNode: string;
    controller: string;
    identity: string;
    address: number | null;
    console: boolean;
    writable: boolean;
    metadata: Record<string, string>;
}
export interface DtNode {
    path: string;
    properties: Record<string, string>;
}
export interface Inventory {
    schemaVersion: 1;
    id: string;
    mode: 'ssh' | 'simulated';
    capturedAt: string;
    endpoint: string;
    username: string;
    complete: boolean;
    issues: string[];
    device: {
        model: string;
        compatible: string[];
        kernel: string;
        firmware: string;
        serial: string;
        bootId: string;
    };
    capabilities: { python3: boolean; i2cget: boolean; timeout: boolean };
    nodes: DtNode[];
    resources: Resource[];
}
export interface Selector {
    path?: string;
    ofNode?: string;
    name?: string;
    identity?: string;
    controller?: string;
    address?: number;
}
export interface LogicalResource {
    id: string;
    domain: Domain;
    selector: Selector;
}
export interface BoardTest {
    id: string;
    name: string;
    adapter: AdapterId;
    resource: string;
    required: boolean;
    fixture: string;
    expected: string;
    parameters: Record<string, number | string | null>;
}
export interface BoardProfile {
    schemaVersion: 1;
    id: string;
    revision: string;
    name: string;
    boardRevision: string;
    match: { model: string; compatible: string; manual: boolean };
    resources: LogicalResource[];
    tests: BoardTest[];
    sequences: { id: string; name: string; tests: string[]; stopOnFailure: boolean }[];
}
export interface PreparedCase {
    test: BoardTest;
    resource: Resource | null;
    problems: string[];
    effects: string;
}
export interface TestPlan {
    profile: BoardProfile;
    profileDigest: string;
    inventory: Inventory;
    cases: PreparedCase[];
}
export interface Readiness {
    reviewed: boolean;
    fixtures: Record<string, { ready: boolean; identity: string }>;
}
export interface StartTests {
    profile: BoardProfile;
    inventoryId: string;
    testIds: string[];
    sequence: string;
    readiness: Readiness;
}
export interface Evidence {
    execution: 'ok' | 'mismatch' | 'blocked' | 'interrupted' | 'error' | 'skipped';
    reason: string;
    measured: string | number | null;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    truncated: boolean;
    cleanup: 'verified' | 'unverified' | 'not-needed';
    cleanupDetail: string;
}
export interface CaseResult {
    test: BoardTest;
    adapterVersion: string;
    resource: Resource | null;
    status: 'pending' | 'running' | 'done';
    verdict: Verdict;
    reason: string;
    startedAt: string;
    finishedAt: string;
    evidence: Evidence | null;
    feedback: { value: 'yes' | 'no' | 'unobserved'; at: string } | null;
}
export interface TestRun {
    id: string;
    mode: 'ssh' | 'simulated';
    phase: 'preparing' | 'running' | 'cleaning' | 'review' | 'complete' | 'cancelled';
    startedAt: string;
    finishedAt: string;
    interruption: string;
    profile: BoardProfile;
    profileDigest: string;
    inventory: Inventory;
    sequence: string;
    readiness: Readiness;
    cases: CaseResult[];
    verdict: Verdict;
}
export interface TestReport {
    format: 'diagnostic-hub-test-report';
    schemaVersion: 1;
    applicationVersion: string;
    generatedAt: string;
    imported: boolean;
    run: TestRun;
}
export type ReportFormat = 'json' | 'html' | 'pdf';
export interface TestingTransport {
    clearTests?(): Promise<void>;
    discoverTests(): Promise<Inventory>;
    prepareTests(profile: BoardProfile): Promise<TestPlan>;
    startTests(request: StartTests): Promise<TestRun>;
    readTestRun(): Promise<TestRun | null>;
    cancelTests(id: string): Promise<TestRun>;
    confirmTest(request: {
        runId: string;
        testId: string;
        value: 'yes' | 'no' | 'unobserved';
    }): Promise<TestRun>;
}
export const activeRun = (run: TestRun | null) =>
    Boolean(run && ['preparing', 'running', 'cleaning'].includes(run.phase));
