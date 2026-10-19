# Design

## Context

See `proposal.md` for motivation and scope. The app has a shared React workspace, an isolated
Electron preload bridge, and an authenticated HTTPS gateway. `SshSession` executes 36 fixed
read-only probes, with a separate PTY and independent clock queries. Desktop uses `DeviceMonitor`
around that session; the gateway owns sessions directly. `useDeviceSession` coordinates collections,
resets, updates, connection generations, and diagnostic JSON import/export. There is no
functional-test state model, board profile resolver, or printable report renderer.

`shared/report.ts` normalizes diagnostic snapshots, and native export uses the backend's last
snapshot. Preserve that authority pattern for test runs, without adding test transcripts to the
existing snapshot or update-backup schemas. Relevant durable clock and terminal specs have been
read; their existing lifecycle, output isolation, and independent clock behavior remain constraints.

This change is cross-cutting, adds data models and privileged operations, and needs this design.

## Goals / Non-Goals

**Goals:**

- Reuse domain logic across board revisions through validated logical mappings and parameters.
- Ground every active operation in current connected-device evidence and declared prerequisites.
- Separate preparation, execution, physical feedback, and verdict assignment.
- Support an engineering bench workflow plus saved ordered sequences using the same runner.
- Produce clean offline documents from canonical test evidence without changing its interpretation.

**Non-Goals:**

- Infer a complete manufacturing acceptance specification from device tree.
- Qualify electrical behavior or signal integrity without appropriate external measurement.
- Provide arbitrary script execution, dynamic executable plugins, automatic package installation,
  persistent device agents, production-line databases, or multi-device fixture orchestration.
- Implement disruptive network/reset/watchdog tests or the other later functional adapters in this
  first increment. Inventory and explicit extension points prepare for those additions.
- Add automatic reconnection, credentials persistence, release/deployment work, or remote report
  upload.

## Decisions

The connected and simulated sources own separate persistent React workspace instances. JSON,
profile, input mode, editor visibility, readiness, selection, notices and run evidence never migrate
between them. Source switching is unavailable while work or operator review is pending. A lost start
reply followed by an unreachable run-status check retains the source lock until disconnection, so
unresolved device work cannot release its activity lease through simulation. Connection generation
changes invalidate only the connected workspace; simulation fault changes invalidate only the
simulated runner. Session reset clears both sources. A keyed page resets transient copy/menu
feedback when the source changes. Simulation uses a dedicated local transport and an accessible
On/Off switch. Input labels are Setup and JSON; the page title is Manufactural tests as requested.

Reports & evidence is removed from navigation and the view model. Diagnostic import/export remains
available on Overview, Diagnostics and diagnostic categories, and is absent on Terminal and Tests.
The Tests workspace retains explicitly named test-report import/export as separate evidence.

### 1. Three independent inputs produce a resolved plan

```text
Running device tree + runtime inventory -----+
                                            |
Versioned board profile --------------------+--> Resolver --> Reviewed plan
                                            |                    |
Adapter capability registry ----------------+                    v
                                                               Runner
                                                                 |
                                                                 v
                                                   Evidence + verdict + cleanup
```

Add shared modules under `shared/testing/` for inventory, profile validation, resolution, adapter
contracts, run evidence, simulation, and document formatting. Add execution/discovery modules under
`backend/testing/`. Keep device-specific executable templates backend-owned.

The live tree is primary hardware-description evidence. Runtime sysfs links, device nodes, installed
tools, driver binding, and topology resolve its relationship to usable Linux resources. Reading an
uploaded DTS and assuming it matches the live system was considered and rejected for the initial
path. Uploaded source/compiled-tree comparison can be a later capability.

Capture only bounded selected hardware-description properties and relevant runtime metadata, not an
unrestricted filesystem dump. Decode binary cells, strings, phandles, and binding/provider cell
counts deliberately; do not parse all DT values as strings or assume node-name conventions establish
device type. Keep unknown bindings as raw observed evidence without inventing semantics. Non-DT
devices remain discoverable through runtime evidence.

