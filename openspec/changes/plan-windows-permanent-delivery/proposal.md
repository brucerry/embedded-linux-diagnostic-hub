> Current status: [v0.6.0 remaining-scope matrix](v0.6.0-remaining-scope.md) distinguishes
> implemented source from missing implementation and pending native qualification. Earlier
> checkpoints below are historical; all-platform installation is not complete.

## Why

Users want the one-line download commands to lead to a clear installation wizard across supported
desktop platforms. Current Windows portable extraction has a measured startup cost; Mac already
installs a complete permanent bundle, while the Linux helper currently extracts for execution. A
shared review flow can explain location, shortcuts, profiles, updates, removal and permissions
without pretending the platforms have identical packaging or trust policies.

## What Changes

- Plan a guided setup entry point for Windows x64, macOS Intel x64/Apple Silicon arm64 and currently
  qualified Linux x86_64 desktops. Other architectures remain unavailable until separately built and
  qualified.
- Retain the existing platform-specific one-line commands, explicit release selection, checksums and
  portable downloads. Default future commands detect OS/architecture, verify the compatible setup,
  open review choices and install only after user confirmation.
- Recommend a Windows assisted per-user NSIS wizard that installs once and launches the included
  EXE; keep the portable EXE. Mac uses native guided choices around its verified bundle helper.
  Linux offers managed AppImage or complete-folder setup with graphical controls when present and a
  terminal wizard fallback.
- Detect verified existing installs and offer launch/update/repair instead of duplicating or
  silently replacing them. Preserve profiles/reports, explicit offline use and platform policy
  refusals.
- Qualify installed identity, staging, shortcuts, removal, interruption recovery and compatible
  update modes before production packaging. Mac automatic installation remains unsupported; new
  Linux directory/managed layouts remain manual until their own update contract is qualified.
- v0.5.2 is published and immutable. Target one combined v0.6.0 release for guided setup/startup
  safeguards, receive-timestamp output and exports, accessible Automation validation, and the latest
  islands/crabs artwork. Keep increments independently reviewable; do not introduce an unrequested
  v0.5.3.

## Capabilities

### New Capabilities

- `guided-desktop-installation`: common reviewed setup/maintenance flow and one-line command
  contract across currently supported architectures.
- `windows-desktop-delivery`: per-user persistent app folder, assisted setup, fixed EXE/shortcut,
  verified replacement and honest startup evidence.

### Modified Capabilities

- `desktop-update-handoff`: explicit delivery identity, compatible assets, truthful
  installed/portable/manual destinations and verified successor confirmation.
- `macos-desktop-distribution`: guided native manual installation while retaining complete bundles,
  architecture selection, integrity verification and normal OS policy.
- `command-automation`: required markers, associated inline field errors and first-invalid focus
  while retaining strict execution validation.
- `automation-exports`: honest receive observations and bounded Serial byte-block provenance, with
  explicit versioned aggregation in detailed exports and legacy/SSH compatibility.
- `local-serial-terminal`: bird-free inert beach artwork, Deselect ownership/control notification
  readable Serial secondary hover/modal focus states, and the queued
  left-foreground/cloud/terminal-palette refinements.
- `connected-device-terminal`: refine the existing SSH terminal height/star presentation without
  rebuilding its baseline stars or changing terminal ownership.
- `connected-device-clock`: disconnected clock text explicitly identifies SSH, independently of a
  connected Serial session.

## Impact

Future changes touch platform download helpers, packaging configuration, native delivery/receipt
coordination, profile locks, installer UI adapters, release catalogue/checksum manifests and
platform-native tests. Current source facts and the focused UX, architecture matrix, command
compatibility, security limits and phased acceptance gates are in cross-platform-plan.md. Detailed
Windows prototype and replacement mechanics remain in implementation-plan.md.

Implementation has now been explicitly authorized following the cross-platform wizard direction.
Local source currently adds bounded installation contracts and native declared-payload observation
with focused tests; wizard helpers and packaging are not yet integrated. User direction favors a
wizard across platforms; it does not authorize system-wide installs, host permission changes, new
paid services, security bypasses or publication. Independent review precedes production code.
Historical tags/assets and the user's separate live-test edit remain intact.

October 15 reconciliation: accepted bird removal/distant islands/crabs are complete baseline work.
The left foreground removal, Serial contrast/clouds and SSH height/star refinement remain unchecked.
Storage lifecycle/full-output integration and the optional flow viewer have dedicated sibling
changes; this release plan keeps their combined publication gates open.
