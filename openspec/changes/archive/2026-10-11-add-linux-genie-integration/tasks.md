# Tasks

Implementation resumed by the user on 2026-10-11, with subsequent approval for isolated WSL2
installation and qualification. Four verified test environments are now installed. Retain the full modern
target matrix and add Ubuntu 22.04/GNOME 42. Completed modern checks are historical evidence, not
legacy support; reopened delivery/detection/documentation checks need to cover both formats.
Disposable test installations are retained pending separate cleanup authorization; compact evidence
and the original SSH/default environment are preserved.

## 1. Establish native GNOME feasibility

- [x] 1.1 Build a small original compositor deformation prototype in an isolated GNOME session.
      Verify native frame minimize and dock restore with actual Diagnostic Hub terminal content,
      approximately 500 ms outgoing/reverse motion, intermediate frame evidence and no full-size
      restore flash before integrating production setup. Record native completion and hook behavior.
- [x] 1.2 Establish the qualification environments for Ubuntu 24.04/GNOME 46, Ubuntu 26.04/GNOME 50
      and Debian 13/GNOME 48, using real runtime/version checks. Verify nested Wayland and available
      X11 launch paths without modifying the user's desktop or existing Linux SSH test environment;
      record unsupported physical configurations and prerequisites honestly.

## 2. Implement the app-specific companion

- [x] 2.1 Add the original GNOME ESM companion with app-only native minimize/restore routing and
      runtime capability gates. Verify real GNOME native completion, saved normal/maximized bounds
      and an untouched non-target control app with the same visible title.
- [x] 2.2 Add stable Linux application identity, matching packaged/per-user desktop entry and owned
      icon registration. Verify actual Wayland application ID and X11 window class resolve to
      Diagnostic Hub and that the registered launch path survives temporary AppImage extraction
      cleanup, including a path with spaces.
- [x] 2.3 Implement fresh GNOME app-icon/dock geometry and upright four-edge deformation. Verify
      real matching anchors, icon reorder and dock relocation before restore, scaled/negative-origin
      display cases, and native fallback when no safe anchor exists; keep fixture and physical
      evidence distinct.
- [x] 2.4 Implement cancellation, bounded recovery, reduced-motion handling and disable/unload
      cleanup. Verify rapid minimize/restore, resize, app close, missing rendering, conflicting
      routing and extension disable leave the owned actor usable with exactly one native completion
      and no idle timeline or retained window image.
- [x] 2.5 Add a read-only live companion status endpoint with embedded release/build identity.
      Verify active versus installed-but-stale code, no window-control methods, and full endpoint
      cleanup on disable.

## 3. Package verified release integration

- [x] 3.1 Package the versioned companion ZIP with fixed UUID, allowed shell majors and immutable
      build identity. Verify exact allowed contents, original source parity, metadata/version and
      checksum; reject links, traversal and unexpected archive members.
- [x] 3.2 Extend the release asset list, Linux artifacts, checksum generation, release validation
      and publication configuration together. Verify a complete staged app/companion asset set at
      one tag/source commit and failure for missing, mismatched or stale artifacts without
      publishing. Include the separately validated legacy companion when GNOME 42 is implemented.

## 4. Extend the one-line Linux setup

- [x] 4.1 Add running-GNOME session/version/capability detection and optional setup modes to the
      existing helper. Verify the default one-line flow offers setup on supported GNOME; other
      desktops, unsupported shells, `--no-genie` and `--download-only` make no optional desktop
      changes. Select legacy versus modern packaging from the actual running shell.
- [x] 4.2 Add one understandable consent step listing missing apt prerequisites and per-user
      changes. Verify accept/decline, missing sudo, no terminal, apt failure and library recheck;
      elevation is limited to package installation, no desktop is installed and optional failure
      still permits an otherwise runnable app to launch.
- [x] 4.3 Fetch and validate the companion from the app's exact selected tag, then atomically
      install only managed files. Verify corrupt checksum, wrong metadata, archive attacks,
      symlink/ownership collisions, network failure and older releases preserve the prior managed
      version and ordinary verified app; test both AppImage and archive formats.
