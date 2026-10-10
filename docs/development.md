# Development and maintenance

## Module boundaries

`src/app/App.tsx` selects pages and assembles the application shell. `src/hooks/useDeviceSession.ts`
owns connection state, periodic scheduling, snapshots, graph history and report operations. Both
editions use these same modules. The hook selects the native preload bridge on desktop or
`src/services/GatewayClient.ts` in the browser.

Page modules render overview and diagnostic search/cards. Feature modules implement the connection
dialog, evidence tables/trees/graphs, terminal, test workspace and animated transfer artwork. Common
components provide modal focus/scroll management, status badges, copy feedback and rounded icons.
Preserve component identity during live updates so focus, expanded trees and scroll positions remain
stable.

`src/features/testing/useBoardTests.ts` maintains independent connected and simulated workspaces.
Switching sources preserves only that source's settings; connection generation changes invalidate
connected setup and ignore late replies. The test page remounts on source changes to clear temporary
copy feedback, while modes and editor state live in the corresponding source hook. Diagnostic report
actions belong to diagnostic pages; Tests owns its separate test-report import and export controls.

`src/services/history.ts` prepares numeric history in a short-lived Web Worker to keep collection
parsing off the UI thread. Each worker receives evidence and the previous numeric sample, then
terminates after returning its result. Restricted browsers and portable `file://` pages use a
fallback that yields between diagnostics. Collection stays busy through preparation so disconnect,
RAM reset and updates cannot race an unfinished snapshot. Graph geometry is cached between pointer
events; a hover changes the highlighted sample only when the nearest sample changes.

Desktop and web always use full motion for transfers, hover feedback, page transitions and smooth
scrolling. There is no motion setting or saved motion preference. Regression checks must exercise
these effects with the OS reduced-motion preference enabled as well.

`shared/diagnostics/` contains the fixed command catalogue, parsers, summary findings, process
sampling and history presentation. These modules must not import Electron, React or browser globals.
`shared/types.ts` describes transport/result contracts; `shared/report.ts` validates saved reports.

`backend/ssh/session.ts` performs SSH authentication, bounded read-only collection and remote
terminal channel ownership. `backend/ssh/terminal.ts` handles PTY input/output and backpressure.
They are shared by Electron and the gateway, without importing either platform.
`backend/ssh/monitor.ts` owns desktop collection serialization. Native IPC, host-key prompts and
report dialogs stay under `electron/`; HTTP authentication, origins, target allowlists and session
expiry stay under `gateway/`.

`shared/diagnostics/device-clock.ts` defines the fixed device clock command, parser and transport
validation. `useDeviceClock` owns one independent minute schedule and transient availability state;
`DeviceClock` renders it in the shared header. Clock queries reuse the authenticated connection
through a non-PTY exec channel with a five-second deadline and 8 KiB output limit. Cancellation
closes only that query. The display uses the device's calendar and effective offset directly,
without PC timezone conversion, systemd, a device agent or report-schema changes.

Sample snapshots are **test fixtures only**, under `tests/fixtures/snapshots.ts`, with generic
hardware identities and distribution-specific output formats. The app exposes only the fixed
diagnostics, with no board profile or arbitrary diagnostic exec/file API. Terminal is a separate
interactive PTY; its user-entered commands are not diagnostic evidence.

## Formatting

Prettier is pinned in `package-lock.json`. `.prettierrc.json` and `.editorconfig` specify four
spaces, no indentation tabs, LF endings and a preferred 100-character wrap width. Configure your
editor to use the repository formatter; `npm run format` formats maintained source, tests,
configuration and documentation. `npm run format:check` is enforced in all CI builds. Generated
bundles, release artifacts, test recordings and the dependency lockfile are excluded from
formatting.

Keep functions focused on one responsibility and use named prop types for complex components.
Explain measurement semantics and failure handling where the code cannot make them obvious.
Formatting does not wrap literal probe commands or rewrite device-output fixtures: their exact
contents are part of the collection/parser contract.

## Add or change a diagnostic

1. Add a bounded, read-only command to `shared/diagnostics/probes.ts`; discover capabilities instead
   of choosing behavior from a board model. Preserve an installed tool's meaningful failures.
