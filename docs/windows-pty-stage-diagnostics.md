# Bounded PTY stage diagnostics

These observations apply to the separately fenced PTY observation mode. They build on candidate50's
parent deadline correctness repair. They do not repair or explain the Windows overrun in
run39382944852, grant execution authority, or change any timing/workload/ownership requirement.

## Phase and wait observations

A fixed numeric schema records up to96 paired phase events in memory. The36 phase IDs cover child
entry, runtime/import, installed tool/source checks, HOME/compiler/artifact preparation,
gateway/journal/connect, actor.open, the eight original command/Enter interactions,
finish/settled/readback, each cleanup operation, startup join, diagnostic drain and verdict. Events
distinguish entry, returned, failed and returned after cancellation. Pending and never-entered
phases are listed explicitly. `phaseLedgerComplete` describes the recorded phase pairs only. The
final verdict/pipe-close receipts follow the summary and remain separate proof.

Eight fixed aggregate labels count existing process-table reads, descendant reconciliation, durable
journal commits, diagnostic encoding/queue/ACK/drain and parent evidence writes. They retain
completed/failed/pending counts, service sums and maxima. Existing generation-safe query receipts
remain intact. No query, verification, fsync polling, stream trace or sleep is added for
measurement. Overlapping service sums cannot be added into a critical path or called CPU time.
Journal commit service includes the original raw write/sync and atomic metadata publication; journal
setup/close/readback are measured by their surrounding phases. It does not isolate kernel IO.

The parent retains its admission clock in the existing pre-spawn record and its close clock/wait
aggregates in the existing closure receipt. The deadline still starts before spawn. Loader work
before the first child anchor is an explicitly unpartitioned admission-to-entry interval.

## Clocks and first cancellation

Each child sample brackets `performance.now()` with hrtime reads. It preserves the sampling width,
hrtime millisecond truncation, microsecond rounding and local offset interval. Invalid, nonmonotonic
or inconsistent local samples refuse and hold.

A bound parent receiver adds a conservative parent-admission/child-anchor/parent-receipt bracket. It
assumes no shared clock origin or fixed IPC latency. Parent receipt rounding adds one millisecond to
the upper bound. Mapped values are intervals at that anchor; applying its offset to another
unanchored event is rejected. Another stored sample may be bracketed separately, but uncertainty can
be broad. Overlapping intervals have unresolved cross-process order. Neither wall UTC, PID creation
timestamps nor a compiler stopwatch supplies an alignment. Drift between anchors is unmeasured;
child-local elapsed intervals remain in their original clock.

The first cancellation is latched before cancellation transport or diagnostic work, with a fixed
origin code, phase/ordinal, original deadline, already-aborted state and paired local clock. Only a
bounded digest of the reason is added. Later causes are bounded counters. Parent request, child
observation and ACK are distinct facts. A first-cause record is attempted once through existing
durable evidence paths after abort/admission closure; send acceptance is insufficient. The parent
has a protected synchronous journal record; an unexpected asynchronous parent persistence port is
retained in state and causes a sticky hold. The child uses the original owner-fsync-before-ACK
channel. Persistence errors remain secondary to the first cause.

## Reservations inside the existing limits

Let `S` be the UTF-8 size of the selected `{stage,data}` record. A timeline record is checked before
enqueue for full wire/journal size `S+512`, and charged `2*S+512` to cover the retained logical copy
plus the larger full wire/journal representation. Receiver additions and the fixed
nonce/binding/sequence/prefix fit the512-byte allowance; maximum-width controls verify this.

| Domain                                            |       Reserved capacity |             Original ceiling retained |
| ------------------------------------------------- | ----------------------: | ------------------------------------: |
| Child first-cause record                          |  1row,2048charged bytes |         Full selected frame≤1024bytes |
| Child timeline batch                              | 1row,32768charged bytes |        Full selected frame≤16384bytes |
| Child terminal suballocation                      |        2rows,34816bytes | 16rows/131072bytes/65536pending bytes |
| Shared root journal, including parent first cause |        3rows,36864bytes |                4096rows/10485760bytes |

Unused child terminal rows/bytes cannot be spent by other terminal observations. The first cause
always retains2048pending bytes while existing closure frames can still use60KiB. The summary
requires the entire existing queue to be drained before admission; it cannot crowd out an
already-admitted large closure frame. It then remains inside the same original pending ceiling.
Normal stage admission still protects the original16-row/128KiB terminal allocation. Root ordinary
and multipart/stream charging cannot spend its three protected diagnostic credits. No cap grows. A
combined envelope that cannot fit refuses and retains custody rather than discarding proof. The
later1MiB observation-preparation journal is unrelated and funds none of these diagnostics.

The ledger retains at most96 six-number rows,36 active IDs,8 aggregate rows,4096 aggregate
operations and8400 clock samples. Publication uses at most two child records and one parent
first-cause record. Other anchors/aggregate fields reuse existing records and are charged by their
original producer/receiver/journal paths. No uncharged output sidecar is created on the host. All
added work and waits consume the original work/cleanup clocks. Fixed work quantity does not bound
storage/IPC stall latency. Local in-memory overhead measurements do not establish Windows latency,
an overhead percentage, a hard heap limit or headroom within25seconds.

## Failure and custody

Missing phase ends/anchors/ACKs or summaries remain incomplete or unavailable. The summary states
its measured-through point and excludes its own final encoding/send/ACK and later verdict/close
cost. First-cause and final publication tasks remain referenced. Encoding, budget, short-write,
fsync, ACK, disconnect or close failure uses the existing sticky hold; passing assertions, zero exit
or log-send success cannot replace actual closure. Cleanup-only phase observations, including
compiler/startup joins and diagnostic drain, cannot throw ahead of their owned callbacks. Journal
commits and original descendant-proof attempts remain callable after diagnostic failure. The startup
controller drains already-admitted operations, identity/query observations, pipe closure and
diagnostic tasks inside its original cutoff. Each descendant attempt is memoized; a failure cannot
retry it. New process reads remain blocked at the sampler port while held. A final proof that would
need such a read remains unknown and failed. Late completion after cutoff cannot admit a new proof,
restart the timeout or claim a joined child. Secondary cleanup errors remain in referenced custody;
successful draining never clears the original diagnostic failure or hold.

The original25-second whole-stage cutoff,7000ms readiness,100ms quiet/UTF8/ANSI/journal drain,
15000ms helper and10000ms close remain. Candidate50 equality/delayed-timer guards, source/tool/
artifact checks, fresh runtime/PTY/Bash and all eight assertions remain. An expected disconnect
following the final durable ACK does not attempt another record after the sealed final frame; its
original abort behavior is retained. No earlier phase or closure proof is skipped.

Runs39382944852,39375434374,39365924595,39351381522 and39286378484 remain historically
release-unproved. This local diagnostic candidate does not authorize commit, publication, CI, a
hosted/native attempt, retry, replacement, deadline extension, memory qualification or release.
