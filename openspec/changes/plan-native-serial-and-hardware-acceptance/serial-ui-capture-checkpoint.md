# Interim Serial correctness and UI review checkpoint

The 17-file source candidate is ready for independent review and is **not adopted** into the
original working tree. Packet: `serial-ui-capture-review.json` and `serial-ui-capture-review.patch`,
74,085 patch bytes, SHA-256 **9873e2e9c67958c2d5c0825b067ca379e75f132c2a6c7e1beb8992b4490d9ba5**.
The patch applies cleanly to its stated original-working-tree baseline. All other candidate source
matches the exact native-qualified snapshot; the user's separate live test is excluded and
unchanged.

## Completed in this candidate

- **Small-output Serial Automation failure:** the real session class reproduced `output-limit` below
  64 KiB when a small ANSI listing arrived one byte at a time. Capture now uses bounded 1,024-byte
  logical blocks, independent of native read boundaries, without raising the shared 256-record limit
  or changing SSH capture. At the existing interim 64-KiB bound there are at most 64 blocks. Raw
  bytes, streaming UTF-8 and literal prompt behavior remain intact; incomplete UTF-8/ANSI, overflow,
  wrong/missing prompts and cancellation cannot advance later input.
- **Truthful receive provenance:** each block explicitly records `serial-byte-block-v1`, first/last
  contributing host receive observations and a per-block contributing-read count. `receivedAt` is
  the first observation. One read may contribute to multiple blocks. Interior native read boundaries
  and timestamps are not retained and are never represented as original events, per-byte/line
  timestamps or device emission times. Array order survives equal/backward wall clocks. Validation,
  UI and all exports preserve this distinction; JSON with blocks is schema 2. Legacy/SSH-only JSON
  remains schema 1 and its CSV columns remain unchanged. Device-prefix observation uses the last
  contributing receive observation rather than a block's first time.
- **Deselect race:** successful cleanup publishes its final state after releasing closing ownership.
  Chooser/settings become enabled, framing values remain, no port stays selected, and reselection
  never opens automatically. Pending/timed-out cleanup still owns the port and blocks replacement.
- **Serial readability and clock:** enabled secondary hover colors and modal keyboard focus are
  scoped to Serial. Custom chooser, pagination, normal/hover/disabled states and Tab/Enter selection
  pass browser checks; SSH styles remain unchanged. DeviceClock now says exactly **SSH
  disconnected** when SSH is disconnected, including while Serial is connected.
- **Automation actions:** Clear retained results reuses the existing destructive-warning palette and
  the installed `BrushCleaning` icon (`Broom` is unavailable). Start flow has a decorative Play
  icon. Text/accessibility names, handlers and icon alignment are preserved. Only Cancel run remains
  during active/waiting work; its existing implementation disarms queued steps, repeats and future
  scheduled work and requests active cancellation. Help/status retain the warning that sent commands
  may continue remotely. No user retained results were cleared; the browser test keeps its synthetic
  cancelled row.

## Evidence and limits

- `serial-ui-capture-final-unit.log`: **84 passed, 0 failed**, covering the real Serial class,
  capture/export validation, independent SSH behavior, clock behavior and cancellation.
- Nine successive flows on one connected fake Serial session each run `pwd` then a fragmented ANSI
  `ls`: **18 complete captures**, one open, no intermediate closes, fresh counters/generation
  ownership and distinct run identities. No leak is established by the user's screenshot. The
  screenshot's small-output failure is consistent with the reproduced defect; the hardware's actual
  fragmentation was not recorded.
- `serial-ui-capture-browser-origin-corrected.log`: **30 affected browser cases passed**. After the
  later button requests, `automation-actions-browser.log` passes all **12 Automation cases**;
  `automation-actions-final-browser.log` passes the final presentation/help-text case. Enabled
  normal/hover contrast meets 4.5:1, focus meets 3:1 against the adjacent background; disabled
  styles retain their existing opacity/palette. Dark/light OS appearance and forced colors are
  exercised.
- `serial-ui-capture-portability-final.log`: **Chromium, Firefox and WebKit passed** against the
  locally built production website. Typecheck and changed-file formatting pass. A final static
  Cancel explanation was clarified afterward and verified by the final browser case/typecheck.
- Screenshots in `serial-ui-visuals/` include chooser normal/hover/disabled/keyboard focus, default
  and nondefault retained framing after Deselect, warning-button focus, play icon and single Cancel
  action. The hover, Deselect and Automation action screenshots were visually inspected.
