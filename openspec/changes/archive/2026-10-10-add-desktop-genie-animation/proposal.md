# Proposal

## Why

Diagnostic Hub can make desktop minimize and restore feel more polished with the macOS-inspired
Genie effect demonstrated by UI Layouts. The transition must remain a visual enhancement: the
connected device, interactive shell and running board tests must retain their existing lifecycle.

## What Changes

- Apply the effect to the native Windows title-bar/system-menu **Minimize** command, contracting a
  snapshot of the application content toward the current Windows taskbar over approximately 500 ms,
  with a reverse restore. Detect its left, top, right or bottom edge dynamically on minimize and
  restore, including per-display bars, and anchor both directions to the application's current
  taskbar button when uniquely exposed.
- Coordinate a temporary transparent animation overlay with genuine Electron minimization, keeping
  the main window, native frame, taskbar entry and live workspace intact.
- Preserve bounds, maximized state, keyboard focus, SSH/PTY state and test execution across the
  transition; handle repeated requests and interruptions without stranded invisible windows.
- Use ordinary native transitions for OS paths bypassing the native system command, unsupported
  platforms, reduced motion and capture/rendering failures. Restore after a native-command Genie
  minimize uses the reverse effect when supported, including a taskbar restore.
- Document the supported paths and verify geometry, lifecycle continuity, recovery and idle cost.
- Reduce the pause after native minimize/restore requests by overlapping independent preparation and
  batching fresh taskbar properties, with real startup-latency and frame-pacing measurements.

## Capabilities

### New Capabilities

- `desktop-window-transitions`: Snapshot-based Genie minimize/restore, native fallback, display
  geometry, transient-resource ownership and preservation of device work.

### Modified Capabilities

None. Existing terminal, clock and board-test requirements remain in force. The new desktop
transition gets a reduced-motion exception without changing existing full-motion page animations.

## Impact

- Electron window creation and lifecycle in `electron/main.ts`; new transition controller, read-only
  Windows taskbar geometry adapter and locally bundled, sandboxed overlay renderer/preload with its
  own narrow IPC authority.
- A compiled C message gate for only the owned native HWND, with pinned Koffi for ordinary native
  calls and no JavaScript FFI window procedure, plus a narrow restore notification in
  `electron/preload.ts` and `shared/types.ts`. No in-app motion button or renderer minimize API is
  provided.
- Build/package entry points, focused controller/geometry tests, native desktop smoke coverage and
  desktop/web capability checks. Gateway, SSH commands and report schemas are unaffected.
- `docs/design.md`, `docs/development.md` and `docs/usage.md` for behavior and compatibility notes.
- Adapt the canvas-warp technique from [UI Layouts](https://www.ui-layouts.com/components/mac-genie)
  rather than importing its mock desktop/dock. Retain applicable upstream license attribution for
  reused code; no dependency installation is planned just for its demo scaffolding.