- [x] 4.4 Persist only the owned extension's accepted enablement and report live active/pending,
      skipped, unsupported or failed state. Verify first installation, cached update, globally
      disabled extensions and next-login activation without an automatic restart/logout, false
      success, changes to other extension IDs or repeated installation prompts.
- [x] 4.5 Add documented managed disable/removal and report actual installed bytes separately from
      system prerequisites. Verify repeat setup, version change, rollback and removal preserve
      unrelated extensions, desktop entries, app downloads and device data.

## 5. Qualify native behavior and continuity

- [x] 5.1 Add meaningful unit/downloader tests for compatibility, geometry, identity, verification,
      consent and activation/rollback outcomes. Run formatting, type checks and the relevant Linux
      downloader/unit suite with tests that fail when these contracts are broken, including legacy
      format selection and rejection of cross-format metadata.
- [x] 5.2 Add dedicated GNOME compositor qualification for the targeted Ubuntu/Debian runtime
      versions, retaining the existing Linux package/native fallback job. Verify native actions,
      intermediate frame deformation, dock/maximized restoration, target isolation, reduced motion,
      disable recovery and 100 native/resize/interrupt cycles in actual GNOME; do not count Xvfb
      alone or mocked actors as this gate.
- [x] 5.3 Extend real-app loopback SSH qualification under GNOME. Verify the same connection/PTY,
      sustained terminal output beyond the stall deadline, live collection and connected/simulated
      run identity survive native minimize/restore, with no replay, duplicate requests or resets;
      verify clock/visibility refresh and eligible focus on return.
- [x] 5.4 Build and verify the Linux packages plus companion, run the one-line first-install/update
      flow in isolated targeted desktops, and exercise existing Windows Genie and browser checks.
      Record any unqualified physical configurations without marking their checks complete.

## 6. Document and finish

- [x] 6.1 Update linked download/usage/development guides with the supported GNOME matrix, optional
      install prompts, first-login/update activation, fallback, removal and measured size. Verify
      commands and messages match observed behavior and keep the README concise. Include Ubuntu
      22.04 only when its independent legacy qualification has passed.
- [x] 6.2 Record qualification evidence and clean only owned generated test/build/prototype output.
      Verify dependencies, source, private planning/evidence and the existing Linux SSH server
      remain; validate this OpenSpec change and retain explicit unchecked criteria when evidence is
      missing.

## 7. Add Ubuntu 22.04 without narrowing the full matrix

- [x] 7.1 Recreate disposable qualification environments after the requested cleanup and establish
      Ubuntu 22.04/GNOME 42 Wayland and available X11 prerequisites with actual runtime checks.
      Preserve the existing Linux SSH server and retain the GNOME 46/48/50 target environments.
- [x] 7.2 Implement the original GNOME 42 legacy entrypoint and required compositor/runtime API
      adapters, sharing deformation rules with the modern implementation. Preserve app-only routing,
      native completion, read-only build status and bounded cleanup; do not merely widen modern ESM
      metadata.
- [x] 7.3 Add the separately named release-matched legacy ZIP, strict source/content/build checks,
      manifests, checksums and helper selection. Verify consent, first installation, cached updates,
      both app formats, rollback and removal without disturbing the modern integration contracts.
- [x] 7.4 Add dedicated GNOME 42 compositor CI and complete the entire GNOME 42/46/48/50 matrix.
      Require visible intermediate frames, 100 native/resize/interrupt cycles, real SSH/PTY and
      connected/simulated run continuity, one-line setup/update and all relevant failure cases.
      Resolve GNOME 50's black output or use a working isolated Linux desktop for visual evidence;
      callbacks alone must not pass the visual gate.

## Continuation source milestone - 2026-10-11

GNOME 42 legacy modules are generated from the existing owned effect and geometry, with legacy
imports/lifecycle and byte decoding. Separate legacy ZIP identity, checksums, Linux manifests,
release gates, isolated installer selection and GNOME 42 Wayland/X11 CI definitions are implemented.
Ordinary GNOME 42 setup remains gated until compositor qualification passes. This source work does
not complete tasks 7.1-7.4 or the reopened acceptance tasks: no GNOME installation or actual
compositor qualification was performed. Modern behavior and all existing unchecked criteria remain.

