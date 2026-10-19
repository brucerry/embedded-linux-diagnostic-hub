# command-automation Specification

## Purpose

Provide explicitly armed ordered SSH/Serial scripts with validated timing, isolated execution and
clear interruption semantics.

## ADDED Requirements

### Requirement: Deliberate ordered flow editing

The application SHALL provide named, enabled, reorderable and duplicable multiline command steps for
both SSH and Serial. It SHALL preserve each editor as one command/payload, insert newlines on Enter,
and execute only after explicit Run once or Start. Active arming SHALL freeze commands, delays,
framing, clock and repetition independently of subsequent draft edits.

#### Scenario: Multiline edits during a run

- **WHEN** an operator edits or pastes a multiline command after arming
- **THEN** the active flow retains its snapshot and the edit applies only after the next explicit
  arming

### Requirement: Optional validated scheduling

The application SHALL support immediate execution, optional wall-clock start using local or verified
device time, optional elapsed delays before steps and optional repetition after completed flows
without overlap/backlog. Run once SHALL honor the configured start and step delays while disabling
repetition. All UI and execution boundaries SHALL strictly validate calendar dates, leap years, time
components, IANA zones, DST gaps/folds, explicit offsets, finite bounded intervals and unambiguous
instants. A start SHALL be rejected if it is less than two seconds plus clock uncertainty in the
future at arming.

#### Scenario: Impossible or ambiguous start

- **WHEN** a draft names an impossible day, nonexistent local time, unresolved repeated time,
  conflicting offset or past start
- **THEN** execution is blocked with a field-specific message while the draft is preserved

#### Scenario: Scheduled one-shot execution

- **WHEN** an operator chooses Run once with a valid future start and step delays
- **THEN** the flow waits for that start, applies those delays and finishes without repetition

### Requirement: Honest device clock and suspended work

Device scheduling SHALL require an identified current-connection time source, actual sample
epoch/zone, bounded freshness and uncertainty. The application SHALL NOT relabel local time as
device time or send unsupported Serial clock/setup/sentinel commands. It SHALL pause on
disconnect/replacement, sleep or timer stalls, document hide, clock jump, stale/failed calibration,
with explicit rearming and no missed-run catch-up.

#### Scenario: Serial console has no verified time source

- **WHEN** a Serial flow requests device-clock scheduling without a verified calibration
- **THEN** arming is unavailable with an explanation and local-clock scheduling remains usable

### Requirement: Isolated bounded transport execution

SSH SHALL execute deliberate user scripts in owned bounded exec channels with genuine exits,
separately captured streams and generation fencing. Serial SHALL require exclusive input ownership,
explicit previewed line-ending bytes, a bounded literal prompt condition and timeout. Prompt
observation SHALL NOT imply a successful exit. Stop SHALL disarm pending/repeated work; Cancel SHALL
stop subsequent steps and request owned-channel cancellation without claiming remote rollback.
Genuine ordinary nonzero SSH exits SHALL retain the default continue-to-next-step policy. Signalled
termination or close without a genuine exit status SHALL preserve available signal/core/message
evidence and pause later steps and repetition rather than inventing an exit code.

#### Scenario: Connection replacement during asynchronous work

- **WHEN** a connection changes while a clock sample, command or delayed start is pending
- **THEN** the old operation cannot execute against the replacement connection and the flow pauses

#### Scenario: Signal or missing exit status

- **WHEN** an SSH command ends by signal or closes without a genuine exit status
- **THEN** available termination evidence remains reviewable and later/repeated steps pause
