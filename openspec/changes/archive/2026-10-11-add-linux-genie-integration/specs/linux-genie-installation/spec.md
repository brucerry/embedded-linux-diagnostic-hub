# Spec Delta

## Purpose

Let Ubuntu and Debian users obtain optional native Genie support through the ordinary Linux
download-and-run command, with verified delivery and understandable setup and activation outcomes.

## ADDED Requirements

### Requirement: One-line compatible Genie setup

The existing Linux one-line download command SHALL offer optional Genie setup on supported GNOME
graphical sessions on Ubuntu and Debian. It SHALL detect the running desktop, actual shell version,
session availability and supported integration before changing anything. Initial qualification SHALL
cover Ubuntu 22.04 LTS/GNOME 42, Ubuntu 24.04 LTS/GNOME 46, Ubuntu 26.04 LTS/GNOME 50 and Debian
13/GNOME 48 with their supported GNOME sessions; other shell versions and desktops SHALL keep
ordinary app launch with a clear unsupported status. The helper SHALL NOT install or switch the
user's desktop environment to obtain the effect.

#### Scenario: Supported GNOME session

- **WHEN** the user runs the ordinary Linux one-line command in a supported GNOME session
- **THEN** the helper offers the required optional Genie setup without requiring a separate manual
  extension download or expert knowledge of desktop internals

#### Scenario: Ubuntu 22.04 legacy GNOME session

- **WHEN** the user runs the ordinary Linux one-line command in a qualified Ubuntu 22.04 GNOME 42
  session
- **THEN** the helper offers the release-matched legacy companion for that runtime and does not
  attempt to load the incompatible modern ESM package

#### Scenario: Other desktop or older shell

- **WHEN** the user runs the helper under an unsupported desktop or shell version
- **THEN** the app remains available with native minimize/restore and the helper explains that Genie
  is unavailable without trying to replace the desktop

### Requirement: Scoped prerequisite installation

Before installing optional system packages or changing per-user desktop integration, the helper
SHALL present the proposed setup and obtain explicit consent in the user's terminal. It SHALL
install only missing, identified prerequisite packages through the existing Ubuntu/Debian package
manager, elevate only package installation, and perform extension/app registration as the normal
desktop user. Declining optional Genie setup, lacking an interactive terminal, or an optional setup
failure SHALL NOT prevent launch when the ordinary app prerequisites are satisfied. An already
installed compatible companion SHALL NOT require another installation prompt on every launch.
`--download-only` SHALL NOT install packages, register or enable extensions, or launch the app.

#### Scenario: Accept necessary packages

- **WHEN** a supported desktop user accepts optional setup with missing prerequisite utilities
- **THEN** the helper installs only those packages, rechecks availability and performs per-user
  Genie setup without launching the app as root

#### Scenario: Skip optional setup

- **WHEN** the user declines Genie setup or the helper has no terminal to request consent
- **THEN** no optional package or desktop change occurs and ordinary verified app launch continues

#### Scenario: Download without installation

- **WHEN** the helper is invoked with `--download-only`
- **THEN** it obtains the requested verified app without optional integration changes or execution

### Requirement: Release-matched verified companion

The companion SHALL be delivered as an immutable, checksummed asset from the exact release tag
selected for the app, including explicitly requested older versions and engineering prereleases.
Installation SHALL verify its bytes, declared identity, compatibility and expected archive contents
before enabling or replacing integration. Corrupt, absent, incompatible or unsafe companion content
SHALL NOT be executed or installed and SHALL NOT replace a previously working companion. The
ordinary verified app SHALL remain launchable. Release qualification SHALL verify both assets and
their version/source identity before publication.

Legacy GNOME 42 and modern GNOME 46/48/50 packages SHALL have separate immutable release assets,
runtime-specific compatibility and strict archive validation. They SHALL preserve the same scoped
ownership, consent, rollback, activation and removal contracts. A metadata-only allowlist change
SHALL NOT qualify an incompatible extension format.

#### Scenario: Explicit version selection

- **WHEN** the helper downloads an explicitly requested release that provides Genie support
- **THEN** its companion and checksum come from that same release rather than the newest release

#### Scenario: Runtime-specific companion format

- **WHEN** the selected release provides both legacy and modern companions
- **THEN** the helper selects the verified asset compatible with the actual running shell and
  requires matching app/version/source identity before any installation change

#### Scenario: Corrupt or unsafe companion

- **WHEN** a companion checksum, metadata or archive-content check fails
- **THEN** the helper leaves existing integration intact and launches only the verified ordinary app
  with an understandable Genie setup failure

#### Scenario: Older release has no companion

- **WHEN** the selected app release predates Linux Genie delivery
- **THEN** the helper reports unavailable support and preserves the existing download-and-run flow

### Requirement: Truthful activation state

Setup SHALL distinguish active integration from installed-but-pending activation, skipped,
unsupported and failed states. Success messages SHALL require confirmation from the current shell
that the expected companion is enabled, compatible and running. When the shell must reload the new
or updated extension, the helper SHALL give the needed next-login instructions and continue app
launch with native behavior. It SHALL NOT restart the shell, log out, reboot or claim a newly
installed extension is active merely because files were copied. Existing global extension and
animation preferences SHALL remain unchanged.

#### Scenario: First installation needs a new session

- **WHEN** the companion is installed but the current shell cannot yet load it
- **THEN** the helper reports pending activation, explains how to finish at the next login and
  launches the app without Genie until activation is confirmed

#### Scenario: Extensions globally disabled

- **WHEN** the user's shell policy disables extensions
- **THEN** the helper respects that policy, explains the inactive state and does not enable other
  extensions or change global preferences

### Requirement: Reversible per-user integration

Integration SHALL be installed under the current user's data directories, identify owned files,
preserve unrelated extensions and desktop entries, and handle repeat setup and updates without
duplicating registrations. Users SHALL have a documented disable/removal command that removes only
Diagnostic Hub's managed companion and registration while retaining their app downloads and device
data. Setup SHALL report its installed size separately from existing system prerequisites, and
release documentation SHALL describe the supported matrix and fallback behavior.

#### Scenario: Repeat setup or update

- **WHEN** the user reruns the helper or selects a newer compatible release
- **THEN** setup reuses or updates only the managed integration, preserves unrelated user files and
  reports whether the current session is using the requested version

#### Scenario: Remove Genie support

- **WHEN** the user invokes the documented managed removal command
- **THEN** only the owned Genie integration is disabled and removed, and ordinary app use and device
  data remain available
