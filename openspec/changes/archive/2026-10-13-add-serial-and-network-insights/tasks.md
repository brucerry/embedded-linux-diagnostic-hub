# Tasks

Local implementation is authorized and underway. Checked tasks have supporting
synthetic/loopback/browser evidence; physical qualification and unfinished broad coverage remain
unchecked. Preserve the four-line tests/ui/live.spec.ts edit, main-only branch state and all release
assets/tags/history.

## 1. Confirm the narrow runtime gate

- [x] 1.1 Add a focused pinned-Electron 44.5.1 harness for navigator.serial availability and
      packaged app:// versus exact development-loopback permission details, using injected chooser
      descriptors; verify trusted top-level acceptance and unrelated/opaque/subframe denial without
      physically opening ports.
- [x] 1.2 Confirm installed Web Serial options/stream cancellation and renderer type needs without
      adding dependencies; verify compilation and a fake-port idle read/blocked hardware-flow write
      can be cancelled. If the runtime cannot meet the contract, record the specific failing
      evidence and request a design decision before substituting a native dependency or changing
      security.
- [x] 1.3 Record the exact implementation baseline and user edit; verify git diff stays focused and
      no version/workflow/dependency/release change is included during feature development.

## 2. Add bounded network evidence and collectors

- [x] 2.1 Define optional version-1 networkEvidence, nonrecursive command sections and separate
      omission records in shared types; extend report validation/export/import and verify old
      schema-1 reports, complete new round trips, invalid operation/duplicate identity/exit mismatch
      and aggregate byte/count limits.
- [x] 2.2 Extract an owned bounded exec primitive from backend/ssh/session.ts and add a global
      three-exec semaphore plus twelve-second network-group deadlines; verify loopback fixtures
      enforce concurrency, cancel late channels, retain real exits and record not-run detail without
      synthetic execution.
- [x] 2.3 Implement safe selector construction for fixed backend-discovered names/numeric selectors
      and strict PHY names; verify quotes, whitespace, shell metacharacters, option-like/control
      names, stale interface IDs and hostile SSIDs never cause extra commands.
- [x] 2.4 Upgrade interfaces and routes collection with per-command ip JSON support negotiation,
      text/legacy fallbacks and IPv4/IPv6 table scope; verify BusyBox option rejection falls back
      but permissions/runtime/timeouts do not hide failures.
- [x] 2.5 Extend ethernet evidence with detailed ip link/statistics and optional neighbor/default
      ethtool reads while retaining sysfs primary output; verify existing EINVAL/permission fixtures
      and packet/error graph keys remain correct, missing ethtool is explicit, and only allowlisted
      getter commands execute.
- [x] 2.6 Extend wireless evidence with discovery/current state, mode-appropriate link, station and
      survey reads plus regulatory and low-priority power-save detail; verify missing tools versus
      installed-tool failure, AP with zero clients, driver unsupported/denied survey, disappearing
      interfaces and output budgets.
- [x] 2.7 Add per-generation/topology PHY/version cache and fixed capability-refresh/reset options
      to desktop/gateway collection; verify original source timestamps, reset/reconnect/topology
      invalidation, authorization and no overlapping collection or arbitrary exec endpoint.

## 3. Implement meaningful network parsing

- [x] 3.1 Add bounded iw discovery/info/link/peer parsers and typed nullable fields; verify
      managed/AP/mesh/monitor, multiple PHYs/interfaces, reordered/unknown/missing blocks,
      Unicode/HTML-like SSIDs and upstream-derived legacy-through-EHT fixtures retain raw evidence.
- [x] 3.2 Parse surveys with frequency/in-use/noise/time units and preserve MLO link IDs/per-link
      observations; verify mismatched/no-current surveys remain unknown, valid zero is retained and
      signal/bitrate descriptors do not merge peers/links.
- [x] 3.3 Parse PHY bands/channel restrictions/modes/combinations and regulatory scope; verify
      disabled/no-IR/radar/DFS/CAC/max-power records, per-interface-type HE/EHT blocks, cached age
      and unsupported optional fields remain distinguishable from current negotiation.
- [x] 3.4 Parse ip JSON/text links, addresses, routes/nexthops and neighbors; verify
      bridge/VLAN/veth/bond/tunnel topology, admin/carrier/UNKNOWN, IPv4/IPv6 lifetimes/DAD,
      multiple defaults/tables/multipath and STALE neighbor semantics.
