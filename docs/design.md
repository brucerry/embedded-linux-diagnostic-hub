# Window and workspace design

The desktop uses a normal framed Electron BrowserWindow. Native minimize, restore, maximize and
close are owned by Windows or the Linux compositor. Restore sends a notification so the existing
terminal can refresh its layout; it does not recreate the SSH connection or PTY. No transient
animation window, capture surface, native message hook, taskbar helper, Koffi dependency or motion
IPC remains.

Linux keeps diagnostic-hub.desktop, the diagnostic-hub executable, product name, updater identity
and user-data paths. During window construction only, the Electron desktop identity is scoped to
diagnostic-hub-native.desktop, which sets WM_CLASS and the Wayland app ID to diagnostic-hub-native.
The existing desktop identity is restored immediately afterward, including on construction failure;
matching StartupWMClass metadata keeps the original launcher file name. The legacy app-specific
extension requires both the previous exact class and desktop ID, so it cannot match the new class.
No installed extension or global preference is modified. A compositor may regroup an existing pinned
window until its shortcut metadata is refreshed; no duplicate launcher is created.

Overview, Diagnostics and Terminal share one device session. Tests discovery/execution/report IPC
and gateway routes have been retired. Ordinary probes and clock parsers do not import the old DT
inventory parser. The reported OpenWrt error was not reproduced or repaired; removing the live Tests
path prevents invoking that parser through the application. Pure historical report validators remain
for offline schema regression coverage.

Electron 44.5.1 derives these window properties from
[CHROME_DESKTOP](https://github.com/electron/electron/blob/v44.5.1/shell/common/platform_util_linux.cc#L460)
at
[window construction](https://github.com/electron/electron/blob/v44.5.1/shell/browser/native_window_views.cc#L294);
the Chromium --class switch does not override them. The retained compositor gates verify the actual
class and stable identity restoration.
