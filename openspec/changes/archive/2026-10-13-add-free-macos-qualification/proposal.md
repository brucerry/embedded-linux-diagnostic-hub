# Proposal

## Why

Bruce approved zero-cost Intel and Apple Silicon macOS build/test coverage after stable v0.2.0
publication. Current qualification covers Windows/Linux only, and macOS must not pretend the
existing executable updater works.

## What Changes

- Add standard public-repository macos-15-intel/x64 and macos-15/arm64 build, packaged
  SSH/UI/native-window and 100-cycle terminal tests.
- Verify architecture, ad-hoc bundle integrity and ASAR/source identity in logs, without retained
  binary artifacts, paid cache/storage or public Mac downloads.
- Show honest unsupported automatic-update handling on macOS; preserve Windows/Linux updater
  behavior and all seven Linux compositor cases.
- Keep published v0.2.0 and the separate restore-notification candidate unchanged.

## Capabilities

### New Capabilities

- `macos-ci-qualification`: Free architecture-specific hosted qualification, package integrity and
  explicit unsupported updates.

### Modified Capabilities

None; Windows/Linux and connected-device contracts remain intact.

## Impact

New macOS-only workflow and bundle verifier; explicit darwin branches in desktop smoke and
unsupported-update UI/status tests. No Apple account, Developer ID, notarization, paid runner,
hardware access, software installation on Bruce's machine, updater deployment, new release or tag
change.
