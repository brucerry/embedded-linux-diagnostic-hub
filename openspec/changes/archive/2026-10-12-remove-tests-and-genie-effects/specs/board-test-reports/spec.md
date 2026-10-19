# Spec Delta

## REMOVED Requirements

### Requirement: Separate portable test evidence

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Optional readable HTML and PDF documents

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Clean consistent report presentation

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Trusted generation and local-only handling

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

## ADDED Requirements

### Requirement: Preserve historical test artifacts

Retiring test report controls SHALL NOT delete saved user JSON/HTML/PDF files, historical qualification evidence or unique unfinished source experiments. Historical validators retained for automated compatibility coverage SHALL remain isolated from active device collection and UI. Current documentation SHALL identify feature retirement without rewriting prior release outcomes.

#### Scenario: Existing saved report survives retirement

- **WHEN** the user updates to the workspace without Tests
- **THEN** saved report files remain on disk and removal does not run a data-cleanup migration
