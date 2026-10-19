# v0.6.0 risk-based verification and Windows 11 DUT checklist

This matrix tracks applicable acceptance, exact evidence and remaining gaps. It is not a claim of
exhaustive proof. Frozen per-packet manifests identify actual source/test/log hashes; new correction
receipts supersede a result only at their own stated source scope. Preserve failures, skips and
independent review outcomes.

## Execution order and evidence rules

1. The indexing delta and separate timing/initialization corrections are independently accepted and
   qualified in the exact 411-file isolated composition. Preserve all separate frozen evidence and
   original failures. Original application source adoption and final product gates remain open.
2. Implement independent SSH streaming, then persistent console/Enter/context capture under their
   current proposals; qualify each bounded increment before composition.
3. Complete the visual batch and optional graph only after its design review; no PDF dependency
   installation is authorized by this matrix.
4. Run applicable full combined validation at the final integrated source checkpoint, including
   ordinary configured suites, realistic supported runtimes, native platform gates and independent
   review. Avoid competing broad suites on shared hardware during latency/load measurements. Repeat
   ordinary three-engine/three-worker cohorts sequentially rather than claiming a differently
   scheduled repeat-each load is identical.
5. Keep physical Windows 11/DUT work for Bruce under explicit hardware availability/authorization.
   No mock is hardware acceptance, and published support must distinguish runtime capability from
   actual adapter/OS qualification.

Every outcome records source/patch hash, runtime/OS/browser, config/payload/assertion hashes,
command, exit code, passed/failed/skipped cases, logs/traces/receipts and retained intermediate
failures. Do not weaken assertions, raise speculative timeouts, suppress unsupported cases or infer
a root cause from a passing rerun. Native browser launch sandbox/cache restrictions are environment
outcomes, not product-test passes.

## Verification matrix

