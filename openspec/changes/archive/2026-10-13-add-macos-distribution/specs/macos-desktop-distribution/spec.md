# Spec Delta

## Purpose

Deliver verified Intel and Apple Silicon desktop app bundles with safe manual installation and truthful macOS trust, update and qualification guidance.

## ADDED Requirements

### Requirement: Complete architecture-specific release downloads

A published release offering Mac support SHALL include separate complete Intel x64 and Apple Silicon arm64 app bundles, same-release SHA-256 checksum documents and version/source/architecture manifests. Bundle identity, minimum macOS version and ad-hoc signature status SHALL be truthful. Existing Windows/Linux files and update behavior SHALL remain intact.

#### Scenario: Select a Mac release

- **WHEN** a user selects either supported Mac architecture
- **THEN** the complete bundle, its checksum and matching manifest identify the same version, source and architecture

### Requirement: Native architecture and runtime selection

The Mac helper SHALL select the native compatible architecture, including an Apple Silicon Mac running a translated terminal, accept an explicitly selected safe release tag and otherwise use the latest published stable release. Unsupported platform, architecture, root execution or macOS version SHALL fail clearly without launching an incompatible binary or installing dependencies.

#### Scenario: Translated Apple Silicon terminal

- **WHEN** an Apple Silicon user starts the helper from a translated Intel terminal
- **THEN** it selects the native arm64 bundle without automatically installing Rosetta

#### Scenario: Unsupported input

- **WHEN** the platform, architecture, tag or minimum OS requirement is unsupported
- **THEN** the helper reports the limitation without replacing a working app or requesting elevation

### Requirement: Verified staging and safe replacement

The helper SHALL verify same-release archive checksums, manifest version/source/architecture, bundle identity and integrity before replacing an existing app. It SHALL reject unsafe archive paths or links and unsafe installation targets, support paths containing spaces, and stage privately on the target volume. Failed or interrupted downloads, verification or replacement SHALL preserve the previously installed app and leave its user data untouched.

#### Scenario: Corrupt or incomplete download

- **WHEN** a download is interrupted, checksum is wrong or metadata does not match the selected bundle
- **THEN** no new app launches and the prior app remains intact

#### Scenario: Unsafe archive or destination

- **WHEN** an archive can escape its app root or a target is an unsafe link or incompatible file
- **THEN** extraction/replacement is rejected without altering unrelated paths

#### Scenario: Replacement failure

- **WHEN** replacement fails or is interrupted after the prior app has been moved
- **THEN** the prior app is restored and its settings, credentials and reports are preserved

### Requirement: Explicit manual installation and launch

The documented one-line command SHALL download, verify and install the complete app in a user-owned location and request a normal macOS launch. The helper SHALL support installation without launch and explicit version/directory selection. An already-running app SHALL not be replaced. Mac in-app automatic update installation SHALL remain explicitly unsupported; manual updates SHALL use the same verification and replacement safeguards.

#### Scenario: Running app or manual update

- **WHEN** a user attempts a replacement while the app is running
- **THEN** the helper asks the user to quit and preserves the current installation

#### Scenario: Launch refusal

- **WHEN** macOS refuses launch
- **THEN** the helper reports the refusal, preserves/restores the prior app when applicable, and points to explicit user/administrator approval without bypassing protections

### Requirement: macOS protections and accurate documentation

The helper SHALL NOT disable Gatekeeper, strip quarantine, invoke administrator installation, enroll a signing account or claim notarization/Developer ID trust. README, platform/download commands and Mac installation/troubleshooting documentation SHALL explain architecture selection, complete bundle layout, ad-hoc signing, manual updates and managed-device limitations using actual published artifacts. CI command-line launch SHALL be distinguished from quarantined browser-download acceptance and physical-device testing.

#### Scenario: Unnotarized or managed Mac

- **WHEN** local trust or managed-device policy blocks an ad-hoc app
- **THEN** documentation reports the limit and available explicit platform approval/administrator guidance without automatic policy changes

### Requirement: Gated publication and published-command verification

Mac files SHALL remain private in new-tag staging until all required source, platform and asset checks pass. Only the complete verified release SHALL become publicly available. The published helper/archives/checksums/manifests and documented command SHALL be checked end to end on both available native Mac CI architectures. Prior release tags/assets SHALL not be modified.

#### Scenario: A failed release gate

- **WHEN** any required platform or asset gate fails
- **THEN** the new draft remains unpublished and existing releases remain available and unchanged

#### Scenario: Completed publication

- **WHEN** all required gates pass
- **THEN** the complete release is published and actual public downloads are independently verified and launched through the documented helper on each supported hosted architecture
