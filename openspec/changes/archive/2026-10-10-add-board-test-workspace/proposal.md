# Proposal

## Why

Linux board projects repeatedly rewrite functional test scripts around different device-tree
mappings, Linux resource names, fixtures, and acceptance criteria. Diagnostic Hub already discovers
hardware; adding reusable tests and versioned board profiles would turn that evidence into
repeatable engineering tests and saved sequences, with readable reports for sharing the results.

## What Changes

- Isolate simulated and connected test workspaces behind an accessible simulation switch, use
  Setup/JSON labels and the requested Manufactural tests title, remove the redundant Reports &
  evidence tab, and scope diagnostic report actions to diagnostic views.

- Add a Tests workspace to both desktop and website editions, retaining the shared device clock.
- Stack guided setup sections, automatically draft profiles after complete discovery, provide
  accessible field validation and a synchronized JSON editor with animated copying, and offer direct
  paste-and-run JSON for prepared engineering fixtures without intermediate confirmations.
- Reconcile the running device tree with Linux runtime resources and installed test capabilities;
  generate an editable draft profile without automatically operating hardware.
- Introduce versioned JSON board profiles with board matching, logical resource mappings, test
  parameters, fixture prerequisites, expected results, and declared changes/restoration.
- Add a bounded, cancellable test runner on independent SSH execution channels, with collection
  coordination, resource ownership, session-generation protection, and separate test evidence.
- Implement the first reusable adapters: LED patterns with operator verification, fixture-based UART
  loopback, and approved byte-register I2C identity checks. Other discovered domains remain visible
  with explicit adapter availability; GPIO, SPI, PCIe, LAN/WLAN, HDMI, and watchdog functional
  adapters are future extensions rather than implied coverage in this increment.
- Support individual tests and saved sequences, explicit Pass/Fail/Blocked/Skipped/Inconclusive
  verdicts, cleanup evidence, and prominently labeled simulation for users without hardware.
- Add optional modern test documents: structured JSON, a self-contained readable HTML report, native
  PDF export on desktop, and a print/Save as PDF workflow on the website. Documents are generated on
  demand and include provenance, measurements, limits, verdicts, and cleanup results.
- Document profile authoring, fixture requirements, test limitations, and report generation
  separately from the concise README.

## Capabilities

### New Capabilities

- `board-test-profiles`: Live inventory reconciliation, board/resource matching, versioned editable
  profiles, prerequisite validation, and draft generation.
- `board-test-execution`: Isolated test planning/execution, reusable initial adapters, cancellation,
  resource coordination, honest verdicts, and simulation.
- `board-test-reports`: Separate portable test evidence, local import/export, clean HTML/PDF
  documents, and consistent provenance and verdict presentation.

### Modified Capabilities

None. Existing terminal and clock contracts are retained: test execution adds a temporary input
block and collection coordination through existing blocking/lifecycle concepts, without combining
their evidence, changing the remote shell, or interrupting independent clock reads.

## Impact

- Shared profile, inventory, run, validation, adapter-contract, and report modules.
- `backend/ssh/session.ts` and new test/discovery modules; fixed diagnostics remain read-only.
- `shared/types.ts`, `electron/main.ts`, `electron/preload.ts`, `gateway/server.ts`, and
  `src/services/GatewayClient.ts` gain narrow validated testing operations, not arbitrary exec.
- `src/app`, `src/hooks/useDeviceSession.ts`, the terminal input boundary, and a dedicated testing
  feature gain lifecycle, scheduling, navigation, and report controls.
- Unit, authenticated SSH/gateway, browser, native PDF, and report-layout qualification; physical
  hardware qualification remains a separately recorded activity requiring real boards/fixtures.
- No mandatory device agent, Python installation, test tool installation, cloud service, or fixture
  framework. UART/tool capabilities are detected and missing prerequisites block the affected test.
- OpenSpec planning remains local under the existing repository exclusions. No release, tag, push,
  or installation changes are part of this change.
