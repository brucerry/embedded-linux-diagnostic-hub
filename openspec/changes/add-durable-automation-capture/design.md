# Design

## Context

See proposal.md. Original main is 2f84f429 (package 0.5.2); it still has legacy bounded SSH capture.
The current isolated Serial candidate composes independently reviewed storage/transport/UI packets
and the accepted seven-file P2 correction. It is not adopted original application source. The
October 15 audit found storage work tracked under a skip-specs decision queue and an earlier
storage-design.md, with partial Serial full-output coverage in the Windows release delta but no
complete storage lifecycle/index/migration contract. These artifacts repair coverage prospectively;
they do not rewrite that history.

Inspected sources: shared/capture-store.ts, automation-stream.ts and automation-result.ts;
electron/capture-store.ts, capture-catalog.ts and capture-host.ts; browser IndexedDB/native adapters
and StoredSerialResults; SerialSession/runner/AutomationPage; backend/ssh/automation.ts/session.ts,
gateway/server.ts and GatewayClient.ts. The existing manual PTY and terminal ACK transport supply
useful patterns but have different ownership from Automation.

## Goals / Non-Goals

Goals: canonical raw evidence with bounded working sets; genuine commit/seal/outcome boundaries;
scalable metadata access; deterministic recovery and explicit local retention; authenticated
streaming for both transport editions.

Non-goals: unlimited physical storage, guaranteed upstream UART delivery, persistence of manual
terminal transcripts, device commands for discovery/setup, remote archives/services, automatic
replay, new dependencies or platform acceptance from synthetic tests.

## Decisions

### Preserve canonical data and bounded processing

Use asynchronous repository begin/append/seal/fail/page/read/record/result/delete/pin/close
operations. Native main owns physical profile files outside ASAR; browser uses IndexedDB. The
implemented native v1 layout is raw.jsonl plus metadata/outcome sidecars, not the length-framed
binary format suggested by the historical feasibility note. Raw bytes are base64 evidence with
CRC/order/range verification; preserve v1 format and immutable outcome semantics.

Current limits: 16 KiB frames, 64 KiB batches, 256 KiB pending backlog, 8 KiB preview, 100
repository page rows and 256 KiB page budget; visible queries default to 20 rows. Header metadata is
at most 32 KiB and outcome metadata at most 8 KiB. Script content is at most 8192 bytes, transmitted
Serial payload at most 8194 with CRLF. These are operation/working-set bounds, not total
capture/retention caps. Quota estimates reserve no capacity. Avoid full arrays, accumulated output
strings and whole-export Blobs.

| Record            | Fields and evidence boundary                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header            | transport, host receive source, run/step IDs, command/name, startedAt, allowlisted target, exact requestBase64, mode/intent/timeout                                                                                               |
| Observation frame | ordered observation, receivedAt, stream, original observation offset/totalBytes, raw bytes, CRC32; split frames do not invent receive observations                                                                                |
| Capture metadata  | schema/id/sequence, active/complete/incomplete state, reason/failure, finalizedAt host time, committed bytes/frames, observations, first/last receive time, pending observation and observedBytes (null after unknown crash loss) |
| Outcome           | immutable command/run/schedule/completion snapshot committed after verified raw seal; no recovery-invented outcome                                                                                                                |

Bounded display and safe ANSI/plain-text search are separate projections. Terminal rendering ACK is
not storage ACK or completion. The writer finish loop must join batches launched by another flush
before sealing; Serial watchdog/cancel/generation checks continue through outcome commit.

### Use a disposable native index

Pinned Node 24/Electron exposes built-in node:sqlite (actual Electron 44.5.1/Node 24.21.0/SQLite
3.53.4 probe retained). The candidate stores only sequence/opaque-ID membership in a fresh
.catalog-UUID.sqlite on each open. Canonical metadata/raw/outcome remain authoritative. One
streaming startup directory scan rebuilds membership; later pages read bounded IDs/metadata without
rescanning all directories. Startup stays O(n); the 1 MiB SQLite pager target is not a process heap
guarantee. Index unavailability falls back to bounded scanning with a persistent warning; duplicate
canonical sequences and unsafe aliases fail closed while preserving evidence.

Use the existing physical filesystem boundary, regular/unlinked-file validation and
listing/read/export/delete leases. Explicit deletion first validates owned contents then renames to
.deleting-UUID before removing known files. Recovery completes only that intent. Unknown/unpublished
.pending data is retained with a warning; stale cache cleanup failure does not erase raw evidence or
block safe reads. This is cheaper than rescanning per page and safer than treating the index as
primary data. Native platform behavior beyond this Windows candidate remains a gate.

