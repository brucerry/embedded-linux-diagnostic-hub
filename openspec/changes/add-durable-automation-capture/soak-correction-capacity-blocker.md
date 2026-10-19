# Source-local correction and capacity refusal checkpoint

This successor preserves the unaccepted candidate-27 source
c36ee36517cb5158b111d44dab98a3a9837adfd1a7bed21bd2d8310e815b970e, candidate 25 and the sealed
independent candidate-26 controls. Exact current source, patch, commands, logs and preservation
checks belong to task-5/windows-soak-final-candidate-28/review-packet. This document does not
approve the source, a memory policy, a host workload or publication.

## Completed local corrections

- Reader expansion bytes reset per logical report; cumulative transaction node/member limits and
  lifetime decoded-work charges remain. A transaction containing three 1.5-MiB reports verifies that
  aggregate size above 4 MiB does not incorrectly invoke the per-report ceiling.
- Native results use one streaming semantic validation, preserving membership, metadata, outcomes,
  raw provenance/CRC, per-stream hashes, complete readable-output hashes and schema semantics. JSON
  raw arrays and CSV rows do not become whole-report object graphs. Markdown/text bodies use exact
  expected byte counts; fences and full integrity trailers remain checked.
- Native viewer validation uses exact owned-file EOF/hash and a bounded prefix. File size, identity,
  alias refusal and actual close are checked before acknowledgement or retirement. Browser
  result/viewer acceptance paths use the same streaming ownership boundary. The legacy browser
  byte-reading compatibility helper is outside these acceptance paths.
- An uncertain artifact-reader close retains its ownership record, prevents next-file admission and
  prevents the soak owner from finishing. Cancellation and semantic failures still attempt close and
  preserve failed evidence. There is no automatic closure waiver or retry.

## Decisive capacity blocker

The production native sample method and aggregate sample function, with actual OwnedHost and
ProcessSampler implementations and controlled IPC/OS-data ports, publish seven logical records and
four identity/lifecycle reports per successful sample. The maximal reviewed global history contains
256 instances: 253 native, two gateway and one harness.

All three targets (7,200, 9,600 and 12,000) complete 5,178 samples and refuse sample 5,179 on the
unchanged decodedBytes work limit. Both generic decode passes remain charged. Actual controlled
child endpoints and the timeline descriptor close; the incomplete stream cannot become valid
evidence. These are data-only refusal controls, not observed process-memory results or cadence.

This mandatory-publication subset is already too large. Startup/cycle/checkpoint/geometry/shutdown
and other whole-job publications add nonnegative cost and cannot repair the refusal. The static
stage inventory is not a complete dynamic whole-job count proof. No whole-job fit is claimed, and no
counter, cadence, history, geometry, duration or minimum-cycle requirement is reduced. Further
design or scope changes require independent review; this checkpoint does not choose one.

## Serialization and simultaneous lifetimes

Forty-eight actual production scope/format serializer cases include retained catalogs 1/2/3,
primary/rearm, cancellation/quota shapes, cross-page records, 17-byte prompt, source-generated
headers and non-null validated outcomes, largest ordinal strings and adversarial metadata. All
selected 16-KiB cases remain below 128 MiB and pass streaming semantics. The largest modeled file is
64,515,283 bytes. The 64-byte negative crosses 128 MiB and refuses; it is not retried or qualified.

The physical lifetime model separates encoded raw journals, metadata/outcomes, one live report,
viewer phases, timeline, streams, profile/SQLite/WAL/free pages, caches, compiled assets, cleanup
reserve and transient files. Sequentially retired report throughput is not simultaneous occupancy.
Active profile/worker/viewer growth and between-poll allocated peaks remain unproved; the model does
not turn residual apparent-byte capacity into a positive physical-capacity claim. Sparse-file
boundary controls test the actual inventory/file guards without filling disk, not Windows allocation
behavior. The independent decoded-work refusal already blocks the complete schedule.

## Official OpenSpec tooling

The repository's generatedBy 1.13.1 metadata matches the official @fission-ai/openspec@1.13.1
package, requiring Node >=20.19. It was installed only in task-local tooling with lifecycle scripts
disabled, without global or repository dependency changes. Official list --json resolved the copied
workspace. Official validate add-durable-automation-capture --type change --strict --json
--no-interactive passed with zero issues at this checkpoint; exact output is retained in the packet.
Structural validation does not close tasks 4.8/4.8.2/4.8.3 or establish runtime/capacity acceptance.

Collection remains disabled. No commit, push, dispatch, hosted/native soak, original planning-tree
edit or protected-root modification is part of this checkpoint.
