import assert from 'node:assert/strict';
import test from 'node:test';
import { FlowRunner } from '../src/features/automation/runner';
import { fixture, released, settled, until } from './fixtures/runner-cancel-fixture';

test('held cleanup retry retains custody then preserves an acknowledged evidence failure without replay', async () => {
    const failure = 'Console stopped with incomplete or unacknowledged evidence: retained IO failure';
    const f = fixture(FlowRunner, { steps: 1, finishRejects: 1, finishFailure: failure });
    await settled(f.running);
    assert.equal(f.runner.cleanupPending, true); assert.equal(f.releases(), 0);
    const retained = structuredClone(f.rows), finish = f.backend.finishFlow!;
    let open!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { open = resolve; });
    f.backend.finishFlow = async reason => { entered = true; await gate; return finish(reason); };
    const retry = f.runner.retryCleanup();
    try {
        await until(() => entered);
        assert.equal(f.runner.retryCleanup(), retry);
        assert.equal(f.runner.busy, true); assert.equal(f.runner.cleanupPending, true);
        assert.equal(f.releases(), 0); assert.equal(f.held(), true);
        assert.throws(() => f.runner.start(f.plan, f.backend), /awaiting cleanup/);
        assert.deepEqual(f.commands, ['step-1']); assert.deepEqual(f.rows, retained);
    } finally {
        open(); await settled(retry);
    }
    released(f, 1);
    assert.equal(f.states.at(-1)!.state, 'paused');
    assert.equal(f.states.at(-1)!.message, failure + ' Flow paused; arm explicitly to resume.');
    assert.ok(f.states.every(state => state.state !== 'finished'));
    assert.deepEqual(f.rows, retained); assert.deepEqual(f.reasons, ['complete', 'cancelled']);
    await settled(f.runner.retryCleanup());
    assert.equal(f.releases(), 1); assert.equal(f.reasons.length, 2);
});

test('acknowledged retry without an outcome failure preserves the ordinary cleanup status', async () => {
    const f = fixture(FlowRunner, { steps: 1, finishRejects: 1 });
    await settled(f.running);
    await settled(f.runner.retryCleanup());
    released(f, 1);
    assert.equal(f.states.at(-1)!.state, 'paused');
    assert.equal(f.states.at(-1)!.message, 'Console cleanup acknowledged. Arm explicitly to resume.');
    assert.deepEqual(f.commands, ['step-1']); assert.deepEqual(f.reasons, ['complete', 'cancelled']);
});
