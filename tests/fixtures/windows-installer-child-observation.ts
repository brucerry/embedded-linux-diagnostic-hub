// Source-only observation. Attaching listeners or receiving events does not
// establish native process identity or retirement of descendants. No timer,
// signal, retry, or installer admission is implemented here.
export const WINDOWS_LAUNCH_CAPTURE_BYTES = 64 * 1024;

type Observer = (...args: unknown[]) => void;

export function observeWindowsInstallerChild(child: object) {
    let registrationErrorObserved = false,
        registrationError: unknown = null;
    const noteRegistrationError = (error: unknown) => {
        if (!registrationErrorObserved) registrationError = error;
        registrationErrorObserved = true;
    };
    function register(target: unknown, event: string, observer: Observer): boolean {
        try {
            if ((typeof target !== 'object' && typeof target !== 'function') || target === null)
                throw Error('FIXED_LAUNCH_OBSERVER_TARGET_UNAVAILABLE');
            const on = Reflect.get(target, 'on');
            if (typeof on !== 'function') throw Error('FIXED_LAUNCH_OBSERVER_UNAVAILABLE');
            Reflect.apply(on, target, [event, observer]);
            return true;
        } catch (error) {
            noteRegistrationError(error);
            return false;
        }
    }
    function pipe(name: 'stdout' | 'stderr') {
        const storage = Buffer.alloc(WINDOWS_LAUNCH_CAPTURE_BYTES);
        let handle: unknown = null,
            capturedBytes = 0,
            bytesObserved = 0,
            truncated = false;
        let endObserved = false,
            closeObserved = false,
            errorObserved = false,
            error: unknown = null;
        let invalidChunkObserved = false,
            dataAfterTerminalEvent = false;
        try {
            handle = Reflect.get(child, name);
        } catch (error) {
            noteRegistrationError(error);
        }
        // Retain the exact pipe before attempting listener registration. Register
        // terminal/error observers before 'data', which can start flowing mode.
        const errorObserverAttached = register(handle, 'error', (fault) => {
            if (!errorObserved) error = fault;
            errorObserved = true;
        });
        const endObserverAttached = register(handle, 'end', () => {
            endObserved = true;
        });
        const closeObserverAttached = register(handle, 'close', () => {
            closeObserved = true;
        });
        let dataObserverAttached = false;
        const onData: Observer = (chunk) => {
            if (endObserved || closeObserved) dataAfterTerminalEvent = true;
            // This component never changes encoding. Node pipe data is bytes;
            // strings and other payloads are not silently recoded as evidence.
            if (!(chunk instanceof Uint8Array)) {
                invalidChunkObserved = true;
                return;
            }
            bytesObserved = Math.min(Number.MAX_SAFE_INTEGER, bytesObserved + chunk.byteLength);
            const count = Math.min(storage.length - capturedBytes, chunk.byteLength);
            storage.set(chunk.subarray(0, count), capturedBytes);
            capturedBytes += count;
            if (count < chunk.byteLength) truncated = true;
            // Keep draining after the cap; retain neither further chunks nor
            // an unbounded event list. Never pause/destroy/close the pipe here.
        };
        return {
            start() {
                dataObserverAttached = register(handle, 'data', onData);
            },
            snapshot: () =>
                Object.freeze({
                    handle,
                    errorObserverAttached,
                    endObserverAttached,
                    closeObserverAttached,
                    dataObserverAttached,
                    endObserved,
                    closeObserved,
                    errorObserved,
                    error,
                    invalidChunkObserved,
                    dataAfterTerminalEvent,
                    capturedBytes,
                    bytesObserved,
                    truncated,
                    // A string snapshot preserves exact bytes without exposing mutable
                    // storage; split UTF-8 and binary output remain byte-exact.
                    capturedBase64: storage.subarray(0, capturedBytes).toString('base64'),
                }),
        };
    }
    function terminalEvent() {
        let observed = false,
            code: number | null = null,
            signal: string | null = null;
        let invalidPayloadObserved = false;
        return {
            observe(rawCode: unknown, rawSignal: unknown) {
                const valid =
                    (rawCode === null ||
                        (typeof rawCode === 'number' && Number.isSafeInteger(rawCode))) &&
                    (rawSignal === null ||
                        (typeof rawSignal === 'string' && rawSignal.length <= 64));
                if (!valid) invalidPayloadObserved = true;
                if (!observed && valid) {
                    code = rawCode as number | null;
                    signal = rawSignal as string | null;
                }
                observed = true;
            },
            snapshot: () => Object.freeze({ observed, code, signal, invalidPayloadObserved }),
        };
    }
    const exit = terminalEvent(),
        close = terminalEvent();
    // Child terminal observers precede pipe flowing mode. The launch primitive
    // already owns the persistent child 'error' observer.
    const exitObserverAttached = register(child, 'exit', exit.observe);
    const closeObserverAttached = register(child, 'close', close.observe);
    const stdout = pipe('stdout'),
        stderr = pipe('stderr');
    // Observe both pipes' errors and terminal events before either can flow.
    stdout.start();
    stderr.start();
    return Object.freeze({
        snapshot() {
            const out = stdout.snapshot(),
                err = stderr.snapshot(),
                childClose = close.snapshot();
            const pipeHandlesDistinct =
                out.handle !== null &&
                out.handle !== undefined &&
                err.handle !== null &&
                err.handle !== undefined &&
                out.handle !== err.handle &&
                out.handle !== child &&
                err.handle !== child;
            return Object.freeze({
                child,
                registrationErrorObserved,
                registrationError,
                exitObserverAttached,
                closeObserverAttached,
                exit: exit.snapshot(),
                close: childClose,
                stdout: out,
                stderr: err,
                pipeHandlesDistinct,
                // Require reliable close evidence on all three distinct handles.
                // Raw event flags survive registration/payload/stream anomalies,
                // but the combined observation then stays false. This still
                // establishes neither native admission nor descendant retirement.
                childAndPipesCloseObserved:
                    !registrationErrorObserved &&
                    !childClose.invalidPayloadObserved &&
                    pipeHandlesDistinct &&
                    !out.invalidChunkObserved &&
                    !err.invalidChunkObserved &&
                    !out.dataAfterTerminalEvent &&
                    !err.dataAfterTerminalEvent &&
                    childClose.observed &&
                    out.closeObserved &&
                    err.closeObserved,
            });
        },
    });
}

export type WindowsInstallerChildObservation = ReturnType<
    ReturnType<typeof observeWindowsInstallerChild>['snapshot']
>;
