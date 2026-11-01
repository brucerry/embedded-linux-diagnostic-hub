import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePlan, type AutomationPlan } from '../shared/automation';
import {
    MAX_SERIALIZED_PLAN_BYTES,
    snapshot,
} from '../src/features/automation/flow/model.ts';

type Mode = 'independent-script' | 'console';
type FlowInput = Parameters<typeof snapshot>[0];
const capturedAt = '2026-10-28T00:00:00.000Z';
const bytes = (text: string) => new TextEncoder().encode(text).length;
const modes = ['independent-script', 'console'] as const;
const intentError = /Step 1: SSH input intent must be Script or Send Enter/;

const plan = (mode: Mode, commands = ['fixture command']): AutomationPlan => ({
    transport: 'ssh',
    ssh:
        mode === 'console'
            ? {
                  mode,
                  ready: { role: 'shell-prompt', literals: ['fixture# '] },
                  completion: { role: 'shell-prompt', literals: ['fixture# '] },
              }
            : { mode },
    steps: commands.map((command, index) => ({
        id: 'step-' + index,
        name: 'Step ' + (index + 1),
        enabled: true,
        command,
        delaySeconds: 0,
        ssh: { intent: 'script' },
    })),
    timeoutSeconds: 60,
    repeatSeconds: null,
    start: null,
    serial: { lineEnding: 'LF', prompt: '# ', timestampPrefix: '' },
});

const flowInput = (draft: AutomationPlan): FlowInput => ({
    draft,
    active: null,
    busy: false,
    state: { state: 'idle', message: 'Ready' },
    evidence: [],
});

// Deliberate test composition, NOT a new production viewer gate or copied validator logic.
function validatedSnapshot(value: AutomationPlan, trace: string[]) {
    const validated = validatePlan(value);
    trace.push('snapshot');
    return { validated, view: snapshot(flowInput(validated), false, capturedAt) };
}

function accepted(value: AutomationPlan) {
    const before = structuredClone(value);
    const trace: string[] = [];
    const result = validatedSnapshot(value, trace);
    assert.deepEqual(trace, ['snapshot']);
    assert.deepEqual(result.validated, before);
    assert.notEqual(result.validated, value);
    assert.notEqual(result.validated.steps, value.steps);
    assert.notEqual(result.validated.steps[0], value.steps[0]);
    assert.deepEqual(value, before);
    assert.deepEqual(
        result.view.nodes.map((node) => node.command),
        before.steps.map((step) => step.command),
    );
    assert.deepEqual(
        result.view.nodes.map((node) => node.enabled),
        before.steps.map((step) => step.enabled),
    );
    assert.equal(result.view.kind, 'Draft');
    assert.equal(result.view.capturedAt, capturedAt);
    return result;
}

function refusedBeforeSnapshot(value: AutomationPlan, pattern: RegExp) {
    const before = structuredClone(value);
    const trace: string[] = [];
    assert.throws(() => validatedSnapshot(value, trace), pattern);
    assert.deepEqual(trace, [], 'the ordered test composition must not enter snapshot');
    assert.deepEqual(value, before);
}

function rawBudget(value: AutomationPlan, total: number) {
    assert.ok(value.steps.every((step) => bytes(step.command) <= 8192));
    assert.equal(
        value.steps.reduce((sum, step) => sum + bytes(step.command), 0),
        total,
    );
    assert.ok(total <= 65536);
}

function withDisabledDraft(mode: Mode, command = '') {
    const value = plan(mode, [command, 'enabled fixture']);
    value.steps[0].enabled = false;
    return value;
}

