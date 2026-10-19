## ADDED Requirements

### Requirement: Default honest receive observations

Result output SHALL show UTC receive times at retained precision with observed chunk index, stream
and byte count without requiring a device timestamp prefix. It SHALL identify local-client/Desktop
versus gateway receive time when recorded, and SHALL identify missing provenance honestly for older
records. Receive time SHALL NOT be claimed as device emission time or assigned independently to
lines inside a chunk. Equal/backward clocks SHALL NOT reorder chunks. Per-stream incremental UTF-8
presentation SHALL preserve split/multiline boundaries and mark pending or incomplete encoding while
retaining original raw bytes, aggregate output and truncation.

#### Scenario: Split bytes and repeated or backward receive time

- **WHEN** interleaved streams contain split UTF-8 or lines with repeated/backward timestamps
- **THEN** observations retain array order and raw bytes, display completed characters with explicit
  chunk boundary context and never fabricate a device/line emission time

### Requirement: Detailed receive-time exports

Text and Markdown SHALL include timestamped received output followed by raw aggregates. CSV SHALL
retain command summary rows and add ordered receive-chunk rows including source, index, stream,
receive time, byte count, decoded fragment, raw base64 and UTF-8 boundary flags without repeating
full aggregate payload per chunk. New CSV text cells SHALL retain formula protection. JSON SHALL
preserve schema version 1 for legacy observations and legacy in-memory SSH-only records. Legacy
aggregated Serial byte-block exports SHALL use schema version 2 with explicit aggregation kind,
first/last contributing host receive observations and per-block contributing-read counts; receivedAt
SHALL mean the first observation. CSV SHALL identify receive-block rows and the same provenance,
while legacy/SSH-only CSV columns SHALL remain compatible. No format SHALL pretend blocks are
original native read events or invent interior, per-byte, line or device-emission timestamps. New
stored raw-observation/outcome exports SHALL use an explicitly versioned storage schema (the
implemented Serial path uses version 3), preserving complete raw bytes and exact receive boundaries
rather than relabeling those records as legacy v1/v2. Optional device prefix extraction SHALL remain
advanced and blank prefix SHALL be valid.

#### Scenario: Blank prefix and truncated hostile output

- **WHEN** the device prefix is blank and retained output is multiline, truncated or
  formula/control-like
- **THEN** host receive times remain visible, truncation is explicit, human formats render/protect
  unsafe text and exact JSON/raw bytes remain available

### Requirement: Serial capture independent of native read fragmentation

Serial Automation SHALL preserve full observed output independently of native read boundaries,
without a small application-imposed total-output cap. Memory parsing/rendering SHALL remain bounded
through storage-backed capture and paginated/virtualized results. A display window SHALL NOT imply
capture truncation. Storage exhaustion/errors SHALL explicitly mark incomplete capture and stop
unsafe advancement without claiming complete output. Exact raw bytes, truthful first/last host
receive provenance and complete streaming exports SHALL remain available with explicit retention and
cleanup controls. Finite available disk/browser quota SHALL be reported honestly.

#### Scenario: Same response in whole or single-byte reads

- **WHEN** the same response and literal prompt arrive whole, one byte at a time or irregularly
- **THEN** retained raw bytes and completion agree while truthful provenance describes aggregation
  with exact observation boundaries in the new stored representation and explicit first/last/count
  limitations for legacy aggregated records

#### Scenario: Output exceeds the in-memory display window

- **WHEN** valid output grows beyond the bounded in-memory window while storage is available
- **THEN** full output continues to storage/export, the display remains bounded, and the flow does
  not stop merely because a small total-byte or native-read-count cap was reached

#### Scenario: Storage failure

- **WHEN** disk, quota or storage I/O fails
- **THEN** capture is explicitly incomplete, later input stops safely, retained raw evidence stays
  reviewable and cancellation/cleanup controls remain available