### Preserve IndexedDB data during migration and ownership loss

Keep schema v2 with captures/frames/settings/results, preserving unknown stores. Validate
legacy/current key paths and unique sequence indexes; migrate recognized v1 by adding results in one
upgrade transaction. Abort malformed legacy migration without changing v1; refuse malformed v2/newer
versions without reset. Repair missing/low sequence counters from retained metadata, preserve
invalid counters with a warning and block new writes. Await transaction completion, including
outcome writes, before releasing versionchange ownership. A real aborted outcome transaction leaves
sealed raw data and permits an explicit immutable retry. Browser eviction/power-loss limitations
remain visible.

### Separate native and browser exports, preserve job ownership

Native export uses an existing trusted Save dialog and atomic destination replacement through
main-owned bounded buffers. Browser uses a same-origin scoped service-worker attachment with
expiring client-bound authorization, pinned membership and integrity preflight. No arbitrary native
path/database/URL input is accepted. Full-scope export snapshots current filter input at click time;
display debounce has no export authority. The mounted Serial result-job owner survives transport
switching. Native shutdown snapshots entry-time pending exports, rejects new dispatch, attempts
renderer disposal, joins all those exports and attempts store close before aggregating failures.

Preflight missing-block controls are implemented. Unexpected midstream Firefox/WebKit download
failure feedback remains unqualified; browser handoff is not physical saved-file confirmation. Keep
this gate explicit.

### Add independent SSH streaming before console

Current SSH exec returns one capped final JSON object. Add an explicit negotiated stream API for
desktop and gateway with authenticated connection/run identity, ordered observations, original
gateway receive times, bounded sequence/range validation and durable ACK credit. Preserve genuine
exit/signal evidence and stdout/stderr identity. Pause both streams under backpressure; stop later
commands on incomplete storage and never silently use the old cap. Use existing HTTP bounded
streaming patterns without adding WebSocket dependencies merely for transport.

Then apply add-ssh-persistent-console-automation: a separate flow-owned PTY, explicit
intents/literal criteria and typed startup/idle/shutdown context segments. Shared exports must
compose both this change and the console delta; neither may overwrite the other's full-output or
provenance requirements. Existing manual PTY transcript privacy stays separate.

## Evidence and current gates

| Slice                      | Exact evidence / status                                                                                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visible Serial integration | frozen visible checkpoint patch SHA256 864c14a29cc74db5343b18b4150358fb755fa64af4b50a7f6837986c56fec742; accepted seven-file correction SHA256 3cc7f1429cc1eabf3e9395e8baf5625d7545802f6b4d3dfdc4437cdb35b9c1b9; 404-file isolated baseline          |
| Index/lifecycle candidate  | Task/capture-index-lifecycle/workspace; 47 native passes, 31 browser passes/two explicit Firefox/WebKit crash skips; build/typecheck and focused format pass; review pending                                                                         |
| Scale/recovery evidence    | 2048 legacy rows, one recovery scan; subsequent 20-row page reads 21 metadata entries/zero directory scans; legacy hashes preserved, index fallback/permissions/duplicates/unsafe hardlinks, SIGKILL committed-prefix and deletion-intent cases      |
| Actual Electron            | production sandboxed preload/context isolation, nodeIntegration off, noAsar false; 2,113,536-byte exact raw round trip, outcome/export/delete; separate SQLite availability probe. Receipt does not explicitly report active index mode/cache health |
| Browser lifecycle          | real upgrade abort/blocked/future/malformed stores, outcome transaction abort/retry, versionchange, every-engine reload; actual Chromium renderer crash only, not Firefox/WebKit crash qualification                                                 |
| WebKit timing              | ordinary three-engine/three-worker probe: 8 pass/one five-second failure. Snapshots show advancing receive/storage/second write in reproduced failures; deadline remains failed. No CPU-cause conclusion or historical-failure waiver                |
| Remaining                  | independent SSH/gateway streaming, console, product heap/backpressure, driver/platform lifecycle, midstream browser failure UX, integrated adoption and release gates                                                                                |

## Risks / Trade-offs

- Local finite storage/eviction → classify availability and completeness without deleting evidence
  or claiming reserved space.
- Sync derived-index work/startup scan → qualify product responsiveness and heap; API bounds alone
  do not prove plateau or throughput.
- Crash/permission differences → native Windows fixtures and Chromium crash evidence are narrow;
  Linux/macOS and other crash paths remain pending.
- Overlapping OpenSpec export deltas → compose the complete requirements in both active changes and
  verify before future synchronization/archive.