- Baseline failing lifecycle/capture logs are retained. The separate gateway browser timeout was
  traced to the isolated server origin differing from the fixture's default; its trace/log are
  preserved in `serial-ui-gateway-timeout/`. Setting the fixture's existing `HUB_TEST_ORIGIN` to the
  correct loopback origin passed unchanged assertions/deadlines. Production policy was not relaxed.

All Serial/device data here is synthetic. No COM/tty port was opened, no DUT SSH connection was made
and no physical hardware acceptance is claimed. This is a source review checkpoint, not a new
packaged application or published v0.6.0 release.

## Separately completed Windows installer acceptance

`physical-fs-native-outcome.json` records the real corrected private install and launch for source
**972be142f3067c49df91cdec6d9bfd08ae7b9f63**, following the independently approved physical-fs fix.
The original repository remains on main **2f84f429214633374e56159296b87c188d64c5f2**.

- New installer: **236,929,189 bytes**, SHA-256
  **8ad94957aea042d4e074a6d2763336e571792005068a96b08c5031f24d980173**; compiler `/WX`, zero
  warnings.
- Extracted 103-file payload was reverified before Apply; all **105 installed manifest entries**,
  ASAR/runtime bytes, the matching UUID shortcut and HKCU uninstall entry were independently
  checked.
- Disposable case: `setup-qa/native-install-install-94dee0fa`; UUID
  **9c2c5f32-b211-4d8e-9fac-80bffc75da63**. Launch-off install kept the original three-profile
  inventory. The first launch added only that UUID profile and showed a visible responsive native
  window, working input and read-only RPC with the matching installed path/profile. The app exited
  0; no owned process remains. App-reported payload status correctly remains `not-checked`; the byte
  verification is separate evidence, not an invented app capability.
- Observed bounds: Apply **16.633 s**, tested interaction **1.839 s** after launch, later native
  visibility/responsiveness confirmation **2.754 s**. These include harness/process-inspector/CDP
  overhead and are not first paint, first presentation or cold-cache measurements.
- The test copy, own integration and profile are retained. Earlier failed Apply, payloads, receipts
  and profiles remain preserved; existing profile contents were not inspected. No uninstall,
  permanent deletion, device interaction or publication occurred. This exact runtime predates the
  proposed Serial/UI packet and does not retroactively qualify that future build.

The reviewed Linux increments are combined separately in `linux-reviewed-aggregate.json`: a clean
33-file aggregate patch with unchanged physical-fs implementation hunks, typecheck and 60 passing
focused tests/three native-Linux skips. Native Linux lifecycle remains unqualified.

## Queued after this independently reviewable checkpoint

1. **Full-output capture supersedes the interim cap.** The candidate still has the existing 64-KiB
   total cap. Bruce's new requirement is not implemented by this packet. Next: storage-backed
   streaming/spooling, bounded in-memory parsing/rendering, paginated/virtualized results and
   complete streaming exports, with explicit incomplete capture on storage failure and
   cancellation/retention/ cleanup controls. Assess desktop disk and browser API/quota feasibility
   before claiming support; no application total-output cap cannot mean infinite physical storage or
   unbounded RAM.
2. **Clean ANSI results:** assess a safe readable streaming projection while retaining exact raw
   exports and truthful timestamp provenance. The current evidence view still renders escapes
   explicitly; clean rendering is not claimed complete.
3. **SSH persistent console:** the separate OpenSpec change `add-ssh-persistent-console-automation`
   has proposal, design, two deltas and tasks, but no SSH code is implemented. It preserves
   independent exec scripts and requires one exclusive PTY, explicit Script/Send Enter, exact CR,
   cwd/normal interactive alias/function state, explicit changed/intermediate prompt criteria, null
   exit status, safe ownership/cancel/reconnect and export provenance. No blank exec workaround,
   `ll` rewrite or guessed profile sourcing is added.
4. **Latest Serial visuals:** remove only the left foreground palm/coconut group, preserving the
   right-side scene and distant island trees; retain the already tested bird-free scene. Evaluate
   Serial-only light ANSI/default foreground, selection and active/inactive cursor contrast over
   sky/ocean/sand with representative colored prompts, preserving raw bytes and SSH theme and using
   no dark covering panels. These newest visual changes are queued, not part of the frozen packet.

The user's four-line `tests/ui/live.spec.ts` SHA remains
**07dd490a4abff47fc24fcd86ceb63a3ff5fa0d7605b427420a08c1af2043376b** and it is not copied into the
candidate. Prior physical-fs/FIFO/Linux review candidates and qualified private artifacts are
unchanged. OpenSpec is local-only; strict validation covers 21 specs/changes. No push, tag or
release is qualified.