for (const mode of modes) {
    test(mode + ': actual validator output at 64 KiB ASCII builds a snapshot', () => {
        const value = plan(mode, Array(8).fill('x'.repeat(8192)));
        rawBudget(value, 65536);
        assert.ok(bytes(JSON.stringify(value)) > 65536);
        assert.equal(accepted(value).view.nodes.length, 8);
    });

    test(mode + ': exact 64 KiB escaped controls survive validation and snapshot', () => {
        // Non-NUL control data is inert; nothing invokes a shell or transport.
        const value = plan(mode, Array(8).fill('\u0001'.repeat(8192)));
        rawBudget(value, 65536);
        assert.ok(bytes(JSON.stringify(value)) > 6 * 65536);
        assert.ok(bytes(JSON.stringify(value)) < MAX_SERIALIZED_PLAN_BYTES);
        assert.equal(accepted(value).view.nodes[0].command, '\u0001'.repeat(8192));
    });

    test(mode + ': 2-byte and 4-byte UTF-8 exact boundaries remain byte-preserving', () => {
        for (const command of ['é'.repeat(4096), '😀'.repeat(2048)]) {
            const value = plan(mode, Array(8).fill(command));
            rawBudget(value, 65536);
            assert.equal(accepted(value).view.nodes[7].command, command);
        }
    });

    test(mode + ': malformed disabled-blank intent is refused before snapshot', () => {
        const invalid: unknown[] = [
            undefined,
            null,
            0,
            false,
            '',
            ' ',
            'shell',
            'SCRIPT',
            'x'.repeat(MAX_SERIALIZED_PLAN_BYTES),
            {},
            { nested: { text: 'x'.repeat(1024) } },
            [],
        ];
        for (const intent of invalid) {
            const value = withDisabledDraft(mode);
            value.steps[0].ssh = { intent: intent as never };
            refusedBeforeSnapshot(value, intentError);
        }
        const missing = withDisabledDraft(mode);
        missing.steps[0].ssh = {} as never;
        refusedBeforeSnapshot(missing, intentError);
    });

    test(mode + ': missing, undefined and null intent never inherit Script defaults', () => {
        for (const [enabled, command] of [
            [false, 'nonblank disabled fixture'],
            [true, ''],
            [true, 'nonblank enabled fixture'],
        ] as const) {
            for (const form of ['missing', 'undefined', 'null'] as const) {
                const value = withDisabledDraft(mode, command);
                value.steps[0].enabled = enabled;
                value.steps[0].ssh =
                    form === 'missing'
                        ? ({} as never)
                        : { intent: (form === 'null' ? null : undefined) as never };
                refusedBeforeSnapshot(value, intentError);
            }
        }
    });

    test(mode + ': disabled empty, whitespace and nonblank Script drafts stay inspectable', () => {
        for (const command of ['', ' \t\n', 'disabled fixture']) {
            const result = accepted(withDisabledDraft(mode, command));
            assert.equal(result.view.nodes[0].command, command);
            assert.equal(result.view.nodes[0].status, 'Disabled · skipped');
        }
    });

    test(mode + ': enabled blank Script is refused before snapshot', () => {
        for (const command of ['', ' \t\n']) {
            refusedBeforeSnapshot(plan(mode, [command]), /Script requires/);
        }
    });

    test(mode + ': 8193-byte and 65537-byte payloads retain both raw guards', () => {
        const invalid = [
            plan(mode, ['x'.repeat(8193)]),
            plan(mode, ['é'.repeat(4096) + 'x']),
            plan(mode, ['😀'.repeat(2048) + 'x']),
            plan(mode, [...Array(8).fill('x'.repeat(8192)), 'x']),
        ];
        for (const value of invalid) {
            assert.ok(bytes(JSON.stringify(value)) < MAX_SERIALIZED_PLAN_BYTES);
            refusedBeforeSnapshot(value, /Script requires|total must not exceed 64 KiB/);
            const input = flowInput(value);
            const before = structuredClone(input);
            assert.throws(() => snapshot(input, false, capturedAt), /oversized commands/);
            assert.deepEqual(input, before);
        }
    });
}

