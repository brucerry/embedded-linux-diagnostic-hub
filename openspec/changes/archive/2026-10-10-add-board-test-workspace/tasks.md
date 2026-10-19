# Tasks

## 9. Separate test sources and focused navigation

- [x] 9.1 Isolate connected and simulated workspace state, including JSON, modes, editor controls,
      readiness, selections, notices and results; reject late replies and cross-source operations.
- [x] 9.2 Replace source buttons with an accessible simulation switch, shorten input labels to
      Setup/JSON, and use the requested Manufactural tests page title.
- [x] 9.3 Remove Reports & evidence navigation and its obsolete page, and expose diagnostic import/
      export controls only on diagnostic pages while retaining distinct test-report controls.
- [x] 9.4 Qualify repeated source toggles, active/review/unconfirmed/reset/reconnect behavior,
      navigation and diagnostic/test report boundaries; rebuild desktop/web and recycle generated
      test artifacts.

## 8. Workspace refinements and direct JSON runs

- [x] 8.1 Stack setup sections at full width, gate later sections on complete discovery,
      automatically regenerate the editable draft after discovery, and remove discovery controls in
      simulation.
- [x] 8.2 Move the synchronized advanced JSON editor above guided fields, reuse animated copy
      controls, and mark all invalid required fields with accessible red borders and errors.
- [x] 8.3 Add a paste-and-run JSON mode with automatic preparation, no intermediate agreements,
      existing execution safeguards, cancellation/recovery, and final inconclusive unobserved LEDs.
- [x] 8.4 Add report export icons, document runnable JSON examples, qualify guided/direct flows and
      responsive layouts, rebuild desktop/web, and recycle task-created caches and screenshots.

## 1. Shared profiles and plans

- [x] 1.1 Add bounded inventory, resource, profile, adapter, plan, case, and run contracts under
      `shared/testing/`; verify typecheck and contract fixtures distinguish execution state,
      verdict, provenance, and incomplete evidence.
- [x] 1.2 Implement strict normalized profile validation and stable profile digests; verify tests
      reject oversized files, unsupported schemas/adapters, duplicate IDs, invalid references,
      unsafe parameters, arbitrary command fields, and credential fields.
- [x] 1.3 Implement board matching and runtime resource resolution using DT/sysfs identity and
      topology; verify changed I2C numbering resolves correctly and mismatched boards, ambiguous
      resources, incomplete evidence, and stale generations block active operations.
- [x] 1.4 Implement draft generation, prerequisite/effect descriptions, and documented sample
      profiles; verify drafts preserve observed mappings while unknown registers, limits, fixtures,
      and future adapters remain non-runnable until completed.

## 2. Discovery and reusable execution

- [x] 2.1 Implement bounded read-only live DT/runtime/tool discovery under `backend/testing/`;
      verify fixtures for binary DT properties, aliases/phandles, I2C muxes, non-DT enumeration,
      permission failures, disabled/unbound nodes, and truncated captures, with no hardware writes
      or scans.
- [x] 2.2 Implement backend-owned typed command construction and bounded remote-job
      execution/cancellation; verify quoting, time/output limits, graceful termination, channel
      cleanup, unverified remote cleanup, and no arbitrary exec or public filesystem-root override.
- [x] 2.3 Implement a session-owned single-run controller, serial sequences, progress/result reads,
      run IDs, operator feedback, verdict summaries, and finite retained state; verify duplicate
      runs, missing prerequisites, stop/continue policy, budgets, cancellation, and invalid/stale
      feedback ownership.
- [x] 2.4 Implement the LED pattern adapter through the LED class interface; verify original
      brightness/trigger capture and restoration on success/failure/cancel, supported bounds, and
      Inconclusive/Pass/Fail operator feedback without inferred optical success.
- [x] 2.5 Implement approved UART fixture loopback with detected installed Python 3 capability;
      verify console/conflict rejection, supported baud/payload validation, exact receive
      comparison, bounded I/O, termios restoration, and explicit missing-helper outcomes.
- [x] 2.6 Implement approved byte-register I2C identity checks; verify
      topology/address/register/mask validation, matching/mismatching observations, missing/busy
      access outcomes, and absence of blind scans, force flags, arbitrary writes, or driver
      rebinding.

## 3. Desktop and gateway transport

- [x] 3.1 Surface testing through `DeviceMonitor`, the optional `DesktopBridge` contract, trusted
      main-process IPC, and preload; verify unauthorized frames and malformed requests are rejected
      before remote operations and native live results remain backend-owned.
- [x] 3.2 Add authenticated session-scoped gateway testing routes with bounded requests,
      polling/rate limits, no-store responses, and lifecycle cleanup; verify
      token/origin/host/session/run ownership, duplicate starts, expiry, lost-start recovery, and
      shutdown behavior.
