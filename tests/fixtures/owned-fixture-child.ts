import { EventEmitter } from 'node:events';

interface Pipe extends EventEmitter {
    resume(): unknown;
}
export interface FixtureChild extends EventEmitter {
    stdout: Pipe;
    stderr: Pipe;
    kill(signal: 'SIGKILL'): boolean;
}
interface Clock {
    set(run: () => void, milliseconds: number): unknown;
    clear(handle: unknown): void;
}
const clock: Clock = {
    set: (run, milliseconds) => setTimeout(run, milliseconds),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One returned child only. A signal request is never a retirement acknowledgement. */
export function ownFixtureChild(
    start: () => FixtureChild,
    options: { timeoutMs: number; clock?: Clock },
) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000)
        throw Error('Unsupported fixture child deadline.');
    const timerHost = options.clock ?? clock;
    let child: FixtureChild;
    let spawned = false,
        spawnFailed = false,
        exited = false,
        closed = false,
        stdoutEOF = false,
        stderrEOF = false,
        stdoutClosed = false,
        stderrClosed = false,
        stopRequested = false,
        signalRequested = false,
        retired = false,
        lineSettled = false;
    let code: number | null = null,
        signal: string | null = null;
    const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const counts = { stdout: 0, stderr: 0 };
    const errors: unknown[] = [];
    const listeners: {
        emitter: EventEmitter;
        event: string;
        listener: (...args: any[]) => void;
    }[] = [];
    let resolveRetired!: () => void,
        resolveDone!: (value: ReturnType<typeof snapshot> & typeof buffers) => void,
        rejectDone!: (error: unknown) => void,
        resolveLine!: (line: string) => void,
        rejectLine!: (error: unknown) => void;
    const retirement = new Promise<void>((resolve) => (resolveRetired = resolve));
    const done = new Promise<ReturnType<typeof snapshot> & typeof buffers>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });
    const firstLine = new Promise<string>((resolve, reject) => {
        resolveLine = resolve;
        rejectLine = reject;
    });
    void done.catch(() => {});
    void firstLine.catch(() => {});
    function snapshot() {
        return {
            spawned,
            spawnFailed,
            exited,
            closed,
            stdoutEOF,
            stderrEOF,
            stdoutClosed,
            stderrClosed,
            stopRequested,
            signalRequested,
            retired,
            code,
            signal,
            stdoutBytes: counts.stdout,
            stderrBytes: counts.stderr,
        };
    }
    function note(error: unknown) {
        if (errors.length < 4) errors.push(error);
        if (!lineSettled) {
            lineSettled = true;
            rejectLine(error);
        }
    }
    function sendStop() {
        if (!stopRequested || !spawned || exited || signalRequested || retired) return;
        signalRequested = true; // At most one request, including refusal or throw.
        try {
            if (!child.kill('SIGKILL'))
                note(Error('Owned fixture child refused its stop request.'));
        } catch (error) {
            note(error);
        }
    }
    function stop() {
        if (retired) return;
        stopRequested = true;
        try {
            child.stdout.resume();
        } catch (error) {
            note(error);
        }
        try {
            child.stderr.resume();
        } catch (error) {
            note(error);
        }
        sendStop();
    }
    function fail(error: unknown) {
        if (retired) return;
        note(error);
        stop();
    }
    let timer: unknown;
    function finish() {
        if (retired || !closed || !stdoutClosed || !stderrClosed) return;
        // Keep custody if an admitted process has no actual exit acknowledgement.
        if (!exited && !(spawnFailed && !spawned)) return;
        retired = true;
        timerHost.clear(timer);
        if (spawned && (!stdoutEOF || !stderrEOF))
            note(Error('Fixture pipe EOF was not acknowledged.'));
        if (!lineSettled) {
            lineSettled = true;
            rejectLine(Error('Fixture closed before its gate.'));
        }
        for (const { emitter, event, listener } of listeners) emitter.off(event, listener);
        resolveRetired();
        if (errors.length)
            rejectDone(new AggregateError(errors, 'Owned fixture child failed after retirement.'));
        else resolveDone({ ...snapshot(), ...buffers });
    }
    function on(emitter: EventEmitter, event: string, listener: (...args: any[]) => void) {
        listeners.push({ emitter, event, listener });
        emitter.on(event, listener);
    }
    // Failure to allocate the deadline must occur before acquiring a child.
    timer = timerHost.set(
        () => fail(Error('Owned fixture child deadline exceeded.')),
        options.timeoutMs,
    );
    try {
        child = start();
    } catch (error) {
        timerHost.clear(timer);
        throw error;
    }
    on(child, 'spawn', () => {
        spawned = true;
        sendStop();
    });
    on(child, 'error', (error: Error) => {
        if (!spawned) spawnFailed = true;
        fail(error);
        finish();
    });
    on(child, 'exit', (exitCode: number | null, exitSignal: string | null) => {
        exited = true;
        code = exitCode;
        signal = exitSignal;
        finish();
    });
    on(child, 'close', (exitCode: number | null, exitSignal: string | null) => {
        closed = true;
        if (exited && (exitCode !== code || exitSignal !== signal))
            note(Error('Fixture exit and close outcomes disagree.'));
        finish();
    });
    for (const name of ['stdout', 'stderr'] as const) {
        const pipe = child[name],
            limit = name === 'stdout' ? 65536 : 16384;
        on(pipe, 'data', (chunk: Buffer) => {
            if (!Buffer.isBuffer(chunk)) {
                fail(Error('Unexpected fixture pipe data.'));
                return;
            }
            counts[name] += chunk.length;
            if (counts[name] > limit) {
                fail(Error('Fixture output exceeded its bound.'));
                return;
            }
            buffers[name] = Buffer.concat([buffers[name], chunk]);
            if (name === 'stdout' && !lineSettled) {
                const end = buffers.stdout.indexOf(10);
                if (end >= 0) {
                    lineSettled = true;
                    resolveLine(buffers.stdout.subarray(0, end).toString('utf8'));
                }
            }
        });
        on(pipe, 'error', (error: Error) => fail(error));
        on(pipe, 'end', () => {
            if (name === 'stdout') stdoutEOF = true;
            else stderrEOF = true;
            finish();
        });
        on(pipe, 'close', () => {
            if (name === 'stdout') stdoutClosed = true;
            else stderrClosed = true;
            finish();
        });
    }
    return { done, retired: retirement, firstLine, stop, snapshot };
}
