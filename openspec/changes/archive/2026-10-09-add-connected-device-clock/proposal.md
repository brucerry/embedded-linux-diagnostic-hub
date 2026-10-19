# Proposal

## Why

Users need to see the connected device's system date, time, and applied timezone while moving
between pages. The current collection timestamp belongs to the app, and the RTC diagnostic describes
hardware, so neither provides this view of the device's running system clock.

## What Changes

- Add a clearly labeled Device time display to the shared sticky header on every page, using green
  16-bit style clock artwork and readable text.
- Show the device's date, 24-hour time, and effective timezone abbreviation and UTC offset; include
  a zone identifier only when reliably available.
- Read the device clock once per minute independently of live diagnostics, with immediate refreshes
  after SSH connection/reconnection, completed app reset, return to an active window, and detected
  reboot. App/page reload clears the old value and refreshes after authentication resumes, matching
  the existing connection lifecycle.
- Keep loading, disconnected, unavailable, and stale values explicit. Never substitute the PC clock
  or an imported report timestamp for device time.
- Use a bounded, read-only SSH execution channel on the existing authenticated connection. Keep
  clock responses isolated from the interactive terminal and exported diagnostic evidence.

## Capabilities

### New Capabilities

- `connected-device-clock`: A persistent device clock display, authoritative time and timezone
  sampling, minute and lifecycle refresh, and safe native/gateway transport behavior.

### Modified Capabilities

None. The existing `connected-device-terminal` requirements remain intact, including isolation of
background SSH execution output from the interactive PTY.

## Impact

- Shared clock contracts and response validation; the SSH session/monitor; authenticated Electron
  IPC/preload and gateway session routes/client.
- Device session lifecycle coordination, a dedicated clock hook, a shared header component, and
  responsive styles.
- Clock parser and transport tests, desktop/gateway fixtures, UI coverage, and real Linux SSH
  qualification where available.
- Brief usage/development documentation updates. No new runtime dependency, report schema change,
  device configuration write, credential persistence, or expansion of the README.
