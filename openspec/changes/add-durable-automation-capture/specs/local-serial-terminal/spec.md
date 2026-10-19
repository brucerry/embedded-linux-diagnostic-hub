## MODIFIED Requirements

### Requirement: Bounded terminal and independent data

Serial SHALL preserve ordered bytes, fragmented UTF-8 and ANSI terminal behavior, selection/copy,
deliberate paste and keyboard escape to controls. Scrollback SHALL be at most 5000 lines,
application chunks at most 16 KiB and pending input/output at most 256 KiB. Overflow/stall SHALL
remain a serial-only actionable failure. Resize SHALL affect local display without device commands.
Untrusted terminal output SHALL NOT execute markup, write the clipboard, open links automatically or
control native windows. Manual transcripts/typed commands SHALL NOT enter diagnostic reports, logs,
update backups or persistent storage. Deliberately armed Automation SHALL instead retain only its
owned capture through the explicit local Automation storage contract, independently of the bounded
terminal display; it SHALL NOT silently persist unrelated manual traffic or insert it into
diagnostic reports/backups.

#### Scenario: High-volume or fragmented output

- **WHEN** output is fragmented or faster than the renderer can consume
- **THEN** decoding remains correct, application buffers stay bounded and any limit is visible
  without affecting SSH diagnostics

#### Scenario: Report export

- **WHEN** the user exports a diagnostic report while Serial is connected
- **THEN** the report contains diagnostic evidence only and no serial transcript or commands

#### Scenario: Explicit Automation persistence

- **WHEN** an operator arms Serial Automation and later types unrelated manual terminal input
- **THEN** only the explicitly owned Automation capture persists in its result store, and manual
  transcript privacy remains intact
