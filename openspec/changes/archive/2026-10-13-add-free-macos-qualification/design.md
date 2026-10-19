# Design

## Context

Bruce approved free Intel/ARM64 build/test/logs after v0.2.0 publication. The repository is public;
Electron 44.5.1 has both darwin binaries. Existing electron-builder supports app directories and
ad-hoc signing. Desktop smoke currently skips native-window cycles on darwin and assumes the
Windows/Linux updater. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:** Qualify x64 and arm64 separately on standard macOS 15 runners, log bundle/source
integrity and run actual packaged SSH/UI/native cycles.

**Non-Goals:** Developer ID, notarization, Apple enrollment, paid runners, increased paid
cache/storage, public Mac assets, a new release/tag, a deployed updater or applying the separate
restore-notification candidate.

## Decisions

- Use macos-15-intel/x64 and macos-15/arm64 with a public-repository job guard, read-only workflow
  permissions, setup-node cache disabled, no uploaded artifacts and no signing secrets. Preserve all
  Windows/Linux workflows and seven compositor rows.
- Build separate ad-hoc signed app directories with the pinned existing builder, no ZIP/DMG
  distribution in this increment. Inspect the main/framework Mach-O architecture, bundle identifier,
  codesign integrity and current ASAR/native-renderer bytes.
- Extend shared desktop smoke explicitly for darwin: real native state acknowledgements and renderer
  restore count, packaged SSH/PTY/clock/reset/trust/security and 100-cycle stress. Preserve
  deadlines and assertions; no pretending a skipped Mac test passed.
- Return explicit unsupported-update status and deny update installation on macOS. Keep the release
  link and existing Windows/Linux behavior; do not construct fake Linux or Mac install fixtures to
  satisfy the updater.
- Use controlled local SSH fixtures on runners. Runner-local app launch is not a
  downloaded/quarantined launch and does not establish Gatekeeper/notarization compatibility or
  older macOS support.

## Risks / Trade-offs

- Hosted Mac desktop animations/permissions differ -> inspect logs and fix integration without
  removing state/event/session checks.
- Unsigned/ad-hoc distribution faces Gatekeeper -> this increment does not distribute; document
  future downloaded-app testing.
- A future private repository could incur runner costs -> public-repository guard; no larger runner
  or paid fallback.
- Existing release-attempt-one notification edge may recur -> retain evidence, no claim retry cured
  it, no application of the excluded candidate.

## Migration Plan

Add the standalone main/PR macOS workflow and platform-aware tests. Push scoped changes to qualify
all existing OS workflows plus Mac. Leave package version and immutable v0.2.0 assets alone. Revert
only new Mac qualification changes if needed, without altering Windows/Linux matrices or unrelated
user edits.
