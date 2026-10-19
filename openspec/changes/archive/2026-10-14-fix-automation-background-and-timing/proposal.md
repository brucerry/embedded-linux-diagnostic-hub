# Proposal

## Why

The Commands label looks like executable content and minimize currently cancels armed work.
Scheduling needs stable controls with automatic timezone offsets and a clear current-time reference.

## What Changes

- Optional step names, explicit payload editors, mouse and keyboard reorder frozen while active.
- Continue armed desktop work while minimized; preserve sleep, ownership, connection, clock and
  timer-stall guards.
- Stable run-mode, date/time and timezone controls, automatic offsets and explicit repeated-time
  choices.
- Real loopback SSH scheduled/repeat/cancel coverage, including native minimize.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- command-automation: deliberate editing, scheduling presentation and background eligibility.

## Impact

Renderer Automation, shared time resolution, trusted Electron lifecycle bridge and focused/native
tests. No new dependencies. Proposed v0.5.1 after full qualification and review.
