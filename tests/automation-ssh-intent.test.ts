import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePlan, type AutomationPlan } from '../shared/automation';

type Mode = 'independent-script' | 'console';
const plan = (mode: Mode): AutomationPlan => ({
    transport: 'ssh',
    ssh:
        mode === 'console'
            ? {
                  mode,
                  ready: { role: 'shell-prompt', literals: ['fixture# '] },
                  completion: { role: 'shell-prompt', literals: ['fixture# '] },
              }
            : { mode },
    steps: [
        {
            id: 'disabled',
            name: 'Disabled blank draft',
            enabled: false,
            command: '',
            delaySeconds: 0,
            ssh: { intent: 'script' },
        },
        {
            id: 'enabled',
            name: 'Enabled inert fixture',
            enabled: true,
            command: 'echo fixture',
            delaySeconds: 0,
            ssh: { intent: 'script' },
        },
    ],
    timeoutSeconds: 60,
    repeatSeconds: null,
    start: null,
    serial: { lineEnding: 'LF', prompt: '# ', timestampPrefix: '' },
});
function accepted(value: AutomationPlan) {
    const before = structuredClone(value);
    const result = validatePlan(value);
    assert.deepEqual(result, before);
    assert.deepEqual(value, before);
    assert.notEqual(result, value);
    return result;
}
function refused(value: AutomationPlan, pattern: RegExp) {
    const before = structuredClone(value);
    assert.throws(() => validatePlan(value), pattern);
    assert.deepEqual(value, before);
}

for (const mode of ['independent-script', 'console'] as const) {
    test(mode + ': disabled blank intent is always a canonical enum', () => {
        const invalid: [string, unknown][] = [
            ['missing value', undefined],
            ['null', null],
            ['number', 0],
            ['boolean', false],
            ['empty string', ''],
            ['whitespace', ' '],
            ['unknown enum', 'shell'],
            ['case variant', 'SCRIPT'],
            ['oversized string', 'x'.repeat(1024 * 1024)],
            ['object', {}],
            ['nested object', { nested: { text: 'x'.repeat(1024) } }],
            ['array', []],
        ];
        for (const [label, intent] of invalid) {
            const value = plan(mode);
            value.steps[0].ssh = { intent: intent as never };
            const before = structuredClone(value);
            assert.throws(
                () => validatePlan(value),
                /Step 1: SSH input intent must be Script or Send Enter/,
                label,
            );
            assert.deepEqual(value, before);
        }
        const missing = plan(mode);
        missing.steps[0].ssh = {} as never;
        refused(missing, /SSH input intent must be Script or Send Enter/);
    });

    test(mode + ': disabled empty and whitespace Script drafts remain accepted', () => {
        for (const command of ['', ' \t\n']) {
            const value = plan(mode);
            value.steps[0].command = command;
            assert.equal(accepted(value).steps[0].command, command);
        }
    });

    test(mode + ': disabled nonblank Script remains accepted without execution', () => {
        const value = plan(mode);
        value.steps[0].command = 'never executed fixture';
        assert.equal(accepted(value).steps[0].ssh?.intent, 'script');
    });

    test(mode + ': enabled blank Script remains invalid', () => {
        for (const command of ['', ' \t\n']) {
            const value = plan(mode);
            value.steps[0].enabled = true;
            value.steps[0].command = command;
            refused(value, /Script requires/);
        }
    });
}

test('absent per-step SSH metadata stays optional only for independent scripts', () => {
    const independent = plan('independent-script');
    delete independent.steps[0].ssh;
    assert.equal(accepted(independent).steps[0].ssh, undefined);
    const legacy = plan('independent-script');
    delete legacy.ssh;
    delete legacy.steps[0].ssh;
    delete legacy.steps[1].ssh;
    assert.equal(accepted(legacy).ssh, undefined);
    const consolePlan = plan('console');
    delete consolePlan.steps[0].ssh;
    refused(consolePlan, /choose an explicit Script or Send Enter intent/);
});

test('console Send Enter with an exactly empty command stays valid enabled or disabled', () => {
    for (const enabled of [false, true]) {
        const value = plan('console');
        value.steps[0].enabled = enabled;
        value.steps[0].ssh = { intent: 'send-enter' };
        assert.equal(accepted(value).steps[0].ssh?.intent, 'send-enter');
    }
});

test('independent Send Enter remains invalid even when its empty step is disabled', () => {
    for (const enabled of [false, true]) {
        const value = plan('independent-script');
        value.steps[0].enabled = enabled;
        value.steps[0].ssh = { intent: 'send-enter' };
        refused(value, /Send Enter requires console mode/);
    }
});

test('console Send Enter still requires an exactly empty command regardless of enablement', () => {
    for (const enabled of [false, true]) {
        for (const command of [' ', 'fixture']) {
            const value = plan('console');
            value.steps[0].enabled = enabled;
            value.steps[0].command = command;
            value.steps[0].ssh = { intent: 'send-enter' };
            refused(value, /Send Enter requires console mode and no script text/);
        }
    }
});
