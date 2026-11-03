import assert from 'node:assert/strict';
import test from 'node:test';
import { visitReorderTarget } from './ui/fixtures/reorder-target-move';

test('target visit delivers two separate same-position moves before preview, including after reflow', async () => {
    const calls: unknown[] = [];
    const mouse = { move: async (x: number, y: number, options?: { steps?: number }) => { calls.push({ x, y, options }); } };
    for (const point of [{ x: 136, y: 851.5 }, { x: 136, y: 494.5 }]) {
        await visitReorderTarget(mouse, point);
        assert.deepEqual(calls.splice(0), [
            { ...point, options: { steps: 1 } },
            { ...point, options: { steps: 1 } },
        ]);
    }
});

test('target visit awaits each acknowledgement, preserves rejection and never retries', async () => {
    const point = { x: 136, y: 851.5 };
    for (const failAt of [0, 1, 2]) {
        const error = new Error('synthetic move failure');
        const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
        let outcome: unknown = 'pending';
        const mouse = { move: () => new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }); }) };
        const task = visitReorderTarget(mouse, point).then(() => { outcome = 'done'; }, failure => { outcome = failure; });
        assert.equal(pending.length, 1);
        await Promise.resolve();
        assert.equal(pending.length, 1);
        assert.equal(outcome, 'pending');
        if (failAt === 1) {
            pending[0].reject(error);
            await task;
            assert.equal(outcome, error);
            assert.equal(pending.length, 1);
            continue;
        }
        pending[0].resolve();
        await Promise.resolve();
        assert.equal(pending.length, 2);
        assert.equal(outcome, 'pending');
        await Promise.resolve();
        assert.equal(outcome, 'pending');
        if (failAt === 2) pending[1].reject(error);
        else pending[1].resolve();
        await task;
        assert.equal(outcome, failAt === 2 ? error : 'done');
        assert.equal(pending.length, 2);
    }
});
