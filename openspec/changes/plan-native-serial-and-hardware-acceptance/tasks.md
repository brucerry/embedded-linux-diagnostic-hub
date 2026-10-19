> Current audit: checked items below are narrow historical checkpoints, not whole-product adoption.
> See design.md and ../add-durable-automation-capture/ for the formal storage contract. No
> unfinished work is archived.

## Pending decisions and acceptance

- [ ] 1.1 Review the native-backend follow-up decision for OS ports outside Web Serial enumeration,
      including dependency/build/ABI and Windows/Linux/Mac driver coverage.
- [ ] 1.2 Physical COM11/platform acceptance: explicitly deferred to authorized hardware
      availability; do not mark fixture results as hardware evidence.

Transferred from fix-local-serial-discovery-and-beach tasks 3.3 and 3.4, with both still pending. No
physical port was opened by the release qualification work.

## 2. Confirmed Serial controls and SSH clock corrections for v0.6.0

- [x] 2.1 Publish the completed Serial close state only after successful cleanup releases closing
      ownership, so Deselect notifies enabled chooser/settings with no selected port. Preserve
      ownership during unfinished/timed-out cleanup, framing values and explicit reselection.
- [x] 2.2 Correct the confirmed custom chooser/shared Serial secondary hover cascade with an enabled
      Serial-scoped light palette and a clearly visible Serial-modal focus outline. Preserve
      disabled colors, ordinary SSH styles and the existing native select design.
- [x] 2.3 Change only the DeviceClock disconnected label to exactly "SSH disconnected", updating
      clock/portability expectations and covering Serial connected while SSH remains disconnected.
- [x] 2.4 Add focused lifecycle and browser regressions, real mouse hover after transition,
      normal/hover/disabled palette checks, keyboard Tab/Enter, pagination, selected-label update
      without auto-open, retained framing and explicit reselection; capture visual evidence and
      prepare an independently reviewable bounded packet before source adoption/release.

Evidence: direct user screenshots inspected in the parent supported Library environment confirm the
custom chooser (not native options) has dark teal text on a dark hover background; source cascade
and actual SerialSession notification probing corroborate both findings. Use fixture-only tests;
physical COM11 remains unqualified and must not be opened for these fixes. Preserve the separate
four-line tests/ui/live.spec.ts user edit. The previously qualified disposable Windows snapshot is
972be14 and remains separate from this UI source increment.

- [x] 2.5 Present Clear retained results with the existing destructive-warning button palette and a
      decorative cleanup icon (the installed icon set has BrushCleaning, not Broom); add a
      decorative Play icon beside Start flow. Preserve both labels and existing behavior, verify
      normal/hover/focus/disabled states and icon alignment in applicable appearance modes, and
      inspect screenshots using synthetic retained rows only. Do not clear the user's real results.

- [x] 2.6 Remove the redundant running Stop button after verifying Cancel run already disarms
      repetition/queued steps, aborts waits and requests active cancellation. Keep Cancel run and
      the remote-termination uncertainty warning. Verify active, between-step, repeating and
      scheduled states cannot send later input or restart without explicit rearming.

## 3. Fragmentation-independent Serial Automation capture for v0.6.0

- [x] 3.1 Reproduce the actual-class failure where the 257th native read triggers output-limit below
      64 KiB, then implement bounded 1024-byte Serial capture blocks (at most 64 for 64 KiB) without
      raising the shared 256-chunk limit or changing SSH capture. Preserve exact retained bytes,
      streaming UTF-8/prompt detection and conservative stop on overflow or uncertainty.
- [x] 3.2 Carry explicit serial-byte-block provenance: first and last contributing host receive
      observations plus contributing-read count, with receivedAt explicitly the first observation.
      Never describe blocks as original reads or infer per-byte, line or device emission times.
      Preserve observed order across wall-clock jumps; individual interior read boundaries/times are
      intentionally not retained in this bounded representation.
- [x] 3.3 Validate optional block provenance, expose truthful ranges/aggregation in UI and every
      export, and use a new JSON export schema version when aggregated blocks are present while
      retaining legacy/SSH schema behavior. Use the last observed block receive time where a Serial
      device-time-prefix observation previously consumed the last raw read timestamp.
- [x] 3.4 Regress whole/one-byte/irregular/UTF-8/ANSI/prompt fragmentation, sequential commands and
      Enter-only with fresh capture counters/no stale-prompt advancement, exact 64-KiB/overflow
      stopping with no next command, wrong/missing prompt, cancellation, incomplete escapes and
      raw-byte/timestamp-provenance exports. Prepare a bounded independent review packet together
      with the confirmed Deselect, hover/focus and exact SSH-disconnected label corrections.

