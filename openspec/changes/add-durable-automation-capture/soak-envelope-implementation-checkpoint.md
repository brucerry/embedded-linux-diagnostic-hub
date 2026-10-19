# Approved envelope implementation and remaining capacity refusal

Candidate 29 preserves the exact sealed candidate-28 input and the reviewer decision at
`task-4/soak-capacity-envelope-decision-2`. Its decision seal is
`ea871d422e81fc87cdb22153f49a3065c648b6a8165622e250e5962d778b3498`. That approval covers local
source implementation and deterministic controls only. Source acceptance, host execution, collection
enabling and publication remain absent.

## Implemented source controls

The versioned `soak-local-reference-v2` contract charges one expanded canonical observation pass.
Its lifetime 2-GiB allowance has independent 1,280-MiB sample, 512-MiB other-work and 256-MiB
cleanup partitions. Work failures remain sticky. Planned dictionary/counter admission is atomic: a
refused transaction publishes no bytes or definitions and cannot consume cleanup credit. Healthy
cleanup records and the final footer remain sync/close protected and explicitly report incomplete
work. Writer I/O corruption remains fatal. The collector refuses ownership release from this
incomplete local integrity result.

Qualification consumers must provide bounded provisional state and commit it transactionally; there
is no generic second-decode fallback. Canonical hashes stream without a duplicate complete report
buffer. Exact immutable definitions and event-history elements are parsed once, preserve order and
all original data, and charge expanded bytes on every use. The reader retains parsed immutable
definitions rather than retaining raw bytes and a duplicate graph. Small transactions use one
self-contained canonical row, acknowledged after sync; larger transactions retain bounded extents.
The 32-MiB canonical staging and 16-MiB reader admission rules remain separate from RSS.

Named physical policy partitions are 48 MiB capture/raw/meta/outcomes, 128 MiB other active profile,
128 MiB one live artifact, 64 MiB timeline, 2 MiB streams, 32 MiB auxiliary and 10 MiB cleanup. The
allocated 412 MiB leaves 4 MiB unallocated within the 416-MiB job limit. Work inventory refuses
above 406 MiB. Two jobs and at most 8 MiB collector overhead fit the 840-MiB cohort policy ceiling.
Known artifact admission reserves a slot before work; joined readers/producers and actual unlink are
required before release. Failed/cancelled files and real temporary-file overlaps remain charged. A
known native atomic link commit is counted once by inode only when both owned names are present; a
copied output consumes both files. Captures are excluded from the other-profile partition. The
MEMORY-journal capture catalog is counted once without inventing a catalog WAL.

Finite budgets, the 128-MiB per-file refusal, the quiescent 64-MiB/500-record guard, payload,
history coverage, cadence targets and deadlines are unchanged. No counter is reset per sample,
report, cycle or dictionary transition.

## Model limits and remaining blockers

The sample-only 7,200/9,600/12,000 targets pass under the approved envelope. A controlled retained
native-cycle replay also passes those counts, with three warmup and 100 measured cycles and 309
extra checkpoint publications. These results do not prove arbitrary warmup counts or the complete
live source-phase census.

Adding the actual `SerialGeometryRead` proof for every 33-MiB cycle exposes another timeline
capacity refusal: the 9,600-sample target completes 9,529 samples, then refuses on the unchanged
physical-byte work limit. Exact final results, counters, model source inputs and failure/cleanup
evidence belong to the candidate review packet. Further encoding or scope design needs reviewer
resolution. This checkpoint does not increase the timeline budget or reduce evidence/workload.

The active-profile and auxiliary reservations remain policy allowances. Chromium/worker writes have
no source-enforced pre-write quota; periodic apparent-byte inventory cannot prove allocated space or
peaks between checks. Real selected PNG/SVG output, arbitrary full-phase/forced-GC composition, live
throughput and physical host fit remain unproved. The implementation cannot turn these unknowns into
an acceptance claim.

Collection stays disabled. Tasks 4.8, 4.8.2 and 4.8.3 remain open.
