# Spec Delta

## Purpose

Retain deliberately armed Automation output as complete, provenance-aware local evidence while
keeping working memory bounded and failures recoverable without replaying device input.

## ADDED Requirements

### Requirement: Truthful bounded lifecycle qualification evidence

Lifecycle qualification offered as evidence for bounded capture memory SHALL distinguish sampled
peaks, retained comparable checkpoints, intentional persistent storage and explicit owner closure.
Warm and measured retention comparisons SHALL match retained-state key, process role, PID and
creation identity. Each required group SHALL contain at least three actual spaced warm and three
measured checkpoints. Replacement processes SHALL NOT borrow another lifetime's baseline.
Ephemeral-role observations SHALL state their lifecycle-local limitation and SHALL NOT establish
cross-process or cross-cycle retention. Calibration SHALL require complete matched observations
independently of whether reviewed memory thresholds are supplied.

Checkpoint evidence SHALL retain increasing global checkpoint ordinals, cycle ordinals separately,
monotonic read windows and actual spacing. Slopes using comparable-checkpoint indexes SHALL identify
bytes per comparable checkpoint in configuration and policy identity. Actual attempted, usable,
unavailable and coalesced sampling counts SHALL remain distinct; a 250-ms target SHALL NOT imply
simultaneous process observations or four successful samples per second.

Qualification evidence SHALL use source-bound lifetime admission limits and strict ordered
reconstruction. An invalid final event, partial transaction, dictionary/reference failure, unclosed
footer or failed descriptor closure SHALL NOT establish accepted sample/owner completion. Finite
pilot budgets SHALL remain separate from full-soak contracts. Passing local deterministic controls
SHALL NOT imply host throughput, disk, allocation, memory policy or release qualification.

#### Scenario: Process replacement and delayed observer read

- **WHEN** a process is replaced or an actual sampling read exceeds the target cadence
- **THEN** the replacement requires its own matched warm and measured groups, exact read timing and
  coalesced requests remain visible, and no missing checkpoint or cross-lifetime baseline is
  invented

#### Scenario: Late corrupt event or failed closure

- **WHEN** an earlier event in a transaction is valid but a later event is corrupt, or a write,
  sync, ownership-hold callback or descriptor close fails
- **THEN** no invalid transaction becomes accepted evidence, descriptor closure is still attempted,
  and uncertain actual closure cannot become a successful ownership release

### Requirement: Full observed-output storage with bounded memory

Automation capture SHALL retain every successfully accepted receive observation's exact raw bytes,
stream, ordered sequence, host receive timestamp and byte boundaries in local persistent storage
without a small application-imposed total-output or retained-row cap. It SHALL separately expose
observed bytes, committed bytes, capture completeness and clipped display preview. Application
queues, parser state, previews and page responses SHALL remain bounded as total stored output grows.
Finite storage/quota and possible upstream driver loss SHALL NOT be described as unlimited capacity
or proof of all device-emitted bytes.

#### Scenario: Output beyond former caps

- **WHEN** a healthy command emits more than 64 KiB or a complete export exceeds 32 MiB
- **THEN** total size alone does not stop capture, raw observations remain ordered and exact, and
  display clipping does not imply capture truncation

### Requirement: Persistence failures stop advancement truthfully

Quota/disk-full, permission, unavailable API, aborted transaction, I/O, integrity and
bounded-backlog failures SHALL have distinct actionable states. A failed capture SHALL retain its
last committed prefix and explicit incomplete reason, stop later commands/repetition and require
deliberate rearming. If failure metadata cannot be saved, the interface SHALL keep a persistent
warning and reopening SHALL identify the abandoned capture as interrupted. The application SHALL NOT
silently use capped memory, delete old evidence to make room, infer missing observed-byte counts
after a crash or claim remote termination.

#### Scenario: Storage fills after a prompt

- **WHEN** a prompt or exit is observed but final capture or outcome persistence fails
- **THEN** the next action is not sent, the committed prefix remains reviewable and the result does
  not claim successful durable completion

