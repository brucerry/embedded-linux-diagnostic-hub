# Proposal

## Why

Bruce wants a simpler diagnostic workspace and standard platform window behavior across Windows and Linux. He reported an OpenWrt board raising Invalid DT property through Tests discovery; that report is not reproduced parser-fix evidence and the entire Tests feature is being retired instead.

## What Changes

- **BREAKING** Remove Tests navigation, setup/JSON/simulation workspace, run/report controls and all corresponding desktop IPC, gateway routes and live SSH test lifecycle wiring. Preserve ordinary diagnostics, clock, terminal, connection trust, reports, updates and session reset.
- Remove Genie rendering, native minimize interception, taskbar geometry helpers, optional GNOME companion activation/packaging and downloader setup/removal paths. Use ordinary Electron/platform windows; preserve native restore notification and device-session continuity.
- Change only the Linux window class, keeping the desktop identity stable so an already installed app-specific legacy extension cannot match the new app. Do not uninstall extensions, change global desktop preferences or delete managed user data.
- Retain and adapt automated regression coverage for desktop/gateway/UI/window continuity/security and packaging. Preserve historical source/evidence and saved user reports; retire obsolete feature-only test programs with tracked source recoverable in Git; preserve only unique uncommitted experiments in a snapshot.
- Supersede/archive add-custom-diagnostic-tests with its actual 1/36 completion state. Preserve its undispatched UART experiment and receipts; cancel all Python-removal, socat and helper work.

- Apply the user-requested future release-page format: exact-tag name and Description, Changes, Commits, Links sections, with a prior-published-release baseline. Published notes remain unchanged.

## Capabilities

### New Capabilities

- `release-page-format`: Require the user-defined four-section release body, exact-tag title, and complete prior-published-release comparison.

### Modified Capabilities

- `board-test-profiles`: Retire live board inventory/profile workspace requirements.
- `board-test-execution`: Retire Tests UI, adapter execution and test transport requirements; require absence of retired reachable entry points.
- `board-test-reports`: Retire in-app test-run import/export controls while preserving existing files and historical evidence.
- `desktop-window-transitions`: Replace Genie-specific behavior with standard native windows and session continuity.
- `linux-genie-installation`: Retire companion installation/activation/publication requirements without modifying existing system/user extensions.

## Impact

Changes span React navigation/session state, desktop bridge/IPC, gateway API, SSH session coordination, window setup, build dependencies/assets, launchers/release validation/CI, and current documentation/tests. Published release assets/tags and historical qualification notes remain unchanged. The strict test DT parser is not silently patched; residual callers are audited, and retained legacy validators are isolated from live collection. No board operations, target package/helper installs, new distributions, system extension removal or publication are authorized.