## Approved runtime milestone - 2026-10-11

Four isolated WSL2 targets were recreated from verified official images; package services stayed
blocked and the original SSH/default distro was preserved. GNOME42.9 passed Wayland and X11
qualification with actual nonblank/differing frames, 100 native cycles, fresh dock anchors,
bounded cleanup, real Bash PID/PTY continuity, connected/simulated software run identity and
automatic focus. This completes environment preparation and the independent legacy adapter
checks in7.1/7.2. Modern46/48/50 qualification and actual helper/cache/both-format contracts remain
open. See .codex/gnome-qualification/runtime-2026-10-11.md for provenance, evidence paths and
the remaining Linux unit resize-observation failure. No physical qualification or publication
is claimed. Cleanup awaits separate authorization.

## 8. Explicit stability qualification requested by the user

- [x] 8.1 Extend isolated stress qualification with at least 200 rapid/repeated size changes across
      100 native minimize/restore cycles, resizing during both animation directions, interruption,
      reversal, maximize/restore and competing owned window actions. Overlap sustained software
      PTY output, collection/clock refresh and connected/simulated test activity. Require bounded
      native recovery within 3 seconds and record responsiveness/IPC delays, frame cadence,
      p50/p95/max transition times and any missed timing criteria. Inspect app/compositor crash
      logs, unhandled errors, stale actors/effects and process/session continuity; reproduce and
      fix observed issues, then rerun affected checks. These are finite nested-WSL/software tests;
      retain explicit physical GPU/display and untested responsiveness gaps.

## Second runtime checkpoint

The complete detached Linux suite passed145/145 after replacing a fixed30ms resize observation
with a bounded assertion of the actual exact120x40 SSH receipt. The affected Windows test passed
3/3. Modern fixture module detection was corrected after GNOME46 exposed a removed legacy config
module. GNOME46.0 and48.7 Wayland passed100 native cycles,8 actual frames, real PTY and connected/
simulated identity/focus continuity. GNOME50.1 passed native callbacks/state checks but FAILED
actual visual qualification because external frames were black. It is not a supported visual pass.

Actual one-line helper/AppImage/archive launches, per-user installation, repeat-without-prompt,
controlled update/pending activation and managed removal preserving downloads passed on GNOME42
and46 X11. Update tags/manifests are controlled local release fixtures using real current app bytes;
genuine second-version app update/next-login qualification and helper Wayland observation remain
open in7.3. GNOME46/48 X11 native stress and GNOME50 visible output remain open in7.4. The newly
requested extended stability gate8.1 has not been run or marked complete.

## Fourth runtime checkpoint

Task7.3 complete: genuine locallybuilt RC4-to-0.2.0-rc.5-qualification.1 AppImage/archive updates on GNOME42 X11 passed, both pending in cached session and active in a fresh isolated session without another prompt or registration change. Matching original legacy/modern ZIPs, immutable checksums/build/version, rollback/removal and modern contracts retain prior tested evidence. Transport is an explicit local fixture; no public release or physical/GDM login claimed.

GNOME46/48 X11 and46Wayland passed complete extended stress/PTY/collection/connected+simulated focus/identity gates. GNOME48Wayland completed100stress400resizes373actualchanges but FAILED saved-normal-bounds against nativecontrol (1100x760 expected versus1122x785 actual); preserve exact comparison. GNOME50baseline actually renders targetUI and has a nonzero effecttexture duringmotion, but visibledeformation remains unqualified. Tasks7.4/8.1 remain open. Runtimehandoff has measuredlimits and repeatedteardownlogs.

## Fifth runtime checkpoint - 2026-10-11

Task 2.5 complete independently of visual motion: real session-bus introspection permits only
GetStatus on the owned interface; completed GNOME42/46/48 real-app runs verify endpoint disappearance
on disable. Both genuine GNOME42 app-format updates report installed-but-stale/pending activation,
then active matching embedded version/commit/source hash in a fresh isolated session. Modern
controlled update/status evidence is retained. No window-control method is exported.

