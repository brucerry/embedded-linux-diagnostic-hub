## MODIFIED Requirements

### Requirement: Bounded provenance-aware results

Results SHALL retain immutable command/run/transport/target snapshots, execution mode and explicit
step intent, exact request/output bytes, duration, local timestamps and available device observation
provenance. Independent SSH results SHALL retain genuine exit/termination evidence and separate
streams. Persistent SSH console results SHALL identify combined PTY output, the matched literal
criterion/role and prompt-observed completion with unavailable exit status; they SHALL NOT be
presented as genuine successful exits or independently captured stderr. Aggregated legacy blocks
SHALL identify first/last contributing host receive observations and read counts without inventing
interior read, per-byte, line or device emission times. New stored observations SHALL preserve their
exact receive boundaries and ordered raw bytes.

Working memory, previews and displayed pages SHALL be bounded; retained evidence SHALL persist until
explicit deletion rather than silent total-output/row eviction. The interface SHALL distinguish
complete/incomplete capture, committed/observed bytes, preview clipping, storage/recovery failure
and legacy truncation. Search/status/command filters SHALL inspect full retained evidence, and row
selection SHALL use stable capture identities across pages. Autoscroll SHALL be pausable. A safe
readable ANSI/control projection SHALL remain separate from exact raw evidence and SHALL NOT execute
output-supplied markup, links or clipboard controls.

#### Scenario: No device timestamp or exit

- **WHEN** a Serial or persistent SSH console response lacks a valid explicitly sourced timestamp
- **THEN** device time and exit remain unavailable while host receive provenance and the actual
  completion condition remain reviewable

#### Scenario: Off-page and preview-clipped evidence

- **WHEN** a matching result is off-page or its match appears beyond the bounded preview
- **THEN** full retained evidence determines filtering/export membership and selection retains the
  exact stable identity

#### Scenario: Export stateful console and Enter evidence

- **WHEN** an operator exports Script and Send Enter steps from one owned console
- **THEN** the supported formats preserve exact payload/intent/mode, combined PTY identity, matched
  criterion, null exit status and complete raw receive provenance without reexecution

### Requirement: Local reviewable QA exports

The application SHALL stream selected, filtered or all retained results as JSON, CSV, Markdown and
plain text on explicit user action without reexecution or fresh queries. Membership/filter/selection
and committed high-water marks SHALL be snapshotted at click time, independently of a debounced
display query or later rows. Export ownership and pending state SHALL survive transport-tab changes.
JSON SHALL preserve exact retained raw bytes and truthful receive/aggregation/outcome provenance in
an explicitly versioned format, including incomplete state and legacy limitations. Human formats
SHALL identify clipping/incompleteness and preserve full available output through safe streaming
transformations. CSV SHALL quote correctly and document formula-injection transformations. Markdown
SHALL safely fence arbitrary payloads and escape headings; human formats SHALL visibly render unsafe
controls. Exports SHALL allowlist identity metadata and warn that commands/output can contain
secrets.

Export paths SHALL remain local, bounded in memory and protected by read leases. Native destination
cancellation/failure SHALL preserve the previous destination and release ownership; browser
downloads SHALL authenticate the scoped owner/client and preflight retained-block integrity before
attachment handoff. Missing/corrupt blocks SHALL fail distinctly from EOF; unexpected midstream
failures SHALL surface honest failure/uncertainty and cleanup rather than success. Shutdown SHALL
join exports pending at entry, attempt all cleanup stages and report failures after ownership is
settled. Browser handoff SHALL NOT claim verified physical download completion.

#### Scenario: Filtered hostile output export

- **WHEN** retained output contains formula prefixes, multiline commas/quotes, control characters or
  Markdown fences
- **THEN** each selected format is structurally safe and transformations are documented without
  modifying the exact JSON evidence

#### Scenario: New query and transport switch during export

- **WHEN** a user types or clears a filter and immediately exports, then changes transport while it
  is pending
- **THEN** the export uses that click's current filter and keeps its owner/busy state until
  completion or acknowledged cleanup

#### Scenario: Local export failure

- **WHEN** a destination write or browser response fails after starting
- **THEN** the app reports failed/uncertain delivery, preserves stored evidence and releases its
  leases without claiming a complete saved file
