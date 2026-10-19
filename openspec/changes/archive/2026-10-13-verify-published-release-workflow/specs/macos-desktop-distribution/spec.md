# Spec Delta

## ADDED Requirements

### Requirement: Read-only published-release verification

Normal verification SHALL resolve the latest stable release's tag and source together; an explicit published tag SHALL select its own immutable consumer source and tagged command, including supported historical or preview releases. Current workflow names and badges SHALL be version-neutral; one-time recovery data SHALL remain clearly historical and manual-only.

An already published Mac-capable release SHALL be verifiable without rebuilding, uploading, replacing, publishing or modifying release files or tags. Verification SHALL validate public availability, complete artifact/checksum/manifest catalogs, version/source identity, tag-derived helper bytes and release notes, followed by actual published-command and installed-app checks on both available native Mac architectures. Status documentation SHALL distinguish availability and current validation from historical publication failures; failed runs SHALL remain visible and unsuccessful checks SHALL not be represented as passing.

#### Scenario: Audit a published release

- **WHEN** an authorized read-only verification targets an already published release
- **THEN** all public files and native command checks must pass before its verification reports success and release data remains unchanged

#### Scenario: Explicit historical release selection

- **WHEN** an explicit published Mac-capable tag is selected after a newer stable release exists
- **THEN** verification binds that tag's source and downloads together and executes the tagged helper without switching to latest

#### Scenario: Audit fails or historical publication failed

- **WHEN** any published audit check fails or an earlier publication run failed
- **THEN** the actual check reports failure, historical evidence remains available and no published release or tag is altered to obtain a passing status
