import path from 'node:path';

export interface SetupSuccessor {
    pid: number;
    creationTimeMs: number;
    profile: string;
}
export interface NativeSetupWindow {
    pid: number;
    executable: string;
    createdAt: string;
    handle: number;
    visible: boolean;
    minimized: boolean;
    title: string;
    version: string;
}
/** Cosmetic titles can change after navigation; native process/window identity cannot. */
export function matchesSetupSuccessor(
    root: string,
    expected: SetupSuccessor,
    version: string,
    current: NativeSetupWindow | null,
) {
    if (!current) return false;
    const expectedVersion = version.split('-')[0];
    const nativeVersion = current.version.trim().split(/[ +\-]/)[0];
    return (
        current.pid === expected.pid &&
        Number.isInteger(current.pid) &&
        current.pid > 0 &&
        path.resolve(current.executable).toLowerCase() ===
            path.join(root, 'Diagnostic Hub.exe').toLowerCase() &&
        Number.isInteger(current.handle) &&
        current.handle !== 0 &&
        current.visible === true &&
        current.minimized === false &&
        Number.isFinite(expected.creationTimeMs) &&
        Math.abs(Date.parse(current.createdAt) - expected.creationTimeMs) <= 1 &&
        (nativeVersion === expectedVersion || nativeVersion === expectedVersion + '.0')
    );
}
