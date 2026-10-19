# Spec Delta

## ADDED Requirements

### Requirement: Versioned custom measurement intent

Both editions SHALL accept version 2 profiles defining reviewed driver or command measurements alongside existing tests. Each measurement SHALL specify a logical resource, channel/metric, definition ID/version/digest, typed parameters, required/optional status, fixture intent, explicit unit-compatible acceptance criteria, freshness policy and bounded sampling intent. Numeric ranges SHALL declare each inclusive/exclusive boundary; enumeration/boolean criteria SHALL declare exact expected values. Unknown fields, invalid bounds, incompatible units, unsupported definitions and budgets above hard limits SHALL be rejected before target work. Version 1 profiles SHALL retain their existing validation, adapter behavior and canonical digest semantics. Unsupported versions or peers SHALL receive an actionable compatibility error without execution or silent downgrade.

#### Scenario: Existing profile remains usable

- **WHEN** an engineer imports a valid version 1 LED/UART/I2C profile in the new application
- **THEN** its existing meaning and digest remain unchanged and its supported tests remain available

#### Scenario: Unknown engineering unit

- **WHEN** a measurement's criterion uses a unit incompatible with its reviewed channel conversion
- **THEN** preparation cannot proceed and identifies the unit mismatch without guessing a conversion

### Requirement: Shared physical resource and channel selection

Measurement definitions SHALL use the same current connected-device selection, inventory and logical-resource mapping as other tests. Inventory SHALL record runtime parent/topology, driver/interface provenance, channel identifier, identity strength, access capability and incomplete discovery. Enumeration numbers, labels and encounter-order IDs SHALL NOT alone prove stable physical identity. Preparation and execution SHALL resolve one current resource/channel within the selected session and boot generation; ambiguity, hot removal, changed identity or conflicting ownership SHALL block affected work. A manual mapping with weak identity SHALL be explicitly labeled and reviewed for the current generation, with the limitation retained in evidence; it SHALL NOT become a silent portable binding.

#### Scenario: hwmon index changes after reboot

- **WHEN** a sensor receives a new hwmon enumeration number but its reviewed parent and channel identity uniquely match
- **THEN** fresh preparation resolves the new path and records its identity evidence rather than trusting the old number

#### Scenario: Identical sensor labels are ambiguous

- **WHEN** two observed channels match the same selector without sufficient parent identity
- **THEN** the measurement remains blocked until an explicit current mapping resolves the ambiguity

### Requirement: Visible measurement capability and intent

Guided setup and direct JSON SHALL expose supported measurement definitions, targets, raw/engineering units, conversion provenance, ranges, sampling limits, freshness support, effects and missing prerequisites. Discovery SHALL leave board-specific ranges and fixture intent unfilled instead of inventing acceptable electrical or physical limits. Guided preparation SHALL require explicit current review; direct JSON Run SHALL record the same validated intent/readiness through its existing single action without adding intermediate confirmations. Changing source, profile, definition, channel or identity SHALL invalidate dependent preparation. Simulated state SHALL remain independent of live state.

#### Scenario: Source cannot provide sample age

- **WHEN** a profile requires bounded source-sample age but the reviewed definition provides no such evidence
- **THEN** preparation marks that test Blocked and distinguishes a recent read from a proven recent physical sample

#### Scenario: Direct JSON defines a complete supported measurement

- **WHEN** an engineer presses Run JSON with valid complete intent and current supported prerequisites
- **THEN** the existing direct workflow prepares and runs without another agreement while recording the measurement criteria and readiness

### Requirement: Native capability compatibility

Fresh inventory and preparation SHALL use versioned observed native access capabilities rather than Python presence. Supported historical version 1 inventory/reports SHALL retain original normalized content/digests and remain inert on import; their Python flags SHALL NOT authorize current UART execution. New capability schemas SHALL reject unknown fields and unsafe ABI/method claims. A client SHALL identify unsupported testing peers before dispatch instead of silently selecting an older Python-backed workflow.

#### Scenario: Historical Python capability is imported

- **WHEN** a version 1 saved report records python3 capability
- **THEN** its historical evidence remains readable without executing Python or supplying current native UART readiness
