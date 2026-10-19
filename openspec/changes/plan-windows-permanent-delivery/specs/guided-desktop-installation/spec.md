## Purpose

Give desktop users a clear reviewed installation and maintenance flow through familiar one-line
commands, preserving their data and the real capabilities and security policies of each supported
platform.

## ADDED Requirements

### Requirement: Reviewed platform-specific setup

Guided setup SHALL identify the compatible supported OS, native architecture and release, show
app/data location, integration options, update/removal behavior and truthful trust/prerequisite
limits before modifying an installation. Windows x64 setup SHALL use current-user installation
without elevation. Mac x64/arm64 setup SHALL retain verified complete bundles and manual
maintenance. Linux desktop setup SHALL offer only architectures with matching qualified assets.
Installation SHALL begin only after an explicit review confirmation.

#### Scenario: User reviews first installation

- **WHEN** a supported user opens guided setup
- **THEN** they can review/change supported locations and options, cancel without installation, or
  explicitly confirm installation and receive the actual resulting app path

#### Scenario: Unsupported or protected destination

- **WHEN** architecture, runtime, destination ownership, permissions or OS policy prevents setup
- **THEN** setup explains the actual limitation without fetching incompatible binaries, elevating or
  changing host security settings

### Requirement: Retained one-line command entry points

Each supported platform SHALL retain its documented shell download/setup entry point and compatible
explicit version selection and download-only behavior. Future default interactive entry points SHALL
verify matching release setup material and open a reviewed setup flow. Historical helpers SHALL
retain their immutable release contract. A missing wizard asset for a selected historical release
SHALL be explained with an explicit legacy portable/manual choice rather than an invented wizard.

#### Scenario: One-line guided installation

- **WHEN** a supported user invokes the future default one-line command
- **THEN** compatible setup material is verified, review choices are presented and installation
  waits for user confirmation before reporting the actual installed path and offering normal launch

#### Scenario: Explicit legacy or download-only request

- **WHEN** a user selects an older release or an existing explicit format/download-only option
- **THEN** the helper preserves the identified release/artifact intent and does not silently install
  a different delivery or replace user data

### Requirement: Bounded interactive and offline behavior

Setup SHALL distinguish piped script input from user confirmation, support a bounded terminal review
alternative when available, and fail clearly when neither a usable graphical interface nor a
terminal is available. Noninteractive execution SHALL NOT imply acceptance. Offline installed launch
and verified compatible local setup material SHALL be supported without silently trusting incomplete
cached downloads. Unattended installation SHALL remain unavailable unless separately designed and
qualified.

#### Scenario: Piped command without user input surface

- **WHEN** a one-line piped command has no available GUI or controlling terminal
- **THEN** it reports download-only/manual alternatives and exits without hanging or accepting
  default installation choices

#### Scenario: Offline already-installed launch

- **WHEN** the user chooses launch for a verified existing installation while offline
- **THEN** its durable entry point can launch without a release check, device connection or fresh
  extraction required by permanent-folder delivery

### Requirement: Existing installation maintenance

Guided setup SHALL discover bounded app-owned installation records and verify actual
path/version/payload before offering Launch, Update or Repair. It SHALL NOT silently duplicate
installations, downgrade versions, overwrite foreign paths or share a mutable profile. Multiple
valid installations SHALL require explicit selection. Data/report import and shared-profile use
SHALL be explicit choices with applicable validation and locking.

#### Scenario: Repeat setup command

- **WHEN** an existing verified installation is found
- **THEN** setup identifies its location/version and offers maintenance rather than creating a new
  default copy or silently reinstalling it

#### Scenario: Ambiguous or changed installation

- **WHEN** multiple installations exist or an owned installation is damaged
- **THEN** setup requests explicit selection or reviewed repair while preserving unrelated files and
  profile/report data

### Requirement: Owned integration and removal

Setup SHALL declare and create only selected per-user application shortcuts and uninstall
bookkeeping appropriate to the platform. It SHALL NOT add autorun, services, login items, global
PATH changes or system-wide menu entries. Removal SHALL target only verified owned
files/integrations, refuse unsafe or busy destinations and retain profiles/reports unless a separate
deletion choice is explicitly confirmed.

#### Scenario: Remove an installed app

- **WHEN** the user confirms app removal
- **THEN** only the selected owned app/integrations are removed and settings/reports are retained by
  default with their location identified

### Requirement: Truthful setup and launch outcomes

Progress SHALL separate download, integrity verification, installation, launch requested and
observed native execution. Unknown-total/non-download steps SHALL use truthful indeterminate status.
OS trust refusals and missing prerequisites SHALL remain visible without policy bypass. Success
SHALL NOT imply unqualified automatic update, architecture support, signing/notarization or native
startup performance.

#### Scenario: App installed but launch denied

- **WHEN** verification/installation succeeds but normal OS launch is blocked
- **THEN** setup reports the verified installed path and actual launch denial without claiming the
  app is running or altering security policy
