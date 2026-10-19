# Spec Delta

## Purpose

Provide an interactive terminal on the connected device, preserving device identity, SSH lifecycle,
diagnostic evidence, bounded transport, convenient clipboard access and normal remote keymaps.

## ADDED Requirements

### Requirement: Automatic embedded terminal workspace

Both editions SHALL provide Terminal with the live SSH username/endpoint. One PTY SHALL start
automatically on each authenticated device connection, even before visiting Terminal, and remain
mounted across tabs. The UI SHALL omit manual terminal lifecycle controls/wording and use
Ready/Preparing shell/Unavailable status. Commands SHALL use the connected SSH user's permissions.

#### Scenario: Authenticate a device

- **WHEN** a device connects successfully and the user visits Terminal
- **THEN** its interactive shell is available without another login or manual shell action

#### Scenario: Historical evidence without a device

- **WHEN** there is no live connection, including an imported report or retained snapshot
- **THEN** input is disabled, Connect device is offered and historical endpoints receive no commands

### Requirement: Reuse SSH with bounded interactive behavior

The terminal SHALL use one PTY on the existing authenticated SSH connection, reject duplicate
creation, preserve working directory/program state across inputs and tabs, and stream
byte-preserving ANSI/Unicode output. Resize SHALL fit the display and update the remote PTY.
Read-only diagnostics SHALL continue on independent fixed-probe channels without another
authentication.

#### Scenario: Interact while collecting evidence

- **WHEN** the user enters commands or runs a program and diagnostics collect
- **THEN** the shell retains its state and diagnostics retain their fixed commands and evidence

### Requirement: Cleanup and stale-input protection

Disconnect, target replacement, report import, update disconnect and app/page exit SHALL release
channels, subscriptions and input queues. Events/input from old IDs or connection generations SHALL
NOT affect replacement devices. A normally closed shell SHALL automatically be replaced on the same
healthy SSH connection, preserving bounded local history, discarding pending input, showing a Shell
restarted notice and restoring focus only when visible and unblocked. No commands SHALL be replayed.
A fresh shell SHALL use its default directory/environment. Automatic recovery SHALL be limited to
three restarts in ten seconds. Shell refusal, lost streams and exhausted recovery SHALL show
actionable Unavailable status while preserving healthy SSH diagnostics without retry loops. Device
reconnect SHALL create a fresh shell. Update transactions SHALL block shell creation/input and
disconnect SHALL cancel pending recovery.

#### Scenario: Replace or disconnect a device

- **WHEN** the current connection ends or is replaced with pending input/output
- **THEN** its terminal is released and cleared; no stale data reaches the replacement terminal

#### Scenario: Shell fails independently

- **WHEN** the PTY is refused, its stream fails or the recovery limit is exhausted
- **THEN** the UI asks for device reconnect and diagnostics remain usable without a retry loop

#### Scenario: Exit the login shell

- **WHEN** exit, logout or Ctrl+D ends the outermost shell on a healthy SSH connection
- **THEN** one replacement shell is available without authentication, the transcript is retained,
  queued input is discarded and a visible unblocked terminal regains focus

#### Scenario: Exit a nested shell

- **WHEN** exit ends a nested shell while the outer shell remains running
- **THEN** no replacement is created and the normal remote shell behavior remains intact

### Requirement: Bounded transport and evidence isolation

Scrollback and transport queues SHALL be finite. Input/output chunks SHALL be at most 16 KiB,
pending queues at most 256 KiB, with output credit/backpressure and a 30-second stalled-consumer
terminal-only failure. Input/resize traffic SHALL have per-session rate and byte limits. Browser
frame parsing SHALL be bounded. Typed commands/transcripts SHALL NOT enter reports, logs, browser
storage or update backups. Reset session data SHALL erase local display/history and queued input
without a device command or ending SSH/the shell.

#### Scenario: Slow consumption or large paste

- **WHEN** output cannot be consumed or input exceeds capacity
- **THEN** queues remain bounded and a clear terminal-only error appears while SSH remains usable

#### Scenario: Reset or export

- **WHEN** session data is reset or diagnostic reports/update backups are saved
- **THEN** reset sends no shell command, and saved artifacts contain diagnostic evidence only

### Requirement: Authenticated and validated transport

Native operations and clipboard reads SHALL require the trusted application frame. Gateway
operations SHALL require bearer authentication, allowed Origin, active session and pinned device.
IDs, dimensions, payloads and acknowledgment sequences SHALL be validated before remote input.
Streams SHALL use no-store headers, immediate flush and keepalives, and release on abort/expiry/
shutdown. Secrets SHALL NOT appear in URLs. Remote markup/OSC SHALL NOT execute scripts, change the
clipboard, automatically open destinations or control native windows.