| Risk / boundary                                  | Existing or focused checks                                                                                                                                                                                                             | Remaining qualification / explicit limits                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeated/reentrant flows and arming              | automation-activity/cancel tests, real Serial integration and accepted delayed-host-lease cancellation correction; repeated same-session re-arms and consecutive Enter                                                                 | Repeat against final combined source; verify one active owner, no overlapping repetition/backlog, stale grants/rejections cannot clear a newer attempt                                                                                                                                        |
| Cancellation at asynchronous boundaries          | Lease acquisition, command write, receive/storage append, raw seal, immutable outcome, delay/repetition/schedule and cleanup controls in accepted packets                                                                              | Extend every new SSH/console API await and export/graph lifecycle. Cancel stops later input, never promises remote rollback; failed cleanup retains ownership                                                                                                                                 |
| Ownership across switch/unmount/reconnect        | Accepted stored-results transport-switch job owner; generation/delivery fences; native shutdown joins entry-time exports; Serial close/reselect fixtures                                                                               | Final true renderer unmount/navigation/update, browser client/socket loss, stalled cleanup and replacement-session matrix; do not infer from a transport switch alone                                                                                                                         |
| Sleep/stall and scheduling                       | automation-time-boundary/automation tests, watchdog-through-persistence controls, strict date/time/zone/DST validation and frozen plans                                                                                                | Final local/device clock freshness, DST gaps/folds, leap/invalid dates, backward/equal clocks, long suspension/resume-before-watchdog, explicit rearm/no catch-up on all supported editions                                                                                                   |
| Script/empty/Enter and SSH shell truth           | Existing Serial script/Enter/Enter/script and genuine independent-exec exit/signal policy                                                                                                                                              | Persistent SSH remains unimplemented: one dedicated PTY, normal cwd/env/alias/function initialization, exact CR Enter, changing/initial/intermediate literal prompts, wrong/missing prompt, no implicit confirmation/profile/alias injection                                                  |
| Fragmented/large/binary/ANSI output              | Exact raw storage beyond 32 MiB, byte/range/CRC controls, whole/one-byte/irregular UTF-8/ANSI/prompt tests and new bounded-tail oracle/work-budget controls                                                                            | Verify full integrated SSH and console; preserve raw evidence while stripping controls only for safe presentation. Partial UTF-8/escape must not authorize a prompt                                                                                                                           |
| Receive/device timestamp provenance              | Existing UTC source/index/stream/byte evidence, backward-clock ordering, aggregated legacy limitations and terminated-line clock-prefix correction                                                                                     | New SSH/gateway stream preserves original observation source/times; PTY has combined channel identity; no per-line/device-emission timestamp or exit-code invention                                                                                                                           |
| Quota/disk/partial commit/integrity              | Foundation/core fault controls, short writes, missing/corrupt frames, immutable outcome failure/retry and no-next-send tests                                                                                                           | Final product availability/recovery UI and actual platform behavior; finite quota estimates reserve no space. Do not fill user disks for testing                                                                                                                                              |
| Index and explicit deletion recovery             | Frozen 47-pass native packet: 2048 legacy rows, one scan then bounded late page, cache quota/permission/degradation, duplicates/aliases, real child SIGKILL and validated delete intent                                                | Index and initialization correction independently accepted; exact composition passes. Product index-mode health/heap and Linux/macOS native filesystem behavior remain pending                                                                                                                |
| Schema/migration/versionchange/crash             | Frozen lifecycle matrix 31 pass/two actual-crash skips: v1 upgrade preservation, abort/blocked/malformed/future schema, counters, actual outcome transaction abort and versionchange, reload all engines, real Chromium renderer crash | New initialization/versionchange commit+abort tests call the real capture helper and require zero producer calls, retained locks until settlement and rejected late acknowledgement. Firefox/WebKit actual crash remains explicitly unqualified                                               |
| Export scopes and escaping                       | Full-output selected/filtered/all, off-page stable IDs, current-input filter snapshot, exact raw JSON, CSV formulas/quotes, safe Markdown/control projection, scoped browser preflight and native destination preservation             | Unexpected midstream Firefox/WebKit download-error feedback/cleanup remains open; browser handoff is not verified saved-file completion. Requalify cancel/tab switch/unmount/shutdown and format/version composition                                                                          |
| Parallel timing and parser resource bounds       | Original nine-case config, three engines/three workers and five-second next-write poll; bounded storage/terminal/parser traces and deterministic bounded-copy regression                                                               | Retain all failed old/experimental runs. Only complete task after unchanged ordinary matrix passes at the corrected source, repeatability and appropriate regressions; stage wall times do not prove a CPU/disk root cause                                                                    |
| Graph interactions and exports                   | Design/spec/tasks only (0/13): consecutive directed edges, view-only drag, passive frozen/live snapshot and theme/accessibility requirements                                                                                           | Once implemented: pointer cancellation, keyboard/pin/focus, pan/zoom/fit, maximum 20 steps, long/untrusted text, reduced motion, complete off-screen SVG/PNG/PDF, readable pagination, resource limits and no execution/startup/storage-ACK interference                                      |
| Serial/SSH visual refinement                     | Accepted bird-free islands/crabs and existing SSH stars are baseline; latest palette/cloud/left-foreground/height refinements are unchecked                                                                                            | Actual narrow/wide themed screenshots, measured text/focus/cursor contrast, pointer-inert artwork, reduced motion, xterm fit/scroll/keymap and unchanged raw bytes/prompt matching                                                                                                            |
| Installer/update/repair/recovery/removal/startup | Existing setup/channel/path/successor/transaction/profile-lock tests and exact earlier Windows 972be14 native install/launch receipt                                                                                                   | Final distinct-version/native busy/interruption/recovery/report/profile/shortcut/helper/repair/update/removal cases on applicable Windows/Linux/macOS platforms, within authorization. Earlier snapshot acceptance is not current combined-source acceptance; do not uninstall or install now |
| Integrated memory/load/lifecycle                 | Bounded queue/frame/page/preview contracts and existing large generated captures; native cache's 1 MiB pager target is not process-heap proof                                                                                          | Actual app heap plateau versus output/retained rows, UI responsiveness under capture/search/export, shutdown/update/client loss, driver-overrun separation, sustainable throughput and native platform evidence. Do not substitute a unit allocation count for product memory qualification   |
| Final release/docs/source agreement              | Main-only/local-only OpenSpec policy and immutable published 0.5.2 assets/tags; user live.spec.ts edit preserved                                                                                                                       | Combined source adoption, ordinary full verification/build/portability/native checks, accurate supported/unsupported matrix, final version/assets/checksums/docs and independent review. No new CI/push/tag/publication is authorized here                                                    |

