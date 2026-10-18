import assert from 'node:assert/strict';
import test from 'node:test';
import { FlowRunner, type RunClock, type FlowState } from '../src/features/automation/runner';
import type { AutomationPlan, CommandCapture } from '../shared/automation';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const exit: CommandCapture = {
    stdout: 'fixture',
    stderr: '',
    exitCode: 0,
    completion: 'exit',
    truncated: false,
    chunks: [],
};
for (const phase of ['active', 'between-steps', 'repeating', 'scheduled'] as const) {
    test(`Cancel run disarms ${phase} execution with no queued step, repetition or scheduled restart`, async () => {
        let mono = 0,
            wall = Date.UTC(2026, 9, 15),
            calls = 0,
            cancellations = 0,
            releases = 0;
        const waits: { due: number; resolve(): void }[] = [];
        const clock: RunClock = {
            local: () => wall,
            mono: () => mono,
            sleep: (ms, signal) =>
                new Promise((resolve, reject) => {
                    const cancel = () => reject(Error('Cancelled.'));
                    signal.addEventListener('abort', cancel, { once: true });
                    waits.push({
                        due: mono + ms,
                        resolve: () => {
                            signal.removeEventListener('abort', cancel);
                            resolve();
                        },
                    });
                    if (signal.aborted) cancel();
                }),
        };
        const states: FlowState[] = [];
        const runner = new FlowRunner(
            (s) => states.push(s),
            () => {},
            clock,
        );
        const plan: AutomationPlan = {
            transport: 'ssh',
            steps: [
                { id: 'one', name: 'one', enabled: true, command: 'echo one', delaySeconds: 0 },
                {
                    id: 'two',
                    name: 'two',
                    enabled: true,
                    command: 'echo two',
                    delaySeconds: phase === 'between-steps' ? 2 : 0,
                },
            ],
            timeoutSeconds: 10,
            repeatSeconds: phase === 'repeating' ? 1 : null,
            start:
                phase === 'scheduled'
                    ? { epochMs: wall + 5000, clock: 'local', zone: 'UTC' }
                    : null,
            serial: { lineEnding: 'CR', prompt: '# ', timestampPrefix: '' },
        };
        if (phase === 'repeating') plan.steps = plan.steps.slice(0, 1);
        const pending = runner.start(plan, {
            connection: () => 'owned-fixture-generation',
            available: () => true,
            acquire: () => () => {
                releases++;
            },
            target: { endpoint: 'synthetic' },
            execute: async (_step, _plan, signal) => {
                calls++;
                if (phase !== 'active') return exit;
                return new Promise<CommandCapture>((resolve) => {
                    const cancel = () => {
                        cancellations++;
                        resolve({ ...exit, exitCode: null, completion: 'cancelled' });
                    };
                    signal.addEventListener('abort', cancel, { once: true });
                    if (signal.aborted) cancel();
                });
            },
        });
        for (let count = 0; count < 10; count++) await tick();
        assert.equal(runner.busy, true);
        assert.equal(
            states.at(-1)!.state,
            phase === 'active' ? 'running' : phase === 'between-steps' ? 'delaying' : 'waiting',
        );
        const before = calls;
        runner.cancel();
        await pending;
        wall += 900000;
        mono += 900000;
        for (const wait of waits) wait.resolve();
        for (let count = 0; count < 5; count++) await tick();
        assert.equal(calls, before);
        assert.equal(calls, phase === 'scheduled' ? 0 : 1);
        assert.equal(cancellations, phase === 'active' ? 1 : 0);
        assert.equal(releases, 1);
        assert.equal(runner.busy, false);
        assert.equal(states.at(-1)!.state, 'paused');
        assert.match(states.at(-1)!.message, /cancelled/i);
        assert.match(states.at(-1)!.message, /already sent may continue/);
    });
}
