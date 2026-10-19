# board-test-profiles Specification

## Purpose

Let teams describe board-specific resources, fixtures, and acceptance criteria once, then reuse
functional tests across projects without rewriting shell commands for each device.

## Requirements

### Requirement: Retired live test inventory

The application SHALL provide no Tests profile/inventory workspace or Discover board action in
either edition and SHALL NOT perform the retired test-inventory discovery automatically. Ordinary
diagnostic collection and clock/terminal functions SHALL remain available through their independent
paths. Removal SHALL NOT claim reproduction or repair of the reported OpenWrt DT-property error.

#### Scenario: Connect an OpenWrt-described fixture

- **WHEN** the diagnostic workspace connects to a fixture with board metadata that would be invalid
  for the retired test parser
- **THEN** no retired inventory request is sent and normal collection does not use that parser