GNOME48Wayland targeted bounds controls passed five exact enabled/disabled comparisons, and another
five after 100 rapid interruption/resize cycles. Actual compositor-approved rectangles were
1100x780 before the ordinary controls and1100x755 after stress; requested1100x760 does not alone
establish the acknowledged frame. The original full-sequence1100x760-to1122x785 failure remains
unresolved until its exact rerun and frame/buffer/actor observations are reviewed. Equality gates
remain exact; no production geometry change or tolerance was introduced.

GNOME50 supported native texture export now succeeds after fixing the diagnostic Gio file API.
Outgoing offscreen PNG contains actual app UI; incoming PNG contains title bar but lacks app body.
This narrows surface capture/repaint investigation; it does not establish visible deformation.
Full visual/stability/matrix and documentation acceptance remain open.

Final fifth checkpoint: the full48Wayland rerun passed exact1100x760 saved bounds,100stress+100normal
cycles400requests382observedchanges and complete continuity. Earlier1122x785 failure is retained;
no production fix was made, so intermittent geometry remains unresolved. GNOME50 outgoing realUI
texture but missingincomingbody and bothouterframes withouttargetdeformation leave visualgate open.
Task2.5 is independent and complete; total15/25, remaining2.2/2.4/3.2/4.1/5.2/5.3/5.4/6.1/7.4/8.1.

## Sixth checkpoint independent acceptance - 2026-10-11

Task5.3 complete from seven actual session/backend continuity reports:42-wayland-capture-rerun,
42-x11,46-x11-stress-finalfocus,46-wayland-measured-stress,48-x11-stress-finalfocus,
48-wayland-bounds-observed-full,50-wayland-loader. Each passes42orderedticks,unchangedremote
BashPID/PTY,oneconnection/channel,livecollection/clock,distinctretainedconnected/simulatedrunIDs
andeligibleautomaticfocus. GNOME50 continuity is independent of its failed visual gate; no
physical board result is claimed. Task6.1 complete from linked guides with truthful target/setup
gates,prompts,immediate-or-pending activation,fallback,removal and actual measured modern/legacy
sizes. Documentation does not establish release or visual qualification.

Tasks2.2/3.2/4.1/5.4 remain open:GNOME50 helper update resolves window:4;complete actual staged
Windows/Linux/companions/gateway/web/launchers set remains missing;ordinaryGNOME42setup is gated;
modern genuineupdate/freshsession and affectedWindows/browser acceptance remain incomplete.

Final sixth checkpoint:17/25 complete. GNOME50 flat offscreen drawing works but identity/half meshes
disappear on both actualapp andsolidwidget;identicalGNOME46mesh renders. Alternate softwareMesa
observed-paint route still failsmesh. GNOME48fullmixedrerun passes exactbounds andcontinuity;
filtered5000configure/ackrecordsretained butinitialclient/GJStracesempty,correctedsource needsrerun.
No productionfix orreducedacceptance. Nextturnxhighauthorized;runtimehandoff haspreciselimits.

## Eighth checkpoint independent identity acceptance - 2026-10-11

Task2.2 complete from actual X11 identity on42/46 (diagnostic-hub class and diagnostic-hub.desktop
Shell registration), both-format per-user desktop/icon/path-with-spaces checks, and new actual
mapped Wayland helper/managed Gio.desktop launches on46/50 AFTER helper exit/extraction closure.
GNOME46 also passes genuine RC4-to-RC5 qualification AppImage/archive cached pending and fresh-session
active updates; GNOME50 controlled updates use RC4 bytes and explicit fixture identity. Separate
post-extraction Gio launch on X11 is unrecorded but is not an additional per-backend requirement in
2.2. Exact evidence and preserved failures are in the eighth runtime handoff checkpoint.

GNOME50 actor-owned OffscreenEffect layer now visibly renders actual deformed app content, including
after ordinary native restore. This is a static software rendering control, not native Genie motion
qualification;2.4/5.2/7.4/8.1 remain open. GNOME48 intermittent bounds failure/trace preserved without
an identical rerun.3.2 still lacks complete actual staged assets/required manifest fields;4.1 legacy
public setup remains gated;5.4 retains full matrix and affectedWindows/browser gaps. Total18/25.

## Current production closure audit - 2026-10-11

