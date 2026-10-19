# Tasks

All implementation tasks are intentionally unchecked. Design/spec artifacts precede implementation;
the local browser PDF generator is a proposed review assumption, not an installed/approved
dependency. Reliability/storage/SSH gates retain priority.

## 1. Passive viewer and visual design

- [ ] 1.1 Add a bounded read-only view model identifying draft versus frozen active plan and
      available live step/state; verify draft edits cannot replace the active snapshot and no viewer
      subscriber owns execution or raw output.
- [ ] 1.2 Add the lazy Show flow entry and accessible in-app dialog with theme tokens, soft readable
      cards and a pinned detail pane; verify no graph layout/export work or heavy graph/PDF code
      runs at startup, focus restores and long commands remain readable.
- [ ] 1.3 Render one directed edge between each consecutive authored command block, including
      labelled disabled steps; verify exact edge count/order, arrow direction and separate
      schedule/repetition annotations without all-to-all edges or new branching.

## 2. Interaction and live behavior

- [ ] 2.1 Add smooth bounded view-only drag with pointer capture and adjacent-edge updates,
      pan/zoom/fit/reset and equivalent keyboard controls; verify command IDs/order/enablement never
      mutate, text selection in details works and pointer cancellation cleans up.
- [ ] 2.2 Add hover/selection/click-to-pin details, live state labels/icons and reduced-motion
      behavior; verify visible focus, text/control contrast, narrow/wide layouts and truthful
      unknown/cancelled/uncertain status using synthetic flows.
- [ ] 2.3 Qualify open/close/drag/zoom/detail actions during waiting, delayed, active and repeated
      flows; compare exact command bytes/count/order and durable capture ACKs with the same flow
      without the viewer, including cancel/disconnect and modal focus changes.

## 3. Full-graph local export

- [ ] 3.1 Build an inert full-scene snapshot independent of viewport transform; verify all
      nodes/edges/labels and snapshot identity/time persist after pan/zoom, hostile markup is text
      and no script/link/resource fetch or raw-output accumulation occurs.
- [ ] 3.2 Add local SVG and bounded PNG export from that complete scene; verify off-screen content,
      Unicode/long text, explicit downscale/size failure, no silent crop and released object
      URLs/canvas memory.
- [ ] 3.3 Qualify a reviewed small lazy local browser PDF generator before adding any package:
      inspect primary docs/license/security/font/worker/offline behavior and bundle size, and
      demonstrate readable paginated/tiling output without blocking a synthetic active flow. If the
      user rejects the proposed route, update scope/design explicitly first; no dependency
      installation occurs during this planning pass.
- [ ] 3.4 Add native asynchronous PDF through a separate sandboxed local render surface and trusted
      bounded Save request; verify no privileged preload/new origin exception, no external
      navigation/network, readable complete pagination, cancellation/error cleanup and unchanged
      flow continuity.
- [ ] 3.5 Integrate browser PDF only after its reviewed generator/continuity qualification; verify
      complete multi-page output and detail references, no print-dialog fallback and honest
      unavailable/failed export states across the supported engines.

## 4. Integration acceptance

- [ ] 4.1 Verify maximum 20-step flows and extreme bounded coordinates/command lengths while
      active/repeating; demonstrate bounded listener/layout/export resources and no startup,
      storage-throughput, lifecycle/watchdog or terminal-input regression without raising existing
      deadlines.
- [ ] 4.2 Review polished actual-theme screenshots and keyboard/reduced-motion interactions at
      narrow/wide sizes, independently review the bounded source/export packet and rerun applicable
      aggregate gates. Retain all broader v0.6.0 platform/docs/publication gates; graph
      implementation is not authorized by this proposal alone.
