import type { TestContext } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

// Allocate held gates before acquiring the resources whose teardown must join them.
export function consoleTestGate(
    t: Pick<TestContext, 'after'>,
    beforeRelease: () => void = () => {},
) {
    let resolve!: () => void;
    const promise = new Promise<void>((release) => {
        resolve = release;
    });
    t.after(() => {
        beforeRelease();
        resolve();
    });
    return { promise, resolve };
}

// The fake late-open callback must be delivered by teardown if the body failed first.
// Mark it used before calling, so throwing callbacks cannot be replayed by teardown.
export function consoleTestCallback<Args extends unknown[]>(callback: (...args: Args) => void) {
    let delivered = false;
    return (...args: Args) => {
        if (delivered) return;
        delivered = true;
        callback(...args);
    };
}

/** Own only this returned child, never a PID lookup or a process group. */
export function consoleTestChild(child: ChildProcessWithoutNullStreams) {
    let spawned = false,
        exited = false,
        closed = false,
        stopRequested = false;
    child.once('spawn', () => {
        spawned = true;
    });
    child.once('exit', () => {
        exited = true;
    });
    const done = new Promise<void>((resolve, reject) => {
        child.once('close', () => {
            closed = true;
            if (!spawned || !exited || !child.stdout.readableEnded || !child.stderr.readableEnded)
                reject(Error('Test child exit or pipe EOF was not acknowledged.'));
            else resolve();
        });
    });
    void done.catch(() => {});
    return {
        done,
        stop() {
            if (closed) return;
            child.stdout.resume();
            child.stderr.resume();
            if (!exited && !stopRequested) {
                stopRequested = true;
                child.kill('SIGTERM'); // Request only; done still requires exit, EOFs and close.
            }
        },
        snapshot: () => ({
            spawned,
            exited,
            closed,
            stopRequested,
            stdoutEOF: child.stdout.readableEnded,
            stderrEOF: child.stderr.readableEnded,
        }),
    };
}
