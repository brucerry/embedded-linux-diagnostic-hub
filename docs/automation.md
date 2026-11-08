# Ordered Automation

Build optionally named/enabled multiline steps for connected SSH or explicitly opened local Serial.
Enter inserts a newline. Each editor remains one deliberate script/payload; typing/export never
executes it. Step name (optional) labels captured results; a blank name becomes Step N. The
multiline command editor contains the executable text. Drag a noninteractive part of a command card
to preview its position while hovering; inputs, textareas, buttons and other controls remain
editable. The placeholder marks the insertion position, list edges scroll during dragging, and
Escape or cancellation restores the original order. Keyboard-accessible move buttons remain
available; reordering is disabled while armed. Reorder/duplicate/remove, inspect exact escaped
payload bytes, then Run once or Start flow. Active flows freeze a snapshot; draft edits apply on the
next arming. Immediate one-flow execution is default. Optional wall-clock start, elapsed delay
before each step and off-by-default repetition after a complete flow are independent. No
overlap/backlog/reconnect occurs. Stop prevents later work and lets an active step finish; Cancel
requests owned-channel/capture cancellation. Already sent commands may continue and cannot be
undone. Timing controls stay in place when run modes change. Choose the start with calendar/time
pickers and an IANA timezone; the selected date's UTC offset is calculated automatically. Repeated
local times require an explicit earlier/later occurrence. The live reference clock uses the selected
zone and clock source; its ticks never change the chosen fields or scheduled instant. Start input
requires valid YYYY-MM-DDTHH:mm[:ss], a real IANA zone and resolved UTC offset. Impossible dates,
DST gaps, unresolved folds, conflicting offsets, nonfinite/out-of-range values and past/near-past
starts are rejected without losing drafts. Arming revalidates and requires at least two seconds plus
clock uncertainty in the future. Local starts use host wall time; delays use elapsed time. Device
scheduling requires explicit SSH Sample device clock, actual current-connection epoch/zone and
bounded RTT uncertainty; armed device schedules refresh this disclosed fixed read-only source.
Serial received ISO timestamps do not prove emission latency, so arbitrary Serial consoles cannot
arm device-clock starts. This restriction is enforced by plan validation and arming, including
programmatically supplied plans; received timestamps are not calibration. Local scheduling remains
available. Desktop Automation continues while minimized: a trusted active-work lease disables
renderer background throttling while armed/running and releases it after completion or interruption.
Page exit, sleep/timer stalls, disconnect/replacement, ownership loss, clock jumps or stale/failed
samples pause work; resume requires explicit rearming, with no catch-up or persistent OS task.

Independent SSH capture keeps later input disarmed when finalization is unacknowledged. Explicit
cleanup retry joins the same owned retirement without executing the command or recording its
evidence again. A missing or invalid start acknowledgment cannot establish ownership retirement;
cleanup stays pending rather than replaying an uncertain command or claiming it has stopped.

Run once honors the configured wall-clock start and step delays but disables repetition; its label
explicitly identifies scheduled execution. Execution boundaries validate real IANA zones and
matching wall-time/offset/instant metadata and reject extraneous or inapplicable calibration.

## SSH and Serial input

SSH offers two execution modes:

- **Independent script** uses a separate exec channel for each step, with separate stdout/stderr
  evidence and genuine exit status. Multiline text is one script: `cd` can affect later lines in
  that script, but it does not change the working directory of a later step. An ordinary nonzero
  exit retains the deliberate continue policy. Signalled termination or close without a genuine exit
  status pauses later steps and repetition, retaining available signal/core-dump/message evidence.
  Optional **Capture device time** records a real sourced sample, not relabeled local time.
- **Persistent console** owns one interactive shell across the flow's steps and repetitions, so
  shell state such as a changed working directory can persist. Choose initial shell-prompt and
  completion criteria explicitly. **Script** requires nonblank text and appends one CR; **Send
  Enter** requires empty script text and sends exactly one CR. Input remains ordered, and prompt
  observation does not bypass a pending write acknowledgement. The combined PTY journal includes
  startup, idle and shutdown context; context is not a command, and an observed prompt is not a
  process exit status. Console records use local receive time; per-command device-time capture is
  unavailable in this mode. A missing console capability is an error, not a silent switch to exec.

Builtins and aliases are interpreted by the remote shell. For example, `cd` changes that shell's
state; `ll` works only if the selected remote shell provides it as an alias, function or executable.
Diagnostic Hub does not define aliases, rewrite shell profiles or inject setup/sentinel payloads.
Normal remote interactive-shell startup can still run the device's own configured initialization.