## Current evidence roots and known gaps

- Accepted Serial visible correction:
  Task/serial-fix-evidence/visible-serial-review-correction.json, patch SHA256
  3cc7f1429cc1eabf3e9395e8baf5625d7545802f6b4d3dfdc4437cdb35b9c1b9.
- Frozen indexing candidate: Task/serial-fix-evidence/capture-index-lifecycle-review.json, patch
  SHA256 17c767666f6880515c8b691c5ff54345cbc0689ba6ed04661a53e445b6d3608e; unchanged while its
  follow-up is corrected.
- Timing investigation: Task/webkit-progress-probe (frozen original evidence) and
  Task/webkit-latency-correction (new isolated stages/experiments/correction). The receive-overlap
  experiment did not clear the gate and is preserved rather than adopted.
- Initialization lifecycle correction: Task/capture-begin-correction, based on the frozen 410-file
  indexing source. Preserve negative-control commit/abort observations and exact
  producer-call/lock/transaction evidence.
- SSH preparation: Task/ssh-storage-console-preparation. Real ash/PTY is not qualified: no
  ash/busybox/docker on PATH; selected-environment read-only WSL enumeration returned
  Wsl/E_ACCESSDENIED, which does not prove the host has no distributions.
- Current OpenSpec audit: Task/openspec-compliance-audit. Its 23/23 structural pass does not
  establish historical compliance, full implementation or release readiness.

## Windows 11 DUT checklist for Bruce — not performed by Codex

Record the tested app version/source and executable SHA256, Windows 11 build/architecture, desktop
or browser/version, adapter/driver/version and the OS-offered port identity (including COM11 where
actually offered). Do not record passwords/tokens or claim all driver classes from one adapter.
Bruce owns UART enablement, wiring, target boot/login and target command choice.

- [ ] Confirm the target UART and wiring independently. Inspect the offered local port list without
      opening anything; selecting alone must not open/send, cancelled chooser is normal, and no
      arbitrary COM path or automatic first choice appears.
- [ ] Review the displayed baud/framing/flow control and expected adapter reset/control-line
      effects. Connect deliberately to one port; verify an actual ready terminal and correct bytes
      with a known benign target response. No automatic login/setup/discovery/Break/DTR/RTS command
      should be sent.
- [ ] Exercise Disconnect (retain selection), Deselect (release then clear), framing
      retention/editing while closed and explicit reselection/reconnect. Verify no duplicate
      ownership or stale disabled controls after successful cleanup; unfinished cleanup must remain
      visible and block replacement.
- [ ] Check keyboard, selection/copy, deliberate paste and line endings with known harmless inputs;
      active/hidden/modal input ownership and raw versus decorated display remain distinct. A device
      prompt observed by the app is not an SSH exit status.
- [ ] Arm a small Serial flow with the actual unique literal prompt, then script/Enter/Enter/script
      and repeated flows. Review exact payload previews before Run; verify fresh prompt/capture
      state and no unsolicited extra Enter, command replay or automatic confirmation.
- [ ] Run a controlled known large/fragmented response and compare raw retained/exported bytes with
      independently available target evidence where possible. Review receive timestamps/source,
      preview clipping, complete/incomplete state and full search/export. Host observations alone do
      not prove every emitted UART byte was received.
- [ ] Cancel during command output and between steps/repetitions; verify no later input without
      explicit rearm. Observe any target-side command continuation honestly. App cancellation cannot
      promise rollback or guaranteed remote process termination.
