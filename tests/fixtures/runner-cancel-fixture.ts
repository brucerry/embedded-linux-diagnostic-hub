import assert from 'node:assert/strict';
import type {
    FlowRunner,
    FlowBackend,
    FlowState,
    RunClock,
} from '../../src/features/automation/runner';
import type { AutomationPlan, AutomationRecord } from '../../shared/automation';

export type Phase = 'prepare' | 'execute' | 'record' | 'finalize' | 'finish' | 'sleep';
interface Options {
    hold?: Phase;
    steps?: 1 | 2;
    repeat?: boolean;
    omitFinish?: boolean;
    recordFailure?: boolean;
    executeFailure?: boolean;
    finalizeFailure?: boolean;
    finishRejects?: number;
    finishFailure?: string;
    cancelOnFinishing?: boolean;
}

/** Bounded Promise jobs only: no timeout, interval, scheduler, IO or process hook. */
export async function until(check: () => boolean) {
    for (let turns = 0; turns < 256; turns++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.fail('The in-memory fixture did not reach its boundary within 256 Promise turns.');
}

export async function settled(task: Promise<unknown>) {
    let done = false,
        rejected = false,
        failure: unknown;
    void task.then(
        () => {
            done = true;
        },
        (error) => {
            done = true;
            rejected = true;
            failure = error;
        },
    );
    await until(() => done);
    if (rejected) throw failure;
}

export function fixture(Runner: typeof FlowRunner, options: Options = {}) {
    const local = Date.UTC(2028, 1, 29, 12),
        events: string[] = [],
        states: FlowState[] = [],
        rows: AutomationRecord[] = [],
        commands: string[] = [],
        finalizes: string[] = [],
        reasons: ('complete' | 'cancelled')[] = [],
        watches = new Set<() => void>();
    let entered = false,
        open!: () => void,
        releases = 0,
        acquires = 0,
        unwatches = 0,
        watchCount = 0,
        sleepCount = 0,
        leaseHeld = false,
        signal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => {
        open = resolve;
    });
    const note = (event: string) => {
        assert.ok(events.length < 200, 'Bounded event trace exhausted.');
        events.push(event);
    };
    const boundary = async (phase: Phase) => {
        note(phase + ':enter');
        if (options.hold === phase && !entered) {
            entered = true;
            await gate;
        }
        note(phase + ':leave');
    };
    const clock: RunClock = {
        local: () => local,
        mono: () => 0,
        watch: (callback) => {
            assert.ok(++watchCount <= 3, 'Unexpected extra preparation or command watcher.');
            watches.add(callback);
            return () => {
                assert.equal(watches.delete(callback), true, 'Watcher removed exactly once.');
                unwatches++;
            };
        },
        sleep: (_ms, owned) => {
            assert.equal(++sleepCount, 1, 'Unexpected repetition or second wait.');
            assert.equal(options.hold, 'sleep', 'No unplanned waiting is allowed.');
            return new Promise<void>((resolve, reject) => {
                entered = true;
                const abort = () => {
                    owned.removeEventListener('abort', abort);
                    reject(Error('Cancelled.'));
                };
                owned.addEventListener('abort', abort, { once: true });
                void gate.then(() => {
                    owned.removeEventListener('abort', abort);
                    resolve();
                });
                if (owned.aborted) abort();
            });
        },
    };
    const runner = new Runner(
        (state) => {
            states.push(state);
            note('state:' + state.state);
            if (
                options.cancelOnFinishing &&
                state.message === 'Finishing flow and saving retained evidence…'
            )
                runner.cancel();
        },
        async (row) => {
            rows.push(row);
            await boundary('record');
            if (options.recordFailure) throw Error('Synthetic outcome failure.');
        },
        clock,
    );
    const plan: AutomationPlan = {
        transport: 'ssh',
        steps: Array.from({ length: options.steps ?? 2 }, (_, index) => ({
            id: 'step-' + (index + 1),
            name: 'Step ' + (index + 1),
            enabled: true,
            command: 'fixture-' + (index + 1),
            delaySeconds: 0,
        })),
        timeoutSeconds: 10,
        repeatSeconds: options.repeat ? 1 : null,
        start:
            options.hold === 'sleep'
                ? { epochMs: local + 5000, clock: 'local', zone: 'UTC' }
                : null,
        serial: { lineEnding: 'CR', prompt: '# ', timestampPrefix: '' },
    };
    const backend: FlowBackend = {
        target: { endpoint: 'in-memory fixture; never a connection' },
        connection: () => 'fixture-connection',
        available: () => true,
        acquire: () => {
            assert.equal(++acquires, 1);
            leaseHeld = true;
            note('acquire');
            return () => {
                assert.equal(++releases, 1, 'Lease released exactly once.');
                leaseHeld = false;
                note('release');
            };
        },
        prepare: async (_plan, owned) => {
            signal = owned;
            await boundary('prepare');
        },
        execute: async (step, _plan, owned) => {
            signal = owned;
            assert.ok(commands.length < 2, 'No third command is permitted.');
            commands.push(step.id);
            await boundary('execute');
            if (options.executeFailure) throw Error('Synthetic execute failure.');
            return {
                stdout: 'retained fixture',
                stderr: '',
                exitCode: 0,
                completion: 'exit',
                truncated: false,
                chunks: [],
            };
        },
        finalize: async (id) => {
            assert.ok(!finalizes.includes(id), 'Command finalized exactly once.');
            finalizes.push(id);
            await boundary('finalize');
            if (options.finalizeFailure) throw Error('Synthetic finalize failure.');
        },
        ...(options.omitFinish
            ? {}
            : {
                  finishFlow: async (reason: 'complete' | 'cancelled') => {
                      assert.ok(reasons.length < 2, 'Only initial close and one retry allowed.');
                      reasons.push(reason);
                      await boundary('finish');
                      if (reasons.length <= (options.finishRejects ?? 0))
                          throw Error('Synthetic close unacknowledged.');
                      if (options.finishFailure) return { failure: options.finishFailure };
                  },
              }),
    };
    const running = runner.start(plan, backend);
    return {
        runner,
        backend,
        plan,
        running,
        events,
        states,
        rows,
        commands,
        finalizes,
        reasons,
        open,
        entered: () => entered,
        releases: () => releases,
        held: () => leaseHeld,
        aborted: () => signal?.aborted,
        sleepCount: () => sleepCount,
        watches: () => watches.size,
        watchCount: () => watchCount,
        unwatches: () => unwatches,
    };
}

export function released(f: ReturnType<typeof fixture>, commands: number) {
    assert.equal(f.commands.length, commands);
    assert.equal(f.rows.length, commands);
    assert.equal(f.finalizes.length, commands);
    assert.equal(f.releases(), 1);
    assert.equal(f.held(), false);
    assert.equal(f.runner.busy, false);
    assert.equal(f.runner.cleanupPending, false);
    assert.equal(f.watches(), 0);
    assert.equal(f.unwatches(), f.watchCount());
    assert.ok(f.events.lastIndexOf('release') > f.events.lastIndexOf('finalize:leave'));
    assert.ok(f.events.lastIndexOf('release') > f.events.lastIndexOf('finish:leave'));
    assert.ok(f.events.lastIndexOf('release') < f.events.length - 1);
}
