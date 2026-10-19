# Local implementation evidence

2026-10-13. Change: add-serial-and-network-insights. Baseline main
0344878ad9b6d0fc54d53923b03771fea8d905f3, package 0.4.0. Source remains local and uncommitted. No
push/tag/deploy, dependency change, physical port open, real target execution, host
permission/security change or release asset/history mutation occurred.

## Implemented scope

- Independent local Serial page, explicit selection/open/close/deselect, framing/echo/ending,
  generation ownership, bounded byte streams and cleanup watchdog; narrow Electron
  chooser/permission/update quiescence.
- Readable WLAN/LAN summaries with separate status/capabilities, per-command raw
  evidence/errors/omissions, fixed getter inventory, queue/group limits, topology cache, exact
  counters, MLO/peer/frequency separation and reduced legacy fallback.
- Sun-only soft pixel beach with pig/duck/volleyball/waves/sand/trees; pointer-safe,
  reduced-motion/hidden pause; original SSH art preserved.
- SSH/Serial Automation ordered named/enabled multiline steps, duplicate/reorder, immutable run
  drafts, explicit byte preview, immediate/strict optional wall-clock starts, elapsed delays and
  off-by-default repetition. Verified SSH clock source/refresh, stale/jump/timezone/sleep/disconnect
  guards; Serial scheduling uses local clock unless a verified provider exists.
- Isolated bounded SSH exec/raw/real exits, exclusive Serial literal-prompt capture with honest
  ambiguity; bounded result table/filters/selection/autoscroll and local JSON/CSV/Markdown/text
  exports. Timing/framing execution snapshots and timestamp provenance are retained, credential
  metadata is allowlisted, no export reexecutes.

## Verified evidence

- Final full unit suite: 207 tests, 196 passed, 11 Windows platform skips, zero failures. Final
  Automation/network focused batch: 27 passed; Serial session batch: 8 passed.
- Full browser suite: 107 passed / one Linux Bash PTY skip on Windows. Subsequent final feature
  suite: all 10 passed; additional live WLAN focus/selection test passed.
- Portable production website: Chromium, Firefox and WebKit (3 passed), desktop/mobile nested URL.
- Final desktop/web/gateway builds and type checks pass.
- Final Windows native desktop proof: trusted IPC, SSH/PTY/clock/report export, host-key
  replacement/cancel/reuse, native resize/minimize/restore (3 cycles, latest 300ms), update
  checks/development install restriction. test:window-desktop aliases the same comprehensive desktop
  proof; dedicated AppImage relaunch test is Linux-only and was not run.
- Electron44.5.1 sandboxed app:// Serial proof: secure API, renderer Node undefined, no authorized
  ports; trusted top-level only; unrelated/subframe/opaque/other types denied; stale/removed offered
  IDs rejected; single chooser callback; temporary listeners removed; stale cleanup ack
  rejected/missing ack stops update. Zero physical opens and persistent grants. Proof saved in
  task/feature-evidence/serial-native-proof.json.
- Native Automation proof on real packaged app/bridge passed: one loopback synthetic multiline
  script, Unicode/raw capture, genuine exit 7, actual local exported JSON file, stale-connection
  rejection and exclusion of credentials/session token. It used the Chromium sandbox and zero
  physical opens. The initial Playwright download-event observer timed out despite the real file
  being written; the corrected proof asserts the saved file. No product API workaround was needed.
  Proof/screenshot: task/feature-evidence/automation-native-proof.json and automation-native.png.
- Maintained tracked/new source formatting passes. npm run verify stops in its global formatter
  because 60 preserved ignored historical .codex/OpenSpec files are unformatted. Those artifacts
  were deliberately retained; type/unit gates were run independently. No feature file was flagged.
- Strict OpenSpec validation passes with six delta capabilities and all four planning artifacts
  present. Implementation tasks now reflect local evidence; physical acceptance is still unchecked.
- git diff for tests/ui/live.spec.ts remains exactly the user's original four-line history-worker
  poll. Main/HEAD/version unchanged; workflows/package-lock/release trees have no source edits.

## Artifacts

