/** Observe only this caller-owned writer; never force closure or retry an operation.
 * @param {{ on: (event: string, listener: (...args: any[]) => void) => unknown,
 * once: (event: string, listener: (...args: any[]) => void) => unknown,
 * write: (chunk: string | Buffer) => unknown, end: (...args: any[]) => unknown }} stream
 */
export function createCaseLogLifecycle(stream) {
    let finished = false;
    let closed = false;
    let failed = false;
    let failure;
    let endRequested = false;
    let endTask;
    let acknowledgeClose;
    // This internal promise only fulfills: an error before end() is not an unhandled rejection.
    const closure = new Promise((resolve) => {
        acknowledgeClose = resolve;
    });
    const retainFailure = (error) => {
        if (!failed) {
            failed = true;
            failure = error;
        }
    };
    stream.on('error', retainFailure);
    stream.once('finish', () => {
        finished = true;
    });
    stream.once('close', () => {
        closed = true;
        if (!finished) retainFailure(Error('Case log closed before finish.'));
        acknowledgeClose();
    });
    return {
        snapshot: () => ({ finished, closed, failed, error: failure, endRequested }),
        write(chunk) {
            if (failed) return false;
            try {
                return stream.write(chunk);
            } catch (error) {
                retainFailure(error);
                return false;
            }
        },
        end(chunk) {
            if (endRequested) return endTask;
            endRequested = true;
            endTask = closure.then(() => {
                if (failed) throw failure;
            });
            if (!closed) {
                try {
                    // After a failure, end normally without attempting another payload write.
                    stream.end(failed ? undefined : chunk, (error) => {
                        if (error !== undefined && error !== null) retainFailure(error);
                    });
                } catch (error) {
                    retainFailure(error);
                }
            }
            return endTask;
        },
    };
}
