import type { AutomationPlan } from '../../shared/automation';
import type { ConsoleCompletion } from '../../shared/ssh-console';
import type { FlowInput } from '../../src/features/automation/flow/types';

export interface CompletionFixture {
    name: string;
    input: FlowInput;
    criteria: (ConsoleCompletion | null)[];
}
const defaults: ConsoleCompletion = {
    role: 'shell-prompt',
    literals: ['DEFAULT_COMPLETION_ONE#', 'DEFAULT_COMPLETION_TWO:/#'],
};
const shell: ConsoleCompletion = {
    role: 'shell-prompt',
    literals: ['OVERRIDE_SHELL_ONE>', 'OVERRIDE_SHELL_TWO#'],
};
const intermediate: ConsoleCompletion = {
    role: 'intermediate-input-prompt',
    literals: ['DISTINCT_STEP_COMPLETION_MARKER?', 'Confirm explicit input?'],
};
const long: ConsoleCompletion = {
    role: 'intermediate-input-prompt',
    literals: Array.from(
        { length: 8 },
        (_, i) => `LONG_${i}_` + 'W'.repeat(170) + '<&>"\\ 日本語 👩‍💻\ufffe\uffff\u202e_END',
    ),
};
function plan(criteria: (ConsoleCompletion | null)[]): AutomationPlan {
    return {
        transport: 'ssh',
        ssh: {
            mode: 'console',
            ready: { role: 'shell-prompt', literals: ['INITIAL_READY_ONLY#'] },
            completion: structuredClone(defaults),
        },
        steps: criteria.map((completion, i) => ({
            id: `step-${i + 1}`,
            name: `${i % 2 ? 'Enter' : 'Script'} field ${i + 1} <&> 日本語`,
            enabled: true,
            command: i % 2 ? '' : `printf 'SCRIPT_${i + 1} <&> 日本語\ufffe'\nsecond line`,
            delaySeconds: i + 1,
            ssh: {
                intent: i % 2 ? 'send-enter' : 'script',
                ...(completion ? { completion: structuredClone(completion) } : {}),
            },
        })),
        timeoutSeconds: 60,
        repeatSeconds: 9,
        start: null,
        serial: { lineEnding: 'CR', prompt: 'SERIAL_COMPLETION#', timestampPrefix: '' },
    };
}
const input = (draft: AutomationPlan): FlowInput => ({
    draft,
    active: null,
    busy: false,
    state: { state: 'idle', message: 'Ready' },
    evidence: [],
});

/** Explicit expected criteria are independent of the exporter's reconstructed appendix. */
export function completionFixtures(): CompletionFixture[] {
    const active = input(plan([shell, intermediate]));
    active.active = { id: 'frozen-criterion-generation', plan: structuredClone(active.draft) };
    active.busy = true;
    active.state = { state: 'waiting', message: 'Waiting for owned console' };
    active.evidence = [
        {
            ordinal: 1,
            runId: 'recorded-generation',
            completion: 'prompt-observed',
            exitCode: null,
            uncertain: false,
        },
    ];
    active.draft.ssh!.completion = { role: 'shell-prompt', literals: ['NEXT_DRAFT_ONLY#'] };
    active.draft.steps[0].ssh!.completion = {
        role: 'shell-prompt',
        literals: ['NEXT_STEP_ONLY#'],
    };
    const independent = plan([null]);
    independent.ssh = { mode: 'independent-script' };
    independent.steps[0].ssh = { intent: 'script' };
    const swapped = plan([intermediate, shell]);
    swapped.steps[1].enabled = false;
    const serial = plan([null, null]);
    serial.transport = 'serial';
    serial.ssh = undefined;
    serial.steps.forEach((step, i) => {
        step.ssh = undefined;
        step.enterOnly = Boolean(i % 2);
    });
    return [
        {
            name: 'inherited Script and Enter',
            input: input(plan([null, null])),
            criteria: [defaults, defaults],
        },
        {
            name: 'shell Script and intermediate Enter overrides',
            input: input(plan([shell, intermediate])),
            criteria: [shell, intermediate],
        },
        {
            name: 'intermediate Script and shell Enter overrides',
            input: input(swapped),
            criteria: [intermediate, shell],
        },
        {
            name: 'long escaped alternatives for Script and Enter',
            input: input(plan([long, long])),
            criteria: [long, long],
        },
        {
            name: 'active frozen criteria survive draft changes',
            input: active,
            criteria: [shell, intermediate],
        },
        {
            name: 'independent SSH has no console criterion',
            input: input(independent),
            criteria: [null],
        },
        {
            name: 'Serial Script and Enter retain global completion',
            input: input(serial),
            criteria: [null, null],
        },
    ];
}
