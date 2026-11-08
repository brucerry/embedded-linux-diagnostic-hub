import path from 'node:path';
import {
    WINDOWS_WINDOW_QUERY_SOURCE,
    decodeWindowsWindowQuery,
    type WindowQueryCapture,
} from './windows-installer-window-query';
import {
    consumeWindowQueryScratch,
    type WindowQueryScratch,
} from './windows-installer-window-query-scratch';

type Listener = (...args: any[]) => void;
interface Events {
    on(name: string, listener: Listener): unknown;
    off(name: string, listener: Listener): unknown;
}
export interface QueryPipe extends Events {
    readonly readableEnded: boolean;
    readonly closed: boolean;
    readonly destroyed: boolean;
}
export interface QueryChild extends Events {
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    readonly stdout: QueryPipe | null;
    readonly stderr: QueryPipe | null;
}
export interface QuerySpawnOptions {
    cwd: string;
    shell: false;
    detached: false;
    windowsHide: true;
    stdio: ['ignore', 'pipe', 'pipe'];
    env: { SystemRoot: string; WINDIR: string; TEMP: string; TMP: string; USERPROFILE: string };
}
/** The injection boundary is for controlled tests, not installer/native admission. */
export interface WindowQueryHost {
    scope: 'controlled-memory';
    platform: string;
    systemRoot: string | undefined;
    spawn(file: string, args: string[], options: QuerySpawnOptions): QueryChild;
}