- [ ] Test authorized unplug/hotplug/target reboot/power-cycle and actual recoverable driver faults
      when safely available. Verify no automatic reconnect or replay, correct
      missing/busy/permission/settings/cleanup failure states and no host permission/driver changes
      by the app.
- [ ] Test actual SSH console mode only after it is implemented/published and separately authorized:
      cwd persistence (`cd` then `pwd`), normally initialized aliases/functions,
      changed/intermediate prompts and explicit Enter. Keep the manual Terminal separate and
      preserve genuine independent-exec exit behavior.
- [ ] Capture final source-specific native startup/update/repair/removal evidence only under the
      applicable explicit install/cleanup authorization. Do not treat this checklist as permission
      for Codex to install, uninstall, change access, connect to hardware or publish.

For every DUT item, keep actual pass/fail/not-run and concise reproduction details. Leave
unavailable hardware/driver/platform cases unchecked. Add discovered edge cases to the matrix before
claiming the final combined candidate qualified.

## Latest isolated correction outcomes

- Prompt-tail packet: Task/serial-fix-evidence/webkit-tail-latency-review.json; two files, patch
  SHA256 e6753f38285df28da3d325f2ec396641ef980404c4bb5c4499467ec0c518d214. Three sequential ordinary
  original UI matrices pass 27/27 with unchanged test/config/worker/deadline hashes. Focused checks
  46/46 and stored-Serial integration 33/33 include overlapping controls; two targeted old-parser
  controls fail as expected. Build/typecheck/format pass. Independent correction review accepted;
  the exact isolated 411-file composition also passes the original nine-case UI cohort. Final
  product gates remain.
- Initialization/versionchange packet:
  Task/serial-fix-evidence/capture-begin-versionchange-review.json; two files against the frozen
  410-source index candidate, patch SHA256
  9891f03f8c9fe7a3699c481e228bbb4472f2f1556a077195afb93ccb36d38cc9. Full lifecycle matrix passes 37
  cases/two existing actual-crash skips. Six old-source controls fail: all release locks early;
  commit calls the producer once in each engine. Corrected commit/abort cases retain both locks
  until settlement and call the producer zero times. Build/typecheck/format pass; independent review
  accepted and exact isolated composition passes 37 lifecycle cases/two unchanged crash skips.
  Original app adoption remains pending.
- The rejected receive-overlap experiment and an earlier restricted-context 39-pass/10-timeout
  native run remain retained rather than counted as acceptance. The final source passes the
  applicable 33 stored-Serial controls. The initial restricted Vite cache launch refusal is also
  retained; the authorized local fixture runs completed and no environment stall remains.
- These narrow outcomes do not close SSH, browser midstream-download feedback, graph, product
  heap/platform/DUT, installer or final publication acceptance. No exhaustive-proof claim is made.

## Accepted composition and bounded SSH preparation

Task/capture-accepted-integration/accepted-integration.json identifies the exact qualified 411-file
isolated source: 87 native passes, nine original ordinary UI passes, 37 lifecycle passes/two
existing actual-crash skips, desktop/web/gateway builds, strict typecheck/format and actual
sandboxed Electron IPC. See accepted-capture-integration-checkpoint.md. This closes durable tasks
2.2/4.1 and native queue 8.11/8.12 at isolated-composition scope, not root source adoption, product
index-mode/heap, every historical timing failure's exclusive cause or final release acceptance.

Task/serial-fix-evidence/ssh-console-contract-fixtures-review.json is a separately frozen four-file
preparation on that exact baseline: 26 focused passes, strict typecheck/build/format, model stateful
shell semantics, unchanged actual independent-exec ownership behavior, PTY refusal and exact
2,113,536-byte native-storage/quota feasibility. The pump is test-only stdout; production
both-stream credit/ownership/native/gateway APIs remain unimplemented. It has no shipping console
consumers or capability advertisement. Initial fixture/typecheck failures remain retained. See
../add-ssh-persistent-console-automation/ssh-contract-fixture-checkpoint.md.

