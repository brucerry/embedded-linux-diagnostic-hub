import path from 'node:path';
import {
    observeWindowsInstallerChild,
    type WindowsInstallerChildObservation,
} from './windows-installer-child-observation.ts';

// Source-only building block. Not wired to the offline CLI or installer admission.
// It does not establish payload identity, process identity, complete event history,
// or descendant retirement. A caller must retain and observe the returned handle.
export interface FixedLaunchHost {
    platform: string;
    environment: NodeJS.ProcessEnv;
    spawn(
        file: string,
        args: string[],
        options: {
            cwd: string;
            shell: false;
            detached: false;
            windowsHide: false;
            stdio: ['ignore', 'pipe', 'pipe'];
            env: NodeJS.ProcessEnv;
        },
    ): unknown;
}
export interface FixedLaunchCustody {
    readonly attempted: boolean;
    readonly handleReturned: boolean;
    readonly child: unknown;
    readonly invocationError: unknown;
    readonly errorObserverAttached: boolean;
    readonly processErrorObserved: boolean;
    readonly processError: unknown;
    readonly observation: WindowsInstallerChildObservation | null;
    readonly outcome:
        | 'not-attempted'
        | 'returned-unobserved'
        | 'invocation-uncertain'
        | 'process-error-unretired';
}

// Lexical confinement only. It is not a filesystem, reparse-point, payload, or
// trust check, and must not be used as authorization to launch.
export function validatedWindowsInstallRoot(root: unknown): string {
    if (
        typeof root !== 'string' ||
        root.length > 220 ||
        !/^[A-Za-z]:\\/.test(root) ||
        root.endsWith('\\') ||
        root.includes('/') ||
        /[\x00-\x1f\x7f<>"|?*]/.test(root) ||
        path.win32.normalize(root) !== root
    )
        throw Error('FIXED_LAUNCH_ROOT_INVALID');
    const parts = root.slice(3).split('\\');
    if (
        !parts.length ||
        parts.some(
            (part) =>
                !part ||
                part === '.' ||
                part === '..' ||
                /[.:]$/.test(part) ||
                /[ ]$/.test(part) ||
                part.includes(':') ||
                /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(part),
        )
    )
        throw Error('FIXED_LAUNCH_ROOT_INVALID');
    return root;
}

// Construct custody before invoking spawn. Only one invocation is allowed, even
// after a synchronous exception: an exception does not prove no process exists.
export function createWindowsFixedLaunchAttempt(installRoot: string, host?: FixedLaunchHost) {
    // No implicit native launcher exists. Callers own any explicitly injected
    // host; this preparation's tests inject controlled doubles. A payload
    // comparison is not a launch capability and cannot supply a native host.
    if (!host) throw Error('FIXED_LAUNCH_NATIVE_ADMISSION_DISABLED');
    const root = validatedWindowsInstallRoot(installRoot);
    if (host.platform !== 'win32') throw Error('FIXED_LAUNCH_WINDOWS_REQUIRED');
    const executable = path.win32.join(root, 'Diagnostic Hub.exe');
    let attempted = false,
        handleReturned = false,
        child: unknown = null,
        invocationError: unknown = null;
    let invocationFailed = false,
        errorObserverAttached = false,
        processErrorObserved = false,
        processError: unknown = null;
    let observation: ReturnType<typeof observeWindowsInstallerChild> | null = null;
    const snapshot = (): FixedLaunchCustody =>
        Object.freeze({
            attempted,
            handleReturned,
            child,
            invocationError,
            errorObserverAttached,
            processErrorObserved,
            processError,
            observation: observation?.snapshot() ?? null,
            outcome: !attempted
                ? 'not-attempted'
                : invocationFailed
                  ? 'invocation-uncertain'
                  : processErrorObserved
                    ? 'process-error-unretired'
                    : handleReturned
                      ? 'returned-unobserved'
                      : 'invocation-uncertain',
        });
    return Object.freeze({
        executable,
        snapshot,
        invoke(): FixedLaunchCustody {
            if (attempted) throw Error('FIXED_LAUNCH_ALREADY_ATTEMPTED');
            attempted = true;
            try {
                // A packaged Electron application must not inherit the parent
                // worker's Node mode or portable-app launch context. Windows
                // environment names are case-insensitive. Preserve the remaining
                // environment, including system and user-profile settings.
                const env = { ...host.environment };
                const stripped = new Set([
                    'ELECTRON_RUN_AS_NODE',
                    'PORTABLE_EXECUTABLE_FILE',
                    'PORTABLE_EXECUTABLE_DIR',
                    'PORTABLE_EXECUTABLE_APP_FILENAME',
                    'NODE_OPTIONS',
                    'NODE_PATH',
                ]);
                for (const key of Object.keys(env))
                    if (stripped.has(key.toUpperCase())) delete env[key];
                // Direct executable only. No caller-provided command line or shell.
                const returned = host.spawn(executable, [], {
                    cwd: root,
                    shell: false,
                    detached: false,
                    windowsHide: false,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env,
                });
                // A nullish or primitive test-host return cannot be adopted.
                // As with an exception, it does not establish process absence.
                if (
                    (typeof returned !== 'object' && typeof returned !== 'function') ||
                    returned === null
                )
                    throw Error('FIXED_LAUNCH_HANDLE_UNAVAILABLE');
                child = returned;
                handleReturned = true;
                // Node reports spawn failures asynchronously through 'error'.
                // Retain custody before observer registration, which may throw.
                // Keep the listener for custody's lifetime: a later error must
                // not become an uncaught EventEmitter error. Only retain the
                // first error, so repeated events do not grow an evidence list.
                if (!('on' in returned) || typeof returned.on !== 'function')
                    throw Error('FIXED_LAUNCH_ERROR_OBSERVER_UNAVAILABLE');
                returned.on('error', (error: unknown) => {
                    if (!processErrorObserved) processError = error;
                    processErrorObserved = true;
                });
                errorObserverAttached = true;
                observation = observeWindowsInstallerChild(returned);
            } catch (error) {
                invocationFailed = true;
                invocationError = error;
            }
            return snapshot();
        },
    });
}