Tasks 2.4, 4.1 and 5.2 are complete for the recorded isolated software scope.

- 2.4: All seven current production workload cases passed exact native state and bounds checks,
  interrupted resize/reversal, reduced motion, conflicting routing, disable recovery and balanced
  effect cleanup. The six GNOME 50 lifecycle cases also passed actual app close, unavailable
  rendering, initialization failure, missing anchor and teardown failure. The original 500 ms
  timeline and 2 second responsive-main-loop watchdog remain unchanged.
- 4.1: The Linux downloader/companion suite passed 12/12, including actual running-shell selection,
  unsupported/skip modes, ordinary GNOME 42 first/repeat offers and cross-format rejection. The
  ordinary GNOME 42 AppImage install/repeat/genuine update and fresh-session activation passed.
  The ordinary GNOME 48 AppImage install/repeat/genuine update also passed. Previous modern helper
  selection evidence remains applicable; genuine both-format update completion is tracked in 5.4
  and 7.4.
- 5.2: The current production companion passed all seven GNOME 42/46/48/50 backend workload cases,
  each with 100 interrupted and 100 normal cycles, 400 resize requests, actual intermediate frames,
  exact bounds, target isolation, fresh dock/reorder, reduced motion, disable recovery and real
  PTY/run/focus continuity. GNOME 50 also passed actual four-edge first-frame visual acceptance.
  The tested production observation fixtures and controlled session are now in the repository;
  their formatted JavaScript/TypeScript compile to byte-identical code. The dedicated CI matrix
  now enables the existing stress path, uses the qualified GL renderer and declares GNOME 50's
  WirePlumber prerequisite. Hosted CI execution is not claimed.

Tasks 3.2, 5.4, 7.4 and 8.1 remain open. Genuine GNOME 48 archive and GNOME 50 both-format updates,
fresh-session activation, final required software verification and immutable asset parity remain.
GNOME 48's retained bounds failure and GNOME 50's earlier loaded timing failures remain unresolved;
current passes do not establish their causes. Physical GPU/display/device checks remain unqualified.
See .codex/gnome-qualification/runtime-2026-10-11.md and the private task checkpoint for exact
measurement, source hashes, evidence paths and the storage blocker. No commit or tag was created.


## Matrix closure and current-source final audit - 2026-10-11

Task 7.4 is complete for the recorded isolated software scope. The dedicated seven-case CI matrix
covers GNOME 42/46/48 Wayland and X11 plus GNOME 50 Wayland. All seven current-production runtime
cases passed actual intermediate frames, exact bounds, 100 interrupted plus 100 normal cycles,
400 resize requests, real PTY and connected/simulated identity/focus continuity, and native failure
contracts. GNOME 50's four-edge incoming/outgoing visible acceptance and six lifecycle cases passed.
Genuine AppImage/archive helper updates and fresh-session activation are complete on 42/46/48/50.
Hosted CI execution is not claimed; physical GPU/display/device configurations remain unqualified.

Final verification passed from a hash-inventoried current source copy: Windows formatting/typecheck
and 130 unit passes with 15 Linux-only skips; clean detached Linux formatting/typecheck and all 145
unit tests passed, without skips. Failed sandbox and inherited-terminal runs are preserved and are
not the qualifying runs.

Tasks 3.2, 5.4 and 8.1 remain open. Current-source validation rejects both companion ZIPs in the
older complete dirty stage; separately qualified production ZIPs pass. The fresh 96-source/4-config
comparison differs in extension.js, legacy-entry.js and public/download-run.sh. The downloader
change also affects the bundled dist/download-run.sh asset, so current Linux packages still need
refresh and verification. The old stage is not relabeled as current or immutable. A complete asset
set at a new approved source commit/tag is still absent.

The exact GNOME 48 1100x760 paired control passed ten comparisons after both routing modes' full
resize/native lead-ins, but did not reproduce the retained 1122x785 failure. New GNOME 50 diagnostic
misses (123.888/124.546ms loop p95) were isolated to newly added synchronous progress writes: removing
only those writes passed at40.008ms without tracing and43.070ms with full tracing. This explains
those new diagnostic misses, not the historical private-layer heavy-load failures. Their causes
and the historical GNOME 48 failure remain unresolved in8.1. No original timing criterion changed.

