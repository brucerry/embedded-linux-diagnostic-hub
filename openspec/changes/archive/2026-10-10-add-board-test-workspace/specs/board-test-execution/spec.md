# Spec Delta

## Purpose

Execute reusable board tests through the connected device with bounded resource use, separate
evidence, repeatable sequences, and verdicts that reflect the observations actually obtained.

## ADDED Requirements

### Requirement: Shared functional testing workspace

Desktop and website SHALL provide a Tests workspace for profile preparation, individual tests, named
sequences, run progress, cancellation, and results. The connected device clock SHALL remain in the
shared header. Users SHALL be able to navigate between pages without ending a run or losing its
state. Historical/imported evidence SHALL NOT supply a live device target. A transport without
testing support SHALL show an actionable unavailable state while retaining diagnostics and terminal
use.

#### Scenario: Navigate during a sequence

- **WHEN** a user changes pages while a connected test sequence is running
- **THEN** the same run continues and its progress/results remain available upon return to Tests

#### Scenario: Older gateway

- **WHEN** the authenticated gateway does not implement test operations
- **THEN** Tests explains the missing support without disrupting the existing workspace

### Requirement: Direct JSON engineering workflow

Both editions SHALL offer an alternative plain JSON mode accepting a profile or a bounded strict
request with profile, optional sequence/test selection, and optional fixture readiness/identities.
Run SHALL perform discovery, preparation, and execution without intermediate confirmations or
agreements. The execution action SHALL record prepared-fixture readiness, preserve existing board,
parameter, permission, capability, resource, concurrency, cancellation, and restoration safeguards,
and present a report-ready result. Malformed or incomplete intent SHALL be rejected before
discovery. Pending LED observations SHALL automatically finalize as unobserved/Inconclusive without
a prompt; JSON SHALL NOT accept claimed observations or fabricated passing results.

#### Scenario: Paste a prepared sequence

- **WHEN** an engineer pastes valid complete JSON and presses Run JSON
- **THEN** testing prepares and executes through the current source and presents exportable results
  without further agreements, while an unobserved LED cannot pass

#### Scenario: Invalid direct request

- **WHEN** pasted JSON contains malformed fields, unsafe parameters, or missing test intent
- **THEN** Run remains unavailable, the JSON field has a red border and explanation, and no
  discovery or active command is sent

### Requirement: Authenticated isolated bounded execution

Test operations SHALL reuse the authenticated SSH connection through independent non-PTY channels.
Backend-validated typed adapter requests SHALL determine remote commands; the API SHALL NOT accept
arbitrary executable commands or device paths outside validated resolved resources. Existing native
trusted-frame checks and gateway token/origin/session/host constraints SHALL apply. Each test and
run SHALL have finite time, output, input, and retained-state limits. Test stdout/stderr SHALL enter
only test evidence, never the terminal transcript, live diagnostic snapshots, or update backups.

#### Scenario: Test output resembles a shell prompt or kernel log

- **WHEN** an adapter emits prompt-like or kernel-style text
- **THEN** it remains test evidence and does not appear in the interactive terminal

#### Scenario: Unauthorized or malformed execution request

- **WHEN** a caller has an invalid origin/session/frame or supplies an invalid adapter parameter
- **THEN** execution is rejected before a target operation occurs

#### Scenario: Excessive output or stalled process

- **WHEN** an adapter exceeds its finite execution/output limit
- **THEN** the test is stopped, evidence identifies the limit, and no successful verdict is inferred

### Requirement: Resource coordination and lifecycle recovery

Only one functional run SHALL execute per authenticated device session. The application SHALL pause
its live/manual diagnostic collection and reject new terminal input during active testing, while
retaining the shell and its output and allowing independent device-clock reads. Previously queued
terminal input SHALL NOT be replayed after testing. The user's live-update preference SHALL be
preserved. Runs SHALL NOT silently survive target replacement, disconnect, report import, app exit,
or update disconnect; unfinished cases SHALL be recorded with their interruption reason. Session
data reset and updates SHALL coordinate with active tests rather than erase or overwrite a running
test. The UI SHALL explain that the app's coordination cannot stop programs already running on the
device or operations from other clients.

#### Scenario: Five-second live updates during a test

- **WHEN** an active test owns device resources while live updates are enabled
- **THEN** collections wait, terminal input is visibly blocked, the clock remains independent, and
  the selected live schedule can resume after the test releases ownership

#### Scenario: Late reply after reconnect

- **WHEN** an earlier run replies after the device connection is replaced
- **THEN** the reply cannot update the new run or cause an operation on the new device

#### Scenario: Reset while testing

- **WHEN** session reset is requested during an active run
- **THEN** it waits for explicit cancellation/completion and cleanup before clearing test/diagnostic
  RAM

### Requirement: Honest results and cancellation

Each case SHALL record Pass, Fail, Blocked, Skipped, or Inconclusive with a reason, timestamps,
adapter version, resolved resources, parameters, observations, acceptance criteria, bounded raw
evidence, and cleanup outcome. Successful command execution alone SHALL NOT establish physical
hardware success. Cancellation SHALL stop scheduling new cases, terminate bounded app-owned test
work, attempt declared restoration, and identify unverified cleanup. An interrupted test SHALL NOT
receive Pass; unstarted cancelled cases SHALL be Skipped. Pending required feedback and non-pass
required cases SHALL prevent an overall passing verdict.

