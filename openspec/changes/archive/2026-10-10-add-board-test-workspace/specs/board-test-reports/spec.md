# Spec Delta

## Purpose

Provide portable structured test evidence and optional clean human-readable documents that preserve
verdicts, provenance, measurements, and the limitations of each board test run.

## ADDED Requirements

### Requirement: Separate portable test evidence

Both editions SHALL support local JSON export and bounded validated import of versioned test
reports, separately from existing diagnostic snapshot reports. Reports SHALL include
application/adapter versions, source mode, run identity and state, device/firmware/kernel identity
when observed, declared board revision, profile content and revision/digest, inventory provenance,
fixture readiness/identity, selected sequence, case results, acceptance criteria, observations,
operator confirmations, and cleanup/interruption evidence. Missing metadata SHALL be explicitly
identified. Credentials, interactive terminal transcripts, and current header clock state SHALL NOT
enter test reports.

#### Scenario: Export a run with incomplete hardware metadata

- **WHEN** the board serial number or firmware identifier was not observed
- **THEN** the report identifies it as unknown without substituting profile claims as observed
  evidence

#### Scenario: Import a test report

- **WHEN** a valid saved report is imported
- **THEN** it opens as historical local evidence without starting or retargeting a device operation

#### Scenario: Oversized or inconsistent report

- **WHEN** an imported report exceeds bounds, has unsupported versions, or contains inconsistent
  verdicts
- **THEN** import fails with an actionable error without replacing current evidence

### Requirement: Optional readable HTML and PDF documents

Users SHALL be able to generate a self-contained HTML document and a PDF representation on demand
from a selected recorded test run. Desktop SHALL offer native PDF save; website SHALL offer a
print-ready preview and the browser print/Save as PDF workflow, clearly describing that distinction.
Generation SHALL NOT require a cloud service, external fonts/assets, a device-side document tool, or
changing the run's measurements/verdicts. Cancelling a save/print action SHALL preserve the run.
Structured JSON export SHALL remain available independently of document generation.

#### Scenario: Native PDF export

- **WHEN** a desktop user chooses PDF for a recorded run and selects a save path
- **THEN** a PDF document is saved from that run's validated report and export failure leaves
  evidence intact

#### Scenario: Website Save as PDF

- **WHEN** a website user chooses Print / Save PDF
- **THEN** the print-ready report is presented through an explicit print action without claiming
  that a file was saved before the user completes the browser workflow

### Requirement: Clean consistent report presentation

Documents SHALL present a readable title and source label, device/profile/run metadata, a concise
overall outcome and status counts, case results with expected-versus-observed values, relevant
fixture/operator evidence, and cleanup/interruption details. Detailed raw evidence SHALL be
available in a clearly separated appendix. The design SHALL use restrained typography/color, textual
verdicts, readable contrast, whitespace, sensible print margins, and stable pagination. Long values
and output SHALL wrap without clipping or blank/overlapping content. Simulated and imported
provenance and pending required feedback SHALL remain conspicuous in all formats.

#### Scenario: Mixed verdict sequence

- **WHEN** a report contains Pass, Fail, Blocked, Skipped, and Inconclusive cases
- **THEN** the document distinguishes every verdict in text and the overall outcome does not imply
  that blocked or unverified hardware passed

#### Scenario: Long evidence spans multiple pages

- **WHEN** case evidence contains long lines, Unicode, and enough content for multiple printed pages
- **THEN** readable evidence and case headings remain visible without overlapping page boundaries

### Requirement: Trusted generation and local-only handling

Native live report export SHALL use backend-owned run evidence; imported report export SHALL use
validated normalized data and preserve its historical label. Device/profile/evidence text SHALL be
rendered as escaped text and SHALL NOT execute scripts, load remote resources, or access privileged
desktop APIs. Document rendering SHALL have finite limits and release temporary views/resources on
success, cancellation, or failure. The app SHALL generate files only on explicit export/print action
and SHALL NOT upload or automatically persist reports.

#### Scenario: Device output contains markup

- **WHEN** a device result or profile label contains HTML/script-like text
- **THEN** it is shown literally in the report without execution or external requests

#### Scenario: Export interrupted by render failure

- **WHEN** PDF rendering fails or exceeds its limit
- **THEN** the temporary renderer is released, the app shows the error, and the run remains
  exportable as JSON
