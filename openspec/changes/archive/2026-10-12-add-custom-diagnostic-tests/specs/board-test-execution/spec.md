# Spec Delta

## ADDED Requirements

### Requirement: Driver-owned read-only measurements

The application SHALL support reviewed scalar hwmon, thermal and IIO reads and explicitly registered driver ABI reads within their declared support envelopes, including network carrier, block-device capacity and USB connection-speed snapshots. Descriptor and command-recipe contracts SHALL be interface-neutral; domain classification alone SHALL NOT imply implemented or qualified diagnostic coverage. These snapshots SHALL NOT claim traffic throughput, storage integrity or successful USB transfers. It SHALL read only allowlisted attributes of the current resolved resource and SHALL preserve driver ownership. A bound driver, busy resource or unsupported interface SHALL NOT trigger raw bus access, force flags, scanning, unbinding, driver changes, enabling channels, calibration writes, buffer/trigger setup or alternative transactions. Raw access to the same driver-owned target SHALL remain blocked, including when selected through another logical alias. Absent, disabled, unreadable or unsupported channels SHALL remain explicit non-passing evidence.

#### Scenario: Bound I2C sensor exposes a supported hwmon channel

- **WHEN** the selected sensor is driver-owned and has a reviewed readable hwmon channel
- **THEN** the measurement uses that driver interface and performs no raw I2C transaction

#### Scenario: IIO direct read conflicts with existing buffer use

- **WHEN** the driver refuses the scalar read because another consumer owns its current mode
- **THEN** the test reports the conflict without changing buffer state or stealing access


#### Scenario: Non-I2C snapshot is selected

- **WHEN** a supported current block or USB resource is selected for its registered capacity or connection-speed observation
- **THEN** the same typed preparation, criteria, lifecycle and evidence rules apply without raw storage I/O, USB reset or throughput claims

### Requirement: Unit-aware measurements and freshness

Each observation SHALL retain raw value, ABI/driver unit, reviewed conversion and final engineering value/unit. Conversion SHALL distinguish processed values from raw-plus-scale/offset and SHALL NOT double-apply calibration or assume missing scale/offset. Criteria SHALL compare unrounded finite values in compatible units with explicit boundary semantics. Observation time/duration SHALL be distinguished from source sample time, cached update interval and unknown freshness; unchanged values SHALL NOT alone prove staleness. Proven source-age policy violations or missing runtime freshness evidence SHALL be Inconclusive. A recent-observation policy SHALL assess only the recorded read and SHALL NOT claim known physical sample age. Invalid units, faulted/untrustworthy data or incomplete sampling SHALL NOT pass.

#### Scenario: IIO processed temperature is selected

- **WHEN** the reviewed channel exposes an already processed value
- **THEN** the application applies only its declared unit conversion and records that scale/offset were not applied again

#### Scenario: Physical sample timestamp is unavailable at runtime

- **WHEN** a source-age requirement was prepared but the actual observation lacks reliable age evidence
- **THEN** the case is Inconclusive even when its numerical value falls within range

#### Scenario: Value equals an exclusive range boundary

- **WHEN** a complete trustworthy observation equals a declared exclusive upper limit
- **THEN** the comparison fails using the unrounded value and the report identifies the boundary

### Requirement: Bounded acquisition and confirmed termination

New measurement cases SHALL have at most 32 samples, a default 5-second acquisition deadline, at most 25 seconds of acquisition and at most 5 seconds for termination confirmation. Repeated sampling SHALL use a validated interval of 100 to 1000 milliseconds and fit the acquisition deadline. Per-case raw evidence SHALL remain within 64 KiB, command output within 32 KiB, retained run evidence within 4 MiB and exported reports within 16 MiB; the existing 10-minute run ceiling SHALL include measurement work and termination. Cancellation, disconnect, output overflow and deadline expiry SHALL stop further scheduling and terminate only app-owned work under a qualified anchored-ownership/deadline profile. A bounded start handshake SHALL record nonce/boot/start/group ownership durably before a GO acknowledgement permits acquisition. Driver samples SHALL be individually bounded at at most 5 seconds and scheduled by the backend; cancellation SHALL prevent another sample and record the actual bounded wait/termination outcome. Process-group identity SHALL remain anchored while signaling; a stale numeric PID or read-then-kill identity check SHALL NOT authorize signaling. Target Python SHALL NOT be required for these lifecycle guarantees. Closing an SSH channel SHALL NOT count as proof of remote termination. Unconfirmed termination SHALL record unverified cleanup, prevent Pass and block subsequent app test work pending verified recovery; reconnect alone SHALL NOT manufacture recovery proof.

#### Scenario: Recipe exceeds output allowance

- **WHEN** a command exceeds its output budget
- **THEN** acquisition stops, truncation/termination evidence is recorded and the case cannot pass

#### Scenario: Cancellation acknowledgement is lost

- **WHEN** the transport disappears before app-owned process termination is confirmed
- **THEN** the run records unverified termination and subsequent test work remains unavailable until recovery is verified

