# board-test-reports Specification

## Purpose

Provide portable structured test evidence and optional clean human-readable documents that preserve
verdicts, provenance, measurements, and the limitations of each board test run.

## Requirements

### Requirement: Preserve historical test artifacts

Retiring test report controls SHALL NOT delete saved user JSON/HTML/PDF files, historical
qualification evidence or unique unfinished source experiments. Historical validators retained for
automated compatibility coverage SHALL remain isolated from active device collection and UI. Current
documentation SHALL identify feature retirement without rewriting prior release outcomes.

#### Scenario: Existing saved report survives retirement

- **WHEN** the user updates to the workspace without Tests
- **THEN** saved report files remain on disk and removal does not run a data-cleanup migration