- [x] 3.5 Add precision-preserving numeric-token handling and exact cumulative counter display;
      verify escaped JSON strings are untouched, 64-bit counters above 2^53 round-trip exactly and
      unsafe graph samples are omitted with raw values retained.
- [x] 3.6 Parse optional default ethtool physical settings/capabilities against its upstream manual
      and representative fixtures; verify current speed/duplex/autoneg differs from
      supported/advertised modes, unknown speed remains unknown and no test/setter flags enter
      commands.
- [x] 3.7 Centralize bounded evidence references, failure reasons and parser warnings; verify
      partial successes coexist with denied/timed-out/truncated sections and unknown errors are
      shown as command failed rather than guessed hardware absence.

## 4. Add network summaries

- [x] 4.1 Add shared interface selectors and WLAN/LAN Summary views in src/features/network and
      EvidenceModal; verify Summary is the default only for these probes, progressive details are
      readable and raw commands/output/error/tree/table/graphs remain accessible.
- [x] 4.2 Render WLAN state/mode/connection/channel/width/power/signal/noise cards and
      peer/capability/regulatory details; verify units, not-applicable mode behavior, nullable
      values and visibly cached timestamps with managed/AP/missing-field UI fixtures.
- [x] 4.3 Render LAN state/topology/physical/address/route/neighbor/counter details; verify multiple
      records, exact counters, historical labels and reduced fallback scope using focused browser
      tests.
- [x] 4.4 Verify stable focus/expanded sections/selection through live updates, keyboard tab
      controls, narrow/mobile layouts, long hostile labels and collection errors using targeted
      Playwright fixtures; verify no diagnostic markup execution or interface cross-contamination.

## 5. Add safe Serial ownership and permissions

- [x] 5.1 Extract reusable terminal display/fit/input/clipboard primitives with no SSH lifecycle
      behavior; verify existing SSH shell recovery, output isolation, OSC guards,
      paste/selection/keymap and scrolling tests still pass.
- [x] 5.2 Implement a generation-owned Serial controller using injected Web Serial ports, explicit
      framing and selected/opening/connected/closing states; verify selection never opens, double
      Connect is rejected, Disconnect/Deselect/replacement races release late opens and no input is
      replayed.
- [x] 5.3 Implement ordered bounded byte writes and callback-paced receive rendering with input
      visibility/generation guards; verify fragmented UTF-8/ANSI, 16 KiB chunks, 256 KiB limits,
      5000-line scrollback, high-volume/slow-consumer behavior and stalled writes remain serial-only
      failures.
- [x] 5.4 Implement cancellation/unplug/error/unmount cleanup and five-second truthful close
      watchdog; verify idle reader and blocked writer cancellation, locks release, repeated cycles
      leak no listeners and new ports cannot open after unresolved cleanup.
- [x] 5.5 Add narrow Electron chooser/permission module and preload APIs using current trusted-frame
      validation; verify one callback, cancel/expiry, offered-ID validation, live chooser
      add/remove, unrelated/subframe requests, session grant scope and default-denied nonserial
      permissions.
- [x] 5.6 Add browser native chooser/authorized-port labels and feature-detected Forget permission
      behavior; verify insecure/missing API, policy denial, cancellation, busy/denied/unsupported
      framing and browser lack of COM/tty names have accurate UI states.

## 6. Integrate Serial into the shared workspace

- [x] 6.1 Add primary Serial navigation/page title and local controls/terminal with 115200 8N1
      defaults, framing, local echo and Enter choice; verify access without SSH/gateway and visible
      local port identity without misleading SSH/report/live controls.
- [x] 6.2 Implement explicit Connect/Disconnect/Deselect and local Clear/Copy/Paste; verify raw
      key/Enter/paste behavior, no commands/Break/explicit DTR/RTS on open, clipboard generation
      checks and target setup/control-line guidance.
- [x] 6.3 Preserve serial ownership/receive across tabs/minimize/SSH changes/report import while
      disabling hidden/blocked input; extend RAM reset and transport-specific notices and verify
      import/reset never sends serial bytes or relabels local identity.
- [x] 6.4 Integrate update-lock quiesce/acknowledgement and app/page exit cleanup; verify checking
      updates leaves the port open, installation waits for cleanup, stale/missing ack fails safely,
      modal blocking discards pending paste and shutdown does not auto-reconnect.

## 7. Verify and document the release candidate