Explicit SSH step metadata must identify Script or Send Enter, including disabled blank steps.
Disabled blank Script steps remain valid drafts; enabled scripts must be nonblank, and Send Enter is
unavailable in independent-script mode. Validation identifies the affected step/name.

Serial requires exclusive input, exact chosen none/CR/LF/CRLF ending, a bounded printable literal
completion prompt and timeout. A blank Serial step is deliberate only when **Send Enter only** is
selected with CR, LF or CRLF; it then sends only those exact bytes. Local requested-input
annotations appear in the shared Serial terminal separately from received output and are excluded
from command result capture. ANSI/chunk-aware matching and pre-send quiet reduce ambiguity; echo,
unsolicited data and old driver buffers can remain. Prompt-observed never means a successful exit.
Optional literal timestamp prefix records only valid complete received ISO timestamps with offset.
Missing device observations and Serial exits stay unavailable.

## Connection retries

The user-initiated SSH connection operation retries failures classified as `network` only after
failed-attempt cleanup is acknowledged, then waits three seconds before starting another attempt.
Authentication, host-key and policy failures pause for correction; cancellation stops the operation,
and unconfirmed cleanup blocks further attempts. This is not a fixed three-second interval between
attempt starts. It does not replay Automation commands, reconnect an established session or rearm an
interrupted flow. See [SSH connection retries](connection-retries.md).

## Results and exports

Current Automation results use stored captures. The command-row format remains for legacy
compatibility; the current UI does not populate its in-memory result rows. These export contracts
support JSON, CSV, Markdown and text:

| Result view                                                  | JSON contract                                                                                                               | Retention and export scope                                                                                                                                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Legacy in-memory command-row exporter (compatibility format) | `diagnostic-hub-command-automation`, `schemaVersion: 1`; version 2 when retained chunks include Serial aggregation metadata | At most 200 rows / 8 MiB with visible eviction. Selected, filtered or all-retained exports use those rows, excluding evicted data. This exporter's local download limit is 32 MiB.                                       |
| Stored independent-SSH or Serial captures                    | `schemaVersion: 3`, with exact base64 bytes, receive boundaries/timestamps, checksums, outcomes and completeness            | Selected, filtered or all stored captures are read and verified independently of the bounded page and clipped preview. Membership is pinned for export; incomplete captures retain only their verified committed prefix. |
| Stored persistent-console flows                              | `format: diagnostic-hub-console`, `schema: 2`, `mode: console`, `byteEncoding: base64`                                      | One retained capture covers an owned flow and its context. Selected, filtered or all-retained exports inspect complete stored evidence, not just the current page/preview.                                               |

Stored result exports do not use the command-row eviction or 32 MiB download limit above. Active
work must finish or be cancelled before stored export. Export reads retained evidence without
executing commands again; missing observations and uncertain dispatch never justify automatic
replay. Native stored exports report a saved file only after the file commit is acknowledged.
Browser exports report that the stream was sent; check the browser's Downloads for final save
status.

Human-readable formats are projections, not interchangeable raw evidence. Command-row exports
display nonprinting controls as visible `\xNN`; stored capture reports decode received bytes per
stream as UTF-8, replacing invalid sequences; console readable output also strips terminal controls.
JSON/base64 remains authoritative for exact retained bytes and metadata. Markdown escapes metadata
and uses safe fences or quoted readable text as appropriate to its report. CSV quotes cells and
protects formula-like content with an apostrophe; row/capture reports list `transformedFields`,
whereas console reports use `formula_escaped_fields` and `canonical_json_base64` columns. Capture
reports label host receive/record timestamps as UTC, not device emission time; capture completeness
does not imply command success. Review commands/output for secrets before sharing: excluding
connection credentials from export metadata cannot remove secrets present in captured content.

Console Markdown groups flow metadata in tables and separates preparations, command segments,
context and received PTY with headings, rules and icons. Its legend distinguishes capture
completeness, shell closure and prompt observation from command success. Canonical metadata and
record base64 fields remain included.

## Runtime qualification

Browser tabs can be suspended or throttled by the browser/OS; timer stalls still pause rather than
catching up missed runs. Native background support does not prevent system sleep or weaken device
clock freshness and uncertainty rules. Tests distinguish deterministic fake-clock/backend logic,
renderer UI fixtures, and actual Electron/trusted-IPC execution against a loopback ssh2.Server.
Minimized schedule/repeat/cancel qualification uses real renderer timers and real SSH protocol
channels; power suspend/resume events are simulated without sleeping the host. The existence of a
qualification harness is not a passing result for the current candidate. Physical targets remain a
separate acceptance boundary.