- [x] 3.3 Add validated `GatewayClient` testing operations and capability detection; verify bounded
      requests, current-session response ownership, cancellation, and older-gateway unavailable
      behavior without breaking existing clock/terminal/diagnostic operations.

## 4. Existing session coordination

- [x] 4.1 Add a temporary testing activity lock to the session hook and backend; verify live/manual
      collection coordination, already-running collection behavior, preserved live preferences,
      independent clock reads, and resumed scheduling after resource release.
- [x] 4.2 Block new terminal input during active testing at renderer and privileged input boundaries
      while preserving PTY output/resize/acknowledgments; verify pending input is discarded and
      neither test output nor resumed queued commands enter the terminal.
- [x] 4.3 Coordinate disconnect, target replacement, report import, reset, updates, page/app exit,
      and late responses with test cleanup; verify incomplete runs remain explicitly interrupted
      historical evidence and stale run IDs cannot affect replacement devices.

## 5. Tests workspace

- [x] 5.1 Add responsive Tests navigation and a guided board-profile/resource/parameter editor with
      advanced JSON and local import/export; verify keyboard operation, validation feedback, source
      labels, page persistence, and the shared header clock at desktop/mobile widths.
- [x] 5.2 Add resolved-plan review, fixture readiness/identity, individual/sequence selection,
      progress, cancellation, operator review, and expected-versus-observed result details; verify
      missing prerequisites prevent the affected operation and every verdict is readable without
      color alone.
- [x] 5.3 Add a disconnected built-in simulation exercising the sample profile, all verdicts,
      cancellation, cleanup, and operator feedback; verify no device transport is called and
      simulated state is separate from any live connection.
- [x] 5.4 Add separate test-report selection/import and historical viewing; verify malformed imports
      preserve current evidence, imported reports do not become live targets, and existing
      diagnostic import/export keeps its meaning.

## 6. Optional report documents

- [x] 6.1 Add canonical versioned test-report creation/import validation with observed/declared
      metadata, profile digest/content, fixture/operator evidence, parameters, criteria, cleanup,
      and interruption details; verify normalized verdict summaries, round-trip fidelity, 16 MiB
      bounds, and secret/PTY/header-clock exclusion.
- [x] 6.2 Implement escaped self-contained HTML reports with restrained typography, summary counts,
      metadata, expected/observed tables, source labels, case detail, and a raw-evidence appendix;
      verify markup/Unicode/long lines render as text and documents load no external resources.
- [x] 6.3 Implement trusted native JSON/HTML/PDF exports using backend-owned runs or normalized
      imported/simulated data and a temporary sandboxed Electron print renderer; verify saved PDF
      content, cancellation/failure/timeouts, view cleanup, and preserved evidence without
      Node/preload/network privileges.
- [x] 6.4 Implement website HTML/JSON downloads and explicit print-ready preview/Save as PDF
      controls; verify print-only layout, truthful save messaging, matching report content, and no
      cloud calls or automatic report persistence.

## 7. Integration, visual qualification, and documentation

- [x] 7.1 Run adversarial profile/report/transport tests spanning the contracts and privileged
      boundaries; verify shell/HTML injection attempts, stale IDs, forged verdicts, excessive
      output, missing permissions, and malformed device data cannot produce unauthorized operations
      or false passes.
- [x] 7.2 Qualify independent SSH execution through desktop/gateway software fixtures, including
      UART byte comparison, LED restoration, I2C mismatch, cancellation, and transport loss; record
      these as software-path validation and document unavailable real boards/fixtures as physically
      unqualified.
- [x] 7.3 Run browser integration coverage for preparation, page changes during runs, five-second
      collection coordination, terminal/clock isolation, simulation, operator review, imports,
      cancellation, reset, and historical exports; verify desktop/mobile accessibility and existing
      workspace behaviors.
- [x] 7.4 Generate representative native PDFs and website print layouts for mixed verdicts, pending
      feedback, simulation, long metadata, Unicode/markup, and multipage raw evidence;
      render/inspect all pages and verify legibility, pagination, no clipping/overlap, and content
      parity with canonical JSON.
- [x] 7.5 Run format, typecheck, unit tests, relevant browser/native smoke suites,
      desktop/web/gateway builds, and applicable portability checks; verify required checks pass or
      report concrete environment limitations without claiming unexecuted checks passed.
- [x] 7.6 Add concise README links plus dedicated testing/profile/fixture/report documentation and
      development qualification notes; verify delivered examples validate, initial-versus-future
      coverage is accurate, and cleanup removes only newly created disposable test/report artifacts
      while preserving dependencies, fixtures, local settings, and useful build outputs.