- [x] 7.1 Update docs/architecture.md, docs/hardware.md, docs/usage.md, docs/development.md and
      docs/website.md with current fields, reduced capabilities, serial platform/permission behavior
      and historical report semantics; verify stale serial/roadmap claims are removed without
      reviving retired Tests/Genie scope.
- [x] 7.2 Run npm run verify, focused new parser/report/collector/serial tests and npm run test:e2e,
      then build desktop/web/gateway; verify the user's live.spec.ts edit remains verbatim and
      summarize concrete failures before changing anything further.
- [x] 7.3 Run relevant npm run test:desktop, npm run test:window-desktop, npm run test:portability
      and existing update integration checks in available environments; verify current Windows/Linux
      compositor/macOS architecture coverage and packaging/security rules remain intact without
      trial-and-error CI changes.
- [ ] 7.4 Obtain separate authorization for physical serial loopback/console and read-only target
      evidence, then record client OS/runtime/adapter/framing,
      permissions/busy/unplug/open-close/control-line observations and Linux iw/ip versions. Verify
      Windows/Linux/macOS claims and managed/AP/BusyBox coverage with actual evidence; classify
      unavailable environments as remaining qualification gaps, not mock passes.
- [x] 7.5 Reconcile qualification results against the six capability specs, document residual
      optional-field/platform limits and recommend v0.5.0-rc.1 then v0.5.0; verify no
      push/tag/publication occurs without separate authorization and final changes can be reviewed
      as one focused source set.

## 8. Serial visual addition

- [x] 8.1 Reuse existing pig/duck pixel grids for a separate soft beach volleyball SVG/CSS scene
      with waves, sand, trees and sun; verify SSH default artwork/palette is unchanged and no new
      dependency is introduced.
- [x] 8.2 Verify desktop/mobile screenshots, terminal legibility/resize, pointer-safe decoration,
      hidden/modal/document visibility pause and reduced-motion behavior with focused browser tests
      and visual inspection.

## 9. Add ordered Automation and QA exports

- [x] 9.1 Define transport-neutral command plans, immutable run snapshots, finite byte/count/time
      limits and connection fencing; test invalid requests and credential-free metadata.
- [x] 9.2 Implement isolated bounded SSH exec/cancel APIs over trusted desktop IPC and authenticated
      gateway routes, with genuine exits, UTF-8/raw capture and no diagnostic catalogue mixing.
- [x] 9.3 Implement exclusive Serial input ownership, deliberate line-ending bytes and literal
      prompt completion with split ANSI/chunk handling, pre-send quiet, timeout/cancel/unplug/stale
      input caveats.
- [x] 9.4 Add named/enabled multiline command editors with reorder/duplicate/delete, Enter newline,
      exact payload previews and immutable active-run drafts.
- [x] 9.5 Add immediate execution plus optional wall-clock start, per-step elapsed delays and
      off-by-default repetition after whole-flow completion; test no overlap/backlog and
      cancellation while waiting.
- [x] 9.6 Validate strict calendars, leap years, DST gaps/folds/explicit offsets, timezone
      resolution, near-now/past arming, nonfinite/out-of-range inputs and malformed persisted plans
      at UI and execution boundaries.
- [x] 9.7 Add explicit verified SSH clock sampling/refresh with source, freshness, uncertainty and
      current-connection checks; keep Serial device scheduling unavailable without a verified
      provider; test clock jumps/offset/source changes.
- [x] 9.8 Pause armed work on hidden/document exit, sleep/timer stalls, disconnect/replacement,
      stale calibration and uncertain completion; require explicit rearming with no automatic
      reconnect/catch-up.
- [x] 9.9 Add bounded common result table, local/device time provenance, search/status/command
      filtering, row selection and paused autoscroll/new-row indicator.
- [x] 9.10 Export selected/filtered/all-retained JSON/CSV/Markdown/text snapshots with exact
      JSON/raw bytes, CSV formula safety and transformation fields, robust Markdown fences/control
      rendering, visible retention and review warning; verify export never executes or queries.
- [x] 9.11 Add deterministic fake-clock/unit/loopback/browser tests for both transports, boundaries,
      exclusive input, schedule snapshots, hostile exports and generation replacement; do not open
      physical ports or execute real target commands.
- [x] 9.12 Update platform/docs/version qualification and local proposal evidence; keep physical
      UART/platform qualification and publication as separate gates.
