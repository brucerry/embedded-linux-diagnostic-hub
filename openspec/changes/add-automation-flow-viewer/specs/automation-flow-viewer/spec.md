# Spec Delta

## Purpose

Help operators inspect the existing ordered Automation sequence and its live state through an
optional accessible graph, with local complete-graph exports that do not interfere with execution.

## ADDED Requirements

### Requirement: Optional sequential graph without editing execution

Show flow SHALL open an optional lazily loaded in-app viewer of the existing command sequence.
Consecutive command blocks SHALL be joined by directed arrowed edges in their existing order, and
edge geometry SHALL follow node positions. Dragging SHALL change layout only and SHALL NOT reorder,
enable, edit or branch commands. Disabled steps SHALL remain identifiable in their original
position. Schedule and repetition SHALL be clearly annotated without implying new executable
branches. Closing the viewer SHALL preserve the underlying command draft/run and restore focus.

#### Scenario: Drag a command card during a run

- **WHEN** a user moves a graph node and later closes the viewer
- **THEN** connected arrows follow that node, the original execution order/plan remain unchanged and
  the flow continues without duplicate or skipped sends

### Requirement: Readable theme-consistent accessible interaction

The viewer SHALL use the application's theme, soft readable card/edge colors, clear
hover/selection/focus states and text/icons in addition to color for state. It SHALL provide smooth
bounded dragging, panning, zoom controls and fit/reset, plus keyboard alternatives and focus
management. Long/multiline command details SHALL be readable without expanding the canvas
unboundedly, available on hover and accessible click/keyboard pinning. Labels SHALL identify
command/name/ordinal, intent, enablement, delay and applicable timeout; schedule/repetition
information SHALL remain legible. Decoration/animation SHALL respect reduced motion and not obscure
text or intercept unrelated input.

#### Scenario: Keyboard and long command inspection

- **WHEN** a keyboard-only or reduced-motion user opens a flow with long multiline commands
- **THEN** they can inspect/pin details, move the view, zoom/fit and close with visible focus and
  readable text, without editing or sending a command

### Requirement: Honest draft and live snapshots

Idle viewing SHALL identify the current draft; armed/running viewing SHALL identify the frozen
active plan and live current step/repetition/state. Pending, waiting/delaying, running,
skipped/disabled, completed, cancelled/paused and failed/uncertain states SHALL reflect available
runner evidence without inventing successful exits, branches or completion. Concurrent draft edits
SHALL NOT replace the active snapshot. Viewer updates SHALL consume bounded read-only state and
SHALL NOT copy full captured output.

#### Scenario: Edit draft while armed

- **WHEN** a user edits the draft after arming and inspects the graph
- **THEN** the viewer identifies the frozen active sequence and its actual state separately from the
  next-run draft

### Requirement: Complete local graph exports

Explicit SVG/PNG/PDF export SHALL snapshot the full graph, node layout, labels and available state
independently of viewport pan/zoom, and SHALL identify snapshot time and draft/active context.
Export SHALL include off-screen nodes/edges and SHALL NOT silently crop. SVG SHALL be inert escaped
local content without executable markup, external resources or active links. PNG SHALL respect
explicit bounded pixel/memory limits, explaining downscaling or unsupported size rather than
truncating. PDF SHALL keep graph labels/details readable through pagination/tiles and command-detail
pages with clear continuation references. Missing/unqualified platform format support SHALL be shown
honestly and SHALL NOT be disguised as successful export of another format. Commands may contain
secrets; local export disclosure SHALL be visible and no upload SHALL occur.

#### Scenario: Export a panned large flow with hostile text

- **WHEN** a graph with off-screen nodes and markup-like command text is exported
- **THEN** the complete snapshot is present and safely escaped, PDF remains readable across pages,
  and no command/output text triggers a script, resource fetch or device action

### Requirement: Execution-independent bounded viewer lifecycle

Opening, closing, dragging, inspecting and exporting SHALL NOT arm/cancel/restart/pause a flow,
acquire its transport lease, block storage/terminal acknowledgement, duplicate commands or relax
sleep/visibility/ownership guards. The viewer/exporters SHALL load only on explicit use, bound
snapshot/layout/export resources and release owned listeners, object URLs and render surfaces on
close/failure. Startup shall perform no graph layout/export work. Platform export implementations
SHALL be qualified while a synthetic scheduled/repeated/active flow continues, including
cancel/disconnect and large/maximum-size graph interactions.

#### Scenario: Export while a repeated flow runs

- **WHEN** the operator opens the viewer, drags/zooms and exports during a synthetic active or
  repeated flow
- **THEN** command bytes/count/order and lifecycle behavior match the same flow without the viewer,
  storage acknowledgements continue, and viewer cleanup affects only its own resources
