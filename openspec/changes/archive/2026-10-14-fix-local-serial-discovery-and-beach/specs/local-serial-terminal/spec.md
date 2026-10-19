## ADDED Requirements

### Requirement: Equivalent trusted Serial root origins

Desktop Serial permission SHALL accept the trusted origin's browser root serialization with or
without its sole trailing slash. It SHALL retain exact requesting document, trusted WebContents,
main-frame, permission-type and active-session checks. Path/query/fragment/foreign/opaque origin
variants SHALL NOT be accepted by discarding their extra components.

#### Scenario: Actual packaged renderer origin

- **WHEN** the trusted packaged main document requests Serial using app://bundle/ as its origin
- **THEN** permission policy allows that request's valid root form without changing host permission
  or opening/selecting any port automatically

### Requirement: Metadata-optional complete runtime choices

The chooser SHALL preserve every valid unique runtime-offered port ID and OS-supplied name,
including multi-digit COM names, built-in UART, USB and virtual driver identities when offered.
Optional USB IDs/friendly names SHALL NOT gate selection; no COM-number whitelist or first-128
truncation SHALL hide a valid offer. Selected labels SHALL NOT be applied to unrelated handles.
Runtime discovery SHALL be distinguished from previously authorized ports and from arbitrary OS
device nodes outside the runtime catalog. Unsupported classes SHALL be documented honestly.

#### Scenario: COM11 without USB metadata

- **WHEN** the runtime offers COM11 with a valid opaque ID and no USB or friendly-name metadata
- **THEN** it is displayed and explicitly selectable by that offered identity, without opening it

#### Scenario: Offered port after 128 entries

- **WHEN** a valid offered port appears after the first 128 entries
- **THEN** its identity remains selectable and unoffered/stale identities remain rejected

## MODIFIED Requirements

### Requirement: Legible decorative beach volleyball scene

Serial SHALL display the established pig and duck as decorative pixel-style beach volleyball
characters with a soft light palette, ocean waves, sand, side trees and a stationary sun disc with
gentle animated pixel flames around its edge. The Serial-only pig tail SHALL be absent. The Serial
scene SHALL contain no Earth, globe or smiling sun face. The scene SHALL remain behind or outside
legible terminal text, non-interactive and excluded from assistive navigation. Layout SHALL fit
narrow and wide windows. Motion SHALL pause while hidden/blocked and stop for reduced-motion
preference, without unbounded animation resources. The SSH scene SHALL retain its existing
appearance.

#### Scenario: Reduced motion or hidden Serial

- **WHEN** reduced motion is requested or the Serial workspace is hidden/blocked
- **THEN** decorative movement stops or pauses while terminal state and readable text remain usable

#### Scenario: Resize while receiving

- **WHEN** a wide or narrow window is resized while serial output arrives
- **THEN** the pig/duck beach composition and fitted text remain inside the frame without
  intercepting pointer/keyboard input

#### Scenario: Stationary sun and Serial-only tail removal

- **WHEN** Serial decoration is playing
- **THEN** only the edge flames flicker around the stationary solar disc, the Serial tail is absent,
  and shared SSH sprites/artwork remain unchanged