/** Definition-only until called. No installer, close/kill primitive, shell or arbitrary query. */
export async function invokeWindowsWindowQuery(
    requestedPID: number,
    scratch: WindowQueryScratch,
    host?: WindowQueryHost,
) {
    if (!Number.isInteger(requestedPID) || requestedPID < 1 || requestedPID > 2147483647)
        throw Error('WINDOW_QUERY_PID_INVALID');
    // No supported Windows handle-bound scratch-to-process primitive is implemented.
    // Repeated path checks alone cannot rule out replacement between check and spawn.
    if (!host || host.scope !== 'controlled-memory')
        throw Error('WINDOW_QUERY_NATIVE_PATH_CUSTODY_UNAVAILABLE');
    if (host.platform !== 'win32') throw Error('WINDOW_QUERY_WINDOWS_REQUIRED');
    const root = host.systemRoot;
    if (
        typeof root !== 'string' ||
        !/^[a-z]:\\/i.test(root) ||
        root.includes('/') ||
        root.split('\\').some((part) => part === '.' || part === '..') ||
        /[\x00-\x1f"%]/.test(root) ||
        path.win32.normalize(root).replace(/\\$/, '') !== root.replace(/\\$/, '')
    )
        throw Error('WINDOW_QUERY_SYSTEM_ROOT_INVALID');
    const temporary = await consumeWindowQueryScratch(scratch, 'controlled-memory');
    const command = `& {\n${WINDOWS_WINDOW_QUERY_SOURCE}\n} -TargetProcessId ${requestedPID}`;
    const executable = path.win32.join(
        root,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
    );
    const args = [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64'),
    ];
    const state = {
        child: null as QueryChild | null,
        returned: false,
        spawnObserved: false,
        exitObserved: false,
        closeObserved: false,
        exitCode: null as number | null,
        signal: null as string | null,
        closeCode: null as number | null,
        closeSignal: null as string | null,
        historyUncertain: false,
        observationUncertain: false,
        registrationComplete: false,
        invocationError: null as unknown,
        childError: false,
        listenersDetached: false,
        settled: false,
    };
    const pipe = (limit: number) => ({
        limit,
        bytes: 0,
        retained: Buffer.alloc(0),
        endObserved: false,
        closeObserved: false,
        error: false,
        overflow: false,
    });
    const stdout = pipe(8192),
        stderr = pipe(4096);
    const bindings: { source: Events; name: string; listener: Listener }[] = [];
    let resolve!: (value: WindowQueryCapture) => void;
    const completed = new Promise<WindowQueryCapture>((done) => {
        resolve = done;
    });
    function capture(): WindowQueryCapture {
        let failure: WindowQueryCapture['failure'] = 'none';
        if (state.childError && !state.spawnObserved) failure = 'spawn-error';
        else if (
            stdout.error ||
            stderr.error ||
            stdout.overflow ||
            stderr.overflow ||
            state.historyUncertain ||
            state.observationUncertain ||
            (state.settled && (!stdout.endObserved || !stderr.endObserved))
        )
            failure = 'capture-error';
        else if (
            state.childError ||
            !state.spawnObserved ||
            !state.exitObserved ||
            state.exitCode !== 0 ||
            state.signal !== null ||
            state.closeCode !== state.exitCode ||
            state.closeSignal !== state.signal
        )
            failure = 'query-error';
        if (!state.settled) failure = 'pending';
        return {
            requestedPID,
            returned: state.returned,
            exitCode: state.exitCode,
            signal: state.signal,
            stdoutEOF: stdout.endObserved,
            stderrEOF: stderr.endObserved,
            failure,
            stdout: Buffer.from(stdout.retained),
            stderr: Buffer.from(stderr.retained),
        };
    }
    function settle() {
        if (
            state.settled ||
            !state.registrationComplete ||
            !state.closeObserved ||
            !stdout.closeObserved ||
            !stderr.closeObserved ||
            state.observationUncertain
        )
            return;
        state.settled = true;
        let detached = true;
        for (const { source, name, listener } of bindings) {
            try {
                source.off(name, listener);
            } catch {
                detached = false;
            }
        }
        state.listenersDetached = detached;
        if (!detached) state.observationUncertain = true;
        resolve(capture());
    }
    function attach(source: Events, name: string, listener: Listener) {
        bindings.push({ source, name, listener });
        try {
            source.on(name, listener);
        } catch {
            state.observationUncertain = true;
        }
    }
    function adopt(source: QueryPipe | null, observed: typeof stdout) {
        if (!source) {
            state.observationUncertain = true;
            return;
        }
        try {
            if (source.readableEnded || source.closed || source.destroyed)
                state.historyUncertain = true;
        } catch {
            state.observationUncertain = true;
        }
        attach(source, 'error', () => {
            observed.error = true;
        });
        attach(source, 'end', () => {
            observed.endObserved = true;
        });
        attach(source, 'close', () => {
            observed.closeObserved = true;
            settle();
        });
        attach(source, 'data', (chunk) => {
            if (!(chunk instanceof Uint8Array)) {
                observed.error = true;
                return;
            }
            const room = observed.limit - observed.retained.length;
            // Continue draining after overflow, retaining only the bounded prefix.
            if (room > 0)
                observed.retained = Buffer.concat([
                    observed.retained,
                    Buffer.from(chunk.subarray(0, room)),
                ]);
            observed.bytes = Math.min(Number.MAX_SAFE_INTEGER, observed.bytes + chunk.byteLength);
            if (observed.bytes > observed.limit) observed.overflow = true;
        });
    }
    try {
        const child = host.spawn(executable, args, {
            cwd: root,
            shell: false,
            detached: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                SystemRoot: root,
                WINDIR: root,
                TEMP: temporary,
                TMP: temporary,
                USERPROFILE: temporary,
            },
        });
        state.child = child;
        state.returned = true;
        if (child.exitCode !== null || child.signalCode !== null) state.historyUncertain = true;
        attach(child, 'error', () => {
            state.childError = true;
        });
        attach(child, 'spawn', () => {
            state.spawnObserved = true;
        });
        attach(child, 'exit', (code: number | null, signal: string | null) => {
            state.exitObserved = true;
            state.exitCode = code;
            state.signal = signal;
        });
        attach(child, 'close', (code: number | null, signal: string | null) => {
            state.closeObserved = true;
            state.closeCode = code;
            state.closeSignal = signal;
            settle();
        });
        adopt(child.stdout, stdout);
        adopt(child.stderr, stderr);
        state.registrationComplete = true;
        settle();
    } catch (error) {
        // An injected/uncertain invocation throw is not evidence that no child exists.
        state.invocationError = error;
        state.observationUncertain = true;
    }
    return {
        completed,
        get custody() {
            return { ...state };
        },
        snapshot: () => ({
            capture: capture(),
            stdoutBytes: stdout.bytes,
            stderrBytes: stderr.bytes,
            stdoutOverflow: stdout.overflow,
            stderrOverflow: stderr.overflow,
            stdoutCloseObserved: stdout.closeObserved,
            stderrCloseObserved: stderr.closeObserved,
        }),
        decoded: async () => {
            await completed;
            return decodeWindowsWindowQuery(capture());
        },
    };
}
