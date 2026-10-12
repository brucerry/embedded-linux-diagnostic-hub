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
