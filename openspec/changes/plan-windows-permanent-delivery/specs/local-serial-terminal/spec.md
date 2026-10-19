## ADDED Requirements

### Requirement: Bird-free distant island decoration

Serial decoration SHALL remove all birds and related bird motion, present muted tree-covered islands
near the upper ocean, and MAY include small beach crabs. It SHALL retain the soft-light pixel/SVG
style, terminal readability, responsive geometry, aria-hidden pointer-inert decoration and
reduced-motion support. Decoration SHALL NOT send input or open a port.

#### Scenario: Responsive reduced-motion scene

- **WHEN** Serial is resized to mobile dimensions or reduced motion is enabled
- **THEN** islands remain in the upper ocean, crabs remain on the beach, birds are absent and
  terminal/clipboard interaction remains available

### Requirement: Completed Deselect releases visible controls

After successful Deselect cleanup, the application SHALL notify the final idle state after ownership
is released, enable the chooser and framing controls, retain their selected values and require
explicit reselection before another Connect. Unfinished or timed-out cleanup SHALL retain ownership
and block replacement/open operations until cleanup actually completes.

#### Scenario: Deselect an unopened or connected port

- **WHEN** an operator deselects a selected-only or connected local port and cleanup succeeds
- **THEN** no port remains selected, settings/chooser are enabled with retained framing values, and
  selecting a replacement never opens it automatically

#### Scenario: Cleanup exceeds its bound

- **WHEN** cleanup is still pending after its timeout
- **THEN** ownership remains held and new opens stay blocked; successful eventual cleanup publishes
  its released state rather than leaving stale disabled controls

### Requirement: Readable Serial secondary controls

Enabled Serial secondary controls, including the custom chooser and pagination, SHALL retain
readable normal/hover text and visible keyboard focus. Disabled colors and unrelated SSH control
styles SHALL remain unchanged. Normal text contrast SHALL meet 4.5:1, and the Serial modal focus
outline SHALL meet 3:1 against its adjacent modal background.

#### Scenario: Mouse and keyboard port selection

- **WHEN** an operator hovers a custom chooser choice or tabs to a choice and presses Enter
- **THEN** the control stays readable with visible focus, selection updates its label without an
  automatic port open, and disabled pagination keeps its disabled palette

## ADDED Requirements

### Requirement: Serial foreground refinement preserves accepted scene

The Serial scene SHALL remove only the left foreground palm/tree/coconut group that overlaps
terminal output, retain the right-side and distant island trees, and preserve the already
implemented bird-free islands/crabs composition. Decoration SHALL remain behind readable terminal
text, pointer-inert and excluded from assistive navigation without sending device input.

#### Scenario: Foreground cleanup at narrow and wide widths

- **WHEN** Serial is viewed at narrow and wide sizes after the refinement
- **THEN** the left foreground group is absent, the accepted right/distant scene remains and
  text/selection/copy controls are unobstructed

### Requirement: Legible Serial terminal colors and clouds

Serial SHALL use a scoped accessible default/ANSI/selection/cursor presentation that keeps plain
output and representative colored prompts legible across sky, ocean and sand without rewriting raw
output, changing prompt matching or covering the scene with a dark panel. A few subtle soft-light
pixel-style clouds SHALL remain in the sky without obstructing text or pointer input. Optional
cloud/scene motion SHALL stop for reduced motion and pause while hidden/blocked. The SSH terminal
palette and scene SHALL remain independently controlled.

#### Scenario: Output and cursor across the scene

- **WHEN** representative plain/colored output, selected text and active/inactive cursor are shown
  over sky, ocean and sand
- **THEN** text/cursor remain readable with measured contrast, clouds remain subtle/inert and raw
  bytes/completion behavior are unchanged