#### Scenario: Expected identity value differs

- **WHEN** a valid approved register read completes but the observed value fails its expected
  mask/value
- **THEN** the test is Fail with the observed value and acceptance criterion recorded

#### Scenario: Cancel a sequence

- **WHEN** Cancel is pressed during an active test
- **THEN** the current work stops through its bounded cancellation path, cleanup is recorded, and
  later cases do not execute

#### Scenario: SSH disconnect prevents cleanup confirmation

- **WHEN** the transport disappears before restoration can be verified
- **THEN** the run records unverified cleanup and an interrupted non-passing result

### Requirement: LED pattern adapter with physical verification

The initial LED adapter SHALL use a resolved kernel LED-class resource and validated bounded pattern
parameters. It SHALL capture original supported brightness/trigger settings and restore them after
completion, cancellation, or failure where reachable. It SHALL NOT bypass the LED driver by toggling
underlying GPIO. Successful actuation SHALL await explicit operator confirmation of the expected
visible behavior; absence of confirmation SHALL be Inconclusive. Confirmation SHALL be associated
with the specific run/case and recorded as operator evidence rather than automatic optical
measurement.

#### Scenario: Observe a correct pattern

- **WHEN** the LED sequence completes with verified restoration and the operator confirms its
  expected behavior
- **THEN** the case is Pass with both execution and operator evidence

#### Scenario: Brightness writes succeed without observation

- **WHEN** pattern writes complete but no physical feedback is provided
- **THEN** the case remains Inconclusive and cannot make the sequence pass

### Requirement: UART fixture loopback adapter

The initial UART adapter SHALL operate only a uniquely resolved approved port with declared external
loopback wiring and validated baud, payload, and timeout settings. It SHALL compare received bytes
against transmitted bytes, record discrepancies, preserve/restore supported serial settings, and
close only its test-owned handle. Kernel-console ports and resources with known conflicting
ownership SHALL be blocked. Unsupported helpers or inability to verify required setup/restoration
SHALL be reported explicitly without installing tools or stealing resources.

#### Scenario: Loopback succeeds

- **WHEN** the prepared fixture returns the complete expected byte sequence within the timeout
- **THEN** the test records the byte comparison and restoration evidence before assigning its
  verdict

#### Scenario: Selected port is the device console

- **WHEN** runtime evidence identifies the resolved UART as an active kernel console
- **THEN** loopback is blocked before it changes settings or transmits bytes

### Requirement: Approved I2C identity adapter

The initial I2C adapter SHALL resolve a controller/mux path and target address and perform only an
explicitly configured approved byte-register identity read. The profile SHALL supply the register,
expected byte, comparison mask, required tool/access capabilities, and known transaction
constraints. The adapter SHALL NOT blindly scan buses, use force access, unbind drivers, infer
approved registers, or substitute write transactions. Unavailable/busy driver-owned access SHALL be
Blocked or Inconclusive with evidence rather than forced through another interface.

#### Scenario: Address is present but no protocol is approved

- **WHEN** inventory finds an I2C device without a validated test definition for its identity
  register
- **THEN** no transaction is executed solely because the address exists

#### Scenario: Adapter access is busy

- **WHEN** the approved access method cannot obtain the target resource
- **THEN** the test identifies the conflict and performs no forced access or driver rebinding

### Requirement: Clearly separate simulation

Simulation SHALL be controlled by an accessible On/Off switch. Simulated and connected sources SHALL
retain independent JSON, profiles, input modes, editor/control state, fixture readiness, selection,
notices and results. Source switching SHALL NOT carry simulation data into live testing, and SHALL
be disabled during active work, unconfirmed execution status or pending operator review. Connection
changes SHALL invalidate only connected state; fault changes SHALL invalidate only simulation.
Session reset SHALL clear both sources. The input buttons SHALL be labeled Setup and JSON, and the
page title SHALL be Manufactural tests. Diagnostic report controls SHALL be absent from Terminal and
Tests; dedicated test-report controls SHALL remain separate. The redundant Reports & evidence
navigation SHALL be removed.

#### Scenario: Leave simulation after editing JSON

- **WHEN** a user turns simulation off after editing its JSON or selecting controls
- **THEN** only the connected source's own state is shown, with no simulated JSON, readiness or
  results copied to it, and turning simulation on restores only simulation's own workspace

#### Scenario: Reconnect while simulation is selected

- **WHEN** a connected-device generation changes while the user views simulation
- **THEN** connected approvals/mappings are invalidated without changing simulated controls or data

#### Scenario: Backend execution cannot be confirmed

- **WHEN** execution may have started but both its response and recovery status read fail
- **THEN** source switching and new runs remain disabled until disconnection cancels backend work
  and invalidates the connected workspace

Users without hardware SHALL be able to exercise profile preparation, test sequences, verdicts,
operator feedback, cancellation, and reports with a built-in simulated board. Simulation SHALL
execute no hardware command and SHALL NOT borrow the current live connection. The workspace and
every exported document SHALL prominently identify simulated data. Simulated success SHALL NOT be
described as physical qualification of an adapter or board.

#### Scenario: Try the workflow without a device

- **WHEN** a disconnected user selects the simulated board and runs its sample sequence
- **THEN** the workflow is usable and both results and exported documents are visibly marked
  Simulated
