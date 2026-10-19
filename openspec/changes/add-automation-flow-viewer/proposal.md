# Proposal

## Why

The ordered Automation editor becomes difficult to inspect as commands, delays and repetition
accumulate. An optional flow view can make the existing sequence and live state easier to understand
without changing execution semantics.

## What Changes

- Add a lazy Show flow action opening an accessible in-app popup/dialog with theme-consistent soft
  cards, directed arrows between consecutive command blocks, and clear schedule/repetition
  annotations.
- Allow smooth view-only node dragging, pan/zoom/fit and keyboard inspection; arrows follow node
  positions. The user explicitly confirmed dragging does not reorder execution. The existing command
  list remains authoritative; no branching/edge editing is introduced.
- Show draft versus armed snapshot identity, enablement, timing and honest live run states, with
  readable command previews and hover plus accessible click-to-pin details.
- Export the complete graph and its layout/status snapshot locally as SVG, PNG and PDF, independent
  of the viewport; paginate PDF details/readable graph tiles rather than shrinking everything
  illegibly.
- Keep opening/closing/interacting/exporting independent of execution ownership, storage
  acknowledgements and lifecycle guards. Do not add startup work, external services or new
  permissions.

## Capabilities

### New Capabilities

- `automation-flow-viewer`: optional read-only sequential graph, accessible interactions, live
  snapshot semantics, bounded lifecycle and full-graph local exports.

### Modified Capabilities

None. Existing ordered editing, scheduling, cancellation, capture and terminal contracts remain
authoritative. Graph image/PDF exports are covered by this capability rather than changing QA
raw-result exports.

## Impact

AutomationPage receives a read-only snapshot adapter and lazy viewer entry. A new isolated
view/layout/export module can use installed React, SVG and browser primitives for the current
20-step maximum; no graph library is needed. Existing Modal focus management and theme tokens are
relevant but execution activity must not depend on the viewer's mounted state.

Desktop PDF can use built-in Electron printToPDF in an unprivileged isolated local render surface.
The proposed browser PDF approach is a small reviewed lazy local generator; this is a reversible
planning assumption awaiting user review, not permission to install a dependency now. No dependency
is installed. Browser PDF remains unqualified until the generator and live-run continuity gates
pass; changing this approach or deferring that format requires an explicit scope update. See
design.md. All implementation tasks remain unchecked; this is design/feasibility before code,
targeted for the combined v0.6.0 release after reliability gates.