Repository local-only change:
openspec/changes/add-serial-and-network-insights/{proposal.md,design.md,tasks.md,automation-draft.md,cleanup-audit.md,implementation-evidence.md,specs/}.
User docs: docs/{serial.md,network-insights.md,automation.md};
architecture/hardware/usage/development/website/README references reconciled. Screenshots:
C:/Users/bruce/Desktop/Codex/2026-10-13/task/feature-evidence/{serial-desktop.png,serial-mobile.png,serial-reduced-motion.png,wlan-summary.png,lan-summary.png,lan-mobile.png,automation-serial.png,automation-mobile.png,automation-ssh.png}.
Cleanup: six pre-feature generated trees (~3.5MB) were recoverably quarantined to
task/v040-cleanup-quarantine; inventory.json lists exact source/destination/file counts/bytes.
release/, .codex evidence/recovery bundle, archived specs, dependencies, tags/history and reusable
release tools remain intact. Hardcoded .github/workflows/release-recovery.yml is the sole actionable
retirement-review candidate; it remains untouched because retiring it affects recovery tooling.

## Remaining qualification and delivery

The one outstanding task is separately authorized physical UART/adapter/OS/control-line/unplug/busy
qualification and actual Linux iw/ip/driver/BusyBox evidence. Windows mocks do not establish
Linux/macOS adapter behavior. Serial received timestamps cannot prove arbitrary-console latency;
verified device-clock starts are unavailable on that transport, with local timing usable.
Source/provider uncertainty and prompt ambiguity are documented product states. Recommended target:
v0.5.0-rc.1 qualification, then v0.5.0. Keep source changes in reviewable logical local commits
(network evidence/parser/UI; Serial/native lifecycle/art; Automation/scheduler/exports; docs/tests),
explicitly excluding the user's live edit and ignored OpenSpec artifacts. A later authorized
consolidated push can run unchanged maintained CI gates; investigate concrete failures before
workflow tweaks. Version/tag/assets/publication remain separate authorization.

## Final review and scoped corrections (2026-10-13)

All four P2 findings are fixed: SSH signals/unknown close retain termination evidence and pause
further work (ordinary nonzero exit still continues); C0/C1 export controls are safe throughout
human-readable headers/metadata/body while JSON remains exact; scheduled Run once honors
start/delays and does not repeat; execution boundaries validate IANA zone, separate offset,
wall-time/instant consistency and all supplied metadata, including rejecting local calibration.
Post-fix checks: 23 Automation unit cases and 5 Automation browser cases pass, type/source
formatting and desktop/web/gateway builds pass. Refreshed sandboxed native proof exercises actual
loopback SIGTERM metadata through trusted IPC, skips the next step and exports termination evidence.
Full-suite receipts above are pre-review; no duplicate full suites were run. Review receipt with
exact file manifest, all 60 formatter paths, dependencies and screenshot paths:
C:/Users/bruce/Desktop/Codex/2026-10-13/task/feature-evidence/final-review.json. Aggregate npm run
verify remains failed at prettier --check .: 13 GNOME evidence/helper files, 39 archived OpenSpec
files and 8 canonical specs; configuration predates this feature. A narrow exclusion can be reviewed
but was not applied. Quarantine exact size is 2,736,173 bytes / 39 files, correcting the earlier
rough estimate. All six trees match inventory and every file was hashed/read; fresh outputs
currently occupy their original locations. Retiring the 209-line historical recovery workflow
remains an unapplied checked patch; a retained historical allowlist references its path. No other
current workflow/user docs do so. Screenshot upload through the supported helper was unavailable
before preparation; no Library IDs or delivered attachments exist. Ten PNGs remain local.
Fixed-header/backdrop positions in some full-page screenshots are capture presentation artifacts;
the physical/native viewport and mobile layout gates remain valid. Physical qualification is still
pending, and source/history/user edit are preserved.

## Final-source verification closure and local preview (2026-10-13)

This section supersedes the pre-review aggregate/full-suite status above. The final code passed
`npm run verify`: formatting, TypeScript and 215 unit cases (204 passed, 11 platform skips, zero
failures). Full browser suite: 110 passed, one Linux-only Bash PTY skip. Production nested-site
portability: Chromium/Firefox/WebKit, three passed. Final-source sandboxed Windows desktop proof
passed native window transitions (three minimize/restore cycles), trusted IPC, update guards,
loopback SSH and report export. Affected Serial policy/lifecycle and Automation trusted IPC proofs
were rerun sequentially and passed. Serial created zero persistent grants and opened zero physical
ports. Automation preserved actual loopback SIGTERM, paused/skipped the later command, retained
ordinary exit 7, exact multiline Unicode and local JSON export, and rejected stale connections.