test('20-step high-expansion canonical console metadata and max raw bytes compose', () => {
    const value = plan(
        'console',
        Array.from({ length: 20 }, (_, index) => '\u0001'.repeat(index === 19 ? 3292 : 3276)),
    );
    const criterion = () => ({
        role: 'shell-prompt' as const,
        literals: Array.from({ length: 8 }, (_, index) => '\ud800'.repeat(255) + index),
    });
    value.ssh = { mode: 'console', ready: criterion(), completion: criterion() };
    value.serial = {
        lineEnding: 'LF',
        prompt: '\ud800'.repeat(256),
        timestampPrefix: '\ud800'.repeat(128),
    };
    value.steps.forEach((step, index) => {
        step.id = String(index).padEnd(128, '\u0001');
        step.name = '\u0001'.repeat(120);
        step.ssh = { intent: 'script', completion: criterion() };
    });
    rawBudget(value, 65536);
    assert.ok(bytes(JSON.stringify(value)) > 6 * 65536);
    assert.ok(bytes(JSON.stringify(value)) < MAX_SERIALIZED_PLAN_BYTES);
    const result = accepted(value);
    assert.equal(result.view.nodes.length, 20);
    assert.ok(result.view.nodes.every((node) => node.criterion?.includes('Completion criterion:')));
});

test('legacy independent metadata omission is preserved; console omission is refused', () => {
    const value = withDisabledDraft('independent-script');
    delete value.ssh;
    for (const step of value.steps) delete step.ssh;
    assert.equal(accepted(value).validated.ssh, undefined);
    const consolePlan = withDisabledDraft('console');
    delete consolePlan.steps[0].ssh;
    refusedBeforeSnapshot(consolePlan, /choose an explicit Script or Send Enter intent/);
});

test('console Send Enter stays exactly empty and correctly labelled enabled or disabled', () => {
    for (const enabled of [false, true]) {
        const value = withDisabledDraft('console');
        value.steps[0].enabled = enabled;
        value.steps[0].ssh = { intent: 'send-enter' };
        const result = accepted(value);
        assert.equal(result.view.nodes[0].command, '');
        assert.equal(result.view.nodes[0].intent, 'Send Enter (exact CR)');
    }
});

test('Send Enter mode and exact-empty restrictions are refused before snapshot', () => {
    for (const enabled of [false, true]) {
        const independent = withDisabledDraft('independent-script');
        independent.steps[0].enabled = enabled;
        independent.steps[0].ssh = { intent: 'send-enter' };
        refusedBeforeSnapshot(independent, /Send Enter requires console mode/);
        for (const command of [' ', 'nonempty fixture']) {
            const value = withDisabledDraft('console', command);
            value.steps[0].enabled = enabled;
            value.steps[0].ssh = { intent: 'send-enter' };
            refusedBeforeSnapshot(value, /Send Enter requires console mode and no script text/);
        }
    }
});

test('validated frozen max plan stays inspectable beside an oversized next-run draft', () => {
    const source = plan('console', Array(8).fill('é'.repeat(4096)));
    const sourceBefore = structuredClone(source);
    const validated = validatePlan(source);
    rawBudget(validated, 65536);
    assert.deepEqual(validated, sourceBefore);
    assert.notEqual(validated, source);
    const input = flowInput(plan('console', ['x'.repeat(MAX_SERIALIZED_PLAN_BYTES + 1)]));
    input.active = { id: 'validated-frozen-fixture', plan: validated };
    const before = structuredClone(input);
    const result = snapshot(input, true, capturedAt);
    assert.equal(result.kind, 'Active snapshot');
    assert.equal(result.identity, 'validated-frozen-fixture');
    assert.deepEqual(result.nodes.map((node) => node.command), source.steps.map((s) => s.command));
    assert.deepEqual(input, before);
    assert.deepEqual(source, sourceBefore);
});

test('separate 1 MiB viewer cap still rejects oversized invalid draft metadata', () => {
    const value = plan('independent-script');
    value.serial.timestampPrefix = 'x'.repeat(MAX_SERIALIZED_PLAN_BYTES);
    refusedBeforeSnapshot(value, /Serial: invalid line ending or timestamp prefix/);
    // Viewer inspection is intentionally separate from execution validation for unarmed drafts.
    const input = flowInput(value);
    const before = structuredClone(input);
    assert.ok(bytes(JSON.stringify(value)) > MAX_SERIALIZED_PLAN_BYTES);
    assert.throws(() => snapshot(input, false, capturedAt), /1 MiB serialized plan limit/);
    assert.deepEqual(input, before);
});
