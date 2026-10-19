# Design

## Context

See `proposal.md` for motivation and `specs/desktop-window-transitions/spec.md` for the contract.
The current app uses Electron 44.5.1 with one normally framed, opaque `BrowserWindow` in
`electron/main.ts`. Only closing the main window or quitting clears its SSH monitor. The renderer
has a sandboxed, isolated preload, and privileged handlers verify the exact main window, frame and
URL. There is currently no window-control API.

`src/app/App.tsx` already has desktop-only header actions. Terminal remains mounted across pages;
its transport has output credit and a 30-second stalled-consumer deadline. The clock and terminal
artwork already respond to visibility. `tests/desktop-smoke.ts` supplies a loopback SSH/PTY fixture
and exercises real Electron, including packaged builds. Windows and Linux have separate CI jobs.

The UI Layouts component animates snapshots of simulated DOM windows with horizontal canvas strips.
It does not control native windows. Its fixed demo dimensions, mock dock, icons and dependencies are
not needed here. Electron's documented `minimize` event occurs after minimization, so it is not a
cancellable hook for intercepting every native Windows path.

The documented full-motion policy and `tests/ui/motion.spec.ts` deliberately preserve page/hover
animation under reduced motion. This design adds a narrowly documented desktop-window exception.

## Goals / Non-Goals

**Goals:**

- Separate native lifecycle coordination from a testable geometry/warp renderer.
- Keep one authoritative main workspace; animation never remounts the app or owns device resources.
- Make failure recovery independent of a successful animation callback.

**Non-Goals:**

- Replace the native window frame or emulate a macOS desktop. Following the current taskbar edge and
  the uniquely identified application button is in scope.
- Intercept Win+D or all OS/compositor animations that bypass the native system command.
- Add Linux/Wayland Genie support, global motion settings, new diagnostic commands or a release.

## Decisions

### 1. Windows-only native-command entry point, with native controls retained

Use a compiled C message gate to attach `SetWindowSubclass` only to the main window's HWND on its
owning thread. Forward ordinary messages directly on the native Windows stack, without a JavaScript
FFI window procedure or forwarding Chromium on an alternate FFI stack. Post a registered message to
Electron's own hook for the minimize notification. Pinned Koffi (MIT, Node-API prebuilt Windows x64)
calls only ordinary native functions. Intercept `WM_SYSCOMMAND/SC_MINIMIZE`, defer preparation until
the native caption handler returns, and hand off through a guarded real minimize. The native title
bar, system menu, resizing/maximize/snap and taskbar remain the controls. There is no header
minimize button or renderer minimize API. Keep only a narrow restore notification for the device
clock.

Suppress DWM transitions per window while the custom handoff owns minimization/restoration, and
restore them on completion or recovery. Never change global animation preferences. Remove the
subclass before HWND destruction; `WM_NCDESTROY` also releases any remaining native state. Hook
failures fall back to the original window procedure. Paths bypassing SC_MINIMIZE retain native
fallback; do not restore an already minimized window merely to replay an outgoing animation.

Build the gate with installed MSVC and the Windows SDK, using a static runtime and an unpacked DLL.
Only Windows desktop builds require this compiler; Linux and web builds skip the step. Qualify
external-process resizing, resizing during restoration, interrupted native cycles, garbage
collection and native close against both development and packaged runtimes.

### 2. On-demand native capture and a temporary overlay

Use `webContents.capturePage()` for the application content, including xterm's rendered canvas. Use
the documented `stayHidden` option for any hidden capture. This avoids DOM reconstruction and does
not capture the OS frame or other applications. Capture once per direction; restoration uses a fresh
snapshot where possible rather than retaining terminal/credential pixels while minimized. Bound
snapshot dimensions while preserving aspect ratio (initial target: at most four million pixels), and
bound preparation with the same recovery deadline as the whole transition.

Render through an independent frameless transparent window covering the union of content bounds and
destination anchor. It has no taskbar entry, shadow, input or focus and is not a modal/child window
whose lifetime automatically follows main-window minimization. Show it without activation; ignore
mouse events. Bundle its entry point locally with a dedicated preload and strict CSP. It receives
only one transition payload and returns readiness/completion, never the general hub API.

