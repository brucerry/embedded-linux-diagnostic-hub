# Local Serial Terminal Delta

## Purpose

Provide a user-controlled UART terminal for ports attached to the client computer, independently of
remote SSH diagnostics and with bounded, explicit device ownership.

## ADDED Requirements

### Requirement: Independent Serial workspace and port selection

The application SHALL provide a primary page named Serial without requiring SSH, a gateway token or
a diagnostic snapshot. Ports SHALL be labeled as attached to this computer. One port SHALL be active
at a time. Choosing a port SHALL NOT open it; Connect SHALL explicitly open the selected port,
Disconnect SHALL close it while retaining selection, and Deselect SHALL close then clear selection.
Chooser cancellation SHALL be a normal outcome. The application SHALL NOT select a first/default
port automatically.

#### Scenario: Serial before SSH

- **WHEN** the user opens Serial without any SSH connection
- **THEN** supported local port selection and terminal controls remain available with their own
  identity/status

#### Scenario: Select and deselect

- **WHEN** a user selects a port and later connects and deselects it
- **THEN** selection alone sends no bytes or open request, Connect opens only that port, and
  Deselect closes it before clearing selection

### Requirement: Accurate port access and limited grants

Desktop selection SHALL show OS port names where supplied and validate the current offered port and
chooser identity. Browser selection SHALL use a deliberate chooser action and distinguish authorized
ports from all host ports; unknown COM/tty paths SHALL NOT be fabricated. Stale/untrusted selections
SHALL be rejected. App-managed grants SHALL be session-scoped to selected devices, without blanket
permissions, blocklist bypasses or permission changes. Forget permission SHALL be distinct from
Deselect and available when supported.

#### Scenario: Invalid or removed choice

- **WHEN** a choice belongs to an old chooser, an untrusted frame or a port removed from the offered
  list
- **THEN** no port is selected or opened and the chooser can be cancelled

#### Scenario: Browser access limit

- **WHEN** only previously authorized ports can be listed or no OS name is exposed
- **THEN** the UI explains that limit and offers a user-operated chooser without claiming a complete
  host inventory

### Requirement: Explicit UART settings and safe actions

The page SHALL expose editable baud rate, 7/8 data bits, none/even/odd parity, 1/2 stop bits and
none/hardware flow control, defaulting to 115200 8N1 with no flow control. Invalid settings SHALL be
rejected before opening; driver rejection SHALL remain visible. Settings changes SHALL require
closing/reopening. Local echo SHALL default off, and Enter CR/LF/CRLF choice SHALL be explicit. The
application SHALL NOT enable a target UART, run commands, change host access, send Break or
explicitly alter DTR/RTS automatically. Connect guidance SHALL acknowledge possible
adapter/control-line reset effects.

#### Scenario: Invalid or unsupported framing

- **WHEN** settings are invalid or the driver rejects an otherwise valid setting
- **THEN** invalid settings are blocked locally or an actionable driver failure appears without a
  replacement setting/open attempt

#### Scenario: Silent target

- **WHEN** a connected target sends no data
- **THEN** the app waits for user input or received bytes without issuing discovery, login,
  enablement or test commands

### Requirement: Generation-scoped cleanup without reconnect

At most one owner SHALL hold a port and its read/write resources. Opening, closing and selection
state SHALL be visible. Disconnect, Deselect, unplug, stream failure and app/page exit SHALL
invalidate queued input, cancel pending I/O, release ownership and close idempotently. Late opens
and stale output/paste SHALL NOT reach replacement sessions. Cleanup timeout SHALL remain an
error/closing state and SHALL NOT assert successful release. Reconnect SHALL always require explicit
user action and SHALL NOT replay bytes.

#### Scenario: Disconnect races open

- **WHEN** an open completes after Disconnect or selection replacement
- **THEN** the late port is released and cannot become the new active terminal

#### Scenario: Idle read or blocked write

