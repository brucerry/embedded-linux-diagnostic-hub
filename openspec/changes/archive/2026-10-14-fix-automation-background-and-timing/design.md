# Current batch: Automation usability and background execution

Serial corrections remain in place and unpublished. Add a separate local Automation follow-up
specification alongside fix-local-serial-discovery-and-beach; preserve the archived v0.5.0 contract.

## Implementation plan

1. Rename the label editor to Step name (optional), start it blank and derive a readable Step N
   capture label only when omitted. Keep the actual multiline command input visibly separate.
2. Add handle-based mouse dragging with existing move-up/down keyboard buttons, offered-step ID
   validation, focus/position feedback and disabled reorder while armed/executing. Preserve active
   immutable snapshots and payload bytes.
3. Remove visibility/minimize as an unconditional cancellation trigger. In Electron, support active
   background timing via a trusted activity lifecycle and prevent renderer background throttling
   while armed/running; add explicit main-process suspend/resume eligibility notifications/gating.
   Preserve connection/ownership/clock-jump/stale-calibration/sleep-stall guards, no
   overlap/backlog, explicit rearming after real interruption, and page-exit cleanup. Browser
   suspension/throttling limitations must remain explicit. Minimize must not weaken the
   sleep/uncertainty rules.
4. Replace conditional jumping Timing inputs with stable run-mode and schedule/repetition sections.
   Provide date and time pickers, selectable IANA timezone, automatic offset for the selected
   scheduled date, and a live current-time reference in that zone/source. Keep chosen wall fields
   and resolved scheduled instant fixed when the reference ticks. Use existing strict resolution and
   add explicit earlier/later choice for DST folds; reject gaps, invalid calendars and past or
   race-past starts. Retain local/device selection and verified SSH clock refresh/fencing; Serial
   device scheduling stays unavailable without a verified provider.
5. Add native minimized-window and real protocol SSH-server scheduling/repetition/cancellation
   integration coverage; preserve strict assertions and capture bytes/status. Then run focused and
   full applicable unit/browser/native/build/portability gates before review and consolidated push.

## Verified existing test boundaries

- tests/automation-ssh.test.ts uses SshSession and gatewayFixture, whose ssh2.Server creates real
  loopback SSH authentication/session/exec channels. It verifies exact multiline payloads, split
  UTF-8/raw stderr, genuine exit7, reconnect fencing, owned cancellation, output bounds, terminal
  exclusion, pre-start cancellation tombstones and session retention. This is a protocol mock
  server, not a real DUT.
- tests/automation-desktop-smoke.ts launches actual sandboxed Electron and trusted IPC against that
  real loopback protocol fixture. It verifies exit7, SIGTERM pause/skip, Unicode/multiline payloads,
  local JSON export and exclusion of credentials/tokens. Existing receipt:
  task/ui-revision-after/final-automation-native.log.
- tests/automation.test.ts FlowRunner tests cover delay/repeat/no overlap, scheduled due time,
  cancellation, clock jumps, replacement, calibration and active-command suspension using fake
  clocks/backends. These are deterministic engine tests, not SSH wire integration.
- tests/ui/automation.spec.ts SSH UI test uses installDesktop and overrides runAutomation in the
  renderer. It exercises UI/snapshots/export behavior, not real SSH protocol timing. Serial UI uses
  synthetic navigator.serial. tests/automation-termination.test.ts uses synthetic client
  EventEmitter channels for signal/unknown exit rules.

New real-protocol minimized/scheduled/repeating/cancel integration is therefore needed to qualify
the expanded requirement; earlier evidence must not be described as physical or all-wire scheduling
coverage. No standalone mock service or real DUT/physical UART operation is authorized or started.

## Concrete current behavior

AutomationPage explicitly cancels when document.hidden is true. FlowRunner separately rejects timer
stalls over2500ms or local/monotonic drift over1000ms and fences connection/calibration. The primary
Electron window currently leaves backgroundThrottling at its default. Timing has an optional
schedule checkbox, conditional fields and manually entered UTC offset. Existing resolveWallTime
already performs strict calendar/zone/DST resolution and returns valid alternatives.

## Remaining consequential boundary

The all-OS-port request exceeds Chromium's catalog for some driver metadata cases/PTYs. Current
Serial correction accepts every runtime offer without brand/COM-number gates, but a native transport
is a separate architectural decision and no universal hardware claim is made.

## Decisions

Native trusted-main IPC holds an active-work lease and disables background throttling only while
armed. Power suspend/resume invalidates eligibility and sends an interruption to the renderer. Page
exit/renderer destruction also releases the lease. Browser runs retain timer-stall guards without
promising suspended-tab execution. Schedule controls resolve the selected fields independently of a
live reference clock; folds require earlier/later occurrence selection. No time field is
automatically advanced.

## Migration

No persisted drafts require migration. No release publication is authorized by these local
artifacts.
