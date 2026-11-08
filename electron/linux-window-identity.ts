// Electron 44 derives WM_CLASS and Wayland app ID from CHROME_DESKTOP at window creation.
// Scope the native window identity without renaming the product, launcher or data directory.
export const LINUX_DESKTOP_NAME = 'diagnostic-hub.desktop';
export const NATIVE_WINDOW_DESKTOP_NAME = 'diagnostic-hub-native.desktop';

export function withNativeLinuxWindow<T>(
    setDesktopName: (name: string) => void,
    create: () => T,
): T {
    setDesktopName(NATIVE_WINDOW_DESKTOP_NAME);
    try {
        return create();
    } finally {
        setDesktopName(LINUX_DESKTOP_NAME);
    }
}

/** Menu identity is derived only from an already validated installed record, never a CLI title. */
export function installedLinuxDesktopName(installationId: string) {
    if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            installationId,
        )
    )
        throw Error('Invalid Linux installation identity.');
    return 'diagnostic-hub-' + installationId + '.desktop';
}
export function withInstalledLinuxWindow<T>(
    setDesktopName: (name: string) => void,
    installationId: string,
    create: () => T,
): T {
    setDesktopName(installedLinuxDesktopName(installationId));
    try {
        return create();
    } finally {
        setDesktopName(LINUX_DESKTOP_NAME);
    }
}