#### Scenario: Invalid or unauthorized request

- **WHEN** a frame/token/origin/session is invalid, or IDs/payloads/dimensions/sequences are
  malformed
- **THEN** the operation is rejected before remote input or privileged clipboard access

### Requirement: Selection, clipboard and terminal keymap

A top-right copy button SHALL copy selection or bounded local terminal history with the existing
copied-rise feedback. Left-drag SHALL only highlight text; right-click SHALL reveal a
keyboard-operable Copy/Paste menu while preserving the selection. Ctrl+C SHALL copy selected text
and otherwise send the normal remote interrupt. Ctrl+V SHALL paste only through deliberate user
action and xterm's paste handling, including bracketed mode where enabled. Async paste SHALL recheck
target, visibility and modal blocking. Remaining xterm navigation/editing/history/function keys
SHALL reach the remote PTY; shell keymaps SHALL remain remote-owned. Ctrl+Shift+Escape SHALL return
focus to controls.

#### Scenario: Copy selection and paste

- **WHEN** selected output is copied with Ctrl+C/menu/button and text is deliberately pasted
- **THEN** copy shows the shared animation without interrupting, and paste reaches the current
  unblocked target in byte order

#### Scenario: No selection during a running program

- **WHEN** Ctrl+C is pressed without a selection
- **THEN** the remote program receives its ordinary interrupt

### Requirement: Prompt clear and visual presentation

Clear terminal SHALL discard previous display/history while retaining the current prompt/input line,
without injecting a remote command or fabricated prompt and restore terminal input focus. Ctrl+L
SHALL also follow normal remote redraw handling. Recognizable plain prompts SHALL be colored locally
after redraw, clear, resize and scroll while remote colors remain intact. Two animated pixel-art
duck/pig characters SHALL play behind the text, with pixel trees and a small tilted Earth rotating
once per second, with sufficient contrast, no pointer interception and no assistive-navigation
content. Animation SHALL pause while hidden/blocked and layout SHALL fit desktop/mobile without
horizontal overflow. Fitted rows and the cursor SHALL stay inside the visible terminal at full
capacity. When scrollback exists or an interactive program consumes wheel input, terminal wheel
scrolling SHALL NOT scroll the document, including at either scroll boundary. With no scrollback in
the normal buffer and no mouse tracking, wheel input SHALL scroll the document without sending
remote keys. Backslash continuations, subshells and loops SHALL be handled by the remote shell
without a client-side command parser.

#### Scenario: Clear a ready shell

- **WHEN** Clear terminal is clicked at a prompt
- **THEN** one current prompt/input line remains and the shell state is unchanged

#### Scenario: Redraw and browse a plain prompt

- **WHEN** a shell redraw changes a plain prompt, the display is cleared or resized, or history is
  browsed
- **THEN** the complete recognized prompt remains mint, respecting any remote foreground color

#### Scenario: Wheel over a short terminal

- **WHEN** the normal terminal has no scrollback and no mouse tracking
- **THEN** wheel input can scroll the document without remote input

### Requirement: Safe connection-form backdrop dismissal

Direct left-button backdrop clicks SHALL dismiss non-busy modals. A text-selection drag starting
inside the dialog and ending on the backdrop SHALL NOT dismiss it. Existing Escape/close behavior
SHALL remain available.

#### Scenario: Release a selection outside the form

- **WHEN** a connection field is highlighted by dragging outside the dialog and releasing
- **THEN** the form and its values remain; a subsequent direct backdrop click can dismiss it

### Requirement: Diagnostic and interactive output isolation

Only output from the active interactive PTY SHALL enter its terminal transcript, apart from local
shell-recovery notices. Diagnostic exec stdout/stderr, including collected system/kernel logs, SHALL
remain snapshot evidence even during concurrent shell input or five-second live updates. Remote PTY
stdout/stderr SHALL remain byte-preserving; the client SHALL NOT infer ownership from line content
or timing. Device-configured broadcasts, login banners and background jobs writing directly to that
PTY cannot be classified separately from command output, and this limitation SHALL be documented
without changing remote logging settings.

#### Scenario: Collection alongside interactive input

- **WHEN** live collection returns stdout/stderr and kernel-style log messages while a user executes
  commands
- **THEN** only PTY output enters terminal display/history, and diagnostics remain available in
  snapshots

#### Scenario: User requests log text

- **WHEN** a user command prints kernel-style text through the PTY
- **THEN** the text remains visible rather than being filtered by its appearance