### Requirement: Immutable outcomes and safe recovery

Raw sealing SHALL verify observation order, byte ranges, counters and integrity. Immutable execution
outcomes SHALL be committed separately after sealing, with host finalization times distinguished
from device emission/completion times. Reopen/reload/crash recovery SHALL retain canonical raw
files/records and unknown data, classify unsealed captures as interrupted and never replay commands.
Recognized legacy data SHALL migrate without losing its existing observations/outcomes; malformed,
blocked or future schemas SHALL refuse or defer visibly without destructive reset or downgrade. An
aborted metadata transaction SHALL leave sealed raw evidence intact and permit explicit valid retry
without replacing an existing outcome.

#### Scenario: Abrupt termination and future schema

- **WHEN** the owner dies after a committed prefix, or a newer unsupported database is encountered
- **THEN** recovery preserves available evidence without invented outcomes, while the unsupported
  newer store remains unchanged with an explanation

### Requirement: Recoverable bounded catalog and explicit retention

Catalog paging SHALL use bounded working sets without materializing all metadata/output. Derived
indexing SHALL be rebuildable from canonical evidence; cache failure SHALL preserve captures and
expose degraded operation. Conflicting canonical identities/sequences or unsafe aliases SHALL be
retained with an integrity failure. Captures SHALL remain until deliberate deletion; active
writer/read/export leases SHALL prevent conflicting deletion. Interrupted explicit deletion SHALL
recover only its previously validated owned intent, without deleting unrelated captures or unknown
files.

#### Scenario: Index failure or interrupted deletion

- **WHEN** the derived index becomes unavailable or a process dies during a deliberate delete
- **THEN** evidence remains accessible through a safe bounded recovery path where possible, the
  warning persists, and only the identified deletion intent can finish

### Requirement: Trusted ownership and acknowledged streaming

Native capture operations SHALL accept opaque validated identities from the trusted current
application frame, never renderer-selected paths. Browser operations SHALL hold origin-scoped
writer/read/delete ownership and client-bound scoped export authorization. SSH desktop/gateway
streaming SHALL negotiate support explicitly, authenticate the current session/connection/run and
preserve original receive provenance, ordered sequences and bounded credit. Producers SHALL await
persistence acknowledgement before releasing bounded backpressure; enqueueing alone SHALL NOT
acknowledge durability. Cancel, connection replacement, navigation and shutdown SHALL fence stale
work and join owned writes/exports/cleanup before releasing ownership. No capped or different
execution-mode fallback SHALL occur silently.

Capture initialization SHALL keep its writer/capture leases until its pending transaction settles.
Store closure or versionchange SHALL invalidate a late initialization acknowledgement before active
ownership is published or any producer is invoked.

#### Scenario: Versionchange before initialization acknowledgement

- **WHEN** a real initialization transaction is pending when the store receives versionchange and
  later commits or aborts
- **THEN** ownership remains held through settlement, the closed store refuses the acknowledgement,
  no producer is called and committed initialization data is retained without fabricated
  output/outcomes

#### Scenario: Slow consumer and stale generation

- **WHEN** a storage consumer is slow or the authenticated connection is replaced during an awaited
  write
- **THEN** buffers stay bounded, stale callbacks cannot reach the replacement session and no later
  input is authorized by an obsolete acknowledgement

### Requirement: Local privacy and honest platform states

Only explicitly armed Automation capture SHALL persist its command/output evidence. The UI SHALL
identify storage location class, finite usage/quota estimates and browser persistence/eviction
limits without promising reserved space or power-loss durability. Persistence permission requests
SHALL require deliberate user action. Missing/denied APIs and export capabilities SHALL be shown
honestly without changing host permissions or using external storage services. Manual terminal
transcripts SHALL remain excluded from diagnostics, logs and update backups.

#### Scenario: Unavailable browser storage

- **WHEN** required persistent storage is unavailable or denied
- **THEN** Automation full capture explains the unsupported state without executing under an
  undisclosed small cap, and unrelated diagnostics/report viewing remain usable