Reuse or adapt only the reference's easing/strip-warp technique, with applicable MIT attribution if
copying source. Use canvas and requestAnimationFrame directly; do not install `html-to-image`,
Motion or a dock component solely for this animation. A renderer-only in-page effect cannot draw
over the desktop when the real window is minimized, so it does not meet the selected behavior.

### 3. Main-process controller with a bounded visibility handoff

Use a separate controller, provisionally `electron/window-transitions.ts`, with explicit states:
`visible`, `preparing-minimize`, `minimizing`, `minimized`, `preparing-restore`, `restoring`,
`disposed`. Give every attempt a generation ID, one deadline and a final desired native state. Prime
taskbar metadata asynchronously without delaying the main page. Until initialization finishes,
native controls remain immediate and use their ordinary behavior; no in-app readiness control is
needed. Ignore callbacks from old generations; coalesce duplicate requests; a newer contrary request
cancels the old attempt into its requested native state rather than stacking overlays.

For minimize, record content/window bounds, maximized state and eligible renderer focus. Prepare
capture/overlay before concealing the main window. Once the overlay confirms its first full-size
frame, temporarily set the main window's opacity to zero, perform the genuine minimize, and run the
outgoing warp. This keeps its taskbar identity while the content snapshot animates. No window bounds
are shrunk. Dispose the outgoing overlay and image when finished; retain only small transition
metadata while minimized.

Overlap fresh taskbar lookup, capture/PNG encoding and hidden renderer startup rather than awaiting
each in sequence. Create the transient renderer at the source bounds, then apply the final queried
geometry before delivering its generation's payload. Authorize the payload request normally and
resolve its wait with null on cancellation. Do not keep a hidden renderer or old snapshot between
directions. Fetch taskbar accessibility identity/rectangle properties in one fresh UI Automation
batch and match in compiled helper code; this reduces crossing/PowerShell overhead without using
stale shell positions. Measure request-to-ready latency and frame intervals in real Electron,
separately from the approximately 500 ms effect and with no competing builds/tests. Defer HWND
creation until the native restore callback has returned, and check generation after native creation,
bounds/visibility changes and opacity handoff. Windows can reenter main-window events during these
calls; cancellation must destroy an unassigned surface and prevent stale payloads or completion from
mutating the newer transition.

For an owned restore, handle the native restore event with the main window still transparent, verify
current geometry, capture current content and run the reverse warp. On completion, restore opacity
and hand off to the live content before destroying the overlay. Restore focus only if the
application is still the intended foreground target and the prior element remains eligible; never
override a new modal or another app the user selected. Do not change terminal fit dimensions for the
warped image or send synthetic device input.

A main-process watchdog expires no later than two seconds after the request/restore event. Every
failure/cancel path restores normal opacity, applies the final requested native state, destroys the
overlay, clears timers/listeners and drops image references. Main-window close and app quit dispose
the controller before ordinary SSH cleanup. A renderer reload cancels the effect into native state.
The animation renderer may disable its own background throttling during its finite lifetime; the
main workspace retains current visibility and throttling policy. Test PTY consumption while actually
minimized, beyond its stalled-consumer deadline, rather than assuming a 500 ms effect proves it.

### 4. Dynamic taskbar geometry and motion policy

Use `screen.getDisplayMatching()` on the content rectangle. Query Windows taskbar geometry before
each direction, prioritizing that display's taskbar and choosing the nearest actual taskbar if it
has none. Use `SHAppBarMessage(ABM_GETTASKBARPOS)` for the primary system taskbar, and read
secondary shell taskbar rectangles together with their monitor bounds. Native rectangles are
physical pixels; convert them with `screen.screenToDipRect()` before comparing with Electron's DIP
rectangles.

The prototype uses a fixed, read-only Windows PowerShell helper with a small P/Invoke
implementation. Initialize its native type once outside the animation deadline, then request
metadata on demand through a bounded line protocol. Do not run arbitrary commands supplied by the
renderer, require administrator privileges, poll desktop state, or modify taskbar settings. A failed
helper uses an unambiguous single work-area inset only; an unknown/ambiguous edge falls back to
native animation. The production adapter must preserve these contracts, bundle its fixed helper
script if retained, and verify its startup/query cost and shutdown ownership in packaged builds.

