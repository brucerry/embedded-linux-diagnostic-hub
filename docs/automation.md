# Ordered Automation

Build named/enabled multiline steps for connected SSH or explicitly opened local Serial. Enter
inserts a newline. Each editor remains one deliberate script/payload; typing/export never executes
it. Reorder/duplicate/remove, inspect exact escaped payload bytes, then Run once or Start flow.
Active flows freeze a snapshot; draft edits apply on the next arming. Immediate one-flow execution
is default. Optional wall-clock start, elapsed delay before each step and off-by-default repetition
after a complete flow are independent. No overlap/backlog/reconnect occurs. Stop prevents later work
and lets an active step finish; Cancel requests owned-channel/capture cancellation. Already sent
commands may continue and cannot be undone. Start input requires valid YYYY-MM-DDTHH:mm[:ss], a real
IANA zone and resolved UTC offset. Impossible dates, DST gaps, unresolved folds, conflicting
offsets, nonfinite/out-of-range values and past/near-past starts are rejected without losing drafts.
Arming revalidates and requires at least two seconds plus clock uncertainty in the future. Local
starts use host wall time; delays use elapsed time. Device scheduling requires explicit SSH Sample
device clock, actual current-connection epoch/zone and bounded RTT uncertainty; armed device
schedules refresh this disclosed fixed read-only source. Serial received ISO timestamps do not prove
emission latency, so arbitrary Serial consoles cannot arm device-clock starts. Local scheduling
remains available. Hide/page exit, sleep/timer stalls, disconnect/replacement, clock jumps or
stale/failed samples pause work; resume requires explicit rearming, with no catch-up or persistent
OS task. SSH uses isolated exec channels, separate streams/raw base64 and genuine exits. Optional
Capture device clock before commands retains a real sourced sample, not relabeled local time. Serial
requires exclusive input, exact chosen none/CR/LF/CRLF ending, a bounded printable literal
completion prompt and timeout. ANSI/chunk-aware matching and pre-send quiet reduce ambiguity; echo,
unsolicited data and old driver buffers can remain. Prompt-observed never means a successful exit.
No setup/date/sentinel payload is injected. Optional literal timestamp prefix records only valid
complete received ISO timestamps with offset. Results retain at most 200 rows / 8 MiB, 64 KiB output
and 256 raw chunks per command, with visible truncation/eviction. Search/status/command filters,
selection, local/device time display and paused autoscroll support review. Missing device
observations and Serial exits stay unavailable. Selected/filtered/all-retained exports support
JSON/CSV/Markdown/text, freezing retained data without rerun/query. JSON schema 1 preserves exact
text/raw bytes and allowlisted identity/time metadata without connection credentials. CSV quotes
correctly, apostrophe-protects formula-like cells and lists transformedFields. Markdown sizes safe
fences and escapes headings; human formats show nonprinting controls as visible \\xNN. Review
commands/output for secrets before sharing. Downloads are local, user-triggered and bounded to 32
MiB; all retained excludes evicted rows.

Run once honors the configured wall-clock start and step delays but disables repetition; its label
explicitly identifies scheduled execution. Execution boundaries validate real IANA zones and
matching wall-time/offset/instant metadata and reject extraneous or inapplicable calibration.
Genuine ordinary nonzero SSH exits retain the deliberate continue policy. Signalled termination or
close without a genuine exit status pauses later steps and repetition, retaining available
signal/core-dump/message evidence. Human-readable exports render C0/C1 controls visibly in all
headers, metadata and bodies; JSON keeps exact retained text.
