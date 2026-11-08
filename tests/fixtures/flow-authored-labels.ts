import type { FlowInput } from '../../src/features/automation/flow/types';
export const labelStamp = '2026-11-04T00:00:00.000Z';
export const labelPositions = { alpha: { x: 0, y: 0 }, bravo: { x: 380, y: 0 } };
export function authoredLabelInput(): FlowInput {
    const plan = {
        transport: 'ssh' as const,
        steps: [
            {
                id: 'alpha',
                name: 'Alpha & link',
                command: 'printf ALPHA_17',
                enabled: true,
                delaySeconds: 1,
            },
            {
                id: 'bravo',
                name: 'Bravo <skip>',
                command: 'echo BRAVO_29',
                enabled: false,
                delaySeconds: 3,
            },
        ],
        timeoutSeconds: 5,
        repeatSeconds: null,
        start: null,
        serial: { lineEnding: 'CRLF' as const, prompt: '#', timestampPrefix: '' },
    };
    return {
        draft: plan,
        active: { id: 'label-proof', plan },
        busy: false,
        state: { state: 'finished', message: 'Synthetic receipts; not device execution' },
        evidence: [
            {
                ordinal: 1,
                runId: 'proofA01-synthetic',
                completion: 'exit',
                exitCode: 0,
                uncertain: false,
            },
            {
                ordinal: 2,
                runId: 'proofB02-synthetic',
                completion: 'exit',
                exitCode: 9,
                uncertain: false,
            },
        ],
    };
}
export interface AuthoredLabel {
    ordinal: number;
    role: string;
    text: string;
    x: number;
    top: number;
    size: number;
    height: number;
    color: string;
}
// Authored expectations are literals, never copied from generated model/SVG output.
export const authoredLabels: readonly Readonly<AuthoredLabel>[] = Object.freeze(
    [
        {
            ordinal: 1,
            role: 'name',
            text: '1. Alpha & link',
            x: 114,
            top: 228,
            size: 16,
            height: 31,
            color: '#e7edf4',
        },
        {
            ordinal: 1,
            role: 'intent',
            text: 'Enabled · SSH command',
            x: 114,
            top: 259,
            size: 14,
            height: 24,
            color: '#b9c4d2',
        },
        {
            ordinal: 1,
            role: 'preview',
            text: 'printf ALPHA_17',
            x: 114,
            top: 286,
            size: 14,
            height: 25,
            color: '#e7edf4',
        },
        {
            ordinal: 1,
            role: 'delay',
            text: 'Delay 1 s before send',
            x: 114,
            top: 315,
            size: 14,
            height: 25,
            color: '#b9c4d2',
        },
        {
            ordinal: 1,
            role: 'status',
            text: 'Recorded: Exit 0 · run proofA01',
            x: 114,
            top: 346,
            size: 14,
            height: 28,
            color: '#8bb8ff',
        },
        {
            ordinal: 2,
            role: 'name',
            text: '2. Bravo <skip>',
            x: 494,
            top: 228,
            size: 16,
            height: 31,
            color: '#e7edf4',
        },
        {
            ordinal: 2,
            role: 'intent',
            text: 'Disabled · SSH command',
            x: 494,
            top: 259,
            size: 14,
            height: 24,
            color: '#b9c4d2',
        },
        {
            ordinal: 2,
            role: 'preview',
            text: 'echo BRAVO_29',
            x: 494,
            top: 286,
            size: 14,
            height: 25,
            color: '#e7edf4',
        },
        {
            ordinal: 2,
            role: 'delay',
            text: 'Delay 3 s before send',
            x: 494,
            top: 315,
            size: 14,
            height: 25,
            color: '#b9c4d2',
        },
        {
            ordinal: 2,
            role: 'status',
            text: 'Disabled · skipped',
            x: 494,
            top: 346,
            size: 14,
            height: 28,
            color: '#8bb8ff',
        },
    ].map((value) => Object.freeze(value)),
);
export function assertAuthoredLabelEntries(
    entries: { ordinal: number; role: string; text: string }[],
) {
    for (const expected of authoredLabels) {
        const found = entries.filter(
            (value) => value.ordinal === expected.ordinal && value.role === expected.role,
        );
        if (found.length !== 1)
            throw Error(`SVG label ${expected.ordinal}.${expected.role} cardinality`);
        if (found[0].text !== expected.text)
            throw Error(`SVG label ${expected.ordinal}.${expected.role} literal mismatch`);
    }
    if (entries.length !== 10) throw Error('SVG unexpected graph labels');
    return {
        labels: entries.length,
        ordinals: [1, 2],
        roles: ['name', 'intent', 'preview', 'delay', 'status'],
    };
}
