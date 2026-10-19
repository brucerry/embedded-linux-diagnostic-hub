# Proposal

## Why

All seven retained compositor gates rejected the initial Linux window-class implementation. Electron 44.5.1 derives WM_CLASS and the Wayland app ID from CHROME_DESKTOP at window creation, so the Chromium class switch did not fulfill the already accepted legacy-extension isolation requirement.

## What Changes

- Scope the native identity only during main-window construction and restore diagnostic-hub.desktop afterward, including on failure. Preserve product name, executable, launcher file, user-data and updater identities.
- Keep the actual compositor class assertion and all OS environments, and record observed window identity to diagnose failures.
- Use an accurate unsigned-build caveat for stable releases while supporting historical preview notes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. This implementation correction fulfills desktop-window-transitions and release-page-format contracts already synced by remove-tests-and-genie-effects; skip_specs is explicit.

## Impact

Electron window creation, native integration/unit checks and current design/release notes. No installation, extension operation, board access or new platform environment is needed. No stable tag exists yet.
