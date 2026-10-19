# Spec Delta

## MODIFIED Requirements

### Requirement: Deliberate ordered flow editing

The application SHALL provide optionally named, enabled, reorderable and duplicable multiline
command steps for both SSH and Serial. It SHALL preserve each editor as one command/payload, insert
newlines on Enter, and execute only after explicit Run once or Start. Blank names SHALL be
represented by an ordinal label without becoming command text. Mouse drag and accessible keyboard
reorder SHALL be available only while unarmed. Active arming SHALL freeze commands, delays, framing,
clock and repetition independently of subsequent draft edits.

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
instants. Scheduling controls SHALL retain stable layout, offer date/time pickers and selectable
IANA zones, calculate the selected instant's offset automatically, and show a live reference clock
in that zone. Reference ticks SHALL NOT change the chosen fields or scheduled instant. Repeated
local times SHALL offer explicit earlier/later occurrence choices. A start SHALL be rejected if it
is less than two seconds plus clock uncertainty in the future at arming.

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
disconnect/replacement, sleep or timer stalls, clock jump, stale/failed calibration, with explicit
rearming and no missed-run catch-up.

#### Scenario: Serial console has no verified time source

- **WHEN** a Serial flow requests device-clock scheduling without a verified calibration
- **THEN** arming is unavailable with an explanation and local-clock scheduling remains usable

#### Scenario: Desktop minimized while armed

- **WHEN** the desktop app is minimized during an eligible scheduled, repeated or active run
- **THEN** it continues without cancelling merely because the document is hidden
- **AND** sleep, disconnect, ownership loss, timer stalls and invalid clock evidence still pause
  with manual rearming

#### Scenario: Reference clock ticks

- **WHEN** current time advances while a future start is being edited
- **THEN** the displayed current time advances in the selected zone but the chosen start stays fixed
