## Purpose

Provide an explicit per-user Windows application installation that keeps verified app files in a
permanent folder and offers a simple, durable EXE entry point without repeated portable extraction.

## ADDED Requirements

### Requirement: Explicit extract-once setup

The application delivery SHALL install a complete verified Windows x64 app bundle only after an
explicit setup action. Setup SHALL present an assisted review of app/profile location, selected
shortcuts, update and removal behavior before explicit confirmation. Setup SHALL use an
application-owned per-user destination, require no administrator privileges, preserve unrelated
files and existing installations, and create no service, scheduled task, startup registration,
security exemption or persistent debugging endpoint.

#### Scenario: First setup

- **WHEN** the user chooses extract-once setup
- **THEN** the complete verified bundle is committed to the selected owned folder and later launches
  reuse that installed folder without extracting the portable payload again

#### Scenario: Destination is unavailable

- **WHEN** policy, permissions, disk space or an existing unowned installation prevents safe setup
- **THEN** setup fails with a readable reason and does not elevate, change permissions or overwrite
  that installation

### Requirement: Durable included executable and shortcut

The installed bundle SHALL expose one simple included EXE entry point at a stable app-owned
location. Any optional shortcut SHALL target that location, preserve the approved profile and
continue to work after a successful replacement or rollback. The launcher SHALL NOT rely on a
transient extraction directory, hidden cache or persistent debugger.

#### Scenario: Repeated launch

- **WHEN** the installed EXE or approved shortcut is launched again
- **THEN** the same durable application location starts with the preserved profile and no setup
  extraction or unexpected network collection occurs

### Requirement: Verified bounded bundle staging

Setup and replacement SHALL verify the same-release archive checksum, version, architecture, source
identity and bounded file manifest before activation. Extraction SHALL reject traversal, absolute
paths, duplicate normalized names, unsupported links, unsafe Windows names, unexpected files,
exceeded bounds and modified payloads. Verification SHALL NOT use timestamps or folder names as
substitutes for cryptographic integrity.

#### Scenario: Corrupt or unsafe payload

- **WHEN** staged bytes differ from the verified manifest or an entry escapes the owned destination
- **THEN** activation is rejected and the installed application and profile remain unchanged

### Requirement: Atomic replacement and recoverable rollback

Replacement SHALL quiesce owned Serial, SSH and collection work, preserve requested report recovery
and wait boundedly for owned process/file locks before activation. The previous verified bundle
SHALL remain recoverable until the new version, location and verified payload are observed. A failed
or interrupted replacement SHALL leave a clearly identified usable old or new installation, preserve
user data and never reconnect devices or replay commands automatically.

#### Scenario: Locked or failed replacement

- **WHEN** an installation remains in use or activation/launch fails
- **THEN** replacement stops or restores the previous verified bundle and reports the actual outcome
  without killing unrelated processes or claiming success

### Requirement: Truthful launch qualification

Qualification SHALL measure first setup, first observed fresh-profile launch and repeated launch
separately through native-visible, non-minimized, responsive interaction. It SHALL preserve payload
identity, report individual timings and spread, distinguish renderer observations from native
presentation, and state uncontrolled cache/host limitations. A splash or DOM-only event SHALL NOT be
reported as a usable application.

#### Scenario: Performance target is not met

- **WHEN** observed usable launch remains above the requested target
- **THEN** the result states the measured latency and delivery tradeoffs without a cold-cache claim,
  security workaround or fabricated readiness
