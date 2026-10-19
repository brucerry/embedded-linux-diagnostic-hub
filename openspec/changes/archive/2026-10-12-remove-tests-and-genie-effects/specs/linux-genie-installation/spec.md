# Spec Delta

## REMOVED Requirements

### Requirement: One-line compatible Genie setup

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Scoped prerequisite installation

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Release-matched verified companion

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Truthful activation state

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Reversible per-user integration

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

## ADDED Requirements

### Requirement: No Genie activation or delivery requirement

Current app launchers/builds/releases SHALL contain no Genie setup prompt, companion fetch, extension activation/removal operation or required companion asset. Standard app integrity, platform-library checks and sandbox-preserving launch behavior SHALL remain. Existing downloaded apps/extensions, saved data and historical release evidence SHALL be preserved; no automatic uninstallation migration SHALL run.

#### Scenario: Launch a verified Linux artifact

- **WHEN** the launcher downloads and verifies a supported app artifact
- **THEN** ordinary launch proceeds without optional Genie consent, Python/GLib integration probes or extension changes
