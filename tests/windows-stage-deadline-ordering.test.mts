// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { pilotStageDeadlines, waitPilotStage } from '../scripts/lib/pilot-runtime-startup.mjs';
const turns = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};
function deferred() {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
}
function fixture(t, { initialElapsed = 0, runtimeReady = true, emitFault, cancelFault } = {}) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 1000,
        joins = 0,
        completed = false;
    const limits = pilotStageDeadlines({ deadline: 600000 }, 'real-os-pty', clock);
    clock += initialElapsed;
    const state = { stage: 'real-os-pty', runtimeReady, ...limits },
        child = {},
        closed = deferred(),
        join = deferred(),
        controller = new AbortController(),
        cancellations = [],
        holds = [],
        reports = [];
    let delayJoin = false;
    const startup = {
        children: new Map([[child, { closed: closed.promise }]]),
        async joinChild() {
            joins++;
            if (delayJoin) await join.promise;
        },
    };
    const waiting = waitPilotStage({
        child,
        startup,
        state,
        signal: controller.signal,
        clock: () => clock,
        cancel(reason) {
            cancellations.push(reason);
            if (cancelFault) throw Error('cancel transport failed');
            // Reentrant later cancellation cannot replace the original cause.
            controller.abort(Error('later reentrant cancellation'));
        },
        hold: (e) => holds.push(String(e)),
        emit(stage, data) {
            reports.push({ stage, data });
            if (emitFault === 'sync') throw Error('watchdog persistence failed');
            if (emitFault === 'async') return Promise.reject(Error('watchdog persistence failed'));
            return Promise.resolve();
        },
    });
    const outcome = waiting.then(
        () => ({ passed: true }),
        (error) => ({ passed: false, reason: String(error) }),
    );
    void outcome.then(() => (completed = true));
    return {
        state,
        controller,
        cancellations,
        holds,
        reports,
        outcome,
        close: closed.resolve,
        get joins() {
            return joins;
        },
        get completed() {
            return completed;
        },
        delayJoin() {
            delayJoin = true;
        },
        finishJoin: join.resolve,
        async advanceWithoutTimers(ms) {
            clock += ms;
            await turns();
        },
        async tick(ms) {
            clock += ms;
            t.mock.timers.tick(ms);
            await turns();
        },
    };
}
for (const elapsed of [24999, 25000, 25001])
    test(
        'delayed timer cannot admit completed stage at immutable elapsed boundary ' + elapsed,
        async (t) => {
            const f = fixture(t);
            await f.advanceWithoutTimers(elapsed);
            f.close();
            const result = await f.outcome;
            assert.equal(result.passed, elapsed < 25000);
            if (elapsed >= 25000) {
                assert.match(result.reason, /Stage absolute work deadline/);
                assert.equal(f.joins, 1, 'Expired work still joins already-owned actual closure');
                assert.equal(f.cancellations.length, 1);
                assert.equal(f.reports.length, 1);
            }
            assert.equal(f.state.stageDeadline, 26000);
            assert.equal(f.state.runtimeDeadline, 26000);
            assert.equal(f.state.cleanupDeadline, 600000);
        },
    );
test('already-expired parent wait refuses before any timer delivery and retains pending pipe custody', async (t) => {
    const f = fixture(t, { initialElapsed: 25000 });
    await turns();
    assert.equal(f.cancellations.length, 1);
    assert.equal(f.completed, false);
    assert.equal(f.joins, 0);
    f.close();
    assert.match((await f.outcome).reason, /Stage absolute work deadline/);
    assert.equal(f.joins, 1);
});
for (const first of ['signal', 'stage-timer', 'runtime-timer'])
    test('first cancellation survives competing/reentrant later causes: ' + first, async (t) => {
        const f = fixture(t, { runtimeReady: first !== 'runtime-timer' });
        if (first === 'signal') {
            f.controller.abort(Error('first human signal'));
            await f.tick(25000);
        } else {
            await f.tick(25000);
            f.controller.abort(Error('late signal'));
        }
        assert.equal(f.cancellations.length, 1);
        assert.equal(f.reports.length, 1);
        assert.equal(f.completed, false);
        f.close();
        const result = await f.outcome;
        assert.match(
            result.reason,
            first === 'signal'
                ? /first human signal/
                : first === 'runtime-timer'
                  ? /Stage runtime startup absolute deadline/
                  : /Stage absolute work deadline/,
        );
        assert.equal(f.joins, 1);
        assert.equal(f.holds.length, 0);
    });
for (const emitFault of ['sync', 'async'])
    test(
        'watchdog ' +
            emitFault +
            ' persistence failure holds secondary cause without replacing cutoff',
        async (t) => {
            const f = fixture(t, { emitFault });
            await f.advanceWithoutTimers(25000);
            f.close();
            assert.match((await f.outcome).reason, /Stage absolute work deadline/);
            await turns();
            assert.deepEqual(f.holds, ['Error: watchdog persistence failed']);
            assert.equal(f.joins, 1);
            assert.equal(f.cancellations.length, 1);
        },
    );
test('cancellation transport fault stays secondary to original cutoff and cannot certify closure', async (t) => {
    const f = fixture(t, { cancelFault: true });
    await f.tick(25000);
    assert.equal(f.completed, false);
    assert.deepEqual(f.holds, ['Error: cancel transport failed']);
    f.close();
    assert.match((await f.outcome).reason, /Stage absolute work deadline/);
    assert.equal(f.joins, 1);
});
test('deadline refusal remains pending through owned query/log join after pipe close', async (t) => {
    const f = fixture(t);
    f.delayJoin();
    await f.advanceWithoutTimers(25000);
    f.close();
    await turns();
    assert.equal(f.joins, 1);
    assert.equal(f.completed, false);
    f.controller.abort(Error('later cancellation during join'));
    f.finishJoin();
    assert.match((await f.outcome).reason, /Stage absolute work deadline/);
    assert.equal(f.cancellations.length, 1);
});
test('missing pipe closure reaches original10s cleanup bound, holds, and cannot revive later', async (t) => {
    const f = fixture(t);
    await f.tick(25000);
    await f.tick(9999);
    assert.equal(f.completed, false);
    await f.tick(1);
    assert.match((await f.outcome).reason, /Stage absolute work deadline/);
    assert.equal(f.holds.length, 1);
    assert.equal(f.joins, 0);
    f.close();
    await turns();
    assert.equal(f.joins, 0);
    assert.equal(f.state.cleanupDeadline, 600000);
});
