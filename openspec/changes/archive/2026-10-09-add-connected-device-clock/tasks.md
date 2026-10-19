# Tasks

## 1. Clock contract and SSH backend

- [x] 1.1 Add the shared typed clock sample/availability contract, fixed marked command, and strict
      parser under `shared/diagnostics/`; verify unit tests for GNU/BusyBox output, calendar
      validation, signed offsets, missing optional fields, banners, malformed markers, and
      unsupported format tokens.
- [x] 1.2 Add a bounded clock read to `backend/ssh/session.ts` and delegation in
      `backend/ssh/monitor.ts`, with a five-second deadline, 8 KiB output cap, per-session
      single-flight guard, and query-only cancellation; verify fixture tests for success, oversized
      output, stalled queries, disconnect, client replacement, and continued terminal/diagnostic
      operation.
- [x] 1.3 Extend `tests/fixtures/gateway.ts` with controlled clock responses, boot identity/uptime,
      and query counters; verify tests can independently change clock data and measure clock calls
      without adding clock evidence to snapshots.

## 2. Native and gateway transport

- [x] 2.1 Extend shared bridge types, `electron/main.ts`, and `electron/preload.ts` with optional
      validated clock support using existing trusted IPC and connection/update guards; verify
      desktop smoke coverage for successful reads, denied untrusted access, and unavailable reads
      during blocked lifecycle stages.
- [x] 2.2 Add the authenticated gateway clock route with fixed operation input and independent
      bounded query cancellation; verify gateway tests cover bearer/origin/session rejection, no
      arbitrary command input, concurrent collection, output/time limits, and a healthy session
      after cancellation.
- [x] 2.3 Add clock response validation and compatibility handling to
      `src/services/GatewayClient.ts`; verify unsupported-route 404 preserves the session, malformed
      responses are unavailable, and genuine session expiry still follows the existing disconnect
      lifecycle.

## 3. Refresh and lifecycle state

- [x] 3.1 Add `src/hooks/useDeviceClock.ts` with one session-owned 60-second schedule,
      connection-generation invalidation, explicit availability states, coalesced triggers, and
      cleanup; verify controlled-timer tests show minute reads with diagnostics paused or collecting
      every five seconds, one request in flight, stale recovery, and no schedule duplication across
      navigation.
- [x] 3.2 Coordinate the hook with `useDeviceSession` readiness, completed reset, update/disconnect,
      import, and visibility restoration; verify fresh reads after eligible activity and discarded
      late responses after reset, device switch, same-endpoint reconnect, or unmount.
- [x] 3.3 Detect changed boot identity or decreasing uptime from clock samples and available
      existing collection evidence; verify a detected reboot refreshes promptly without a trigger
      loop, missing boot evidence remains usable, and manual time/zone changes replace the next
      sample atomically.
- [x] 3.4 Extend `tests/ui/fixtures/desktop.ts` with controllable samples, failures, delayed reads,
      and counters; verify app/page reload clears prior state and the next authenticated connection
      reads fresh data without persisted credentials or automatic reconnection.

## 4. Shared green pixel clock

- [x] 4.1 Add an accessible `DeviceClock` component and mount it once in `src/app/App.tsx`'s shared
      header, using green pixel-grid SVG and `YYYY-MM-DD`, `HH:mm`, and device zone text; verify all
      pages/subpages retain the display and device values remain correct under a different browser
      timezone.
- [x] 4.2 Add responsive styling in `src/styles/workspace.css`, using a dedicated header row when
      needed; verify narrow mobile, tablet, and desktop layouts with long labels, existing header
      controls, and unavailable/stale states have no clipping or horizontal page overflow.
- [x] 4.3 Render loading, disconnected, unavailable, current, stale, and unknown-zone states with
      readable text and decorative artwork hidden from assistive technology; verify contrast,
      accessible labels, imported-report behavior, and absence of repetitive screen-reader
      announcements on minute updates.

## 5. Integration qualification and documentation

- [x] 5.1 Add `tests/ui/device-clock.spec.ts` coverage for minute/activity refresh, suspension
      resume, both reload cases, timezone/DST/midnight changes, stale recovery, missing transport
      support, and generation races; run the focused suite against a verified project server, using
      an isolated port/configuration if port 5173 belongs to another project.
- [x] 5.2 Extend terminal isolation and report/privacy coverage so clock polling overlaps user
      commands and diagnostics; verify clock markers/output never enter PTY history, report exports,
      or persisted session data and user input continues during failed clock reads.
- [x] 5.3 Extend production website portability coverage for the header and older gateways; run
      `npm run test:portability` across Chromium, Firefox, and WebKit with mobile layout checks.
- [x] 5.4 Qualify the fixed clock read on the existing local Linux SSH test environment with GNU and
      BusyBox date, OpenSSH/Dropbear, and Bash/ash where available; record actual command results,
      returned zone/offset, and concurrent terminal behavior. If an environment is unavailable,
      record the exact gap and retain fixture coverage without claiming real-server qualification.
- [x] 5.5 Briefly document display location, minute cadence, reload/reboot behavior, timezone
      source, and availability states in `docs/usage.md` and relevant development/gateway docs;
      verify README remains concise and private device details remain local.
- [x] 5.6 Run `npm run verify`, desktop/web/gateway builds, and the relevant desktop/UI integration
      checks under the documented Node 24 environment; review the final diff for unintended
      report-schema, terminal, credential, or device-configuration changes and record results with
      any material limits.

## 6. Display refinements

- [x] 6.1 Render device HH:mm using seven-segment artwork with equivalent accessible text; update
      pixel hands from the same latest sample and retain them when stale.
- [x] 6.2 Style the connected Disconnect device button and hover state orange; preserve Connect
      device styling and document the refined display.
- [x] 6.3 Verify clock updates, stale/disconnected states, button colors, responsive layouts,
      formatting, type checking, and desktop/web builds.

- [x] 6.4 Apply the user's compact layout sketch: pixel clock left, date over timezone in the
      middle, and small seven-segment time right. Verify standard desktop card/header heights,
      metadata placement, mobile/long-zone layouts, and existing clock lifecycle behavior.

- [x] 6.5 Blend the clock into the header with the app's slate surface, subtle border, mint
      artwork/time accents, regular date typography, muted timezone, and dimmer inactive segments;
      preserve compact layout and verify responsive/digit behavior and builds.

- [x] 6.6 Thicken the seven-segment digits with a subtle matching stroke while preserving the
      current size and spacing; verify responsive layout and rebuild both renderer editions.
