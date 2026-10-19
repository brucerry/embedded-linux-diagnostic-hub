# Proposal

## Why

The README release workflow badge still truthfully reports the failed original v0.4.0 tag run because recovery and public verification ran in separate workflows. A current release audit must validate real published data without republishing or obscuring historical failure.

## What Changes

- Add an explicitly read-only published-release audit path to the existing release workflow, with all-file/source/notes validation and both native public command checks.
- Keep every tag-publication dependency and permission guard intact; branch/manual audit events cannot execute publication mutations.
- Distinguish latest-release availability, release workflow health and public Mac verification in documentation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `macos-desktop-distribution`: Add observable generic read-only published-release verification and truthful status reporting.
- `release-page-format`: Preserve four sections while rendering meaningful exact-destination labels and guarded authorized presentation updates.

- Generalize latest stable and explicit historical source/command resolution; make recovery manual-only and clearly historical.
- Render meaningful link labels with exact destinations in future notes and the explicitly authorized current v0.4.0 body only.

## Impact

Release workflow, public asset validation tooling and focused tests, existing Mac HTTP test context, README and delivery documentation. No application/package/helper bytes, release asset or tag changes, account permission expansion, paid runner or added Mac binary storage. Current v0.4.0 release body presentation alone is separately authorized as described above. Final qualification includes an evidenced entry-animation readiness poll in the existing terminal test, preserving all containment assertions and deadlines.
