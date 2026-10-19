# Design

## Context

See `proposal.md` for motivation and `specs/connected-device-clock/spec.md` for the behavior
contract. This crosses the SSH backend, native IPC, website gateway, session lifecycle, and shared
layout, so a design is required.

`src/app/App.tsx` already owns a sticky `site-header` outside page content. `useDeviceSession` owns
the active device generation, native/gateway transport, live collection interval, report import, and
RAM reset. Authentication currently becomes available before initial collection completes. App/page
reload does not automatically reconnect SSH.

`SshSession.collect()` executes 36 fixed probes and timestamps the snapshot on the host. Its private
execution helper bounds diagnostic output and duration; the clock needs a smaller independent
budget. The RTC probe is hardware evidence. Interactive terminal output is already isolated through
`client.shell()`; clock reads must preserve the existing terminal spec.

The gateway authenticates bearer credentials and exact origins, pins allowed targets, and owns SSH
sessions. Its snapshot cancellation path can disconnect a session. `GatewayClient.request()` also
clears sessions on some 404 responses. A clock operation must avoid both side effects for query
cancellation or an older gateway's unsupported route.

## Goals / Non-Goals

**Goals:** Reuse authenticated transports; define one validated clock contract; keep polling
independent of diagnostic timing; maintain device-generation ownership; render a small accessible
header display.

**Non-Goals:** Setting device clocks, timezone configuration, NTP status, a device daemon, automatic
reconnection, persistent clock history, changes to reports or the existing 36-probe inventory, and
continuous decorative animation.

## Decisions

### 1. Sample the device through a fixed SSH command

Add a fixed, versioned clock command and parser under `shared/diagnostics/`, with a shared typed
response validated again at the renderer boundary. In one exec channel, use
`LC_ALL=C date '+%s|%Y-%m-%d|%H:%M:%S|%z|%Z'` inside explicit output markers, and read optional boot
identity and uptime from `/proc/sys/kernel/random/boot_id` and `/proc/uptime`. Do not force UTC or
replace the device's effective timezone environment. No user input is interpolated into the command.

Validate calendar fields, signed numeric offset, finite epoch/uptime where supported, field lengths,
and marker structure. Optional unsupported epoch, zone, or boot fields do not discard otherwise
valid calendar data; invalid required calendar fields make the read unavailable. Treat banners
outside markers separately from clock data. A literal unsupported format token is never displayed as
a zone or numeric value.

Show abbreviation plus `UTC±HH:mm`, for example `CST · UTC+08:00`. Do not derive an IANA identifier
from an abbreviation. This implementation does not require IANA discovery: omission is valid when
authoritative, consistent metadata is unavailable. Do not use `/etc/timezone` alone to override the
effective offset from `date`.