Formatter closure: .prettierignore adds only /.codex/ and /openspec/changes/archive/. Eight existing
canonical specs were formatted locally; normalized text and requirement/scenario headings are
unchanged. All 11 canonical specs plus this active proposal pass strict OpenSpec validation (12/12).
Current source and active OpenSpec artifacts remain checked. The user's tests/ui/live.spec.ts is
still exactly +4/-0; git diff --check passes. Main/HEAD/package version, published release assets,
Git history and dependencies remain preserved. No commit, push, tag or publication occurred.

Local unreleased Windows x64 preview:
C:/Users/bruce/Desktop/Codex/2026-10-13/task/preview-win/Diagnostic-Hub-Test-Preview.exe.
Launch-Preview.cmd provides an isolated preview-profile. README-TEST-PREVIEW.txt and
PREVIEW-INFO.json identify the unsigned uncommitted build, unchanged internal 0.4.0 baseline,
planned v0.5.0 feature qualification and NOT RUN / NOT PASSED hardware status. The published v0.4.0
bytes were not reused or overwritten. The packaged app passed empty-profile Serial/Automation
navigation, secure app origin/Web Serial exposure, absent renderer Node access, zero granted ports
and disabled Run/Connect. No connection, port opening, automation execution or fake observation was
used for preview inspection.

Receipts: task/feature-evidence/verification-closure.json, current-checkpoint.json,
canonical-format-review.json, preview-source-manifest.json, preview-packaged-proof.json,
serial-native-proof.json and automation-native-proof.json. The preview directory holds its SHA-256
and source-manifest digest. All remaining physical cases are explicitly unchecked in
hardware-qualification.md; the user's planned host is Windows 11 at work. Native Linux/macOS and
actual adapter/driver/read-only iw/ip observations remain unqualified here.

Automatic approval review rejected deleting only .github/workflows/release-recovery.yml because
explicit trusted human authorization for that deletion could not be verified. The file remains
present and its reviewed local retirement patch remains unapplied. No indirect deletion workaround
was attempted. This operational cleanup blocker is separate from the passing feature software gates.

Exact portable-wrapper launch also passed using a fresh profile and loopback inspection:
task/feature-evidence/preview-portable-proof.json and preview-portable-serial.png. Playwright's
direct Electron launcher could not attach through the portable wrapper (instrumentation timeout);
ordinary wrapper launch exposed its actual secure app window and passed the same empty-state checks.
No sandbox or host security change was used. HARDWARE-QUALIFICATION.md is copied into preview-win
for transfer with the test build. The final owned source manifest contains 71 files; the separate
user live edit remains untouched. Tracked diff including that edit: 31 files, +1460/-296; 41 new
feature files are separately recorded. No publication action or workflow deletion occurred.

## Authorized main preparation and CI push (2026-10-13)

The user explicitly deferred physical qualification to Windows 11 at work and authorized the next
v0.5.0 release once available software tests pass. The parent narrowed this stage to main push/CI
only, with no tag or publication. package.json and both root lockfile version fields now read 0.5.0;
all dependency entries remain byte/semantic equivalent. Local four-section docs/releases/v0.5.0.txt
records the feature scope and unverified hardware. The earlier isolated preview remains its original
unsigned 0.4.0-baseline candidate bytes, with explicit unreleased provenance; it was not
overwritten.

Post-metadata checks: aggregate verify again passed 204 unit cases with 11 platform skips (215
total), format/type checks passed, native Windows desktop/window/update/SSH/report smoke and
desktop/web/ gateway builds passed, and 17 focused workspace/update browser cases passed. The
previously completed full 110-pass/one-skip browser, 3-engine portability, Serial and Automation
native proofs remain valid for the unchanged feature code. Release-version verification passed with
v0.5.0 as the intended tag, without creating a tag. Release-note literal sections/meaningful links
and unchanged lock dependencies were independently checked.

The original user's v0.4.0 cleanup authorization was supplied and the same reviewed workflow
retirement retry was approved. Only the obsolete .github/workflows/release-recovery.yml was deleted;
reusable recovery modules/tests and the historical allowlist remain valid and preserved. This
resolves the earlier approval blocker; no indirect workaround was used.

One reviewed 75-file commit, 3666022c3fd073d50ea6dae99f2d6922c5662365, was pushed once to main. The
remote refs/heads/main SHA matches exactly. The user's four-line tests/ui/live.spec.ts remains
unstaged and byte-identical to the precommit receipt; local OpenSpec/.codex/.agents, all release
assets, evidence and histories were excluded from the commit. New-source main CI runs: Windows
38419397373; Linux 38419397401; native Mac x64/arm64 38419397372; website 38419398079. These are
pending checks, not passed qualification. The existing main workflow deploys Pages only after
website verification; no new release workflow/tag/publication was invoked.