#### Scenario: Supervisor ownership is not acknowledged

- **WHEN** the target start handshake fails or its ownership record cannot be durably committed
- **THEN** no GO is sent, no driver reading or recipe starts, and bounded startup cleanup/recovery remains explicit

#### Scenario: SSH signal is unsupported

- **WHEN** the server does not deliver the required cancellation signal
- **THEN** only an independently qualified control/deadline path can admit the operation, and SSH channel closure alone cannot produce a passing lifecycle result

### Requirement: Recovery survives application restart

The owning backend SHALL durably record bounded non-secret intent before dispatching new live driver/command measurements and record completion only after verified termination. Persistence failure SHALL block dispatch. Unresolved measurement ownership SHALL gate all affected functional tests, including legacy adapters. Startup and reconnect SHALL reconcile unresolved work using current target/boot and app-owned job/start identity before enabling affected tests. Missing, corrupt or incomplete recovery state SHALL NOT prove resource release; insufficient supported process visibility SHALL keep affected work Blocked. Reset/import/restart SHALL NOT discard unresolved ownership. Reconciliation SHALL NOT signal another client's or an unidentified process. Recovery metadata SHALL exclude report contents, observations and credentials; reports SHALL remain explicit-export only.

#### Scenario: Backend crashes after dispatch

- **WHEN** a backend restarts while its last dispatched operation lacks confirmed termination
- **THEN** durable intent keeps affected tests Blocked until supported reconciliation verifies recovery, and no new run silently replaces that work

#### Scenario: Recovery ledger cannot be read

- **WHEN** startup cannot trust the local ledger or perform complete safe reconciliation
- **THEN** live tests for the affected target remain Blocked with a recovery explanation and no force-run acknowledgement substitutes for evidence

### Requirement: Common verdicts and isolated simulation

Pass SHALL require complete trusted observations satisfying every declared criterion, freshness policy and verified execution lifecycle. A valid trustworthy mismatch SHALL be Fail; unavailable prerequisites/identity/conflicting access SHALL be Blocked; interrupted, malformed or insufficient observations SHALL be Inconclusive; unstarted cancelled cases SHALL be Skipped. Exit code zero SHALL NOT establish measurement success. Simulation SHALL exercise the same definition/criteria/verdict contracts with clearly labeled synthetic observations and fault cases, without invoking live discovery, files or commands. Existing session ownership, terminal/collection coordination, gateway/native authorization and source separation SHALL apply equally to new measurements.

#### Scenario: Read succeeds outside the requested voltage range

- **WHEN** a trustworthy completed measurement produces a voltage outside its validated range
- **THEN** the case is Fail despite successful command execution

#### Scenario: Simulated command recipe passes

- **WHEN** a synthetic recipe fixture satisfies its declared criteria
- **THEN** the result is visibly simulated and provides no physical hardware qualification

### Requirement: Connected-device runtime independence

All application-owned connected-device collection, clock, terminal integration, discovery/preflight and test execution SHALL operate without invoking target Python/python3. Existing UART loopback SHALL remain implemented with a verified native access method preserving console/resource checks, kernel exclusive access, nonblocking/no-controlling-terminal opening, exact byte comparison, queue flush, bounded cancellation and verified serial restoration/owned-handle closure. The application SHALL NOT hide, globally disable or defer an existing feature as a substitute for dependency removal. Missing genuine native capabilities SHALL identify the affected method without automatic installation, upload, escalation or weaker locking. Python-free and Python-2-only executable fixtures SHALL verify the complete remote path; Python-3 presence SHALL NOT mask an invocation. Host test/build runtimes and explicit user terminal commands SHALL NOT be confused with implicit target requirements.

#### Scenario: Python-free connected target uses existing workflows

- **WHEN** a target has qualified native access capabilities and no Python interpreter
- **THEN** collection, clock, discovery and existing adapters including UART perform their preserved functions without any application-owned Python invocation

#### Scenario: Existing UART replacement lacks kernel exclusivity

- **WHEN** a candidate native serial method only offers advisory locking or cannot verify restoration
- **THEN** it is not accepted as removal completion, and custom implementation remains gated on a method that preserves the existing contract

#### Scenario: Python 3 could conceal a residual dependency

- **WHEN** software/SSH tests run with Python commands poisoned or execution-traced across absent, Python-2-only and Python-3-present profiles
- **THEN** any app-owned interpreter call fails prerequisite acceptance rather than being ignored because a capable Python happens to exist

## MODIFIED Requirements

### Requirement: UART fixture loopback adapter

The UART adapter SHALL use a qualified Python-free native access method and operate only a uniquely resolved approved port with declared external
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


#### Scenario: Native serial prerequisites are unavailable

- **WHEN** a connected target lacks a qualified kernel-exclusive native serial access method
- **THEN** UART remains visible with the exact missing capability and no runtime/helper is installed, while its removal task remains incomplete until executable preservation proof is recorded