The user's physical v0.5.2 ls stopped after 36 ms with output-limit while the terminal kept
receiving and stayed connected. Actual read fragmentation for that hardware attempt was not
captured. Parent review reproduced the root defect with the real Serial class: the same 390-byte
ANSI listing and prompt succeeds whole or in three-byte reads, but one-byte reads fail at 256
retained records. The implementation must repair this established defect without claiming
physical-device qualification.

## 5. Superseding full-output storage-backed capture request

- [x] 5.1 Investigate the repeated-run report without assuming ownership/listener leaks; retain
      screenshot evidence that pwd completed then a small ls hit output-limit at 35 ms with only two
      rows/zero evictions. Add repeated successful flows followed by further arms on one session
      with fresh counters/capture ownership and prompt state. Do not claim hardware fragmentation or
      a leak was directly measured.
- [ ] 5.2 Plan and implement full-output streaming/spooling without a small application-imposed
      total-output cap, retaining bounded in-memory parsing/rendering and paginated/virtualized
      results. Assess desktop disk and browser persistent-storage API/quota feasibility before
      claiming support; finite disk/quota availability is not unlimited physical capacity.
- [ ] 5.3 Preserve all observed raw bytes, truthful first/last receive provenance and complete
      streaming exports; distinguish a bounded display window from capture truncation. Surface
      disk-full/quota/storage failures as incomplete capture with safe stopped advancement, and
      provide explicit cancellation, retention/export and cleanup controls without unbounded RAM.
- [ ] 5.4 Review a clean streaming ANSI result projection separately from raw evidence, preserving
      exact raw exports and safe handling of incomplete/control/OSC sequences; do not execute
      output-supplied links, commands or clipboard controls.

The earlier 64-KiB exact-cap/overflow tests qualify only the bounded fragmentation/UI checkpoint.
Bruce's new no-output-limits direction supersedes that total-cap acceptance for the final v0.6.0
capture design. The interim packet still retains the old cap and must not be represented as the
completed full-output request. First independently review/report that checkpoint, then implement
storage-backed capture with explicit platform and storage failure evidence.

## 6. Latest Serial scene and terminal contrast follow-up

- [ ] 6.1 Remove only the left foreground palm/tree/coconut group that overlaps terminal output;
      preserve the right-side scene, distant island trees and already implemented bird-free scene.
      Verify scene structure and screenshots with no device interaction.
- [ ] 6.2 Evaluate a Serial-only accessible light ANSI/default foreground palette and a clearly
      visible cursor over sky, ocean and sand; verify representative colored prompts, plain output,
      selection and active/inactive cursor without output rewriting, hardcoded prompt detection,
      dark covering panels or SSH theme changes.
- [ ] 6.3 Independently review/adopt the frozen interim correctness/UI packet before combining the
      queued scene, full-output storage or persistent SSH console work. Retain source/test hashes,
      fixture screenshots and the distinction from physical hardware acceptance.

Historical checkpoint: the interim 64-KiB packet and its evidence remain frozen. Later accepted
Serial storage/UI work is recorded in 8.8/8.9 below and integrated only in the isolated candidate.
Left foreground/palette/cloud refinements and SSH console implementation remain pending. Windows
native acceptance qualifies its exact earlier private snapshot only.

- [ ] 6.4 Add the latest requested few subtle soft-light 16-bit/pixel clouds in the Serial sky,
      preserving terminal text readability and the remaining right-side/distant scene. Clouds must
      not block pointer input; keep them static or respect reduced motion if animated. This belongs
      with the queued visual batch at high effort, separate from correctness/storage/SSH work.

## 7. Pending activity-lease cancellation correction and storage feasibility

- [x] 7.1 Reproduce the independently reviewed P2 race where Cancel during asynchronous activity
      acquisition is lost when runner.start resets flags. Fence each attempt, invalidate pending
      arming on Cancel, release late grants and guard stale success/failure/finally UI updates.
- [x] 7.2 Verify delayed SSH/Serial leases with no sends or scheduled/repeating restart; cover stale
      grants/rejections during newer arming and active flows, plus focused existing regressions.
      Keep the accepted interim packet and native evidence frozen; submit a two-file correction
      packet for independent re-review before adoption.
- [x] 7.3 Establish the preimplementation storage contract and generated-data feasibility: native
      Windows Node files and browser IndexedDB/reload/streaming attachment exports beyond 32 MiB in
      Chromium, Firefox and WebKit. Record OPFS's Windows WebKit limitation, finite quota,
      bounded-memory requirements, retention, completeness and safe storage-failure behavior.

See automation-arm-correction-checkpoint.md and storage-design.md. Correction is isolated and
unadopted; tasks 5.2/5.3 remain pending production storage integration and full acceptance. Task
2.6's full cancellation guarantee requires this additional correction; previous active-run tests did
not cover pending host leases. The source-only correction adds no native installation qualification.

