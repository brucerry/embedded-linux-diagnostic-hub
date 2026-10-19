# Spec Delta

## REMOVED Requirements

### Requirement: Reconciled connected-board inventory

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Portable versioned board profiles

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Draft profile generation and explicit test intent

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Board matching and unambiguous resource resolution

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Visible prerequisites and effects

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

## ADDED Requirements

### Requirement: Retired live test inventory

The application SHALL provide no Tests profile/inventory workspace or Discover board action in either edition and SHALL NOT perform the retired test-inventory discovery automatically. Ordinary diagnostic collection and clock/terminal functions SHALL remain available through their independent paths. Removal SHALL NOT claim reproduction or repair of the reported OpenWrt DT-property error.

#### Scenario: Connect an OpenWrt-described fixture

- **WHEN** the diagnostic workspace connects to a fixture with board metadata that would be invalid for the retired test parser
- **THEN** no retired inventory request is sent and normal collection does not use that parser
