## MODIFIED Requirements

### Requirement: Honest availability and session ownership

The display SHALL distinguish disconnected, loading, unavailable, current, and stale states. The
disconnected label SHALL be exactly "SSH disconnected", independently of local Serial state. A
failed refresh after a valid sample SHALL retain that sample with a visible Stale label until a
successful retry. Disconnecting, switching devices, importing a report, or changing connection
generation SHALL clear prior values and reject late responses belonging to the old session. The
display SHALL never present PC time, report capture time, or hardware RTC values as current device
system time.

#### Scenario: Read failure and recovery

- **WHEN** the first clock read fails, or a later read fails after a valid sample
- **THEN** the display shows unavailable or explicitly stale values respectively, and the normal
  minute schedule can recover without disconnecting a healthy SSH session

#### Scenario: Late response from another device

- **WHEN** an old clock request completes after the user disconnects or changes devices
- **THEN** its date, time, and zone do not replace the current session's display

#### Scenario: Disconnected or imported report

- **WHEN** no authenticated SSH device is connected, including while viewing imported evidence
- **THEN** the header reports SSH disconnected and does not show report timestamps as live device
  time

#### Scenario: Serial connected while SSH is disconnected

- **WHEN** local Serial is connected and no authenticated SSH session exists
- **THEN** Serial remains connected while the header clock says exactly SSH disconnected and does
  not imply that the local port is disconnected