Next applicable tests must exercise negotiated production SSH streams, both stream identities, slow
and full sinks, cancellation/late ACKs at every await, no-next-send after seal/outcome failure, and
explicit unsupported clients. Typed combined-PTY/context schema and compatibility need review before
console persistence, then dedicated-flow ownership/prompt/input/runner/UI/export qualification. Real
ash/PTY and Bruce's entire Windows 11 DUT checklist remain unperformed.

## Memory/resource audit and planned qualification layers

The independent read-only coverage audit confirms no general CI leak gate. Current CI uses Node 24
across platforms; existing bounds/cleanup/stress and 100-minimize Windows/macOS checks do not
establish whole-app memory qualification. The Serial desktop-smoke listener assertion has no
package/workflow caller. The standalone 64-MiB forced-GC capture fixture is excluded from the
tests/*.test.ts package script and not CI; its historical retained-heap/ArrayBuffer checks start
after 8 MiB and end before close, with no asserted peak RSS/external/native/browser/Electron or
repeated-soak coverage. A previously reported 305,288-byte retained heap is fixture evidence only.

See memory-resource-qualification.md for concrete fast regression and longer soak work. New fast
production SSH tests must count owned connections/channels/readers/ACK waits and include store close
and fixture teardown. Final applicable qualification repeats connect/disconnect, run/cancel/rearm,
transport/page switch and unmount, capture/search/export/clear, plus graph lifecycle when
implemented. Record native/main/renderer/browser heap, buffers/external and RSS separately through
warm-up, work, store closure and full shutdown. Forced GC is diagnostic; intentional local result
files and reusable caches are separate from unreachable memory. Derive budgets/trends from matched
repeated baselines, preserve failures and avoid arbitrary RSS limits or a zero-leak claim.

Tasks 4.7/4.8 remain unchecked. This addition records the audit and plan, not executed whole-app
leak qualification. Source-specific production SSH test outcomes will be linked separately. No CI
workflow dispatch, runner purchase, dependency install or DUT access occurs here.

## Functional SSH milestone and remaining memory/CI work

See production-ssh-streaming-checkpoint.md and
Task/serial-fix-evidence/ssh-independent-stream-review.json for the exact 430-file production
candidate (28-file delta; patch SHA256
677239e7c20ac83e3690787f52886adcb14aa3adfa629a1066975b85aa4d73aa). Final ordinary Node 24 run passes
45 cases; >32-MiB stdout/stderr hashes, actual sandboxed Electron IPC and all three browser SSH
cases pass, alongside nine unchanged ordinary Serial UI cases and desktop/web/gateway builds. Raw
seal/outcome/actual close/queued cancellation and stale navigation-start fences are implemented.
Independent review and original application source adoption remain pending.

Implemented focused resource assertions: 40 deterministic producer cycles and eight real loopback
connect/disconnect cycles, joined channel/session close and store close/reopen, with unforced
heap/external/ArrayBuffer/RSS diagnostics. These tests are in the existing npm test glob, but no CI
was dispatched; no general calibrated memory gate is complete. Growing disk records/cache and
unforced allocation samples are not proof of retained-memory plateau. A retained optional native
crypto process abort is still unexplained despite later ordinary success; task 4.9 remains open.

The independent plan Task/serial-fix-evidence/v0.6.0-memory-resource-regression-plan.md (SHA256
54cfc1acf99bbf84ecb7082cc39c9a47628c65ed874763b74d78cc9b922ea3cb) is now incorporated in
memory-resource-qualification.md and tasks 4.7/4.8: explicit serialized/calibrated Node fast gate,
hard teardown counters, warm-up and closed-cycle samples, opt-in leak negatives, ten-run
calibration, bounded diagnostics, then separate 30-minute normal/forced-GC desktop/browser/gateway
lanes with at least 100 cycles and graph after implementation. Those lanes, negative controls and CI
wiring remain planned, not executed. No zero-leak, complete whole-app memory or hardware acceptance
claim is made.

## Independent SSH review correction and final artifact profile gates

Independent review initially withheld the 430-file milestone for two confirmed bugs, then accepted
the exact six-file correction after verifying 431 files/132 artifacts and rerunning both probes.
Tasks 3.2/3.3 are restored at isolated accepted-source scope; original application adoption remains
open. See ssh-stream-review-correction-checkpoint.md and
Task/serial-fix-evidence/ssh-stream-review-correction-review.json. Do not erase the historical
packet or call a complete/zero-byte cancelled capture truthful when received bytes are known lost.

The focused regression set uses the real runner/backend/client/host/producer/writer and owned
temporary native storage: each preparation boundary, optional clock success/failure, both queued
watchdog orderings, healthy ticking preparation, unsent stdout/stderr, queued other-stream data,
in-flight durable IO/no double counting and interrupted delivery. Old-source negatives must fail on
behavior, never fixture readiness or timeout. Original probes remain runnable and unchanged. Console
extension stays paused pending review of this correction.

Before final v0.6.0 qualification, hash and inspect the exact desktop ASAR and unpacked payload and
actual gateway archive/fresh dependency tree. Assert sshcrypto.node/ssh2 crypto build and
cpu-features absence in both desktop locations; record actual dependency/runtime versions,
production backend module/loader provenance and crypto.bindingAvailable in that same context. A
failed ABI load is not evidence of binary absence. Gateway omit-optional alone is insufficient: the
documented fresh install also ignores build scripts. Historical v0.5.2 inspection and a staged
JavaScript runtime do not qualify a future artifact or arbitrary modified installation.

For each intended shipping profile run a small serialized bounded production set: connect, short
stdout/stderr, genuine nonzero exit, cancellation with pending data, raw/outcome/finalize fence and
disconnect/process exit. Retain byte/gap/resource/close receipts. Repeat long-output tests when the
changed path warrants it, not as a substitute for cancellation or artifact composition checks.
Native-addon support remains a separate explicit qualification decision with matched ABI/binary/
cipher/runtime identities and old-red/new-green evidence before any exact crash-fix claim. The
retained Node 24.21.0 abort remains unexplained. No runtime install/update or cipher-policy change
is implied; see the review report and memory-resource-qualification.md.

## Console component review correction

The separate five-file console component is not accepted: independent review reproduced a complete
capture with five retained/six observed bytes and command attribution for pre-write background data.
Its 436 sources/508 artifacts and the accepted 431-file independent SSH prerequisite remain frozen.
See ../add-ssh-persistent-console-automation/console-component-correction-checkpoint.md for the
separate 437-file candidate/five-file correction, 28 positive cases and seven exact-old-source
behavior negatives. Complete write/replay equality, greater/unknown counts, both pre-write
persistence boundaries, explicit preparation/dispatch, cancelled unsent intent and a delayed write
callback are focused gates. No broad qualification or public CI ran; integration remains isolated
and paused.

Local Windows/MSYS PTY availability was separately confirmed using installed winpty/Git Bash with
both stdin/stdout TTYs. Task/ssh-console-integration/local-pty-probe.json preserves the successful
built-in probe and initial missing-PATH-utility limitation. Linux/ash, normal-profile aliases and
end-to-end OS PTY fixture/platform/DUT evidence are not supplied by that availability check.

## Implicit console seal integrity follow-up

The original console completeness/context fixes are independently confirmed, with overall component
acceptance withheld for skipped outgoing idle verification. The two-file follow-up keeps the
437-file source count: native inputSent verifies the existing prefix before moving activeStart, and
two same-size CRC corruption regressions assert no successful outcome or second write. Thirty cases
pass; old-native controls yield exactly two expected behavioral failures and 28 passes.
Typecheck/format and exact probe evidence are in
../add-ssh-persistent-console-automation/console-idle-integrity-checkpoint.md. No broad
qualification or publication occurred; paused browser integration must implement the same fence.
