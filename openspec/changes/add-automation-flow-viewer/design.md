# Design

## Context

See proposal.md. Inspected AutomationPage, FlowRunner/FlowState, shared/automation.ts, Modal.tsx,
package.json and index.html. Plans currently allow 20 steps, each with a stable
ID/name/enablement/command/delay/Enter intent; schedules/repetition belong to the plan. FlowState
provides aggregate state/current step, not a complete graph history. Current CSP blocks
frames/object content and uses local scripts/styles; do not weaken it to host a diagram. Installed
dependencies include React/Lucide/xterm/ssh2, with no graph or PDF engine.

The user confirmed two semantic decisions: arrows connect consecutive existing command blocks and
follow their positions; dragging affects only view layout. Interaction quality and consistency with
the main application's theme are priorities. Reliability/storage/SSH work stays ahead of this
optional feature.

## Goals / Non-Goals

Goals: a polished optional inspection view, honest live state and readable complete-graph local
export without execution interference. Non-goals: execution reordering through the graph, editable
edges/branches, a second runner, raw-output visualization, automatic port/SSH actions, external
services or new host permissions.

## Decisions

### Use an in-app popup and a read-only snapshot adapter

Prefer a large responsive dialog using existing focus/backdrop semantics rather than a separate
browser tab/window. This keeps the execution document visible and avoids popup blockers or
accidentally invoking current visibility/sleep interruption behavior. Do not make graph visibility
part of backend availability, active lease or cancellation. Closing the viewer only drops view
resources. A pinned command-detail panel is inside this dialog and remains keyboard accessible.

Create an immutable bounded view model from the current draft when idle and the already frozen plan
when armed/running. Use stable step IDs, explicit snapshot kind/run identity, node
labels/enablement/intent/timing and available live status. If extra per-step status is needed,
expose bounded passive runner events; do not create results or await graph rendering on the
execution path. Show unknown state rather than infer success. Draft changes remain visibly distinct
from the armed snapshot.

### Render at most 20 cards with native SVG edges

Use installed React/DOM cards, an SVG edge layer and pointer capture. A separate coordinate map
keyed by step ID controls view layout and never mutates the ordered plan. Store coordinates only in
viewer state initially; reset/fit supplies a deterministic vertical/serpentine layout. Connect i to
i+1 only, with arrowheads and source/target ports at card bounds. Disabled cards remain
visible/labelled; arrows communicate authored order, not a new conditional execution path. A
separate header/badge communicates scheduled start and repeat interval; no branching or all-to-all
edges.

Use application tokens for surfaces/text/accent, soft category/state accents and unobtrusive
shadows. Keep card names/ordinals and short plain-text command previews readable; a scrollable
pinned details pane holds full bounded command text and completion configuration. Target 14px
ordinary detail text, visible 2px focus, 4.5:1 ordinary text and 3:1 meaningful control/state edges.
State includes icon/text, so it is not color-only. Exact visual values are reviewed against actual
themes before adoption.

Pan on background drag, drag cards with pointer capture, zoom through explicit buttons/wheel
affordance and keep focused items discoverable. Keyboard shortcuts provide equivalent selection/pin,
bounded node nudging/view panning, zoom/fit/reset and Escape close; document them in the dialog.
Prevent browser text selection only during intentional drag, preserve command selection in details,
and cancel capture safely on pointer cancellation. Batch transient pointer updates to animation
frames, bound coordinate/zoom ranges, recompute adjacent edges only and stop optional motion under
reduced motion. Do not persist scripts/layout automatically into other stores.

### Export an immutable full-graph scene

Build one bounded inert scene description from all card/edge bounds plus padding, independent of the
current viewport transform. Export clones data at click time; it cannot take execution ownership or
await output capture. Use plain escaped text and controlled SVG elements, never foreignObject,
innerHTML, user URLs, scripts, event handlers or external fonts/assets. Include metadata stating
draft/active identity and snapshot time; graph export is not execution proof or raw QA evidence.

SVG serializes all geometry/labels. PNG rasterizes that same inert scene at a bounded pixel budget
(proposed maximum 16 megapixels/64 MiB RGBA working image); if a layout exceeds the budget offer
explicit downscale or SVG/PDF, never crop silently. Revoke object URLs and release canvases
promptly. Complete commands remain in a detail appendix/companion portion rather than unreadably
tiny card text. Test Unicode, bidirectional/control text, multiline/very long scripts and hostile
markup as text.

PDF uses A4/Letter landscape pages with at least 10–11pt readable labels/details. Export an overview
plus numbered tiles/command-detail pages when the full graph cannot fit legibly; continuation labels
preserve sequential arrows across tiles. Keep page headers/footers and original command ordinals. A
single giant reduced page does not meet acceptance.

### PDF platform feasibility and proposed approach

Electron exposes asynchronous webContents.printToPDF with CSS page sizing/background/page selection.
Use a temporary isolated hidden render surface with sandbox/contextIsolation on, nodeIntegration
off, no privileged preload, no arbitrary navigation/network, and strict local inert content. Main
authenticates/validates the trusted request and owns the Save-dialog destination; never broaden
capture IPC's main-frame guard to trust an export window. Qualify setup/close/error cleanup and run
continuity before claiming support. This is documented feasibility, not a tested native PDF
implementation.

Browser Window.print blocks while its dialog is open; using it on the execution document can violate
the no-pause requirement. A separate popup can also change visibility/focus, so it is not assumed
safe merely because it is separate. The proposed browser route is a reviewed small lazy local PDF
generator with explicit byte/pixel/page limits and no network. This is a reversible design
assumption, not a confirmed user preference or permission to install now; the optional clarification
remains open. Keep complete PDF support in the acceptance contract instead of silently substituting
another format. Before adding a package, review its maintained primary documentation,
license/security, Unicode/font behavior, worker compatibility, size and offline bundling;
demonstrate readable pagination and live-run continuity with the bounded scene. If the user chooses
to defer browser PDF instead, update this proposal/spec/platform scope explicitly before
implementation. SVG/PNG and native PDF feasibility are independent of the package selection.

## Risks / Trade-offs

- Rendering/export work could delay safety timers → keep bounded/lazy/coalesced work, test actual
  repeated/scheduled synthetic runs and move heavy raster/PDF work to an isolated worker/surface
  where possible; never raise watchdog deadlines to accommodate the viewer.
- Graph state could drift from the active plan → immutable identified snapshot and passive bounded
  events; unknown status remains explicit.
- Modal input blocking could accidentally become activity blocking → separate terminal input focus
  protection from Automation ownership, and regress open/close/export during execution.
- Full-graph image bounds can explode after dragging → finite coordinates/pixel/page budgets and
  explicit readable pagination.
- PDF platform differences → qualify actual engines/platforms and report unsupported formats
  honestly; no print-dialog or service fallback presumed safe.

## Migration Plan

No schema/data migration or dependency change occurs during planning. Review the proposed local
browser PDF route and its dependency qualification before adding any package. Implement the lazy
passive viewer separately after reliability prerequisites; then interactions/live-state and each
local exporter in bounded increments. Compare synthetic execution traces with/without every
viewer/export operation. Preserve the existing editor and exports on viewer failure; rollback
removes only the optional entry/module. All implementation and publication remain pending.

## Primary references

- [Electron webContents.printToPDF](https://www.electronjs.org/docs/latest/api/web-contents#contentsprinttopdfoptions):
  local asynchronous PDF API and page/CSS options, checked October 15.
- [Window.print](https://developer.mozilla.org/en-US/docs/Web/API/Window/print): print dialog blocks
  execution; this motivates the browser feasibility gate.
