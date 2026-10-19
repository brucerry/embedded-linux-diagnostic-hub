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
