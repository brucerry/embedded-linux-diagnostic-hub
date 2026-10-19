# Spec Delta

## Purpose

Qualify the desktop application's Intel and Apple Silicon macOS behavior on free public-repository
runners with truthful package integrity and update-support boundaries.

## ADDED Requirements

### Requirement: Free architecture-specific hosted qualification

The repository SHALL qualify macOS x64 on standard macos-15-intel and arm64 on standard macos-15
runners while public. This increment SHALL use read-only workflow permissions, no paid runner
fallback, no signing-account credentials, no retained binary artifacts or paid cache/storage
expansion, and SHALL preserve existing Windows/Linux qualification coverage.

#### Scenario: Main or pull request qualification

- **WHEN** the public repository receives a main push or pull request
- **THEN** both native Mac architectures run build/test qualification and the existing Windows/Linux
  gates remain intact

#### Scenario: Private repository or disallowed service

- **WHEN** the repository is private or a paid runner/account would be required
- **THEN** this free qualification path does not launch a billable fallback

### Requirement: Verify actual packaged application behavior

Each Mac architecture SHALL verify its app/framework architecture, ad-hoc bundle integrity and
packaged-source identity, and SHALL run packaged SSH/PTY/clock/reset/trust/security plus native
window/terminal continuity including 100 cycles. Native state/event/session assertions SHALL NOT be
waived to obtain a green job.

#### Scenario: Current app bundle

- **WHEN** an architecture-specific app directory is built
- **THEN** its architecture and source bytes are verified and controlled SSH/native-window checks
  run against that app

### Requirement: Honest unsupported automatic updates

macOS SHALL explicitly report that automatic update installation is unavailable, retain a link to
releases, reject install requests and SHALL NOT claim Windows/Linux update artifacts support Mac.
Existing supported-platform update behavior SHALL remain intact.

#### Scenario: Check or request a Mac update

- **WHEN** a Mac app checks updates or requests installation
- **THEN** unsupported installation is explicit and no executable download/relaunch is attempted

### Requirement: Qualification and distribution limits

This completed qualification-only increment SHALL remain build/test/log evidence for Mac. It
SHALL NOT add public Mac downloads, notarization or a public Mac release, and SHALL preserve
published v0.2.0. Separately authorized Windows/Linux v0.3.1 publication SHALL NOT be presented as
Mac distribution. Reports SHALL distinguish runner-local launch from downloaded-app Gatekeeper
behavior and SHALL NOT claim older macOS or physical-device qualification.

#### Scenario: Successful hosted jobs

- **WHEN** both Mac jobs pass
- **THEN** reports identify tested architectures/OS and retain the Gatekeeper/download/minimum-OS
  limitations without declaring a public Mac release
