## ADDED Requirements

### Requirement: Responsive SSH height and existing star refinement

The SSH terminal's available height and existing star presentation SHALL be refined without losing
fitted rows/cursor visibility, readable output, ordinary input/selection/copy/scroll behavior or the
established SSH artwork. Existing stars SHALL be treated as baseline behavior. Decoration SHALL
remain pointer-inert and excluded from assistive navigation, and optional motion SHALL pause while
hidden/blocked and stop under reduced-motion preference. Serial theme changes SHALL NOT alter the
SSH palette or terminal ownership.

#### Scenario: Resize a full SSH terminal with reduced motion

- **WHEN** a full terminal is resized between narrow and wide layouts with reduced motion enabled
- **THEN** fitted rows and cursor remain visible, stars remain decorative and static,
  text/scroll/input stay usable and no device input is caused by the presentation change
