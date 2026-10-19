# Automation additions (approved local implementation)

This change now includes an Automation primary tab for SSH and Serial. The numbered flow editor
preserves each named, enabled multiline command as one payload. Enter adds a newline; only explicit
Run once or Start arms a snapshot. Reorder/duplicate/delete are reversible edits; active runs retain
their immutable snapshot and new edits apply on the next arming. No import engine, command
rewriting, shell inference or graph canvas is included.

## Ordered execution and scheduling

Immediate execution is the default. Optional wall-clock start, delay before each enabled step and
repetition after a complete flow are independent controls. Repetition is off by default, sequential
and never overlaps or accumulates missed runs. Stop disarms repetition/waits and allows an already
sent command to finish; Cancel requests cancellation of the owned channel/capture, stops later steps
and never promises remote process rollback. Start preview includes the exact resolved instant, IANA
zone and UTC offset. Strict calendar validation rejects impossible days/leap dates, invalid
components, overflow/nonfinite numbers, DST gaps, unresolved folds or conflicting offsets. Arming
requires at least two seconds plus verified uncertainty in the future and repeats all validation.
Draft text remains intact on failure. Local timing uses the local wall clock for the start and
monotonic elapsed durations for delays. Device timing requires an identified current-connection
calibration with actual device epoch/zone, local receipt and RTT uncertainty; no clock fallback is
relabeled as device time. SSH exposes an explicit fixed read-only clock sampling action, with
disclosed bounded refresh while a device-clock schedule is armed. Serial prompt responses can supply
exact received ISO timestamps via a configured literal prefix for row provenance, but arbitrary
consoles cannot prove emission latency: device-clock arming remains unavailable without a verified
calibration provider. No automatic date/sentinel/setup payload is sent through Serial. Connection
replacement/disconnect, document hide/page exit, app sleep/timer stalls, clock jumps, sample
staleness or failed calibration pause the flow. Resume requires explicit re-arming and a fresh
future start. No background OS scheduled task is created.

## Capture and export

SSH uses isolated authenticated exec channels, real exit status and separately decoded
stdout/stderr. Scripts are deliberate operator actions, distinct from the fixed observational
diagnostic inventory. Serial requires a configured printable literal prompt suffix and bounded
timeout; streaming ANSI removal, split chunks, pre-send quiet input and exclusive ownership reduce
ambiguity. Echo, unsolicited bytes, stale driver buffers or prompt-like payloads can still be
included, so prompt observation is not command success or an exit code. Bounded completed results
(200 rows/8 MiB), 64 KiB per command output, 256 raw chunks and explicit truncation/eviction are
shared. Local start/completion and device observations have honest source/zone provenance.
Search/status/command filtering, row selection and paused autoscroll permit review. Retained
immutable rows export as JSON/CSV/Markdown/text in selected/filtered/all-retained scope without
querying or executing again. JSON preserves exact retained text/raw base64; CSV lists apostrophe
transformations for formula-like cells, robust quotation and newlines. Markdown uses dynamically
sized fences and escaped headings; human formats render nonprinting controls visibly. Credentials
are never copied from connection configuration, but commands/output themselves may contain secrets
and require user review. Exports are local user-triggered downloads.
