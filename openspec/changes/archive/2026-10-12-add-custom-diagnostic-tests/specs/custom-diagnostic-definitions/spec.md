# Spec Delta

## Purpose

Provide reviewed read-only diagnostic access methods that engineers can reuse in board profiles with typed inputs, explicit measurement semantics and reproducible evidence.

## ADDED Requirements

### Requirement: Reviewed read-only definition registry

The application SHALL own a versioned registry of driver ABI definitions and installed-command recipes. Each definition SHALL declare its supported resource/channel identity, access method, prerequisites, known read side effects, output type, units/conversion, parser version, execution limits and freshness capabilities. Definitions with unknown, destructive, clear-on-read or configuration-changing semantics SHALL be unavailable in this increment. Ordinary driver-managed acquisition effects SHALL be declared; the application SHALL NOT add configuration writes or control operations to obtain a reading. A profile SHALL reference a known definition ID/version/digest and supply only its validated typed parameters and criteria. Imported profiles/reports and operator review SHALL NOT create or authorize executable definitions, arbitrary file access, shell code or privileges. Extensions SHALL require application source review and validation of their declared support envelope.

#### Scenario: Profile supplies its own executable recipe

- **WHEN** an imported profile includes shell text, parser code, an executable path override or an unregistered definition
- **THEN** validation rejects it before discovery or execution and identifies the unsupported field or definition

#### Scenario: An unfamiliar driver exposes a readable attribute

- **WHEN** discovery finds a channel whose units or read semantics lack a reviewed definition
- **THEN** it shows unsupported evidence without generating a runnable measurement or inferring safety from file permissions

### Requirement: Installed-command recipes use constrained invocation

A command recipe SHALL constrain the executable's installed absolute identity, supported version, allowed subcommand and argument schema, fixed environment, resource binding, deterministic parser and permitted effects. Runtime parameters SHALL remain data arguments and SHALL NOT introduce option injection, shell evaluation, redirection, pipelines, interpreters, arbitrary scripts, network destinations or configuration/setup operations. The application SHALL verify executable identity and supported version during preparation and immediately before execution. Unsupported tools, changed identity, insufficient privileges or missing supervision prerequisites SHALL block the recipe without installation, sudo or fallback commands. Version probes SHALL themselves be reviewed, read-only and bounded.

#### Scenario: Executable changes after review

- **WHEN** the executable identity or supported version differs from the prepared recipe
- **THEN** execution is blocked and the user receives an explanation requiring fresh preparation

#### Scenario: Resource name resembles a command option

- **WHEN** a supplied target parameter cannot be encoded under the recipe's reviewed argument grammar
- **THEN** validation rejects it and sends no diagnostic command

### Requirement: Capability-based target prerequisite envelope

New driver readings and command recipes SHALL NOT require target Python, a particular Python version, Bash, GNU utilities, a compiler or a deployed helper. Python-free and Python-2-only targets SHALL be supported first-delivery cases when the required independent access/lifecycle capabilities are qualified. The application SHALL select reviewed capability profiles through bounded harmless probes, rather than infer support from command names, distribution, CPU architecture or Python presence. It SHALL display the exact missing capability separately for each access method.

Driver readings SHALL require only their qualified shell/read/framing, opened-resource identity, deadline, ownership and recovery capabilities. Command recipes SHALL additionally require their reviewed utility/version, argv/environment and executable-identity/pinning capabilities. Backend-owned parsers and exact conversion SHALL NOT depend on target JSON tooling or arithmetic width. Missing actual capabilities SHALL block affected methods without installation, escalation, automatic helper upload or a weaker unsafe fallback. Read-only/noexec staging filesystems SHALL NOT themselves block this unstaged execution path. Existing adapters SHALL retain their own prerequisites and SHALL NOT impose them on the new measurements. Software fixtures SHALL be distinguished from physical qualification; no universal Linux-board support SHALL be inferred.

#### Scenario: Target has no Python

- **WHEN** a Python-free target provides a qualified driver-read capability profile and a reviewed channel
- **THEN** the reading is available without invoking, installing or staging another runtime/helper

#### Scenario: Target has only Python 2

- **WHEN** a Python-2-only target otherwise satisfies the qualified capabilities
- **THEN** new measurements use the same runtime-independent path without invoking or upgrading Python

#### Scenario: Different Python 3 version is installed

- **WHEN** the target's Python 3 version or module set differs from other boards
- **THEN** new measurement availability depends on access/lifecycle capabilities rather than Python compatibility

#### Scenario: Recipe utility is absent

- **WHEN** driver-read prerequisites are satisfied but the reviewed ip utility or supported output format is missing
- **THEN** eligible driver readings remain available and that command recipe alone is Blocked

#### Scenario: BusyBox timeout behavior differs

- **WHEN** installed timeout flags or process-group behavior do not match a qualified profile
- **THEN** the application uses another independently qualified deadline/ownership profile or blocks the affected method without issuing guessed GNU-style flags

#### Scenario: Target offers no executable upload location

- **WHEN** temporary storage is noexec or the target root is read-only but the installed execution capabilities are qualified
- **THEN** the unstaged measurement path remains available and no remount, upload or permission change is attempted

#### Scenario: Required ownership evidence is inaccessible

- **WHEN** the selected profile cannot prove opened-resource identity or bounded owned-process recovery
- **THEN** affected measurements remain Blocked with the specific missing capability, regardless of Python presence

### Requirement: Deterministic structured observation

Definitions SHALL produce bounded typed observations and strict parsing rules for their supported output versions. Scalar observations SHALL distinguish numeric values with explicit engineering units, booleans, and enums from a registered finite vocabulary. Criteria SHALL match the observation type; implicit cross-type coercion and string truthiness SHALL be rejected. Carrier state SHALL be a boolean decoded by its registered parser, rather than an untyped numeric measurement. Numeric values SHALL be finite and preserve exact integer/decimal input where floating-point conversion would lose acceptance-relevant precision. Missing, duplicate, malformed, unsupported or truncated required output SHALL NOT yield Pass. The parser SHALL NOT search arbitrary text for a convenient number, execute output, or silently substitute a value, unit, scale or source. Adding a definition for another hardware domain SHALL reuse this contract and SHALL NOT imply functional qualification of every resource in that domain.

#### Scenario: Command exits successfully with malformed output

- **WHEN** a recipe returns exit code zero but its required metric is missing, duplicated or outside the parser's supported format
- **THEN** the case is non-passing with the parse limitation and bounded raw evidence preserved