- **WHEN** Disconnect occurs with a pending idle read or a stalled hardware-flow write
- **THEN** cleanup cancels work without waiting indefinitely for new device traffic and replacement
  opens remain blocked until ownership releases

#### Scenario: Unplug

- **WHEN** an active port disconnects
- **THEN** the session closes or exposes its cleanup failure, discards input and never automatically
  reconnects

### Requirement: Bounded terminal and independent data

Serial SHALL preserve ordered bytes, fragmented UTF-8 and ANSI terminal behavior, selection/copy,
deliberate paste and keyboard escape to controls. Scrollback SHALL be at most 5000 lines,
application chunks at most 16 KiB and pending input/output at most 256 KiB. Overflow/stall SHALL
remain a serial-only actionable failure. Resize SHALL affect local display without device commands.
Untrusted terminal output SHALL NOT execute markup, write the clipboard, open links automatically or
control native windows. Transcripts/typed commands SHALL NOT enter diagnostic reports, logs, update
backups or persistent storage.

#### Scenario: High-volume or fragmented output

- **WHEN** output is fragmented or faster than the renderer can consume
- **THEN** decoding remains correct, application buffers stay bounded and any limit is visible
  without affecting SSH diagnostics

#### Scenario: Report export

- **WHEN** the user exports a diagnostic report while Serial is connected
- **THEN** the report contains diagnostic evidence only and no serial transcript or commands

### Requirement: Workspace and update lifecycle

Changing workspace tabs, minimizing, SSH target changes and importing reports SHALL retain
independent Serial ownership; hidden/modal-blocked terminal input SHALL be disabled. RAM reset SHALL
clear serial display and queued input without sending bytes or ending the port. Update installation
SHALL cancel pending selection, block new input/opening and obtain serial cleanup acknowledgement
before replacement/relaunch; failure SHALL stop that update attempt. Checking update availability
alone SHALL NOT close Serial.

#### Scenario: Browse another workspace

- **WHEN** the user changes tabs or imports an SSH report with Serial open
- **THEN** the same local port remains owned and receives within bounds while hidden input is
  disabled and transport labels stay accurate

#### Scenario: Reset or install update

- **WHEN** RAM reset is requested or installation starts
- **THEN** reset clears local serial data without device input, while installation separately closes
  Serial and cannot proceed if cleanup fails

### Requirement: Honest platform and access states

The page SHALL distinguish unavailable API/insecure context/policy denial, chooser cancellation,
missing device, permission denial, busy port, unsupported settings, stream failure and cleanup
failure without changing OS settings or requesting elevation. Other workspaces SHALL remain usable.
Support claims SHALL identify actual client/runtime/adapter qualification separately from mock
tests.

#### Scenario: Unsupported or denied environment

- **WHEN** the serial API or secure context is unavailable or access is denied
- **THEN** the reason is shown and SSH/report workflows remain available without fallback security
  changes

### Requirement: Legible decorative beach volleyball scene

Serial SHALL display the established pig and duck as decorative pixel-style beach volleyball
characters with a soft light palette, ocean waves, sand, side trees and a rotating sun motif. The
Serial scene SHALL contain no Earth or globe. The scene SHALL remain behind or outside legible
terminal text, non-interactive and excluded from assistive navigation. Layout SHALL fit narrow and
wide windows. Motion SHALL pause while hidden/blocked and stop for reduced-motion preference,
without unbounded animation resources. The SSH scene SHALL retain its existing appearance.

#### Scenario: Reduced motion or hidden Serial

- **WHEN** reduced motion is requested or the Serial workspace is hidden/blocked
- **THEN** decorative movement stops or pauses while terminal state and readable text remain usable

#### Scenario: Resize while receiving

- **WHEN** a wide or narrow window is resized while serial output arrives
- **THEN** the pig/duck beach composition and fitted text remain inside the frame without
  intercepting pointer/keyboard input
