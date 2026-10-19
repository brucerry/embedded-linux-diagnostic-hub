# Proposal

## Why

Engineers currently need a separate SSH client to interact with a device already connected to
Diagnostic Hub. An embedded terminal will keep investigation and command execution in the same
workspace and reuse the authenticated device connection.

## What Changes

- Add a Terminal workspace tab in the shared desktop and website UI, with a real interactive SSH
  shell, keyboard input, ANSI rendering and resizing, automatically available on device connection.
- Add selection copy, a top-right button with existing feedback animation, right-click Copy/Paste
  menu with ordinary left-drag highlighting, Ctrl+C copy/interrupt and Ctrl+V paste. Preserve remote
  keymaps, color recognizable prompts, keep the current prompt/input when clearing and animate
  pixel-art duck/pig characters, trees and a tilted Earth rotating once per second behind text.
- Refresh prompt decoration after shell redraws and allow document scrolling over a normal terminal
  with no scrollback, while containing scrollback and interactive-program wheel input.
- Fit rows inside the visible terminal, isolate scrolling, restore input focus after clearing,
  preserve remote redraw cursor alignment, and verify multiline syntax against an actual Bash PTY.
- Align the ball with sprite kicks and finish fast overview collections with a complete visible
  transfer, retaining accurate collection status.
- Fix form dismissal so text-selection drags released outside the dialog retain the connection form
  while direct backdrop clicks still dismiss it.
- Reuse the current authenticated SSH transport, host verification, target, and user; opening a
  terminal does not prompt for credentials or launch a local shell.
- Keep one terminal channel per device session and preserve it while navigating within the
  workspace. Close it on SSH disconnect, target replacement, report import, update disconnect, and
  application/page exit.
- Replace an exited shell automatically on the same healthy SSH connection, preserving local history
  and restoring input focus, with bounded recovery and no command replay.
- Support desktop streaming through the isolated preload bridge and website streaming through the
  existing authenticated HTTPS gateway.
- Keep diagnostic probes read-only and report exports limited to diagnostic evidence. Terminal
  commands run with the connected SSH user's permissions and terminal transcripts remain in bounded
  RAM.
- Update product and gateway documentation to distinguish automatic read-only diagnostics from
  user-entered interactive commands. The existing whole-product read-only claim will no longer
  describe the terminal feature.

- Verify diagnostic exec stdout/stderr and collected kernel logs remain separate from PTY output
  during concurrent commands and five-second live refresh; document direct remote PTY broadcasts.

## Capabilities

### New Capabilities

- `connected-device-terminal`: An embedded, interactive, session-bound terminal for the currently
  connected SSH device, shared across desktop and gateway-backed website editions.

### Modified Capabilities

None. No main OpenSpec capabilities exist yet; the current read-only scope is described in README
and architecture documentation.

## Impact

- Backend: `backend/ssh/session.ts`, a focused terminal channel module, and `backend/ssh/monitor.ts`
  for channel ownership and cleanup without changing the diagnostic command catalogue.
- Contracts and desktop transport: `shared/types.ts`, `electron/main.ts`, and `electron/preload.ts`
  for validated terminal operations and bounded output delivery.
- Website transport: `gateway/server.ts` and `src/services/GatewayClient.ts` for authenticated
  terminal streaming, input, resizing, and lifecycle cleanup.
- UI: `src/app/App.tsx`, `src/app/view.ts`, session lifecycle hooks, a terminal feature/page, and
  shared styles.
- Dependencies: propose `@xterm/xterm` and `@xterm/addon-fit`; resolve compatible maintained
  versions during implementation and update the lockfile deliberately.
- Tests: loopback SSH PTY fixtures, gateway authorization/lifecycle cases, browser interaction
  tests, and native/packaged desktop smoke checks.
- Documentation: README, architecture, design, development, website, gateway, and qualification
  guidance where they make blanket read-only/no-shell claims.

Scope assumption: both editions receive the feature; a platform preference requested during
discovery may narrow this before implementation. Multiple terminals, SFTP, serial consoles, session
persistence, terminal transcript export, and automatic execution of diagnostic commands are outside
this change.