- Earlier spec lag → retain this audit's initial state and chronology; current structural validity
  is not retrospective process compliance.

## Migration Plan

Keep frozen sources, patches and logs unchanged. Independently review the exact index/lifecycle
packet against its accepted 404-file baseline, then integrate only accepted changes. Preserve
backward-readable raw v1 and non-destructive IndexedDB v1→v2 behavior. Rollback must refuse newer
data honestly, never recreate/delete it. Complete independent SSH streaming and the remaining gates
before updating public support/version/release claims. No publication, install or DUT operation
occurs in this change's planning pass.

## Current bounded corrections and verification matrix

The indexing reviewer narrowly accepted that delta but identified a pre-existing initialization P2:
versionchange could release begin leases before the transaction settled and then acknowledge active
ownership after closure. The separate correction tracks initialization through lease
acquisition/commit/acknowledgement, joins it during versionchange and refuses closed-store
acknowledgement before the producer. Commit/abort controls use the actual capture helper and Web
Locks, with positive and old-source negative evidence in Task/capture-begin-correction. Frozen patch
SHA256 9891f03f8c9fe7a3699c481e228bbb4472f2f1556a077195afb93ccb36d38cc9; 37 browser lifecycle
passes/two existing crash skips, six expected negative failures, build/typecheck/format pass.
Independent review/adoption remains pending.

The separate prompt-tail correction addresses avoidable repeated 4-KiB string copying: 294,912
printable characters had 294,912 trims, now 72 bounded-run trims. It preserves the escape state
machine, destructive-edit truncation order and prompt/delivery/storage fences; CR-only text now
obeys the existing intended 4096-code-unit bound. Measured WebKit parser work fell from 704 ms
total/61 ms maximum to 31 ms/4 ms in the stage probe. This is not an exclusive explanation of all
historical failures or proof of a CPU/disk bottleneck. The receive-overlap experiment did not clear
the gate and was removed. Frozen patch SHA256
e6753f38285df28da3d325f2ec396641ef980404c4bb5c4499467ec0c518d214; three sequential uninstrumented
original nine-case matrices pass 27/27 with three engines/three workers and unchanged five-second
polling. Focused checks pass 46/46 and stored-Serial integration 33/33 (overlapping controls), two
deterministic old-parser controls fail as expected, and build/typecheck/format pass. Independent
review and combined-source gates remain.

See verification-matrix.md for current risk-based coverage and remaining work, including every new
SSH/console asynchronous boundary, export failure handling, scheduling, graph after implementation,
installer/update/native platforms, product heap/load/lifecycle and the explicit not-performed
Windows 11 DUT checklist for Bruce. No broad competing suites were run during the final latency
cohorts. No hardware/port, new install/dependency, permission, CI or publication action is
authorized by that checklist. All frozen indexing/progress/earlier packets and original failure
evidence remain unchanged.

## Production streaming and resource qualification sequence

The accepted 411-file capture composition and four-file SSH preparation are now independently
accepted. Production independent streaming is being implemented in a separate Task-owned workspace.
It must await actual owned-channel closure and client pending IO, raw seal and immutable outcome
before releasing execution ownership; the earlier test-only pump alone did not establish that fence.
The typed combined-PTY/context representation remains a prerequisite to console persistence.

The memory/CI audit confirms existing narrow bounds and cleanup evidence, but no general CI leak
gate. memory-resource-qualification.md defines fast Node 24 resource/retained-memory regression and
longer supported-runtime lifecycle soak work, including store close and full teardown. Tasks 4.7/4.8
distinguish planned coverage from executed source-specific evidence. Current manual-only fixtures
must not be described as CI gates. No new CI dispatch or installation is authorized.

## Qualified production SSH checkpoint

The independent stream is now implemented and qualified in isolation; see
production-ssh-streaming-checkpoint.md for source/patch/runtime/evidence and remaining gates.
Generation negotiation additionally invalidates a stale queued start after document navigation, even
when the underlying SSH connection is retained. Durable ACK follows repository flush; raw seal and
immutable outcome precede finalization/release, and actual owned-channel close plus pending IO are
joined. Typed combined-PTY/context representation and dedicated console remain next-stage work.
Original app adoption and bounded independent review are pending.

The reviewer-supplied memory/resource plan is incorporated with explicit 3+12 fast-cycle/ten-run
calibration/negative-control and 30-minute 5+25-minute/100-cycle lanes. Current new resource checks
are narrow implemented evidence; the proposed general memory command, CI call and full soaks remain
unimplemented. The earlier optional native-crypto abort remains a separately tracked incident.
