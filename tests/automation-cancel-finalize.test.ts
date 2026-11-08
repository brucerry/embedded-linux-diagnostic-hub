import assert from 'node:assert/strict';
import test from 'node:test';
import { FlowRunner } from '../src/features/automation/runner';
import { fixture, released, settled, until } from './fixtures/runner-cancel-fixture';

for (const steps of [1, 2] as const)
    test(`Cancel during finalize pauses ${steps}-step flow after cleanup`, async () => {
        const f = fixture(FlowRunner, { hold: 'finalize', steps, repeat: true });
        try {
            await until(f.entered);
            f.runner.cancel();
            assert.equal(f.aborted(), true);
            assert.equal(f.runner.busy, true);
            assert.equal(f.held(), true);
            assert.equal(f.releases(), 0);
            assert.equal(f.reasons.length, 0);
            assert.deepEqual(f.commands, ['step-1']);
            assert.equal(f.rows[0].completion, 'exit');
            assert.equal(f.rows[0].stdout, 'retained fixture');
        } finally {
            f.open();
            await settled(f.running);
        }
        released(f, 1);
        assert.deepEqual(f.reasons, ['cancelled']);
        assert.equal(f.sleepCount(), 0);
        assert.equal(f.states.at(-1)!.state, 'paused');
        assert.match(f.states.at(-1)!.message, /Flow cancelled.*already sent may continue/);
        assert.ok(f.states.every((state) => state.state !== 'finished'));
    });

test('interrupt during finalize preserves its reason and stops later commands', async () => {
    const f = fixture(FlowRunner, { hold: 'finalize' });
    try {
        await until(f.entered);
        f.runner.interrupt('Page exited. Arm explicitly to resume.');
        assert.equal(f.releases(), 0);
    } finally {
        f.open();
        await settled(f.running);
    }
    released(f, 1);
    assert.deepEqual(f.reasons, ['cancelled']);
    assert.equal(f.states.at(-1)!.state, 'paused');
    assert.equal(f.states.at(-1)!.message, 'Page exited. Arm explicitly to resume.');
});

test('Cancel during pending finish joins it once without reporting success', async () => {
    const f = fixture(FlowRunner, { hold: 'finish', steps: 1 });
    try {
        await until(f.entered);
        assert.deepEqual(f.reasons, ['complete']);
        f.runner.cancel();
        assert.equal(f.runner.busy, true);
        assert.equal(f.releases(), 0);
        assert.equal(f.held(), true);
    } finally {
        f.open();
        await settled(f.running);
    }
    released(f, 1);
    // An already submitted close is joined, not retried or retroactively relabeled.
    assert.deepEqual(f.reasons, ['complete']);
    assert.equal(f.states.at(-1)!.state, 'paused');
    assert.match(f.states.at(-1)!.message, /Flow cancelled/);
    assert.ok(f.states.every((state) => state.state !== 'finished'));
});

test('Cancel before finish selects cancelled close and paused terminal state', async () => {
    const f = fixture(FlowRunner, { steps: 1, cancelOnFinishing: true });
    try {
        await settled(f.running);
    } finally {
        f.open();
    }
    released(f, 1);
    assert.deepEqual(f.reasons, ['cancelled']);
    assert.equal(f.states.at(-1)!.state, 'paused');
    assert.match(f.states.at(-1)!.message, /Flow cancelled/);
});

test('Stop during finalize allows graceful completion without another step or repeat', async () => {
    const f = fixture(FlowRunner, { hold: 'finalize', repeat: true });
    try {
        await until(f.entered);
        f.runner.stop();
        assert.equal(f.aborted(), false);
        assert.equal(f.releases(), 0);
    } finally {
        f.open();
        await settled(f.running);
    }
    released(f, 1);
    assert.deepEqual(f.reasons, ['complete']);
    assert.equal(f.sleepCount(), 0);
    assert.equal(f.states.at(-1)!.state, 'finished');
});

test('uncancelled flow preserves outcome/finalize ordering and release after finish', async () => {
    const f = fixture(FlowRunner);
    try {
        await settled(f.running);
    } finally {
        f.open();
    }
    released(f, 2);
    assert.deepEqual(f.commands, ['step-1', 'step-2']);
    assert.deepEqual(f.reasons, ['complete']);
    assert.equal(f.states.at(-1)!.state, 'finished');
    assert.equal(f.rows[0].runId, f.rows[1].runId);
    assert.deepEqual(
        f.rows.map((row) => row.ordinal),
        [1, 2],
    );
    assert.deepEqual(
        f.events.filter((event) => /^(prepare|execute|record|finalize|finish):/.test(event)),
        [
            'prepare:enter',
            'prepare:leave',
            'execute:enter',
            'execute:leave',
            'record:enter',
            'record:leave',
            'finalize:enter',
            'finalize:leave',
            'execute:enter',
            'execute:leave',
            'record:enter',
            'record:leave',
            'finalize:enter',
            'finalize:leave',
            'finish:enter',
            'finish:leave',
        ],
    );
});