## Reviewed UI revision and final local qualification (2026-10-13)

The parent accepted desktop/mobile screenshots after confirming unobstructed Serial framing controls
and Automation Next: Timing. Serial now uses full light beach framing, dark readable ANSI text, a
textured rotating sun and common/custom baud controls. Automation uses four guided steps with draft
preservation and independent running controls. Hidden floating mobile scroll buttons leave native
page scrolling available. The SSH terminal appearance and execution safeguards remain unchanged.
Screenshots and native/portable secure empty-state proofs are in task/ui-revision-after.

The native capture callback failure was reproduced in an isolated VM without transpiler globals.
Self-contained geometry expressions fix that serialization error while preserving the original
30000-ms budget, at most two PNG captures and native readiness guards. All six prior capture tests
remain; one actual serialized-callback regression was added.

Final local gates passed: format/type and 205 unit tests with 11 platform skips (216 total), 112
browser tests with one platform skip, all three production website portability engines, native
Windows Desktop/Serial/Automation tests and desktop/web/gateway builds. Native Serial opened zero
physical ports and created zero persistent grants. Automation used only loopback software fixtures;
no standalone mock SSH service, actual DUT command or hardware connection was used. The preserved
four-line user edit is included in local browser qualification but excluded from the commit.

The user expressly authorized permanent deletion of two obsolete preview executables and their two
unpacked build directories. Only those four exact targets were removed: 206 files totaling
1063010165 bytes. Profiles, screenshots, proofs, source, dependencies and published release assets
remain. Earlier preview paths in this chronological evidence are now absent and are not current
downloads. Receipt: task/ui-revision-after/preview-cleanup.json. Final gate and source-hash receipt:
task/ui-revision-after/final-local-qualification.json. Physical acceptance remains explicitly
deferred.

## Windows gateway terminal pacing correction (2026-10-13)

Required CI on da7bf71 passed Linux, both macOS architectures and website, but Windows failed the
unchanged five-second Unicode display assertion. The downloaded failure artifact SHA-256 is
b4a7a394c5daa3731287179a7763e253026ff12b35a61ba4fa262e268955a540. Its actual trace shows one
complete successful paste request (4.352 ms) and the exact Unicode marker in rendered rows and
accessibility output after the assertion expired. This is delayed display, not evidence of lost
input/output.

The real GatewayClient regression reproduces 43 awaited consumer turns for 43 tiny byte frames
already in one HTTP read. The correction coalesces adjacent validated data frames within that read
while retaining 16 KiB events, raw byte/UTF-8/ANSI order, state and owner boundaries and awaited
consumer backpressure. It does not wait for later reads, change the fixture, increase timeouts or
weaken assertions. The reproduced case now needs one consumer turn. Original runner scheduling and
HTTP read grouping are not recorded; exact-SHA CI remains required to qualify the corrected source.

Two regression cases pass, including consumption before the next state, bounded data and state
ordering. Aggregate formatting/types and 207 unit cases passed with 11 platform skips (218 total).
All 12 runnable terminal browser cases passed with one Windows Bash skip; the complete one-worker
browser suite is in progress. Evidence: task/pty-ci-investigation/investigation.json,
reproduction.log, regression-fixed.log, terminal-browser.log and verify.log. No tag or publication
occurred.

Corrective qualification completed: the fresh CI-mode, one-worker full browser suite passed 112
cases with one Windows Bash skip. Three production portability engines and fresh native Windows
Desktop/window/update/SSH/report smoke passed. Final aggregate formatting/types and 207 unit cases
passed with 11 platform skips (218 total). The first corrected local full run is retained honestly:
111 passes, one skip and one bootstrap failure before application execution; its trace records
Chromium ERR_NO_BUFFER_SPACE fetching React's runtime. The clean repetition used a fresh owned
server/browser after the native check, preserving every original assertion/deadline and zero
retries. Both previously observed terminal cases passed. No code or test change was made for the
bootstrap error. Final corrective source hashes and receipts are in
task/pty-ci-investigation/final-qualification.json. Only three corrective files will be committed;
the user's four-line edit remains byte-identical and unstaged. Required new-source CI and release
publication remain separate gates; no hardware acceptance is claimed.