Read the app button's physical bounding rectangle from taskbar accessibility metadata, matching the
main-process application identity rather than another app's caption. Normalize the shell's `Appid:`
prefix and whitespace. Prefer that display's uniquely matching button, then a matching button on
another actual taskbar. Anchor to the button's center in both axes; a grouped app uses its group
button. Re-query on every direction so reordering or relocation is respected. If the shell does not
expose a unique match, use the detected taskbar center as a documented approximation. Clamp
off-screen autohide rectangles to their registered monitor edge; do not guess bottom when the work
area equals display bounds. Accessibility reads never click, focus or modify shell UI. Warm helper
queries must finish before transition queries, avoiding startup overlap. Rotate the deformation
axis, not the source image: vertical strip traversal for left/right bars, horizontal traversal for
top/bottom bars, reversing progression on top/left while preserving pixel orientation. Recompute on
restore so taskbar relocation while minimized is respected.

Convert explicitly to snapshot/canvas pixel coordinates using image dimensions and the selected
display scale factor. Compute overlay-local source and target from absolute coordinates, including
negative monitor origins; retain normal/maximized geometry.

Use approximately 500 ms in each direction with a tapering, curved Genie deformation rather than
uniform scaling. Cancel on display removal, DPI/bounds changes or unsupported geometry. Honor the OS
reduced-motion signal for this transition only; preference changes during an effect cancel to native
behavior. Do not introduce saved motion preferences or change page animation CSS.

### 5. Separate authority and transient data

Main-window window-control IPC uses existing sender/frame/URL validation. Overlay IPC separately
validates the exact overlay webContents, main frame, local URL and transition ID. The overlay cannot
invoke hub handlers, open external windows or navigate. Never relax the existing global handler
check to accept every `BrowserWindow`. Captures stay in memory and are not logged, written, uploaded
or included in reports/update backups. Cleanup includes canvas/image references and IPC listeners,
not just hiding a window.

## Risks / Trade-offs

- Windows compositor may show duplicate native animation or a full-size restore flash → prove the
  opacity/overlay handoff with a small real-Windows prototype before integrating the native hook. If
  the contract cannot be met, report that concrete limitation and revise the approach; do not
  silently deliver only a CSS scale effect or claim universal native-path support.
- Native frame disappears independently of captured content → retain and document the content-only
  scope rather than recreating OS chrome in the snapshot.
- Transparent-window/DPI behavior varies → verify actual desktop geometry, mixed DPI and maximized
  restore manually; use native fallback for unsupported cases.
- Shell/taskbar customizers may not expose standard geometry → use current native rectangles where
  available and otherwise a single work-area inset; uncertain placement falls back to native
  behavior. The prototype's warm PowerShell helper adds idle memory, which must be measured before
  choosing the final packaged adapter.
- Hidden main-renderer consumption can stall a PTY → run sustained-output continuity checks and
  address any bounded-consumer problem without keeping decorative animations active while hidden.
- Additional window affects tests that assume one window → identify the main page by its URL and
  verify overlays have no privileged bridge, taskbar entry or leaked lifetime.
- Brief snapshot can include sensitive on-screen values → capture only app content on demand and
  discard it after each direction; maintain existing evidence exclusions.

## Migration Plan

No stored-data, report or backend migration is required. Add the overlay's local HTML/renderer and
preload to the desktop build and packaged assets, preserving the web/portable-web entry points.
Windows qualification covers unpackaged and packaged app operation; Linux/browser checks confirm
native fallback and absence of controls. Document tested paths separately from unverified platform
configurations. Rollback removes the native subclass/controller and restores ordinary native
behavior without affecting sessions, profiles or reports. No commit, tag, push or release is part of
applying this proposal unless separately requested.

## References

- [UI Layouts example](https://www.ui-layouts.com/components/mac-genie) and
  [registry source](https://raw.githubusercontent.com/ui-layouts/uilayouts/main/apps/ui-layout/public/r/mac-genie.json)
- [Electron window lifecycle](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron capture API](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts)
- [Windows taskbar geometry](https://learn.microsoft.com/en-us/windows/win32/shell/abm-gettaskbarpos)
- [Windows subclass lifecycle](https://learn.microsoft.com/en-us/windows/win32/api/commctrl/nf-commctrl-setwindowsubclass)
- [Windows system minimize command](https://learn.microsoft.com/en-us/windows/win32/menurc/wm-syscommand)
- [Per-window DWM attributes](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute)
- [Koffi registered callbacks](https://koffi.dev/callbacks)
