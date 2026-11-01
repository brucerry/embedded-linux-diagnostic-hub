import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MAX_SERIALIZED_PLAN_BYTES,
    snapshot,
} from '../src/features/automation/flow/model.ts';
import type { FlowInput } from '../src/features/automation/flow/types';

const bytes = (text: string) => new TextEncoder().encode(text).length;
const input = (commands = ['echo fixture']): FlowInput => ({
    draft: {
        transport: 'ssh',
        steps: commands.map((command, index) => ({
            id: 'step-' + index,
            name: 'Step ' + (index + 1),
            enabled: true,
            command,
            delaySeconds: 0,
        })),
        timeoutSeconds: 60,
        repeatSeconds: null,
        start: null,
        serial: { lineEnding: 'LF', prompt: '# ', timestampPrefix: '' },
    },
    active: null,
    busy: false,
    state: { state: 'idle', message: 'Ready' },
    evidence: [],
});
// Independently assert the raw-command contract, not a substitute for validatePlan/armPlan.
function rawBudget(value: FlowInput, expectedTotal: number) {
    assert.ok(value.draft.steps.every((step) => bytes(step.command) <= 8192));
    assert.equal(
        value.draft.steps.reduce((total, step) => total + bytes(step.command), 0),
        expectedTotal,
    );
    assert.ok(expectedTotal <= 65536);
}
function accepted(value: FlowInput) {
    const before = structuredClone(value);
    const result = snapshot(value, false, '2026-10-28T00:00:00.000Z');
    assert.deepEqual(
        result.nodes.map((node) => node.command),
        value.draft.steps.map((step) => step.command),
    );
    assert.deepEqual(value, before);
    return result;
}
function refused(value: FlowInput, pattern: RegExp) {
    const before = structuredClone(value);
    assert.throws(() => snapshot(value, false), pattern);
    assert.deepEqual(value, before);
}

test('all 64 KiB of raw ASCII commands remain inspectable despite JSON overhead', () => {
    const value = input(Array(8).fill('x'.repeat(8192)));
    rawBudget(value, 65536);
    assert.ok(bytes(JSON.stringify(value.draft)) > 65536);
    assert.equal(accepted(value).nodes.length, 8);
});

test('JSON escaping does not spend the raw command budget or alter exact control bytes', () => {
    // Controls are deliberate inert fixture data, not commands sent to any shell.
    // U+0001 is nonblank and not NUL, satisfying validatePlan's raw text contract.
    const value = input(Array(8).fill('\u0001'.repeat(8192)));
    rawBudget(value, 65536);
    const serialized = bytes(JSON.stringify(value.draft));
    assert.ok(serialized > 6 * 65536);
    assert.ok(serialized < MAX_SERIALIZED_PLAN_BYTES);
    assert.equal(accepted(value).nodes[0].command, '\u0001'.repeat(8192));
});

test('UTF-8 byte accounting accepts exactly 64 KiB of multibyte text', () => {
    const value = input(Array(8).fill('é'.repeat(4096)));
    rawBudget(value, 65536);
    assert.equal(accepted(value).nodes[7].command.length, 4096);
});

test('max raw payload plus bounded console metadata fits the separate envelope budget', () => {
    const value = input(
        Array.from({ length: 20 }, (_, index) =>
            '\u0001'.repeat(index === 19 ? 3292 : 3276),
        ),
    );
    const criterion = () => ({
        role: 'shell-prompt' as const,
        literals: Array.from({ length: 8 }, (_, index) => '\ud800'.repeat(255) + index),
    });
    value.draft.ssh = { mode: 'console', ready: criterion(), completion: criterion() };
    value.draft.serial = {
        lineEnding: 'LF',
        prompt: '\ud800'.repeat(256),
        timestampPrefix: '\ud800'.repeat(128),
    };
    value.draft.steps.forEach((step, index) => {
        step.id = String(index).padEnd(128, '\u0001');
        step.name = '\u0001'.repeat(120);
        step.ssh = { intent: 'script', completion: criterion() };
    });
    rawBudget(value, 65536);
    assert.ok(bytes(JSON.stringify(value.draft)) > 65536);
    assert.ok(bytes(JSON.stringify(value.draft)) < MAX_SERIALIZED_PLAN_BYTES);
    const result = accepted(value);
    assert.equal(result.nodes.length, 20);
    assert.ok(result.nodes.every((node) => node.criterion?.includes('Completion criterion:')));
});

test('raw per-command cap still refuses 8193 bytes, including multibyte input', () => {
    refused(input(['x'.repeat(8193)]), /oversized commands/);
    refused(input(['é'.repeat(4096) + 'x']), /oversized commands/);
});

test('raw aggregate cap still refuses 65537 bytes even below the serialized cap', () => {
    const value = input([...Array(8).fill('x'.repeat(8192)), 'x']);
    assert.ok(bytes(JSON.stringify(value.draft)) < MAX_SERIALIZED_PLAN_BYTES);
    refused(value, /oversized commands/);
});

test('oversized inert metadata is still refused by the explicit serialized cap', () => {
    const value = input();
    // An invalid, unarmed draft stresses the viewer admission cap, not executable-plan validity.
    value.draft.serial.timestampPrefix = 'x'.repeat(MAX_SERIALIZED_PLAN_BYTES);
    assert.ok(bytes(JSON.stringify(value.draft)) > MAX_SERIALIZED_PLAN_BYTES);
    refused(value, /1 MiB serialized plan limit/);
});

test('command count and identity limits are unchanged', () => {
    const empty = input([]);
    refused(empty, /1–20 commands/);
    refused(input(Array(21).fill('x')), /1–20 commands/);
    const duplicate = input(['x', 'y']);
    duplicate.draft.steps[1].id = duplicate.draft.steps[0].id;
    refused(duplicate, /duplicate IDs/);
    const longName = input();
    longName.draft.steps[0].name = 'x'.repeat(121);
    refused(longName, /oversized commands, names/);
});

test('frozen raw-max plan is independent of an oversized next-run draft', () => {
    const value = input(Array(8).fill('x'.repeat(8192)));
    value.active = { id: 'frozen-boundary-fixture', plan: structuredClone(value.draft) };
    value.draft.steps[0].command = 'x'.repeat(MAX_SERIALIZED_PLAN_BYTES + 1);
    const before = structuredClone(value);
    const result = snapshot(value, true, '2026-10-28T00:00:00.000Z');
    assert.equal(result.identity, 'frozen-boundary-fixture');
    assert.equal(result.nodes.length, 8);
    assert.equal(result.nodes[0].command, 'x'.repeat(8192));
    assert.deepEqual(value, before);
});
