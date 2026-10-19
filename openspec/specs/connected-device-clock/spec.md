# Connected Device Clock

## Purpose

Keep the connected device's running system date, time, and effective timezone clearly visible across
the application, with regular and lifecycle-driven refreshes that preserve terminal isolation.

## Requirements

### Requirement: Persistent accessible device clock

The application SHALL show a consistently positioned, accessibly labeled Device time display in the
shared header on every desktop and website page. It SHALL use green 16-bit style clock artwork with
hands matching the latest device time alongside readable date, seven-segment 24-hour time at minute
resolution, and timezone text. The segment artwork SHALL retain equivalent accessible time text. All
information and status SHALL be available as text, and compact layouts SHALL keep it visible without
clipping navigation or creating horizontal page overflow.

The connected layout SHALL place the pixel clock on the left, date above timezone in the middle, and
compact seven-segment time on the right without an additional visible heading. Standard date and
timezone values SHALL fit a 48-pixel clock card and preserve the 76-pixel desktop header at 1440
pixels wide. Long timezone labels SHALL wrap without clipping the time or causing overflow.

The connected-state **Disconnect device** action SHALL use an orange warning color, including its
hover state, while the disconnected **Connect device** action retains its existing color.

#### Scenario: Navigate between pages

- **WHEN** a connected user moves among Overview, Diagnostics, Reports, Terminal, and diagnostic
  subpages
- **THEN** the same device clock remains visible in the shared header without starting duplicate
  refresh schedules

#### Scenario: Compact layout and assistive technology

- **WHEN** the application is used at a narrow mobile width or with a screen reader
- **THEN** the date, time, timezone, and status remain readable and the artwork does not replace the
  text or repeatedly announce routine refreshes

### Requirement: Authoritative system time and applied timezone

The application SHALL obtain the running system date, time, effective timezone abbreviation when
available, and numeric UTC offset from the authenticated device. It SHALL display the device's
calendar values independently of the PC/browser timezone. A named zone identifier SHALL be displayed
only when reliably reported and consistent with the effective timezone; abbreviations SHALL NOT be
treated as unique zone identifiers. Missing timezone information SHALL be identified explicitly
while retaining any valid date and time.

#### Scenario: Device and PC have different timezones

- **WHEN** the device reports a date and time in UTC+08:00 while the PC uses a different timezone
- **THEN** the header shows the device's date and time with its reported zone and UTC+08:00

#### Scenario: Timezone change or clock correction

- **WHEN** a successful refresh reports a changed timezone, daylight saving offset, or corrected
  system time
- **THEN** the header replaces the prior date, time, and zone together with the new authoritative
  values

#### Scenario: Limited device timezone metadata

- **WHEN** valid device calendar values are available but a zone identifier or abbreviation is
  absent
- **THEN** the header shows the available numeric offset without inventing a zone name, or shows
  Timezone unknown if no offset is available

### Requirement: Independent minute refresh

While connected and active, the application SHALL request a clock refresh every 60 seconds
independently of whether live diagnostics are enabled, paused, or running at another interval. It
SHALL allow at most one clock request in flight, coalesce simultaneous refresh triggers, and avoid
accumulating a backlog during suspension or a slow response.

#### Scenario: Diagnostics are paused or collecting rapidly

- **WHEN** a device remains connected with live diagnostics paused or collecting every five seconds
- **THEN** the clock still refreshes on its own minute schedule without requesting a full diagnostic
  collection or printing clock results in the terminal

#### Scenario: Refresh triggers overlap

- **WHEN** a minute refresh and a lifecycle refresh occur while another clock request is unfinished
- **THEN** requests remain bounded to one in flight and no unbounded retry or catch-up burst occurs

### Requirement: Connection and reload activity refresh

The application SHALL refresh promptly after successful SSH authentication or reconnection,
completed in-app reset, return from suspension or a hidden page, and detection of a device reboot
through changed boot identity or decreased uptime. An app/page reload SHALL discard the previous
clock and refresh after an authenticated connection becomes available under the existing connection
lifecycle. Reboot detection SHALL not depend on reading user terminal input, and SHALL be bounded by
the next successful clock sample or existing diagnostic collection that provides reboot evidence.

#### Scenario: App or page reload

- **WHEN** the user reloads the app or page
- **THEN** old device clock values are discarded and a fresh read occurs after authentication
  becomes available without persisting credentials or introducing automatic reconnection

#### Scenario: Device reboot with a connection interruption

- **WHEN** a device reboot disconnects SSH and the user reconnects successfully
- **THEN** old clock values are cleared and the new device clock is read promptly

#### Scenario: Reboot evidence and in-app reset

- **WHEN** a changed boot identity or decreased uptime is detected, or an in-app reset finishes with
  SSH still connected
- **THEN** the application refreshes the clock promptly with overlapping triggers coalesced

### Requirement: Honest availability and session ownership

The display SHALL distinguish disconnected, loading, unavailable, current, and stale states. A
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

- **WHEN** no authenticated device is connected, including while viewing imported evidence
- **THEN** the header reports No device connected and does not show report timestamps as live device
  time

### Requirement: Bounded authenticated read-only transport

Desktop and gateway clock reads SHALL reuse the existing authenticated SSH connection through a
separate non-interactive execution channel. The operation SHALL accept no user-supplied command,
require the existing IPC or gateway authorization boundaries, apply finite execution/output limits,
and close only its own query channel on timeout or cancellation. It SHALL leave device time,
timezone, and synchronization configuration unchanged. Clock values SHALL remain transient
application state outside report exports and persisted credentials.

#### Scenario: Terminal and diagnostics run concurrently

- **WHEN** a clock read runs while a user command and diagnostic collection are active
- **THEN** clock output remains outside the interactive PTY and diagnostic report evidence, and user
  terminal input continues to operate

#### Scenario: Timeout or rejected access

- **WHEN** a device clock command stalls, produces excessive output, or an unauthenticated caller
  requests a clock read
- **THEN** the query is bounded or denied without exposing arbitrary command execution or closing an
  otherwise healthy SSH session

### Requirement: Graceful compatibility

The clock operation SHALL support validated GNU and BusyBox date output without requiring systemd or
installation of a device agent. Unsupported commands, malformed responses, missing timezone
metadata, and a gateway or desktop bridge without clock support SHALL result in explicit
availability states while preserving existing connection, diagnostic, and terminal functionality.

#### Scenario: Minimal Linux or older gateway

- **WHEN** a connected device lacks supported date formatting or the transport does not provide the
  clock operation
- **THEN** the display explains that device time is unavailable and the terminal and diagnostics
  remain usable
