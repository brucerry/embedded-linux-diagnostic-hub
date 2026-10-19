# Proposal

## Why

Free CI already qualifies Intel and Apple Silicon app bundles, but users have no Mac downloads or working Mac launch command. Provide the explicitly requested distribution experience with truthful ad-hoc signing and Gatekeeper limits.

## What Changes

- Publish complete, architecture-specific Mac app ZIPs with same-release SHA-256 sidecars and version/source/architecture manifests in v0.4.0.
- Add a dedicated Mac helper that detects native hardware including translated terminals, verifies bundle integrity, stages safely in a user directory, handles replacement and launch errors, and supports explicit manual updates.
- Preserve Gatekeeper/quarantine and managed-device policies; add no Developer ID enrollment, notarization, paid runner, persistent credential or automatic in-app Mac updater.
- Retain all Windows/Linux behavior and qualification; gate Mac publication on both existing free native architectures, bundle/helper checks and 100-cycle continuity.
- Stage Mac files only in an authenticated, unpublished new-tag draft, with no added Mac Actions artifacts/caches; publish the complete release only after all gates and source/asset checks.
- Update README Get started, one-line commands, platform table, installation and troubleshooting together; test the published command on both hosted architectures.
- Preserve v0.3.1/v0.3.0/v0.2.0 tags/assets and the separate user edit.

## Capabilities

### New Capabilities

- `macos-desktop-distribution`: Complete Mac downloads, verified architecture selection, safe manual installation/launch, update handling and truthful user guidance.

### Modified Capabilities

- `macos-ci-qualification`: Separate read-only main/PR qualification from narrowly authorized new-tag draft staging, permit the newly authorized Mac distribution, and retain native assertions and qualification limits.

## Impact

Existing Electron directory builds, Mac bundle verifier, release asset/checksum/manifest validation, launcher packaging, release workflows, native downloader tests, README and downloads/Mac/delivery docs. Uses existing tools and GitHub's per-job token only; no dependency-version change or account-permission expansion. Private local OpenSpec remains excluded from Git.