No commit/tag/push/publication/hardware operation occurred. Current-source package builds remain
subject to the4GiB reserve and approved conditional per-test-disk compaction; no further deletion
is authorized. Details and immutable source/parity evidence are in the private runtime handoff.


## Practical stability acceptance after user clarification - 2026-10-11

Task 8.1 is complete for its specified finite isolated software workload. The user clarified that
an exact historical root cause is not required when corrective changes and representative regression
coverage support practical resolution. The current production implementation includes hardened owned
effect disposal/work cleanup and GNOME 50 actor-owned rendering, allocation guards and stage redraw.
All seven production backends pass the unchanged 100 interrupted plus 100 normal cycles, 400 resize
requests, exact bounds and native/PTY/collection/clock/connected+simulated continuity criteria.

GNOME 48 Wayland current production specifically passes the original [0,32,1100,760] normal-frame
comparison, including the negative-origin CSD buffer and stale actor-allocation condition. The exact
paired 1100x760 control also passes ten remaps after both routing modes' full workload lead-ins.
GNOME 50 passes actual four-edge first-frame output, six lifecycle/failure cases and full-trace stress
at 43.070 ms loop p95 / 413.008 ms maximum recovery, without changing the 100 ms / 3 second limits.

This accepts current production behavior in the qualified workload, not a proved historical causal
explanation. Original failures and diagnostic limitations remain preserved. Concurrent browser/build
overload, physical GPU/display/device configurations and higher GNOME 50 native resource scales remain
explicitly unqualified; this task already requires those responsiveness/physical gaps to be retained.
See practical-stability-acceptance-1244.json and the runtime handoff for precise scope and evidence.

Tasks 3.2 and 5.4 remain open. Corrected current-source Linux packages pass full compiled/static
payload parity across AppImage/archive/unpacked, exact bundled downloader checks, both companion
checksums and all eight packaged runtime dependencies plus react-dom/client. The first private
symlink-based dependency collector omitted transitive/native modules; its artifacts and failure
are preserved, and the corrected physical hardlink staging uses existing installed files without
installation or dependency content changes. Fresh packaged UI/SSH acceptance and complete current
asset/source-commit identity remain pending. No local commit/tag was created at this checkpoint.


## Historical issue resolution reconciliation - 2026-10-11

Task 8.1 is reopened. The previous practical acceptance correctly records successful current finite
software qualification, but its closure was too broad for the clarified requirement that historical
failures be demonstrated resolved under their conditions. Unknown root cause alone is not a blocker.

GNOME 48 passes the exact original rectangle and substantial unchanged stress/native-control
regressions, but the intermittent drift was not reproduced and no demonstrated specific corrective
mitigation was identified. GNOME 50 has meaningful corrective rendering/cleanup changes and passes
current workload/lifecycle/visual checks, but the original concurrent browser/build overload was not
recreated or equivalently covered. The original cycle31 report also lacks failure actor/native-set
state. None of these original historical failures is confirmed resolved by the existing evidence.
The newly established synchronous diagnostic-write timing cause is a separate finding.

All successful current software qualification is retained. No unconditional fix claim or acceptance
waiver is made. See historical-issue-resolution-assessment-1302.json for issue-by-issue changes,
equivalence, exact evidence and remaining gaps. Conditional local commit/tag prerequisites remain
unmet until 8.1 has supported historical-resolution acceptance or explicit user direction.


## Accepted historical caveat and current package completion - 2026-10-11

Task 8.1 is closed for the qualified finite software scope by explicit user acceptance after the
issue-by-issue historical assessment. The user was told that original historical GNOME 48 bounds
and GNOME 50 concurrent-load/cycle31 failures are not confirmed resolved and replied, "got it.
those problems should be minor. lets keep moving forward." This is acceptance of proceeding with
the disclosed residual risk. It is not evidence those historical failures are fixed, reproduced,
or equivalently covered. The historical-resolution assessment and failed artifacts stay retained.
All current production matrix, exact-bounds, visual, lifecycle and workload results still stand;
original thresholds are unchanged. Physical GPU/display/device and higher-scale gaps remain open
qualification limits. This explicit direction supersedes the previous conditional closure blocker.

