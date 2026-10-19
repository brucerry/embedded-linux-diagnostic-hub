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

### Requirement: Console context outside command captures

An owned Automation console SHALL retain observed startup, idle/delay/repetition and shutdown output
in typed context segments through the same ordered bounded storage pipeline. A context segment SHALL
identify phase and owned flow/console provenance without fabricating command text, command ordinal,
exit status or AutomationOutcome. Command boundaries SHALL be ordered with raw observations and
persistence; no bytes SHALL be duplicated or silently discarded merely because no step is active.

#### Scenario: Background output between steps

- **WHEN** the dedicated PTY emits bytes during a step delay or before initial shell readiness
- **THEN** those bytes remain reviewable as context, are ordered with adjacent command captures, and
  cannot satisfy a subsequent step's fresh completion criterion
