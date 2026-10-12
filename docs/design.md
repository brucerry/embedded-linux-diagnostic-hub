# Window and workspace design

The desktop uses a normal framed Electron BrowserWindow. Native minimize, restore, maximize and
close are owned by Windows or the Linux compositor. Restore sends a notification so the existing
terminal can refresh its layout; it does not recreate the SSH connection or PTY. No transient
animation window, capture surface, native message hook, taskbar helper, Koffi dependency or motion
IPC remains.

Linux keeps diagnostic-hub.desktop, the diagnostic-hub executable, product name, updater identity
and user-data paths. Only the window class becomes diagnostic-hub-native, with matching
StartupWMClass metadata. The legacy app-specific extension requires both the previous exact class
and desktop ID, so it cannot match the new class. No installed extension or global preference is
modified. A compositor may regroup an existing pinned window until its shortcut metadata is
refreshed; no duplicate launcher is created.

Overview, Diagnostics and Terminal share one device session. Tests discovery/execution/report IPC
and gateway routes have been retired. Ordinary probes and clock parsers do not import the old DT
inventory parser. The reported OpenWrt error was not reproduced or repaired; removing the live Tests
path prevents invoking that parser through the application. Pure historical report validators remain
for offline schema regression coverage.
