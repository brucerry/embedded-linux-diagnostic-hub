# Design

## Context

The desktop and website share `SshSession` PTY ownership, terminal contracts, xterm display and
connection generations. This revision incorporates the user's request for automatic availability,
clipboard interactions, prompt styling, pixel animation and safe modal backdrop gestures.

## Goals / Non-Goals

Provide one persistent interactive device shell per authenticated connection, usable copy/paste and
normal terminal keys. Preserve diagnostic-only evidence, bounded transport and host validation. Do
not introduce a local OS shell, additional login, saved transcripts, remote shell configuration,
arbitrary diagnostic execution or automatic replay of commands. No manual shell lifecycle controls.

## Decisions

### 1. Connection owns the shell

Mount the lazy terminal controller when a device connects, even before the Terminal tab is visited.
Schedule PTY creation after effect setup so React StrictMode's development teardown probe cannot
create duplicate remote shells. Install subscriptions before creation. Keep the same emulator and
remote channel across navigation. Cancel scheduled creation and queued input during teardown; reject
stale events by terminal ID and connection generation. App/page exit, SSH loss, reconnect, report
import and updates release the PTY. A normally closed shell starts a fresh PTY on the same healthy
SSH connection without replaying input. Keep the emulator history, restore normal display modes,
show a local Shell restarted notice and refocus only when Terminal is visible and unblocked. The
fresh shell uses its default directory/environment. Allow at most three automatic restarts within
ten seconds; refusal, stream errors or repeated closure show actionable Unavailable status without
reconnecting SSH or retry loops. Generation checks and teardown cancel pending recovery; creation
pauses during modal/update blocking. Ready/Preparing shell/Unavailable replace manual open/close
wording. Gateway stream ownership is released before publishing its terminal closed event so a
replacement cannot race the previous stream cleanup.

### 2. Existing remote PTY and bounded transports

Use `ssh2.Client.shell` with `xterm-256color`, `setWindow`, stdout/stderr byte events and an
idempotent channel owner. Independent fixed-probe exec channels retain read-only diagnostic
behavior. Validate IDs, dimensions (2-500 columns, 1-300 rows), base64 and sequences. Chunks are at
most 16 KiB; pending input/output queues at most 256 KiB. Pause output at the 64 KiB consumption
window; a 30-second stalled consumer or capacity error releases only the terminal with an error.

Native handlers use the existing trusted-frame wrapper; preload subscriptions acknowledge after
xterm consumes output. Gateway streaming uses bearer headers and allowed Origin, pinned targets,
no-store NDJSON, immediate flush and keepalives. Browser parsing is bounded and awaits consumers;
HTTP write backpressure controls output credit. Input is serialized in 20 ms batches and resize
debounced. Per-session typing/resize allows 60 requests/second with burst 120 and 256 KiB/second;
existing control-route limits remain. Abort, expiry and shutdown clean up channels. No URL secrets.

### 3. Clipboard and key bindings

Reuse `CopyButton` and its copied-rise feedback, extending it with a lazy text getter and button
ref. Top-right copy takes the highlighted text or bounded local history at click time. A left-drag
only highlights text; right-click reveals a keyboard-operable Copy/Paste menu. Ctrl+C copies
selection and otherwise remains the remote interrupt; Ctrl+Shift+C copies without stealing Ctrl+C's
interrupt. Ctrl+V/Ctrl+Shift+V read the clipboard only after deliberate user input and pass text to
xterm.paste, preserving remote bracketed-paste mode. All other xterm keys reach the device, whose
shell/program owns editing/history/function-key semantics. Ctrl+Shift+Escape returns to controls.

Native clipboard reads use a new isolated trusted handler with the existing 262144-character limit;
UTF-8 paste bytes also respect the 256 KiB queue limit. The website uses browser clipboard APIs and
shows failures. Async paste checks the terminal ID, readiness, tab visibility and blocked state
again after reading; input cannot leak to a replacement connection or modal. OSC 52/8, links, window
operations and script markup remain disabled/inert.

### 4. Clear, prompt color and background

Clear terminal calls xterm.clear in display write order: discard scrollback/previous rows but retain
the current cursor line, including prompt and unfinished input. No fabricated prompt or remote
command is inserted. Ctrl+L additionally follows xterm's normal remote form-feed translation so
Readline/TUIs can redraw. Clear terminal restores input focus. Geometry is fitted to a padding-free
inner container, clipped to the frame, with overscroll containment and wheel propagation blocked at
the terminal boundary when scrollback exists or an interactive program consumes wheel input. With no
normal-buffer scrollback or mouse tracking, permit the browser default wheel action without
forwarding wheel-generated keys. Remote output owns cursor placement and shell continuation syntax;
Ctrl+L must not race a local clear against the remote redraw. Reset session data fully erases local
display/history without a command. Refresh screen-reader announcements as well as the visual buffer
to avoid retaining old transcripts.

Use xterm marker decorations to color recognizable plain `$`, `#` or `>` prompts mint, respecting
existing remote foreground colors and alternate-screen programs. Never modify PS1 or device files.
Refresh decorations after same-row redraws, clearing, resizing and browsing history; retire stale
width/color decorations and dispose them with their bounded scrollback markers.

Code-native pixel sprites depict a duck and pig hopping/passing a ball with a floating heart, with
trees behind them and a small tilted Earth at the top right. Loop a pixel continent strip once per
second inside a clipped globe to suggest axial rotation. Render them behind a transparent terminal
canvas with restrained opacity, keeping text legible, pointer events disabled and the illustration
hidden from assistive technologies. Pause animation while the tab is hidden or a modal/reset blocks
it. Responsive SVG bounds avoid horizontal overflow. Synchronize ball arrival with the front feet of
each sprite before kicking toward the other. Overview transfers finish launched trips; for
collections completing before a trip can launch, show one finite trip while reporting draining
rather than active collection. Local demo modes may bridge an installed interactive Bash PTY for
syntax checks; this is explicitly a local-PC test shell, never the application's production
remote-shell transport.

### 5. Modal pointer origin

Track a left-button pointerdown directly on the backdrop. Dismiss on a matching backdrop click only
when that press began there and the modal is not busy. A text-selection drag beginning inside the
dialog and ending outside cannot close the form. Escape and the close button retain existing
behavior.

## Risks / Trade-offs

Remote shells may reject PTYs, exit or use unusual prompts/keymaps; report terminal-only failures
and qualify real hardware separately. Generic prompt recognition is visual only and cannot cover
every custom prompt. A running program may not have a prompt to retain; clear preserves its current
line rather than presenting a false shell prompt. Clipboard permissions may fail on websites; show
feedback and preserve normal selection. Keep animation below text and verify mobile contrast.

## Migration Plan

No stored-data or report-schema migration. Build desktop, website and matching gateway together. Run
contract/SSH/gateway/browser/native/package tests on Node 24, with Windows portable cold launch.
Verify desktop/web asset parity and local-only planning exclusions. No push or deployment is
requested.

## Output isolation verification

The shared SSH session opens independent exec channels for diagnostics and a single PTY channel for
the interactive shell. Only the PTY listeners emit TerminalEvent data. Verify distinct exec
stdout/stderr markers (including kernel-like logs) during typing and idle collection, and
five-second refresh through the renderer. Keep legitimate user-requested log text and shell stderr.
Direct remote broadcasts and shell startup/background output carry no originating-process metadata
in the PTY byte stream; no content filter or remote logging change is introduced.