2. Add types/parsing under `shared/diagnostics/`. Keep standard output accessible even when no
   structured interpretation is suitable. Tables need meaningful columns; hierarchical values use
   trees. Plot only real numeric readings and document units and sample semantics.
3. Add parser and loopback SSH cases under `tests/`, including absent tools, partial evidence and
   malformed output. Add browser coverage when behavior changes; fixture data stays under tests.
4. Run `npm run verify`, browser tests and the desktop smoke test. Update hardware/design docs if
   coverage or interpretation changes. Explicitly authorized real-device validation supplements
   these checks; do not install tools, modify configuration or stress hardware during collection.

## Verification

Windows window transitions are coordinated by `electron/window-transitions.ts`. The authoritative
native frame is retained. `electron/native-window.c` attaches `SetWindowSubclass` to this window's
HWND and intercepts `WM_SYSCOMMAND/SC_MINIMIZE` before the OS minimizes it. Ordinary messages,
including resizing and destruction, stay on the native Windows stack. The handler posts a private
notification to Electron's message hook; no window procedure calls JavaScript through FFI.
`electron/native-window.ts` uses pinned Koffi only for ordinary native function calls and defers
preparation until the caption handler returns. Per-window DWM transitions are suppressed only for
the custom handoff and restored on completion/recovery. It installs no global hook and changes no
system settings. Native state is released during shutdown or `WM_NCDESTROY`, and pending
notifications cannot invoke a disposed controller. The renderer has no window-control API or
Minimize button. Native paths bypassing the system command retain fallback. The authoritative main
window keeps its bounds, identity and device resources. A separate sandboxed overlay with its own
preload receives only a transient content snapshot and geometry; hub IPC continues to require the
exact main frame and URL. Sender, frame, URL and generation checks protect overlay callbacks. A
two-second watchdog handles cancellation, capture failure and renderer death.

`electron/taskbar-query.ps1` is a fixed read-only Windows helper, bundled by the desktop build. It
queries shell taskbar geometry and matches accessibility metadata to the app's AUMID; it does not
click, focus or change shell settings. Physical rectangles become Electron DIP rectangles before
selecting a monitor and button. An unavailable button uses the taskbar center; ambiguous placement
uses native behavior. The helper warms once and is queried only for transitions, with bounded
requests and shutdown cleanup. Geometry tests cover all edges, button centers, negative origins,
image scaling and autohide clamping. No snapshots enter logs, reports or disk storage.

Transition preparation overlaps the fresh taskbar query, snapshot capture/encoding and hidden
renderer startup. The renderer waits for its authorized generation's payload before painting; a
cancellation resolves that wait and destroys the surface. Taskbar accessibility properties are
fetched in one fresh batch and matched in the helper's compiled code, without retaining old button
positions or polling while idle. Each direction still creates and releases its own transient window.
Window creation begins after the native restore callback returns. Generation guards after native
creation, bounds and visibility changes discard reentrant cancellation instead of retaining an
unloaded surface or delivering stale pixels to a newer transition.

Run `npm run test:genie-desktop` on Windows for real Electron security, failure recovery, native and
maximized paths, and sustained loopback SSH/PTY output while minimized beyond the consumer deadline.
Use `HUB_TEST_EXECUTABLE` for a packaged executable. Manual compositor review should include actual
taskbar clicks, Win+D, customized taskbar edges, autohide and mixed DPI. The Linux branch checks
native fallback without an in-app Minimize action. The web build includes only its existing main
HTML entry.

Building the Windows desktop requires Visual Studio C++ Build Tools and an x64 Windows SDK.
`scripts/build-native-window.mjs` discovers the installed compiler without changing machine PATH,
compiles the small native message gate with a static runtime and bundles its DLL outside ASAR. Linux
and web builds skip this compiler step; downloaded apps require no compiler installation. Close
development instances before rebuilding their loaded DLL.

Run `npm run test:genie-stress` on Windows for 100 native minimize/restore cycles, external-process
resizes, resizing during restoration, interrupted transitions, forced garbage collection and native
close with a zero exit code. `HUB_GENIE_CYCLES` sets the cycle count; `HUB_TEST_EXECUTABLE` selects
the packaged runtime. Windows CI runs the same stress test against the packaged app.

