## ADDED Requirements

### Requirement: Accessible actionable draft validation

Automation SHALL mark conditionally required fields and present invalid/missing values with red
borders, short inline text, aria-invalid and associated error descriptions after blur or an
attempted Next/Review/Run correction. Errors SHALL clear when corrected and SHALL NOT rely on color
alone. Validation SHALL cover enabled command rows, at least one enabled step, Serial completion
prompt, timeout/repetition/step delays, and active schedule date/time/timezone/clock/DST occurrence.
Optional blank names and timestamp prefix SHALL remain valid. Next SHALL block an invalid current
stage and focus its first invalid field. Review SHALL provide a reachable correction action that
focuses the first invalid field, including opening advanced settings when needed. Invalid Run
controls SHALL remain blocked; strict backend plan/clock validation SHALL remain authoritative.
Reserved error space SHALL limit layout movement.

#### Scenario: Missing required command or prompt

- **WHEN** an operator attempts Next with a blank required command or Serial prompt
- **THEN** the stage is retained, its first invalid field receives focus with associated text, no
  command/port emission occurs, and correction removes the error

#### Scenario: Optional blank prefix and ambiguous schedule

- **WHEN** a blank optional prefix accompanies an otherwise valid draft or a schedule names an
  unresolved repeated time
- **THEN** the blank prefix is accepted, the repeated time points to its explicit occurrence choice
  and Run cannot bypass strict scheduling validation

### Requirement: Conservative fresh Serial prompt completion

Each Serial Automation step, including Enter-only, SHALL start fresh capture counters and streaming
prompt state. Prior prompts SHALL NOT advance a new step. Incomplete UTF-8 or terminal escape state,
wrong/missing prompts, cancellation and capture overflow SHALL prevent subsequent steps rather than
claiming successful completion. Raw retained bytes and available receive provenance SHALL survive.

#### Scenario: Sequential scripts and consecutive Enter-only actions

- **WHEN** a flow runs Script, Enter, Enter and Script on one explicitly owned Serial port
- **THEN** each action waits for its own fresh complete literal prompt, Enter sends the configured
  line-ending bytes and no stale prompt or old counter advances later input

#### Scenario: Unfinished prompt parsing

- **WHEN** a prompt-looking tail is followed by incomplete UTF-8 or an incomplete escape
- **THEN** no next command or Enter is sent and timeout/cancel retains honest partial evidence

## MODIFIED Requirements

### Requirement: Isolated bounded transport execution

SSH SHALL default to independent deliberate user scripts in owned bounded exec channels with genuine
exits, separately captured streams and generation fencing. An explicitly selected, supported SSH
console mode SHALL instead use one exclusively flow-owned persistent interactive PTY across its
steps and repetitions, preserving the target's normal interactive cwd, environment, aliases and
functions. It SHALL remain separate from the existing Terminal. Script intent SHALL require nonblank
user text; Send Enter intent SHALL be explicit and transmit exactly CR only in console mode. The
application SHALL NOT turn an empty independent exec into Enter, rewrite an alias or inject guessed
profile sourcing. Console completion SHALL require freshly observed explicit bounded literal
criteria, with per-step alternatives/overrides and explicit intermediate-input criteria where
necessary. Prompt observation SHALL NOT imply success or a genuine exit status.

Serial SHALL require exclusive input ownership, explicit previewed line-ending bytes, a bounded
literal prompt condition and timeout. Cancel run SHALL be the single visible cancellation/disarm
action while active or waiting. It SHALL disarm pending steps, repetitions and scheduled restarts
and request owned active-channel cancellation without claiming remote rollback or guaranteed remote
process termination. Genuine ordinary nonzero independent SSH exits SHALL retain the default
continue-to-next-step policy. Signalled termination or close without a genuine independent-script
exit status SHALL preserve available signal/core/message evidence and pause later steps and
repetition rather than inventing an exit code. All modes SHALL preserve storage-backed raw capture
with bounded memory, generation fencing and ownership until unfinished cleanup releases it.
Unsupported console runtimes SHALL refuse with an explanation and SHALL NOT silently change
execution mode.

#### Scenario: Connection replacement during asynchronous work

- **WHEN** a connection changes while a clock sample, command or delayed start is pending
- **THEN** the old operation cannot execute against the replacement connection and the flow pauses

#### Scenario: Signal or missing exit status

- **WHEN** an independent SSH command ends by signal or closes without a genuine exit status
- **THEN** available termination evidence remains reviewable and later/repeated steps pause

#### Scenario: Persistent cwd and normal shell definitions

- **WHEN** a console flow sends `cd /`, then `pwd`, then an alias/function defined by the target's
  normal interactive initialization, using explicitly configured completion criteria
- **THEN** the steps share one shell, `pwd` reports `/`, and the definitions behave as they do in
  that shell without alias rewriting, profile injection or invented exit codes

#### Scenario: Explicit Enter and intermediate input

- **WHEN** a console step explicitly waits for a program's input prompt and the next step is Send
  Enter, including consecutive Send Enter steps
- **THEN** each action sends one exact CR on the same owned PTY, waits for its own fresh criterion
  and never automatically confirms input merely because the program is waiting

#### Scenario: Changed prompt after a directory change

- **WHEN** the prompt changes after a stateful command
- **THEN** an explicitly configured alternative or per-step criterion can complete it, while a
  wrong/missing criterion times out visibly without a guessed match or later input

#### Scenario: Invalid intent or unavailable console

- **WHEN** an accidental blank Script, independent-script Send Enter or unsupported console mode is
  armed
- **THEN** validation refuses before any command is sent and preserves the draft

#### Scenario: Fragmentation, stale input or interrupted capture

- **WHEN** output is fragmented, contains stale prompt text, exhausts bounded pending storage
  capacity or remains incomplete/cancelled across a disconnect
- **THEN** only fresh complete criteria can advance a step; overflow/uncertainty stops later input,
  retained bytes and receive provenance remain reviewable, and reconnect requires explicit rearming

#### Scenario: Cancel every armed phase

- **WHEN** Cancel run is used during active execution, a between-step delay, repetition wait or a
  future scheduled start
- **THEN** no later command/repetition/restart is sent without explicit rearming, available owned
  cancellation is requested and remote-termination uncertainty remains visible

## ADDED Requirements

### Requirement: Deliberate readable Automation action presentation

Clear retained results SHALL retain its descriptive text and clearing behavior while using the
established destructive-warning palette and a decorative cleanup icon. Start flow SHALL retain its
text/accessible name and behavior with a decorative play icon. Enabled normal/hover text SHALL stay
readable, focus SHALL remain visible, and disabled state/icon alignment SHALL remain consistent.

#### Scenario: Review action states without clearing user evidence

- **WHEN** the actions are normal, hovered, keyboard focused or disabled
- **THEN** their text and icons remain correctly aligned/readable in applicable appearance modes,
  icons add no redundant accessible name, and presentation alone clears no retained evidence
