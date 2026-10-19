# automation-exports Specification

## Purpose

Allow operators to review bounded command evidence and download provenance-aware QA exports while
preserving exact JSON bytes and safe human-readable representations.

## ADDED Requirements

### Requirement: Bounded provenance-aware results

Results SHALL retain immutable command/run/transport/target snapshots, actual SSH exit or Serial
completion reason, separate output/raw bytes, duration, local timestamps and available device
observation provenance. Retention SHALL be bounded with visible truncation/eviction. The interface
SHALL support search/status/command filters, row selection and paused autoscroll.

#### Scenario: No device timestamp or exit

- **WHEN** a Serial response lacks a valid explicitly sourced timestamp
- **THEN** device time and exit remain unavailable while local time and completion condition are
  retained

### Requirement: Local reviewable QA exports

The application SHALL export selected, filtered or all retained results as JSON, CSV, Markdown and
plain text on an explicit user action without reexecution or fresh queries. JSON SHALL preserve
exact retained text and raw bytes. CSV SHALL quote correctly and document formula-injection
transformations. Markdown SHALL safely fence arbitrary payloads and escape headings; human formats
SHALL visibly render unsafe controls. Exports SHALL allowlist identity metadata and warn that
commands/output can contain secrets.

#### Scenario: Filtered hostile output export

- **WHEN** retained output contains formula prefixes, multiline commas/quotes, control characters or
  Markdown fences
- **THEN** each selected format is structurally safe and transformations are documented without
  modifying the exact JSON evidence