for (const phase of ['prepare', 'execute', 'record', 'sleep'] as const)
    test(`existing Cancel boundary remains fenced during ${phase}`, async () => {
        const f = fixture(FlowRunner, { hold: phase });
        try {
            await until(f.entered);
            f.runner.cancel();
            assert.equal(f.releases(), 0);
            assert.equal(f.runner.busy, true);
            assert.equal(f.held(), true);
            if (phase === 'record') assert.equal(f.finalizes.length, 0);
        } finally {
            f.open();
            await settled(f.running);
        }
        released(f, phase === 'prepare' || phase === 'sleep' ? 0 : 1);
        assert.deepEqual(f.reasons, ['cancelled']);
        assert.equal(f.states.at(-1)!.state, 'paused');
        assert.match(f.states.at(-1)!.message, /Flow cancelled/);
        assert.ok(f.states.every((state) => state.state !== 'finished'));
    });

test('Cancel during finalize is paused when the backend has no finishFlow callback', async () => {
    const f = fixture(FlowRunner, { hold: 'finalize', omitFinish: true });
    try {
        await until(f.entered);
        f.runner.cancel();
    } finally {
        f.open();
        await settled(f.running);
    }
    released(f, 1);
    assert.deepEqual(f.reasons, []);
    assert.equal(f.states.at(-1)!.state, 'paused');
    assert.match(f.states.at(-1)!.message, /Flow cancelled/);
});

for (const failure of ['recordFailure', 'executeFailure', 'finalizeFailure'] as const)
    test(`${failure} preserves finalization, one release and no later command`, async () => {
        const f = fixture(FlowRunner, {
            recordFailure: failure === 'recordFailure',
            executeFailure: failure === 'executeFailure',
            finalizeFailure: failure === 'finalizeFailure',
        });
        try {
            await settled(f.running);
        } finally {
            f.open();
        }
        released(f, 1);
        assert.deepEqual(f.reasons, ['cancelled']);
        assert.equal(f.states.at(-1)!.state, 'paused');
        assert.match(
            f.states.at(-1)!.message,
            failure === 'recordFailure'
                ? /Synthetic outcome failure/
                : failure === 'finalizeFailure'
                  ? /Synthetic finalize failure/
                  : /transport-error/,
        );
    });

test('Cancel does not hide an acknowledged finish evidence failure', async () => {
    const f = fixture(FlowRunner, {
        hold: 'finish',
        steps: 1,
        finishFailure: 'Synthetic incomplete evidence.',
    });
    try {
        await until(f.entered);
        f.runner.cancel();
    } finally {
        f.open();
        await settled(f.running);
    }
    released(f, 1);
    assert.equal(f.states.at(-1)!.state, 'paused');
    assert.match(f.states.at(-1)!.message, /Synthetic incomplete evidence/);
});

test('unacknowledged finish retains lease until one explicit deduplicated retry', async () => {
    const f = fixture(FlowRunner, { hold: 'finish', steps: 1, finishRejects: 1 });
    try {
        await until(f.entered);
        f.runner.cancel();
    } finally {
        f.open();
        await settled(f.running);
    }
    assert.equal(f.runner.cleanupPending, true);
    assert.equal(f.runner.busy, true);
    assert.equal(f.releases(), 0);
    assert.equal(f.held(), true);
    assert.match(f.states.at(-1)!.message, /cleanup remains pending.*Synthetic close/);
    assert.throws(() => f.runner.start(f.plan, f.backend), /awaiting cleanup/);
    const retry = f.runner.retryCleanup();
    assert.equal(f.runner.retryCleanup(), retry);
    await settled(retry);
    released(f, 1);
    assert.deepEqual(f.reasons, ['complete', 'cancelled']);
    assert.equal(f.states.at(-1)!.state, 'paused');
    assert.match(f.states.at(-1)!.message, /cleanup acknowledged/);
    await settled(f.runner.retryCleanup());
    assert.equal(f.releases(), 1);
    assert.equal(f.reasons.length, 2);
});
