# Spec Delta

## Purpose

Let teams describe board-specific resources, fixtures, and acceptance criteria once, then reuse
functional tests across projects without rewriting shell commands for each device.

## ADDED Requirements

### Requirement: Reconciled connected-board inventory

Both editions SHALL provide on-demand, bounded, read-only discovery of the connected device's
running device tree, supported runtime resources, board/kernel identity, and installed adapter
prerequisites. Inventory SHALL distinguish described, disabled, bound, missing, inaccessible, and
ambiguous resources where evidence permits. Runtime enumeration SHALL supplement device-tree data.
Missing device-tree access SHALL permit explicitly mapped runtime resources without inventing
hardware identity or test coverage. Discovery SHALL NOT perform bus scans, hardware writes, driver
rebinding, package installation, or watchdog activation.

#### Scenario: Running device tree and runtime disagree

- **WHEN** a device-tree node exists but its expected runtime device cannot be resolved
- **THEN** the discrepancy is shown and an active test cannot treat that node as a working resource

#### Scenario: Dynamically enumerated or non-device-tree hardware

- **WHEN** a device is discovered through runtime enumeration without a corresponding device-tree
  node
- **THEN** its observed identity remains available for explicit profile mapping with the source
  shown

#### Scenario: Discovery is incomplete

- **WHEN** a read fails, exceeds a limit, or lacks permission
- **THEN** the affected evidence is marked incomplete and does not prove that expected hardware is
  absent

### Requirement: Portable versioned board profiles

The application SHALL support validated JSON profiles with a schema version, profile identifier and
revision, board matching criteria, logical resource names and selectors, test definitions, fixture
requirements, acceptance criteria, declared effects/restoration, and ordered named sequences.
Profiles SHALL be editable, importable, and exportable locally without storing credentials.
Unsupported schema versions, duplicate identifiers, invalid references, unsupported active adapters,
unsafe parameter values, arbitrary shell commands, and oversized profiles SHALL be rejected with
actionable errors. Valid editing SHALL NOT start a device operation.

#### Scenario: Reuse a test on another board revision

- **WHEN** a user changes the UART resource mapping and baud parameters in a profile
- **THEN** the same loopback adapter resolves and uses those validated settings without a new script

#### Scenario: Import malformed or executable profile content

- **WHEN** a profile contains invalid references or a command field intended for shell execution
- **THEN** validation rejects it before any remote test operation

### Requirement: Draft profile generation and explicit test intent

Users SHALL be able to generate an editable draft from current inventory. Drafts SHALL retain
resource provenance and identify unfilled mappings, fixture requirements, expected values, and
acceptance limits. Discovery SHALL NOT infer electrical limits, arbitrary register transactions,
fixture wiring, physical success, or permission to exercise hardware. Non-implemented domains SHALL
have explicit adapter availability rather than generated runnable placeholder tests.

The guided workspace SHALL automatically populate a fresh editable draft after each successful
discovery, stack sections at full width, and hide profile/review sections until discovery is
complete. Simulation SHALL supply its inventory without exposing a Discover board action. The
advanced JSON editor SHALL appear above guided fields, synchronize valid edits, permit ordinary
selection/copy/paste, and provide a top-right animated copy button. Invalid required fields SHALL
have an accessible red border and explanation, and SHALL prevent progression until corrected.

#### Scenario: Discovery prepares the guided form

- **WHEN** complete connected-board discovery succeeds
- **THEN** the profile section appears below discovery with observed mappings automatically filled
  and unknown test intent visibly invalid until completed

#### Scenario: Discover an I2C device without approved identity parameters

- **WHEN** draft generation finds a known runtime I2C device but no approved identity register/value
- **THEN** it offers the discovered resource and requires those parameters before an identity test
  can run

#### Scenario: Discover a future domain

- **WHEN** inventory contains SPI, GPIO, PCIe, LAN/WLAN, HDMI, or watchdog resources
- **THEN** the UI shows discovered evidence and whether a functional adapter exists without claiming
  a test pass

### Requirement: Board matching and unambiguous resource resolution

Before active tests, the application SHALL reconcile the selected profile with fresh
connected-device evidence and resolve each logical resource to one permitted runtime target.
Selectors SHALL support device-tree/runtime topology and observed identity without relying solely on
globally fixed Linux enumeration numbers. A wrong board, ambiguous match, missing required evidence,
or changed inventory SHALL block the affected operation with an explanation. Any user-supplied board
revision SHALL be identified as declared rather than independently observed. Explicit manual
mappings SHALL be reviewed against current inventory before active execution.

#### Scenario: I2C bus number changes

- **WHEN** the same controller/mux topology is assigned a different logical bus number
- **THEN** resolution uses the observed topology to find the current bus and records that mapping

#### Scenario: Resource selector matches multiple devices

- **WHEN** a logical UART selector matches two runtime resources
- **THEN** the test remains blocked until the mapping is made unambiguous

#### Scenario: Connected target is replaced

- **WHEN** the selected profile was resolved for an earlier connection generation
- **THEN** its old bindings cannot be used to operate the replacement device

### Requirement: Visible prerequisites and effects

Before starting a test or sequence, users SHALL see resolved targets, test parameters, fixture
requirements, expected results, intended effects, restoration, and unmet prerequisites. Fixture
readiness and explicitly approved resource use SHALL be recorded for that run. Missing tools,
permissions, fixture feedback, or unsupported restoration SHALL remain explicit rather than trigger
automatic installation, root escalation, or fallback writes. Test selection and preparation SHALL be
possible independently of running the full sequence.

#### Scenario: Required UART helper is absent

- **WHEN** the selected loopback adapter lacks a supported installed device-side helper
- **THEN** the test is blocked with the missing capability identified and other prepared tests
  remain usable

#### Scenario: Fixture is not attached

- **WHEN** a required loopback fixture has not been marked ready
- **THEN** Run cannot start that active test and the UI describes the required connection