## 8. Storage and export foundation checkpoint

- [x] 8.1 Implement isolated native-file/IndexedDB repositories, bounded writer/backpressure,
      raw-byte/timestamp provenance, explicit incomplete state, recovery and retention without
      automatic deletion. Preserve accepted packets and original application source.
- [x] 8.2 Implement streaming raw JSON/CSV/Markdown/text, existing-destination preservation and
      scoped client-bound expiring browser downloads. Validate pinned data before attachments,
      enforce ownership and keep missing-block failures distinct from EOF.
- [x] 8.3 Add rich Markdown summaries/tables/dividers/icons and safe fences, three-engine rendered
      QA, byte/UTF-8/CSV boundaries, fault/cleanup tests and delayed-release/third-arm regression.
      Prepare an exact isolated source/evidence packet for independent review.
- [ ] 8.4 Integrate Automation UI, native IPC, SerialSession and independent SSH/gateway streaming;
      complete native catalog indexing, product heap/platform/driver-overrun and aggregate
      acceptance.

See capture-storage-implementation-checkpoint.md for the historical foundation. The later isolated
Serial visible path is storage-backed (8.8/8.9); independent SSH still uses the legacy bounded
result. Broad tasks 5.2/5.3 remain incomplete. The Firefox missing-block injection now fails before
any attachment without weakening client/token or ownership checks. Earlier failed-download stalls
and all intermediate failure evidence remain retained. Native installation/DUT/release qualification
was not repeated or broadened.

- [x] 8.5 Correct the independently confirmed foundation P2 seal-verification and
      transmitted-payload bounds defects in a separate five-file packet; preserve negative controls
      and qualify native integrity/runner stopping, all supported line endings and the three-engine
      browser matrix. Submit the correction for independent re-review before foundation adoption.

See capture-seal-correction-checkpoint.md. The correction has 23 passing native/shared/broker tests
and 50 passing browser checks. Its five negative controls reproduce the original defects. Both
foundation and correction remain unadopted. Task 8.4 and full-output production tasks 5.2/5.3 remain
incomplete; unexpected midstream Firefox/WebKit native-download failure UX remains a release gate.

- [x] 8.6 Prepare the focused Serial transport/runner/repository integration checkpoint using the
      independently accepted foundation/correction. Qualify actual SerialSession multi-command
      capture beyond 32 MiB, consecutive Enter, same-session re-arm, awaited seal/result callbacks,
      storage-failure next-command suppression, cancellation during IO and generation fencing.
      Qualify the same core with IndexedDB in three engines and regress actual-component arming.

See serial-storage-integration-checkpoint.md. This isolated, unadopted 12-file packet has 12 new
native integration cases, 53 existing native regressions, nine browser integration cases and all 14
arming/cancellation browser cases passing. That earlier checkpoint did not wire the visible UI. The
later accepted visible Serial/native IPC/catalog/export integration is separately recorded in
8.8/8.9; it does not complete SSH or whole-product adoption. Task 8.4 and production full-output
tasks 5.2/5.3 remain incomplete. Whole-product memory/lifecycle, physical UART driver/platform
evidence and unexpected midstream Firefox/WebKit native-download failure UX remain release gates.

- [x] 8.7 Correct the independently reviewed Serial core P1 persistence-watchdog gap and P2
      terminal-delivery/stale-prompt and unterminated-clock provenance gaps in a separate packet.
      Preserve the frozen baseline and negative controls; qualify healthy slow commits versus resume
      gaps, queued continuation, cancelled re-arming, timeout/cancel/UTF-8/invalid clock tails,
      the >32-MiB path and existing native/three-engine/actual-component cancellation checks. Submit
      the exact five-file correction for independent re-review before acceptance/adoption.

See serial-core-correction-checkpoint.md. The original Serial core review withheld acceptance for
these three findings; passing the earlier qualification was not independent acceptance. The new
correction has 78 native and 35 browser cases passing; eight expected negative-control failures
reproduce all three findings. Original app source remains unchanged. Tasks 8.4 and 5.2/5.3 remain
incomplete, because independent SSH streaming/persistent console, full product memory/lifecycle,
physical platform evidence and unexpected Firefox/WebKit midstream native-download failure UX remain
open. Serial UI/catalog/export/native IPC are now accepted isolated work; indexing/migration is a
tested review candidate (8.10/8.11). The latest clouds request is queued in 6.4; no visuals changed
here.

## 8A. Current isolated integration and remaining storage gates

- [x] 8.8 Prepare and independently qualify the visible stored Serial UI/native
      IPC/catalog/search/full-scope export/clear integration, retaining raw evidence and bounded
      pages; accepted source is the frozen visible checkpoint plus the correction in 8.9, not
      original-repository adoption.
