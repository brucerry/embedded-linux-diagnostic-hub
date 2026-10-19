# Proposal

## Why

Runtime-offered Serial ports do not establish coverage of every OS-valid driver class, and physical
COM11/platform acceptance remains deferred. This local record coordinates those pending decisions
and evidence from separately authorized v0.6.0 increments.

## What Changes

- Keep the native-backend dependency/ABI/platform decision and explicitly authorized hardware
  acceptance open; do not fabricate COM/tty paths or bypass host policy.
- Preserve explicit selection/Connect, exclusive ownership, bounded queues, generation fences and
  acknowledged cleanup. Device UART enablement, wiring and operation remain the user's
  responsibility.
- Reconcile historical checkpoint tasks with accepted isolated Serial integration, the reviewed
  seven-file correction, the new indexing/migration candidate and still-open aggregate gates.
- Route behavioral requirements to plan-windows-permanent-delivery (existing Serial
  controls/artwork), add-durable-automation-capture (full-output storage),
  add-ssh-persistent-console-automation (owned SSH PTY) and add-automation-flow-viewer (optional
  graph). This record is coordination and acceptance bookkeeping, not their replacement
  specification.

## Capabilities

### New Capabilities

None. Keep the existing explicit `skip_specs: true` for this planning/acceptance queue; create no
specs under this change.

### Modified Capabilities

None in this coordination artifact. The concrete behavioral deltas live in the named sibling
changes. A future native Serial backend requires its own concrete platform/dependency decision and
delta before implementation.

## Impact

Local planning and evidence only. Tasks retain the history of separately authorized implementation
packets and distinguish preparation, independent acceptance, isolated integration and final product
adoption. The October 15 audit found that this record's schema design artifact was missing and its
storage expansion had only partial behavioral coverage in the Windows release delta; design.md and
add-durable-automation-capture repair that gap prospectively. Old passes and new structural
validation do not prove historical workflow adherence or release readiness.
