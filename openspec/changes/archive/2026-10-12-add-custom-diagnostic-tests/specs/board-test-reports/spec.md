# Spec Delta

## ADDED Requirements

### Requirement: Reproducible measurement evidence

Version 2 reports SHALL preserve original profile/digest and criteria, definition ID/version/digest, parser/conversion identity, execution capability-profile ID/version and fixed wrapper digest, resolved parent/channel and current path, observed driver/kernel/device identity, identity limitations, installed executable path/version/fingerprint where applicable, validated arguments, raw output/value, engineering value/unit, scale/offset provenance, observation timing, source timing/cache/clock uncertainty, sampling completeness and execution/termination outcome. Missing facts SHALL be explicit. Evidence SHALL describe the measured property and support envelope without upgrading a sensor/counter observation into universal functional hardware qualification. Credentials, environment secrets and unrelated terminal data SHALL be excluded; unsafe output text SHALL remain escaped and bounded in every document format.

#### Scenario: Numerical result can be checked later

- **WHEN** an engineer exports a converted IIO measurement
- **THEN** another reader can identify its raw value, exact conversion inputs/unit, criterion boundaries, source limitations and recorded verdict without rerunning hardware

#### Scenario: Network counter observation is exported

- **WHEN** a reviewed command records an interface packet counter
- **THEN** the report identifies that snapshot and its source without claiming traffic generation, link throughput or a tested peripheral

### Requirement: Historical version compatibility and inert import

The application SHALL validate and render supported version 1 and version 2 reports under their original schema/verdict rules, preserving imported/simulated labels. It SHALL NOT fabricate new provenance for old evidence or recalculate a version 1 digest from an upgraded representation. Version 2 import SHALL reject malformed conversions, incompatible criteria, inconsistent observations/verdicts and oversized data. Conversion/parser semantics SHALL come from an application-owned current or retained historical contract catalog, identified by ID/version/digest; imported descriptors and self-consistent hashes SHALL NOT define trusted conversion rules. Validation SHALL recompute typed converted values and criteria from raw inputs under the matched trusted contract and reject unknown/mismatched contracts or forged conversions. A historical definition absent from the executable registry SHALL remain inert evidence when its trusted historical contract remains supported; it SHALL NOT become executable merely through import. Successful consistency validation SHALL NOT authenticate the physical origin of imported observations. Report import/export SHALL NOT install definitions, retarget a live device or modify current readiness.

#### Scenario: Import a legacy report

- **WHEN** a valid version 1 test report is imported
- **THEN** its original evidence and verdicts render with an imported label and new measurement fields remain unavailable rather than invented

#### Scenario: Imported evidence references an old recipe

- **WHEN** a valid historical report records a recipe no longer executable in the application but its trusted historical contract remains supported
- **THEN** its bounded recorded evidence remains readable without registering or running that recipe

#### Scenario: Forged conversion descriptor is internally consistent

- **WHEN** a report supplies a fabricated conversion and matching fabricated value/verdict/digest
- **THEN** import rejects the unmatched trusted contract instead of validating the attacker-provided formula
