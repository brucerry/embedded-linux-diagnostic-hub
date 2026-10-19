## MODIFIED Requirements

### Requirement: Safe launchable destination

The application SHALL distinguish transient staging from the verified final launchable app path and
provide native folder access and path copying only for app-owned validated destinations. Portable
delivery SHALL preserve the original executable and explain using the new executable for subsequent
launches. Optional installed Windows delivery SHALL identify its stable installed EXE and retain the
previous verified bundle for rollback. An arbitrary process executable path SHALL NOT be treated as
installed delivery without an explicit native installed-delivery identity.

#### Scenario: Renderer submits arbitrary path

- **WHEN** a renderer attempts to open a filesystem path outside the native selected update
  destination
- **THEN** the request is rejected or ignored without opening that path

#### Scenario: Installed Windows destination

- **WHEN** an installed Windows app displays launch or update locations
- **THEN** it identifies the validated permanent EXE and installation root rather than the setup
  EXE, archive staging path or a temporary portable extraction process

### Requirement: Durable handoff evidence

The application SHALL retain bounded current/new version, delivery kind and verified destination
evidence across restart, including clean mode. Restart requested SHALL be distinguished from
confirmation that the new app is running at the expected version, location and verified payload.
Reopening the old executable SHALL show the new destination without claiming successful handoff.
Installed Windows confirmation SHALL bind its stable installation location to the verified successor
bundle, not merely reuse a receipt because the filename is unchanged.

#### Scenario: Old executable reopened

- **WHEN** the old version starts after an update was requested
- **THEN** the receipt reports the observed current version, pending destination and need to launch
  the new executable

#### Scenario: New executable observed

- **WHEN** the expected version starts from the verified final destination
- **THEN** the receipt confirms that observed handoff without automatically deleting the old
  executable

#### Scenario: Stable filename contains the wrong installed version

- **WHEN** an installed EXE is at the expected pathname but its version or verified bundle identity
  differs
- **THEN** handoff is not confirmed and the retained rollback destination remains identified

### Requirement: Platform-specific supported update mechanisms

The application SHALL support automatic verified handoff on Windows x64 and Linux x64 only. Windows
SHALL distinguish portable executable handoff from optional installed-bundle replacement and select
only compatible same-release assets for that delivery kind. Installed support SHALL remain
unavailable until its native bundle verification, activation, rollback and distinct future-version
handoff are qualified; it SHALL NOT silently switch an installed app to portable delivery. Existing
portable Linux AppImage delivery SHALL relaunch the durable AppImage with the preserved profile and
confirm version, path and checksum in the new process. Newly guided Linux installed AppImage or
directory layouts SHALL offer verified manual maintenance until their own native identity, durable
shortcut, replacement and genuine future-version/report recovery contracts are qualified; directory
delivery SHALL NOT spoof APPIMAGE or fetch an incompatible portable replacement. macOS x64 and arm64
SHALL explicitly deny automatic installation without fetching incompatible artifacts and provide
verified-download/manual installer guidance, default destination and current native bundle path
actions. Mac helper stages SHALL distinguish download, verification, installation and normal launch
requested from observed execution, without fabricated percentages or successful automatic handoff.
Native CI SHALL qualify Linux packaged handoff and both Mac architectures' manual installer/UI/path
behavior while preserving signing, Gatekeeper, rollback and unsupported states.

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

#### Scenario: Installed asset is absent or unqualified

- **WHEN** installed Windows delivery has no compatible qualified bundle asset
- **THEN** automatic replacement remains unavailable with readable manual guidance and no portable
  fallback or incompatible fetch

#### Scenario: Linux installed layout is not yet qualified for automatic update

- **WHEN** guided Linux installation uses a new managed or directory layout without qualified
  automatic handoff
- **THEN** updates remain explicitly manual and existing portable AppImage support is preserved
  without false confirmation or incompatible downloads
