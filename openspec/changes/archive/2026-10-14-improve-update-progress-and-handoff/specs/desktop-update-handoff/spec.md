# Spec Delta

## Purpose

Give desktop operators truthful update progress and verified destination and restart evidence
without weakening the native update trust boundary.

## ADDED Requirements

### Requirement: Truthful update stages

The application SHALL expose preparation, download, verification, installation and handoff stages.
Download percentage SHALL use measured bytes only when a validated total is known; other stages and
unknown totals SHALL be indeterminate. Download completion SHALL NOT imply successful verification
or launch. Prestart cancellation SHALL remain available with a cancel icon; unsupported active
cancellation SHALL NOT be presented as functional.

#### Scenario: Missing HTTP length

- **WHEN** the response has no Content-Length but validated release metadata contains a total
- **THEN** download progress uses that validated total and verification remains separate

#### Scenario: Failure after download

- **WHEN** checksum verification or relaunch fails
- **THEN** the UI shows failure rather than claiming the update completed

### Requirement: Safe launchable destination

The application SHALL distinguish transient staging from the verified final launchable app path and
provide native folder access and path copying only for app-owned validated destinations. It SHALL
preserve the original executable and explain using the new executable for subsequent launches.

#### Scenario: Renderer submits arbitrary path

- **WHEN** a renderer attempts to open a filesystem path outside the native selected update
  destination
- **THEN** the request is rejected or ignored without opening that path

### Requirement: Durable handoff evidence

The application SHALL retain bounded current/new version and verified destination evidence across
restart, including clean mode. Restart requested SHALL be distinguished from confirmation that the
new app is running at the expected version and location. Reopening the old executable SHALL show the
new destination without claiming successful handoff.

#### Scenario: Old executable reopened

- **WHEN** the old version starts after an update was requested
- **THEN** the receipt reports the observed current version, pending destination and need to launch
  the new executable

#### Scenario: New executable observed

- **WHEN** the expected version starts from the verified final destination
- **THEN** the receipt confirms that observed handoff without automatically deleting the old
  executable

### Requirement: Platform-specific supported update mechanisms

The application SHALL support automatic verified executable handoff on Windows x64 and Linux x64
only. Linux SHALL relaunch the durable AppImage with the preserved profile and confirm version, path
and checksum in the new process. macOS x64 and arm64 SHALL explicitly deny automatic installation
without fetching incompatible artifacts and provide verified-download/manual installer guidance,
default destination and current native bundle path actions. Mac helper stages SHALL distinguish
download, verification, installation and normal launch requested from observed execution, without
fabricated percentages or successful automatic handoff. Native CI SHALL qualify Linux packaged
handoff and both Mac architectures' manual installer/UI/path behavior while preserving signing,
Gatekeeper, rollback and unsupported states.

#### Scenario: Linux real future package

- **WHEN** Linux updates to a distinct future-version packaged AppImage
- **THEN** new-process version, durable APPIMAGE location and expected checksum confirm handoff
  while report recovery remains offline

#### Scenario: Mac automatic update unavailable

- **WHEN** an Intel or Apple Silicon Mac checks updates
- **THEN** automatic installation stays unavailable, no Windows/Linux artifact is fetched, and
  verified manual steps and native bundle locations remain usable

#### Scenario: Normal Mac helper launch

- **WHEN** the verified helper requests normal launch after atomic installation
- **THEN** it reports a request and preserves failure rollback; separate native qualification
  observes the opened version and bundle without changing system security policy
