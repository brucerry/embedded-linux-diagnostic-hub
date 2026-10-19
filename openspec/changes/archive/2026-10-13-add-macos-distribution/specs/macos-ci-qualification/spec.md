# Spec Delta

## MODIFIED Requirements

### Requirement: Free architecture-specific hosted qualification

The repository SHALL qualify macOS x64 on standard macos-15-intel and arm64 on standard macos-15
runners while public. Main/PR qualification SHALL retain read-only permissions and no Mac binary
Actions artifacts or cache expansion. Separately authorized new-tag distribution jobs SHALL use only
the existing per-job repository token scoped to the new draft and final publication; no persistent
credential, paid runner, signing account or added Mac Actions storage SHALL be required. Existing
Windows/Linux qualification coverage SHALL remain intact.

#### Scenario: Main or pull request qualification

- **WHEN** the public repository receives a main push or pull request
- **THEN** both native Mac architectures run build/test qualification with read-only permissions and the existing Windows/Linux gates remain intact

#### Scenario: Private repository or disallowed service

- **WHEN** the repository is private or a paid runner/account would be required
- **THEN** this free qualification path does not launch a billable fallback

#### Scenario: Authorized new-tag Mac staging

- **WHEN** a qualified new release tag requests Mac distribution
- **THEN** only verified files are staged in its private draft using scoped ephemeral permissions and no public partial downloads are exposed

### Requirement: Qualification and distribution limits

Mac distribution SHALL follow the separately authorized macos-desktop-distribution contract.
Reports SHALL distinguish hosted build/command-line launch from quarantined browser-download
Gatekeeper behavior and SHALL NOT claim older macOS, managed-device acceptance or physical-device
qualification without evidence. Ad-hoc integrity SHALL not be presented as Developer ID trust or
notarization. All existing published releases and tags SHALL remain immutable.

#### Scenario: Successful hosted jobs

- **WHEN** both Mac jobs pass
- **THEN** reports identify tested architectures/OS, actual distribution artifacts and the remaining Gatekeeper/download/minimum-OS limitations