`npm run test:genie-latency` measures 12 native cycles with start-delay and frame-interval
median/p95 statistics. Run it without other builds or tests for a useful timing comparison. The
default p95 startup gate is 400 ms; `HUB_GENIE_MAX_START_MS` adjusts it for qualification hardware.

### Genie qualification limits

Windows qualification uses native system-command messages, packaged security/recovery checks,
100-cycle resize stress, and sustained SSH/PTY and test-run continuity. Both installed displays were
checked, including a negative origin and 125% scaling. Geometry tests cover all four taskbar edges,
autohide and fresh button placement. Physical testing on this PC used top taskbars; the other edges
and autohide were not physically configured. Automated checks do not establish compositor appearance
or the behavior of every Windows shell path. The user reviewed the native animation on this PC.

The early prototype did not receive a recorded visual acceptance check before native integration;
that historical checkpoint remains unverified. Linux fallback is checked by packaged CI under Xvfb,
but no Linux desktop environment was available for local compositor review. Performance measurements
are observations on this PC and vary with background load. The helper retains initialized native
metadata types in memory, with no idle polling; the effect does not imply zero idle memory use.

```sh
npm run verify
npx playwright install --with-deps chromium
npm run test:e2e
npm run test:desktop
npm run build:web
npm run package:win
npm run verify:package
npm run package:linux
npm run verify:linux
npx playwright install --with-deps firefox webkit
npm run test:portability
```

On Linux without a display, run the desktop test under Xvfb. WSL can use WSLg. Only the Linux test
harness normally passes Electron's `--no-sandbox`; set `HUB_TEST_SANDBOX=1` to test normal
production sandbox behavior. After Linux packaging, `npm run test:desktop-update` verifies a real
AppImage download and quit/relaunch using a local future-release fixture, preserving the private
test profile and trusted loopback SSH. It does not publish or modify GitHub releases. Linux package
CI sets this option and exercises both AppRun and AppImage extraction without FUSE. Production
launchers never add `--no-sandbox` automatically.

Windows packaged checks use temporary profiles and loopback SSH, without touching saved user keys or
connected boards:

```powershell
./tests/windows-launch.ps1 -Executable "$PWD/release/Diagnostic-Hub.exe"
./tests/windows-host-verification.ps1 -Executable "$PWD/release/Diagnostic-Hub.exe"
```

The latter verifies changed-host-key cancellation/approval, remembered-key reconnect, an enabled
native window and UI cursor styles, plus valid LAN evidence retained alongside unavailable-attribute
warnings. It also requires the native cursor to stay visible when Windows reports a visible cursor
before launch. Hosted desktops without an initially visible pointer report that physical check as
unavailable; their UI and connection checks still run. Add `-RequireVisibleCursor` on an interactive
Windows PC to require physical cursor acceptance. Physical target validation is separate from these
loopback tests; follow [validation guidance](validation.md) and compare the collected report against
direct read-only SSH output on the nominated target.

## Dependencies and generated assets

Use Node.js 24 and `npm ci` for repeatable builds. Update dependencies intentionally, commit the
manifest and lockfile together, and run the same browser/native/package checks as CI. Recheck the
embedded Electron runtime and Windows compatibility when updating Electron.

Icons are generated by `npm run generate:icons` from the shared brand source. Review generated icon
changes and verify the packaged icon sizes. Keep device reports, `.env.gateway`, SSH private keys,
certificates and `validation/` outside source control.

## SSH to the client host

The desktop accepts `localhost`, `127.0.0.1` and `::1` as SSH targets. The host must run an SSH
server on the selected port, and you must supply a valid local account and verify its host key.
Windows desktop loopback reaches Windows; a Linux desktop launched in WSL reaches that WSL
environment. Use the other environment's reachable address when it is the intended target. Linux
diagnostics need a Linux SSH shell; connecting to a Windows SSH shell does not provide procfs/sysfs.

For the website, the gateway opens the SSH connection. Loopback addresses therefore identify the
gateway's host or container, not the computer displaying the browser. Configure that exact address,
port and trusted fingerprint in `HUB_TARGETS_JSON`, then select it in the connection dialog. A local
gateway can diagnose the same Linux host if its SSH server is reachable from the gateway process.

