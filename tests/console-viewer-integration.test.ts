import test from 'node:test';
import assert from 'node:assert/strict';
import {
    prepareInspection,
    inspectionState,
    inspectionRecord,
    type FlowInspection,
} from '../src/features/automation/flow/inspection';
import { snapshot, scene, initialPositions } from '../src/features/automation/flow/model';
import type { AutomationPlan } from '../shared/automation';

function plan(): AutomationPlan {
    return {
        transport: 'ssh',
        ssh: {
            mode: 'console',
            ready: { role: 'shell-prompt', literals: ['fixture#'] },
            completion: { role: 'shell-prompt', literals: ['fixture#', 'fixture:/#'] },
        },
        steps: [
            {
                id: 'script',
                name: 'Change directory',
                command: 'cd /',
                enabled: true,
                delaySeconds: 0,
                ssh: { intent: 'script' },
            },
            {
                id: 'enter',
                name: 'Confirm explicit input',
                command: '',
                enabled: true,
                delaySeconds: 0,
                ssh: {
                    intent: 'send-enter',
                    completion: { role: 'intermediate-input-prompt', literals: ['Continue?'] },
                },
            },
        ],
        timeoutSeconds: 60,
        repeatSeconds: null,
        start: null,
        serial: { lineEnding: 'CR', prompt: '', timestampPrefix: '' },
    };
}
test('inspection freezes the normalized Run-once plan before any lease and fences stale generation updates', () => {
    const original = plan(),
        first = prepareInspection(original),
        second = prepareInspection(original);
    original.steps[0].command = 'draft edit';
    original.repeatSeconds = 7;
    assert.equal(first.active.plan.steps[0].command, 'cd /');
    assert.equal(first.active.plan.repeatSeconds, null);
    assert.equal(first.state.state, 'waiting');
    assert.match(first.state.message, /awaiting transport ownership/);
    assert.equal(
        inspectionState(second, first.active.id, { state: 'finished', message: 'old completed' }),
        second,
    );
    assert.equal(
        inspectionRecord(second, first.active.id, {
            ordinal: 1,
            runId: 'old-run',
            completion: 'exit',
            exitCode: 0,
            truncated: false,
        }),
        second,
    );
    const rejected: FlowInspection | null = null;
    assert.equal(
        inspectionState(rejected, second.active.id, { state: 'running', message: 'late lease' }),
        null,
    );
});
test('bounded viewer summaries retain only acknowledged metadata and replace repetitions without output ownership', () => {
    let value: FlowInspection | null = prepareInspection(plan());
    const id = value.active.id;
    for (let ordinal = 1; ordinal <= 30; ordinal++)
        value = inspectionRecord(value, id, {
            ordinal,
            runId: 'first',
            completion: 'prompt-observed',
            exitCode: null,
            truncated: false,
        });
    assert.equal(value!.evidence.length, 20);
    const source = {
        ordinal: 1,
        runId: 'next',
        completion: 'prompt-observed' as const,
        exitCode: null,
        truncated: false,
        stdout: 'private raw output',
        chunks: ['must never copy'],
    };
    value = inspectionRecord(value, id, source);
    assert.deepEqual(value!.evidence, [
        {
            ordinal: 1,
            runId: 'next',
            completion: 'prompt-observed',
            exitCode: null,
            uncertain: false,
        },
    ]);
    assert.ok(!JSON.stringify(value).includes('private raw output'));
    value = inspectionState(value, id, {
        state: 'paused',
        cleanupPending: true,
        message: 'Waiting for actual cleanup.',
    });
    const data = snapshot(
        {
            draft: plan(),
            active: value!.active,
            busy: true,
            state: value!.state,
            evidence: value!.evidence,
        },
        true,
    );
    assert.match(data.summary, /Waiting for actual cleanup/);
    assert.match(data.nodes[0].status, /prompt-observed.*paused/);
});
test('console scene/export details disclose explicit CR, per-step roles and null exits while legacy SSH remains independent', () => {
    const draft = plan(),
        input = {
            draft,
            active: null,
            busy: false,
            state: { state: 'idle' as const, message: 'Ready' },
            evidence: [],
        };
    const data = snapshot(input, false);
    assert.match(data.completion, /combined PTY.*exit status is unavailable/);
    assert.match(data.nodes[0].intent, /Script \+ CR/);
    assert.match(data.nodes[1].intent, /Send Enter.*exact CR/);
    assert.match(data.nodes[1].criterion!, /intermediate-input-prompt.*Continue\?/);
    assert.match(data.nodes[0].criterion!, /fixture:\/#/);
    assert.ok(
        scene(data, initialPositions(data.nodes)).details.some((line) =>
            line.includes('intermediate-input-prompt'),
        ),
    );
    draft.ssh = undefined;
    assert.match(snapshot(input, false).completion, /independent script exit/);
});