Task 5.4 is complete for the isolated software scope. Corrected current-source Linux AppImage and
archive both passed actual packaged UI, isolated bridge, SSH collection, trusted-key replacement/
cancel/reuse, report export, disconnect and native update/restart checks. The test harness previously
placed the extraction flag after Playwright's injected inspector arguments, causing a FUSE launch
failure before the app started; desktop-smoke now sets APPIMAGE_EXTRACT_AND_RUN for actual AppImage
launches. No FUSE installation or production app change was needed. Both production companion ZIPs,
compiled/static payload parity and nine packaged runtime import checks pass. All GNOME 42/46/48/50
genuine both-format helper updates and fresh-session activation, existing Windows Genie/portable
checks and browser acceptance were completed in the retained evidence. Physical checks are not
claimed complete. Current Linux evidence: current-packaged-ui-ssh-1307.json and its two logs.

OpenSpec is now 24/25. Task 3.2 remains open for a complete asset set tied to one new clean source
commit/tag, including stale/missing/mismatch negative validation. Current corrected Linux packages
are dirty-snapshot qualification artifacts at RC4 ancestry; they are not immutable RC5 delivery.
The existing RC4 tag stays unchanged. No push/publication/deployment/hardware operation is authorized.


## Complete immutable local RC5 asset qualification - 2026-10-11

Task 3.2 is complete. The reviewed 51-path source change is committed locally as
9df99457dae3bc4317b83f32912875c10979a989, tree b8d32a9bdae04d22e88458c30e0ee75d6338b19a,
with annotated local qualification tag v0.2.0-rc.5 (object b936f8eb8d2e922c73b4d691b142afd384a46a35).
All 255 frozen source files independently match the actual committed Git blobs. The three unrelated
browser test edits remain unchanged and uncommitted. The existing RC4 tag is unchanged; nothing was
pushed, published or deployed.

The complete nine-asset set is in the task's rc5-immutable-1340/complete-release/release directory:
Windows portable, Linux AppImage/archive, modern/legacy42 companions, portable website, gateway and
two launchers. Both platform manifests identify this exact commit/version/tree, and every checksum
sidecar plus SHA256SUMS matches actual staged bytes. Current companions validate against exact
committed sources. The staged web files, gateway version/lock/compiled output and launcher bytes
match their actual build outputs. No dirty-snapshot or ancestry-only identity is accepted.

Final selected-source verify passed Windows formatting/types/130 tests with 15 Linux-only skips and
Linux formatting/types/all145 tests. Fresh Linux formats pass actual sandbox-enabled packaged
UI/SSH/export/update/restart checks; ASAR and native resources match across both formats/unpacked,
with all nine packaged runtime imports verified. Fresh Windows package/native/renderer/brand-icon
and RC5 metadata checks pass; all110 actual portable-extracted files match. Actual portable UI/SSH/
export/update and native Genie geometry/security/recovery/minimized35-second PTY/run continuity pass.
The existing seven-case GNOME software matrix and qualified helper flows remain applicable.

The complete set passed the official release validator. Eight official negative cases reject missing
assets, stale Windows manifest, mismatched Linux commit, checksum mismatch, stale modern companion,
stale legacy companion, changed companion source despite recomputed transport checksums, and legacy
substitution under a modern name. A separate immutable-build-output provenance gate rejects the
actual old Windows binary; the official validator is not credited for that separate payload check.
Original build/staged bytes remain unchanged after all nine rejection checks. Failed preflights and
historical failures remain preserved with their correct status.

OpenSpec is25/25 complete for the authorized isolated/local scope. Historical GNOME bounds/loaded
cycle/timing failures remain unconfirmed resolved; explicit user acceptance of proceeding with the
disclosed caveat is retained. Hosted CI and physical GPU/display/device qualification are not claimed.
No software installation, push/publication/deployment/hardware action accompanied this final phase.
Evidence: rc5-complete-release-gates-1410.json, rc5-final-committed-source-proof-1415.json and the
rc5-selected-{windows,linux}-verify / rc5-{linux,windows}-build / rc5-{linux,windows}-packages logs.