The unit, desktop and website gateway tests use temporary SSH servers bound to loopback ports. They
exercise real SSH authentication and collection against synthetic evidence without requiring a
system SSH service or changing the host's configuration.

## Update and reset verification

The native update coordinator owns collection draining, SSH disconnection, report backups, verified
downloads and relaunch. Its lock prevents new SSH connections or collections until the restart, and
releases on failure without reconnecting. `UpdateReports` keeps durable JSON backups separate from
the acknowledged recovery marker. The shared renderer owns RAM reset and graph history; reset keeps
the existing transport open.

`tests/update-coordinator.test.ts` covers all modes, active collection, overlapping requests,
backup/download/relaunch failures and bounded recovery. The browser update/reset tests cover
cancellation, report restoration, collection pause/resume and fresh graph history. The native
AppImage test performs a real coordinated smart update from a connected loopback device and checks
the imported report with SSH disconnected after restart. Release-note tests use an isolated Git
repository to cover direct and merged commits between published version tags. Keep public release
notes in `docs/releases/<tag>.md` to a few important changes and links to detailed guides. The
release page uses those notes and links the full comparison against the previous published release.

Terminal verification lives in `tests/terminal*.test.ts`, `tests/ui/terminal.spec.ts`, and the
native smoke suite. Browser interaction cases also cover automatic startup before tab selection,
clipboard shortcuts/menu/feedback, representative xterm keys, prompt-preserving clear, pixel
animation, mobile layout and connection-form drag dismissal. Shell key bindings remain device-owned;
see [xterm's terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/) and
[GNU Readline](https://www.gnu.org/software/bash/manual/html_node/Command-Line-Editing.html).
Additional transport checks live in the native desktop smoke test. Loopback PTY fixtures cover byte
input, shell state, Unicode, resize, concurrent diagnostics, host API validation, bounded output,
gateway authentication, rate limits and cleanup. The terminal remains mounted during page
transitions. Reset clears its local display history but keeps the remote shell open; report and
update backup schemas remain diagnostic-only. For an isolated browser test port, set
`HUB_TEST_ORIGIN` to the test server origin when using a local Playwright configuration; the default
remains `http://127.0.0.1:5173`.

Terminal regression checks fill scrollback to test the bottom prompt and wheel containment, verify
Clear terminal focus, right-click selection menus and synchronized sprite kicks. An opt-in
`HUB_BASH_PTY_TEST=1` browser qualification uses the local ignored `.codex/bash-shell.cjs` adapter
when installed to exercise actual interactive Bash continuations, subshells, loops, editing,
interrupts and Ctrl+L redraw through SSH/gateway/xterm. The ordinary fixture deliberately imitates
only a few commands and cannot qualify shell syntax. This PC's local demo supports `--bash` for Git
Bash through a real Windows PTY; commands then run on the developer's PC, with diagnostic readings
still synthetic. Production always runs the connected device's shell.

Clock coverage lives in `tests/device-clock*.test.ts`, `tests/ui/device-clock.spec.ts`, the native
smoke suite and production website portability tests. It covers minimal GNU/BusyBox output,
authenticated access, time/output bounds, query cancellation, terminal/report isolation, older
gateways, independent minute polling, resume/reset/reload/reboot activity and late session replies.
Use the existing Linux SSH qualification environment when available; record unavailable tool/server
combinations explicitly rather than claiming they passed.

Reset scheduling is paused by its internal lock without changing the user's live-update setting. The
progress dialog is rendered outside the inert app shell, so keyboard focus and scrolling stay inside
the overlay. Reset waits for collection to finish, clears renderer/native RAM, retains the current
page, and keeps the overlay up until the first fresh live snapshot is ready. Failed cleanup releases
the lock and preserves evidence. A collection failure during the wait remains paused. `openReleases`
opens one fixed GitHub releases URL through the trusted native bridge.

Once a workspace has displayed evidence, reset preserves its page components when data is cleared.
Overview/report fields become unavailable without substituting a connection or fresh-record guide.
The cover paints for at least 300 ms for fast RAM-only cleanup, blocks interaction throughout fresh
snapshot/history preparation, and is released on success or failure. Failure leaves cleared values
and an actionable error rather than stale readings.
