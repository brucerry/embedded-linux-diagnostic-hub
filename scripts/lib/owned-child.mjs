import assert from 'node:assert/strict';

/** A bounded observation, never an inferred exit from PID absence. Unknown handles stay attached. */
export function observeOwnedChild(child, options = {}) {
    const {
        totalMs = 120000,
        reserveMs = 1000,
        clock = { now: () => performance.now(), set: setTimeout, clear: clearTimeout },
        onEvent = () => {},
        requestStop = null,
    } = options;
    assert.ok(totalMs >= 0 && reserveMs > 0);
    const started = clock.now();
    const state = {
        pid: child.pid ?? null,
        spawnObserved: false,
        exitObserved: false,
        closeObserved: false,
        code: null,
        signal: null,
        closeCode: null,
        closeSignal: null,
        error: null,
        timedOut: false,
        terminationRequested: false,
        killErrors: [],
        elapsedMs: 0,
    };
    let resolve,
        settled = false,
        stopping = false,
        hardTimer;
    const outcome = new Promise((done) => {
        resolve = done;
    });
    const snapshot = () => ({
        ...state,
        killErrors: [...state.killErrors],
        elapsedMs: clock.now() - started,
    });
    const notify = (event) => {
        if (settled) return;
        try {
            onEvent(event, snapshot());
        } catch (error) {
            abort('Lifecycle recorder: ' + String(error));
        }
    };
    const kill = (signal) => {
        if (state.exitObserved || state.closeObserved || child.pid == null) return;
        state.terminationRequested = true;
        try {
            if (!child.kill(signal)) state.killErrors.push(signal + ' returned false');
        } catch (error) {
            state.killErrors.push(String(error).slice(0, 512));
        }
    };
    const abort = (reason) => {
        state.error ??= String(reason).slice(0, 1024);
        if (stopping || settled) return;
        stopping = true;
        // A supervisory owner must forward cancellation, never kill a middle process's watchdog.
        if (requestStop) {
            try {
                requestStop(String(reason));
            } catch (error) {
                state.killErrors.push(String(error).slice(0, 512));
            }
            return;
        }
        kill('SIGTERM');
        const remaining = totalMs - (clock.now() - started);
        hardTimer = clock.set(
            () => kill('SIGKILL'),
            Math.max(0, Math.min(reserveMs / 2, remaining / 2)),
        );
    };
    const finish = () => {
        if (settled) return;
        settled = true;
        clock.clear(workTimer);
        clock.clear(finalTimer);
        clock.clear(hardTimer);
        resolve(snapshot());
    };
    const workTimer = clock.set(
        () => {
            state.timedOut = true;
            abort('Owned child work deadline exceeded; cleanup reserve began.');
        },
        Math.max(0, totalMs - reserveMs),
    );
    const finalTimer = clock.set(() => {
        state.timedOut = true;
        state.error ??= 'Actual child closure unverified at total deadline.';
        finish(); // No unref/detach/process-exit escape: a live OS handle remains attached.
    }, totalMs);
    child.once('spawn', () => {
        state.spawnObserved = true;
        notify('spawn');
    });
    child.once('error', (error) => {
        abort(error);
        notify('error');
    });
    child.once('exit', (code, signal) => {
        state.exitObserved = true;
        state.code = code;
        state.signal = signal;
        notify('exit');
    });
    child.once('close', (code, signal) => {
        state.closeObserved = true;
        state.closeCode = code;
        state.closeSignal = signal;
        notify('close');
        finish();
    });
    return { outcome, abort, snapshot };
}

export function requireObservedClosure(row) {
    assert.ok(Number.isSafeInteger(row?.pid) && row.pid > 0, 'Missing owned child PID.');
    assert.ok(
        row.spawnObserved && row.exitObserved && row.closeObserved,
        'Actual spawn/exit/close incomplete.',
    );
    assert.equal(row.error, null, 'Owned child error.');
    assert.equal(row.timedOut, false, 'Owned child timed out.');
    assert.equal(row.code, row.closeCode, 'Exit/close codes disagree.');
    assert.equal(row.signal, row.closeSignal, 'Exit/close signals disagree.');
    assert.equal(row.signal, null, 'Signal is not a normal outcome.');
}
