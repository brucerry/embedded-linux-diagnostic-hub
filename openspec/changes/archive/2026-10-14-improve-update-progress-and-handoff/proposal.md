# Proposal

## Why

Update progress only describes strings and restart requests lack a durable path/version receipt.
Operators need truthful download progress and the actual launchable app destination.

## What Changes

- Typed stage progress with measured bytes and validated totals, indeterminate verification/handoff.
- Cancel icon with existing prestart cancellation semantics.
- Distinguish staging from verified final executable; validated native Open folder.
- Durable version/path receipt including clean mode, restart request versus observed successful
  handoff.

## Capabilities

### New Capabilities

- desktop-update-handoff: truthful progress, safe path access and durable handoff reporting.

### Modified Capabilities

None.

## Impact

Native updater/coordinator/receipt store, trusted preload, update UI and tests. Existing checksum,
bounded download, atomic rename and platform rules preserved; no dependencies. Proposed v0.5.1 after
review.
