import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutomationPlan, AutomationRecord } from '../shared/automation';
import { prepareInspection } from '../src/features/automation/flow/inspection';
import {
    FlowRunner,
    type FlowBackend,
    type FlowState,
    type RunClock,
} from '../src/features/automation/runner';

test('scheduled inspection and execution retain the armed plan through draft reorder, removal and edits', async () => {
    const epoch = Date.UTC(2028, 1, 29, 12);
    const draft: AutomationPlan = {
        transport: 'ssh',
        steps: [
            {
                id: 'first',
                name: 'First',
                enabled: true,
                command: "printf 'first\\nline'\nprintf '✓'",
                delaySeconds: 0.25,
            },
            {
                id: 'skipped',
                name: 'Disabled',
                enabled: false,
                command: 'never send this disabled command',
                delaySeconds: 7,
            },
            {
                id: 'removed',
                name: 'Removed from next draft',
                enabled: true,
                command: "printf 'still armed after removal'",
                delaySeconds: 0.5,
            },
            {
                id: 'last',
                name: 'Last',
                enabled: true,
                command: "printf 'last'",
                delaySeconds: 0,
            },
        ],
        timeoutSeconds: 10,
        repeatSeconds: null,
        start: {
            epochMs: epoch + 3000,
            clock: 'local',
            zone: 'UTC',
            wallTime: '2028-02-29T12:00:03',
            utcOffset: '+00:00',
        },
        serial: { lineEnding: 'CR', prompt: '', timestampPrefix: '' },
    };
    // Retain aliases to the actual draft objects, rather than a test-side cloned plan.
    const [first, skipped, removed, last] = draft.steps;
    const originalStart = draft.start!;
    const reviewedJson = JSON.stringify(draft);
    const inspection = prepareInspection(draft);
    let local = epoch,
        mono = 0,
        acquisitions = 0,
        releases = 0;
    const sleeps: number[] = [];
    let enterFirstSleep!: () => void;
    const firstSleep = new Promise<void>((resolve) => {
        enterFirstSleep = resolve;
    });
    let releaseFirstSleep!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseFirstSleep = resolve;
    });
    const clock: RunClock = {
        local: () => local,
        mono: () => mono,
        async sleep(ms, signal) {
            if (signal.aborted) throw Error('Logical sleep cancelled.');
            if (!Number.isFinite(ms) || ms <= 0 || ms > 250 || sleeps.length >= 32)
                throw Error('Logical sleep exceeded the finite test budget.');
            sleeps.push(ms);
            if (sleeps.length === 1) {
                enterFirstSleep();
                await gate;
            }
            if (signal.aborted) throw Error('Logical sleep cancelled.');
            local += ms;
            mono += ms;
        },
    };
    const states: FlowState[] = [];
    const records: AutomationRecord[] = [];
    const calls: {
        id: string;
        command: string;
        bytes: number[];
        ordinal: number | undefined;
        local: number;
        planJson: string;
        planIsDraft: boolean;
        stepIsDraft: boolean;
    }[] = [];
    const backend: FlowBackend = {
        available: () => true,
        connection: () => 'memory-scheduled-owner',
        acquire() {
            acquisitions++;
            return () => {
                releases++;
            };
        },
        target: { endpoint: 'memory-only fixture' },
        async execute(step, plan, _signal, _id, context) {
            calls.push({
                id: step.id,
                command: step.command,
                bytes: Array.from(new TextEncoder().encode(step.command)),
                ordinal: context?.ordinal,
                local,
                planJson: JSON.stringify(plan),
                planIsDraft: plan === draft,
                stepIsDraft: [first, skipped, removed, last].includes(step),
            });
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
                completion: 'exit',
                truncated: false,
                chunks: [],
            };
        },
    };
    const runner = new FlowRunner(
        (state) => {
            states.push(state);
        },
        (record) => {
            records.push(record);
        },
        clock,
    );
    // Both product entrypoints receive the same mutable object independently.
    const task = runner.start(draft, backend);
    let editedJson = '';
    try {
        // A pre-wait failure settles the race instead of leaving a pending test forever.
        const waiting = await Promise.race([
            firstSleep.then(() => true),
            task.then(() => false),
        ]);
        assert.equal(waiting, true, 'the actual runner must reach its scheduled wait');
        assert.equal(runner.busy, true);
        assert.equal(states.at(-1)?.state, 'waiting');
        assert.equal(local, epoch);
        assert.equal(calls.length, 0);
        assert.equal(acquisitions, 1);
        assert.equal(releases, 0);

        // Mutate the shared array, nested step objects and nested schedule while armed.
        draft.steps.reverse();
        draft.steps.splice(draft.steps.indexOf(removed), 1);
        first.command = 'edited first command for a future run';
        first.name = 'Edited first';
        first.enabled = false;
        first.delaySeconds = 9;
        skipped.enabled = true;
        skipped.command = 'newly enabled only in the next draft';
        skipped.delaySeconds = 0;
        last.command = 'edited last command for a future run';
        last.delaySeconds = 8;
        originalStart.epochMs = epoch + 60000;
        originalStart.wallTime = '2028-02-29T12:01:00';
        originalStart.zone = 'Etc/UTC';
        draft.timeoutSeconds = 99;
        editedJson = JSON.stringify(draft);
        assert.notEqual(editedJson, reviewedJson);
        assert.deepEqual(draft.steps.map((step) => step.id), ['last', 'skipped', 'first']);
        assert.equal(JSON.stringify(inspection.active.plan), reviewedJson);
        assert.notStrictEqual(inspection.active.plan, draft);
        assert.notStrictEqual(inspection.active.plan.steps, draft.steps);
        assert.notStrictEqual(inspection.active.plan.steps[0], first);
        assert.notStrictEqual(inspection.active.plan.start, originalStart);
    } finally {
        // This only resolves our in-memory gate. No timers, disk fixtures or cleanup hooks.
        releaseFirstSleep();
        await task;
    }

    assert.equal(states.at(-1)?.state, 'finished', states.at(-1)?.message);
    assert.equal(runner.busy, false);
    assert.equal(acquisitions, 1);
    assert.equal(releases, 1);
    assert.deepEqual(calls.map((call) => call.id), ['first', 'removed', 'last']);
    assert.deepEqual(calls.map((call) => call.ordinal), [1, 3, 4]);
    const expectedCommands = [
        "printf 'first\\nline'\nprintf '✓'",
        "printf 'still armed after removal'",
        "printf 'last'",
    ];
    assert.deepEqual(calls.map((call) => call.command), expectedCommands);
    assert.deepEqual(
        calls.map((call) => call.bytes),
        expectedCommands.map((command) => Array.from(new TextEncoder().encode(command))),
    );
    assert.deepEqual(calls.map((call) => call.local - epoch), [3250, 3750, 3750]);
    assert.deepEqual(sleeps, Array<number>(15).fill(250));
    for (const call of calls) {
        assert.equal(call.planJson, reviewedJson);
        assert.equal(call.planIsDraft, false);
        assert.equal(call.stepIsDraft, false);
    }
    assert.deepEqual(records.map((record) => record.command), expectedCommands);
    assert.deepEqual(records.map((record) => record.ordinal), [1, 3, 4]);
    assert.deepEqual(
        records.map((record) => record.startedAt),
        ['2028-02-29T12:00:03.250Z', '2028-02-29T12:00:03.750Z', '2028-02-29T12:00:03.750Z'],
    );
    assert.deepEqual(records.map((record) => record.execution?.stepDelaySeconds), [0.25, 0.5, 0]);
    for (const record of records) {
        assert.equal(record.completion, 'exit');
        assert.equal(record.exitCode, 0);
        assert.equal(record.execution?.timeoutSeconds, 10);
        assert.equal(record.execution?.repeatSeconds, null);
        assert.deepEqual(record.execution?.scheduledStart, {
            epochMs: epoch + 3000,
            clock: 'local',
            zone: 'UTC',
            wallTime: '2028-02-29T12:00:03',
            utcOffset: '+00:00',
        });
    }
    assert.equal(JSON.stringify(inspection.active.plan), reviewedJson);
    assert.equal(JSON.stringify(draft), editedJson, 'the edited next-run draft remains intact');
});