Device tree describes hardware relationships, while dynamically enumerated PCI endpoints can be
outside it. This supports the combined resolver rather than a DT-only runner.
[Devicetree specification](https://devicetree-specification.readthedocs.io/en/stable/devicetree-basics.html)

### 2. Profiles are declarative, versioned, and locally portable

A normalized profile contains:

- `schemaVersion`, `id`, `revision`, human-readable name/description, and declared board revision;
- match criteria using observed model/compatible identity, with an explicit reviewed manual-mapping
  path for boards lacking sufficient identity;
- logical resources with typed selectors, required/optional status, and expected observed identity;
- test IDs, adapter IDs, logical resource references, bounded typed parameters, expected values,
  fixture requirements, and adapter-defined effects/restoration;
- named ordered sequences referencing test IDs, including a continue/stop-on-failure choice.

Use a strict, dependency-light validator at every import and privileged operation, returning
field-specific errors and normalized allowlisted data. Accept no arbitrary command fields or
executable templates. Associate a normalized profile digest with a reviewed plan and report. Resolve
aliases/topology against live resources and refuse ambiguous matches; the user does not edit
compiled commands. Pin inventory/profile digests to the connection generation and refresh preflight
evidence before execution.

Start with a guided editor for the initial adapters and logical mappings, with advanced JSON
editing, import/export, and a generated draft. Draft generation fills only observed mappings and
marks unknown test intent as incomplete. Provide a documented sample profile and schema examples
outside the short README. No local storage of credentials or automatic profile/report persistence.

The guided workspace stacks full-width discovery, profile, and review sections. Complete discovery
is required before later sections appear and regenerates the editable draft automatically. The
simulation source supplies its inventory directly and exposes no discovery action. Advanced JSON
editing sits above guided fields, synchronizes valid edits, and reuses animated clipboard feedback.
Required invalid inputs use red borders, accessible invalid state, and field-specific explanations.

An alternative direct JSON workspace accepts either a standard profile or a strict request
containing `profile`, an optional `sequence` or `testIds`, and optional fixture
readiness/identities. Run is the single execution action: it discovers, prepares, records the
engineer's prepared-fixture readiness, and starts through the existing validated transport without
intermediate agreement dialogs. Unknown intent and malformed input are rejected before discovery;
device/tool prerequisites still yield Blocked evidence through the existing controller. Direct runs
automatically finalize pending LED feedback as unobserved (Inconclusive), never invent physical
observations, and require no follow-up prompt before another run or report export. Reports remain
available in memory until explicit export.

Hard limits initially target a 128 KiB profile, 64 resources, 64 tests, and 16 sequences. Bound
individual strings, selector shapes, list lengths, and parameter ranges as well as the file size.
Discovery output is capped at 2 MiB with finite node/property counts; incomplete captures retain an
explicit incomplete flag and cannot establish absence. Revisit a limit only with a documented board
case, not by disabling validation.

I2C numbering can change with aliases and mux topology. Resolve the controller/node, mux chain, and
address through sysfs evidence rather than treating a bus number as portable identity.
[Linux I2C sysfs](https://docs.kernel.org/i2c/i2c-sysfs.html)

### 3. A small adapter registry defines repeatable tests

Each built-in adapter defines a version, parameter validation, required capabilities, resource
selection rules, effects, evidence interpretation, timeout, and cleanup contract. The backend
registry owns command construction; shell data is safely quoted and numeric/enumerated inputs are
validated before interpolation. The UI receives capabilities and readable plans, not an exec API.

Initial adapters:

- **LED pattern:** Use the actual resolved LED-class directory and its supported brightness range.
  Capture brightness and active trigger, reject unsupported original state, temporarily select a
  supported manual trigger, execute a bounded pattern, and restore/verify both settings. Use
  trap/finally cleanup and an independently bounded remote job. Physical result starts as
  Inconclusive until the operator records Yes/No/Not observed for the expected pattern; operator
  evidence never overrides execution or cleanup failures. Release hardware ownership after cleanup
  even if review is pending. Use the LED subsystem rather than underlying GPIO access.
  [GPIO subsystem guidance](https://docs.kernel.org/userspace-api/gpio/chardev.html),
  [LED class interface](https://docs.kernel.org/leds/leds-class.html).
- **UART loopback:** Require a declared external loopback fixture and an approved uniquely resolved
  port. Detect active kernel consoles from runtime evidence and reject them. Initially use an
  already-installed Python 3 helper employing serial settings, nonblocking bounded I/O, and
  supported exclusive-open facilities; absence of that capability blocks this case without
  installing it. Validate supported baud values and a bounded payload, compare exact bytes, and
  restore captured termios settings in cleanup. Do not treat advisory/app locking as ownership over
  other clients. Other installed serial helpers can be qualified as future alternatives.
- **I2C identity:** Require an explicit approved byte-register read, expected byte, comparison mask,
  address, and supported `i2cget` access. Do not use `-f`, broad scanning, driver unbinding, guessed
  register maps, or alternate arbitrary writes. The approved read protocol can include the command
  byte/register-address transfer required by that device; it is not a general write interface.
  Driver-owned/busy/unsupported access is explicit non-pass evidence.

Register future domains as discovered-but-not-implemented coverage, not runnable dummy tests. Do not
introduce a mandatory Python/pytest/labgrid stack for the portable app. External fixture integration
can be added behind a later adapter contract.

### 4. Backend-owned run state coordinates existing work

Add a testing controller owned by each `SshSession`, surfaced by `DeviceMonitor`. It retains bounded
inventory and the latest run in memory. It supports discover, prepare, start, read status/result,
cancel, and record operator feedback. A backend run ID and connection generation own every request;
the renderer cannot supply measurements or assign a live verdict.

Expose narrow equivalent operations through the trusted desktop IPC and authenticated session routes
under `/api/sessions/:id/tests`. Preserve existing request-body limits and add stricter test schema
limits, finite polling/rate limits, no-store responses, session-scoped run IDs, and backend resource
ownership. Do not encode credentials in URLs. Return a run ID promptly and poll bounded progress; do
not hold a single HTTP request open for an entire sequence. A lost start response can recover the
session's current run through status, without creating a duplicate.

Execute cases serially in the first version. Before acquiring the test lock, finish or reject an
already-running collection explicitly; no test races a probe. Add a temporary activity lock to
`useDeviceSession` so periodic/manual collections, reset, connect/import, and update controls
coordinate with the run without overwriting the user's live preference. Backend checks enforce the
same restriction independently of UI disabling. Cancellation remains available throughout.

During active hardware work, block new terminal writes at both UI and backend input boundaries and
discard app-queued input. Keep PTY output/resize/acknowledgment processing working, preserve the
shell, and do not replay input when releasing the block. Existing remote jobs cannot be stopped by
disabling input; show this limitation during plan preparation. Clock reads remain independent and
allowed.

Case execution has a maximum 60-second budget, 64 KiB combined stdout/stderr, and a bounded cleanup
grace. Entire sequences have a 10-minute budget and 4 MiB aggregate case evidence cap. Resource and
process handles belong to the run. Remote helpers must be self-bounded and restore resources on
normal termination; cancellation requests graceful termination and waits for cleanup evidence before
closing channels. If cancellation/transport loss prevents verified cleanup, record that uncertainty
and block resource reuse until the bounded job is known to have ended or fresh recovery is reviewed.
Never interpret a closed SSH channel as proof that all remote processes stopped.

Disconnect/replacement/expiry/shutdown cancels scheduling and rejects late updates. Preserve the
last received report as interrupted historical evidence in the renderer, without allowing stale IDs
to operate a replacement target. Reset clears completed local test state only after active work and
cleanup finish. A pending operator review is retained until confirmed or explicitly dismissed before
replacing the latest run.

### 5. Execution state and verdict are different fields

Represent run phases such as preparing/running/cleaning/review/complete/cancelled independently of
case verdicts. Pass requires all defined observations and verified required cleanup. Fail means
obtained evidence contradicts acceptance; Blocked means a prerequisite prevented execution; Skipped
means intentionally unexecuted; Inconclusive means evidence or cleanup cannot establish the outcome.
Record reason codes and human-readable detail, not just a colored badge.

An overall pass requires every selected required case to pass; a failed required case fails the run,
and missing/blocked/skipped/unverified required evidence prevents a passing outcome. Operator
feedback is a separate case-owned event with a timestamp/source. Recompute summaries from normalized
case evidence on import rather than trusting caller-provided totals. Truncated evidence remains
marked and cannot satisfy an evidence-dependent comparison.

Provide a built-in simulated inventory/profile/runner that exercises these states without any device
transport. Keep Simulated labels in the workspace and every document. Software fixtures and
simulation validate the implementation path, not physical board performance.

### 6. Optional documents share one canonical report model

Add a separately versioned test-report format and validators, without extending diagnostic snapshot
imports implicitly. A report is frozen from backend-owned run evidence, or normalized historical
import data, with a 16 MiB import/export bound. Record declared versus observed board metadata,
profile digest/content, inventory provenance, fixture readiness/identity, case
parameters/thresholds, adapter versions, bounded evidence, timestamps, feedback, cleanup, and
interruption state. Timestamp labels distinguish report/run capture times from device system time.
Omit secrets, PTY transcripts, and transient header-clock values.

Build escaped self-contained HTML from this canonical model using a paper-first style: white
background, restrained green/teal accent, dark readable text, system fonts, textual verdict badges,
compact metadata, summary counts, expected/observed tables, case detail, and a raw-evidence
appendix. Keep animations and workspace chrome outside documents. Use print margins, repeated table
headings, wrapping, and page-break rules that allow long evidence to span pages without clipping. Do
not load web fonts or external assets. Rendering must not mutate the run or reclassify a verdict.

Desktop export adds a format selector and a native save action. Main selects its canonical live run
or validates imported data, then creates a temporary sandboxed report view with no preload/Node
access, no remote requests, no script execution, and no navigation/window privileges. Render the
same HTML and use Electron `webContents.printToPDF`; enforce a render timeout and destroy the
temporary view in every exit path. Save only the generated document chosen by the user.
[Electron PDF API](https://www.electronjs.org/docs/latest/api/web-contents#contentsprinttopdfoptions).

Website export downloads self-contained HTML/JSON and offers a dedicated in-app print-ready preview
with an explicit Print / Save PDF action. Use browser printing and clearly explain the user chooses
Save as PDF in their browser; do not pretend this is an automatic native PDF download. This avoids
another PDF library/server dependency and keeps pagination aligned with the HTML view.
[Browser print API](https://developer.mozilla.org/en-US/docs/Web/API/Window/print).

Reports remain local and on-demand. Preserve the existing diagnostic export controls and add clearly
named test-report controls rather than changing the meaning of Export diagnostic report. A report
render/save failure leaves JSON evidence available.

## Risks / Trade-offs

- Incomplete DT bindings or runtime permissions -> retain provenance/incomplete flags and require
  explicit reviewed mappings; never infer physical success from node presence.
- Resource names change or match multiple devices -> resolve from current topology/identity and
  block ambiguous or stale bindings before execution.
- Driver ownership and other clients -> prefer subsystem APIs, detect known conflicts, use supported
  exclusive access, and document the app's limited coordination scope.
- Transport loss during state-changing work -> bounded self-cleaning helpers, explicit cleanup
  evidence, conservative non-pass outcomes, and resource recovery before reuse.
- Minimal firmware lacks tools -> per-adapter capability checks and actionable Blocked states; a
  test platform can be useful without claiming every board supports every adapter.
- Operator-verified LEDs are not unattended optical qualification -> distinguish manual feedback in
  results and leave a future fixture adapter extension point.
- Manufacturing requires serial scanning, fixture calibration and unattended reboot recovery -> this
  increment supplies reusable profiles/sequences/reports but does not claim a complete production
  line.
- Browser Save as PDF depends on print UI -> label the workflow clearly and retain native PDF
  desktop export plus universally downloadable HTML/JSON.
- Long/malformed output can break documents -> normalize bounded data, escape all text, disallow
  external resources, and qualify multipage/Unicode/markup cases visually.

## Migration Plan

1. Add shared contracts and backend testing alongside existing diagnostics; preserve current report
   schemas and transport calls.
2. Expose optional testing capabilities, with an unavailable state for older bridges/gateways.
3. Add Tests, simulation, profile preparation, execution coordination, and separate report controls.
4. Qualify software paths and report rendering before documenting physical coverage. Record any
   unavailable real boards/fixtures as unqualified rather than replacing them with simulated passes.
5. Keep planning local and leave delivery/version/tag/push decisions to a later explicit request.

Rollback removes the additive workspace/transport operations while retaining previously exported
standalone documents. No device agent, persistent target configuration migration, or report upload
must be undone. Active runs must finish/cancel and record cleanup before shutting down either
version.