- [x] 8.9 Correct and independently accept current-input export filtering, persistent results-job
      ownership across transport switches and native shutdown joining entry-time exports; exact
      seven-file correction SHA256 3cc7f1429cc1eabf3e9395e8baf5625d7545802f6b4d3dfdc4437cdb35b9c1b9.
      Tests/negative controls and independent review support this narrow checkbox.
- [x] 8.10 Prepare the separate native metadata-index and IndexedDB migration/metadata/reload/crash
      candidate: 47 native passes, 31 browser passes/two explicit non-Chromium crash skips,
      build/format and actual Electron IPC round trip. This records tested packet preparation, not
      independent acceptance or final platform qualification.
- [x] 8.11 Independently review and integrate the exact index/lifecycle packet and separate
      initialization/versionchange correction against the accepted baseline, including
      disposable-index failure recovery, deletion-intent recovery and retained-data migration;
      qualify the exact isolated 411-file composition. Original application source adoption and
      product index-mode/heap/platform gates remain open in add-durable-automation-capture.
- [x] 8.12 Independently accept the bounded prompt-tail correction and qualify the exact isolated
      composition with the ordinary parallel WebKit five-second next-write assertion unchanged. The
      correction passed three sequential original matrices (27/27); composition passed nine original
      UI cases. Preserve historical failed probes and avoid claiming every old failure's exclusive
      cause. Final combined product qualification remains open.
- [ ] 8.13 Qualify unexpected midstream Firefox/WebKit attachment-download failure feedback and
      cleanup while preserving token/client/origin and missing-block preflight controls.
- [ ] 8.14 Complete independent SSH/gateway streaming, product heap/backpressure and applicable
      native platform/lifecycle acceptance through add-durable-automation-capture; keep 5.2/5.3/8.4
      open until their complete scope is met.

Evidence roots: Task/capture-visible-correction, Task/capture-index-lifecycle and
Task/webkit-progress-probe. See the audit's exact path/manifest mapping and the immutable historical
checkpoint files. Browser IndexedDB qualification does not add Web Serial support to Firefox/WebKit;
generated-data tests do not qualify UART hardware or driver overruns.

## 9. Optional graph and queued visual scope

- [ ] 9.1 Review the separate add-automation-flow-viewer design/feasibility/spec/tasks before
      implementation: consecutive directed edges, view-only dragging, theme-consistent interaction,
      live state and full-graph local exports. Graph lifecycle/export must not own or pause
      execution.
- [ ] 9.2 Complete the latest SSH terminal height/star refinement as tracked in
      plan-windows-permanent-delivery; existing stars and accepted bird-free islands/crabs are
      baseline behavior, not missing work to rebuild.

## Current correction and comprehensive verification checkpoint

Independent review accepted the indexing delta and both separate corrections. The exact 411-file
isolated composition passes 87 focused native checks, nine original ordinary three-engine UI cases,
37 lifecycle cases with two existing actual-crash skips, desktop/web/gateway builds, focused
formatting and actual sandboxed Electron IPC. See
../add-durable-automation-capture/accepted-capture-integration-checkpoint.md. Frozen source/negative
controls/old failures remain preserved. Tasks 8.11/8.12 record this isolated integration, not
original application source adoption or every historical failure's root cause.

The separately frozen four-file SSH contract/loopback fixture preparation passes 26 focused cases
and strict build/typecheck/formatting against that accepted integration. It introduces no shipping
console/stream consumer or runtime capability. See
../add-ssh-persistent-console-automation/ssh-contract-fixture-checkpoint.md. Production independent
SSH streaming and typed PTY/context representation precede dedicated-console integration.

See ../add-durable-automation-capture/verification-matrix.md for the explicit risk-based matrix and
not-performed Windows 11 DUT checklist for Bruce. Keep broad 5.2/5.3/8.4, product index-mode/heap,
platform/midstream-export/SSH and combined release gates open; graph remains design-only pending
review, with no PDF dependency installed.

## Production independent SSH milestone

The exact isolated production SSH increment is now qualified (430 source files, 28-file patch): 45
focused ordinary Node cases, >32-MiB exact stdout/stderr capture, actual hidden sandboxed Electron
IPC, three-engine full stored SSH UI and nine unchanged ordinary Serial UI cases, plus builds and
formatting. See ../add-durable-automation-capture/production-ssh-streaming-checkpoint.md. Review and
original source adoption remain pending; 5.2/5.3/8.4/8.14 remain open for their complete scope.

The independent memory/resource plan is incorporated in durable tasks 4.7/4.8, with current partial
resource assertions distinguished from the unimplemented calibrated CI gate/negative controls and
30-minute native/browser/gateway soaks. The optional native-addon abort remains tracked under 4.9.
No DUT/port, install, dependency, policy, CI dispatch or publication action occurred.