GNU documents machine-readable calendar/offset formatting in its
[date syntax guidance](https://www.gnu.org/s/coreutils/manual/html_node/General-date-syntax.html).
BusyBox documents `date` formatting but also allows command/features to be omitted at compile time,
so validate capabilities rather than assuming identical firmware support. See the
[BusyBox manual](https://busybox.net/downloads/BusyBox.html).

Alternatives: using `capturedAt` or RTC data gives the wrong source; requiring `timedatectl`
excludes minimal systems; sending `date` to the interactive terminal would break output isolation
and user commands.

### 2. Bound each query without disturbing the shared connection

Add `SshSession.readClock()` and a `DeviceMonitor` delegate. Reuse the authenticated client with a
dedicated non-PTY exec channel, a five-second deadline, an 8 KiB combined stdout/stderr limit, and
at most one pending clock query per session. Share bounded execution machinery only if diagnostic
defaults remain unchanged. On timeout/cancellation, close the query channel and clean
listeners/timers; never disconnect the whole client. Reject results after client replacement.
Disconnect closes pending queries.

Return a typed sample or a bounded availability error, without raw device output in UI errors. Use
available boot/uptime evidence to detect a reboot. Missing boot evidence reduces detection
capability but does not prevent clock reads.

Alternatives: extending every diagnostic snapshot couples clock refresh to paused diagnostics; a
second SSH login adds credentials and connection cost. The extra bounded exec channel allows the
clock to coexist with the current three-probe batches and PTY.

### 3. Extend both trusted transports additively

Expose optional `readDeviceClock` support in `DesktopBridge`, implemented by an authenticated
`hub:device-clock` handler and preload wrapper. Apply existing trusted-frame and connect/update
guards. Add an authenticated `POST /api/sessions/:id/clock` gateway route with no command-bearing
input, retaining origin, bearer, target/session, and rate-limit policy.

Use the per-session clock guard rather than the snapshot `busy` flag; simultaneous diagnostics
remain allowed. Abort only the clock channel on request cancellation. Extend `GatewayClient` with
typed validation and a clock-specific error path: an unsupported route must not clear the active
session. Leave actual expired-session detection to an explicit session error or the existing
heartbeat/connection lifecycle. Missing bridge support or older gateway endpoints render unavailable
while other features continue. Do not retry unsupported routes every second.

Alternatives: using the generic snapshot request path inherits destructive cancellation behavior;
requiring all gateways to upgrade before the UI starts would unnecessarily block terminal use.

### 4. Coordinate refresh in one session-owned hook

Add `useDeviceClock`, mounted once by the shared app and supplied the transport, active device
generation, connection readiness, reset/update activity, and available reboot evidence from normal
collection. Keep all state in RAM and outside snapshot/report serialization.

Start a read promptly after authentication guards finish, without waiting for a full snapshot. Run a
60-second schedule while connected and visible. Coalesce overlapping timer/activity triggers into at
most one follow-up; do not queue missed ticks. Pause during reset/update/suspension, then read
promptly when eligible again. Use a dedicated completed-reset token rather than treating every
collection or terminal render as a refresh trigger. Visibility restoration covers timer throttling
and sleep. Remove timers/listeners on unmount.

Compare boot identity or uptime rollback on successful samples and any usable collection evidence. A
sample that detects reboot already refreshes the clock; collection evidence requests one fresh
sample. This is detection on the next observation, not a pushed reboot notification. A dropped SSH
connection clears state; existing user-led reconnection triggers the next read. App/page reload
likewise clears RAM and samples after authentication resumes, as confirmed by the user.

Invalidate request tokens on disconnect, import, reset, or generation change, including
same-endpoint reconnection. A late result cannot resurrect old values. If a refresh fails, freeze
the last sample and label it Stale; normal scheduling recovers. Initial failure yields unavailable,
and unsupported transports remain unavailable for that connection.

Alternatives: per-page polling duplicates traffic; using the diagnostic interval violates
independent refresh; monitoring shell input for reboot or timezone commands misses external changes
and compromises terminal boundaries.

### 5. Use a green pixel clock with minute-resolution text

Add a small `DeviceClock` component to the header near its right-side controls. Use a decorative
inline pixel-grid SVG and accessible text: `Device time`, `YYYY-MM-DD`, `HH:mm`, and the effective
timezone. On compact layouts, place it on a full-width header row at the same global location;
preserve navigation and existing action buttons.

Following the user's layout sketch, the connected card places pixel artwork on the left, stacks date
above timezone in the middle, and centers the 18-pixel seven-segment time on the right across both
rows. Keep the Device time region label accessible; omit its visible heading when readings are
available. A compact line height gives a 48-pixel card and a 76-pixel desktop header for standard
readings. Bound the metadata column and wrap long timezone labels safely. Loading and unavailable
states retain a visible heading and explanatory text.

Match the header's palette using the existing slate surface with a faint green tint, a subtle
gray-green border, and 12-pixel corners. Use a small matching stroke around the seven-segment paths
to thicken the digits without increasing their size or changing spacing. Keep mint accents on the
pixel artwork and seven-segment time. Use the application's regular font and light text for the
date, muted text for timezone and availability, and lower opacity for inactive segments. Preserve
the compact dimensions.

Render `HH:mm` as SVG seven-segment digits alongside equivalent hidden text for screen readers. Draw
the pixel clock hands on the same integer grid from the sampled hour and minute, including the hour
hand's minute adjustment. Stale readings retain both digits and hands; disconnected or unavailable
states omit the hands. No extra animation timer or SSH polling is needed. Use an orange background
and lighter orange hover state for the connected Disconnect device action.

Minute resolution is a minor formatting assumption aligned with the requested refresh cadence.
Render the sampled device calendar strings directly, avoiding browser-local conversion and
second-by-second interpolation. New readings naturally update midnight rollover, clock corrections,
and daylight saving changes. Display a clear status for loading/disconnected/unavailable/stale. Hide
decorative art from screen readers and avoid an assertive live region for routine minute updates.
Green text must meet normal contrast requirements.

Alternatives: a canvas or raster asset adds complexity without improving this small graphic; a clock
inside each page loses the consistent position; converting with the PC timezone misrepresents device
time.

## Risks / Trade-offs

- [Minimal firmware lacks date formats or zone data] → Validate individual fields, retain valid
  date/time with explicit unknown zone, and return unavailable for unsupported calendar output;
  qualify GNU and BusyBox devices.
- [TZ settings differ between processes] → Show the effective timezone of the independent device
  command. A user shell's local `TZ` export is process-specific and does not change the header's
  source. Avoid guessing a system-wide IANA zone.
- [Reboot/timezone changes occur between reads] → Refresh at the next minute observation or earlier
  lifecycle/collection evidence; disclose this cadence in usage docs.
- [Extra SSH channel or slow server] → One small query per minute, five-second/8 KiB bounds, no
  overlap, and failure confined to the clock.
- [Older gateway returns 404] → Preserve the session for clock-route incompatibility; exercise
  unsupported and expired-session behavior separately.
- [Responsive header becomes crowded] → Test narrow, tablet, and desktop widths with long zone
  labels and existing controls before delivery.

## Migration Plan

Implement contracts/backend first, then native/gateway integration, lifecycle hook, header UI, and
verification tasks. Native packages receive the UI and IPC together; websites gracefully handle
gateways without the new route. No database, report, device, or persisted-state migration is
required. Rollback removes the additive clock operation and UI while preserving existing SSH
features.

Update `docs/usage.md` and relevant development/gateway guidance briefly; keep README concise.
Record qualification results without committing private device details or local OpenSpec artifacts.
Builds and tests belong to the apply phase.
