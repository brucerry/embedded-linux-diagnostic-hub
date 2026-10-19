# Tasks

## 1. Free qualification scope

- [x] 1.1 Verify public-repository eligibility, pinned Electron darwin binaries and free standard
      runner labels; verify the recorded assessment and approved no-distribution scope.
- [x] 1.2 Add the guarded macos-15-intel/x64 and macos-15/arm64 workflow with read-only permissions
      and no artifact/cache/signing-account costs; verify workflow configuration and hosted runner
      identities.

## 2. Platform integration

- [x] 2.1 Add Mac bundle architecture, ad-hoc signature and ASAR/source verification; verify it runs
      successfully against both hosted app bundles.
- [x] 2.2 Add explicit darwin unsupported-update status/UI and installation rejection; verify
      focused unit and packaged UI checks, with supported-platform updater regressions passing.
- [x] 2.3 Run shared desktop smoke and 100-cycle native/terminal continuity on Mac with existing
      state/event/session deadlines; verify both architectures execute the assertions instead of
      skipping them.

## 3. Complete qualification

- [x] 3.1 Run local typecheck/build/unit/browser regressions and strict OpenSpec validation; verify
      original user edits and immutable v0.2.0 are preserved.
- [x] 3.2 Push scoped changes and track Mac, Windows, Linux base/seven GNOME and website jobs to
      terminal success; diagnose/fix in-scope failures and record exact-source evidence.
- [x] 3.3 Document the tested OS/architectures and Gatekeeper/download/minimum-OS limits; verify no
      Mac download, updater deployment, Apple enrollment or release/tag change occurred.
- [x] 3.4 Add the requested macOS workflow badge alongside README CI badges; verify the main-branch
      SVG image and workflow link return HTTP 200, and all other README bytes are preserved.
- [x] 3.5 Preserve the v0.3.0 Intel initial-capture failure; add bounded native readiness and
      recovery for that specific capture-protocol error within the original screenshot deadline,
      retaining required PNG/native/session evidence. Verify negative cases and qualify the exact
      release source across all four workflows before publishing Windows/Linux assets.
- [x] 3.6 Preserve the checksum-verified Windows blank-startup trace with failed React-runtime
      ERR_NO_BUFFER_SPACE transport; scope Windows browser CI to one worker, retain all tests and
      original deadlines, and verify the clock fixture locally plus exact-source hosted coverage. Do
      not claim an upstream transport root-cause cure.
- [x] 3.7 Preserve the a41 Linux/ARM clock failures and absent hosted traces; demonstrate the
      pending-PTY virtual-time fixture race and immediate hidden-callback polling gap. Require
      established real PTY before fake-clock jumps, guard hidden polling synchronously, retain the
      original readiness/count deadlines and assertions, and retain bounded failure diagnostics in
      job logs without adding artifact storage beyond the existing policy. Verify deterministic
      before/after regression, full clock suite, fresh native smoke and the complete exact-source
      hosted matrix before release.
- [x] 3.8 Establish renderer-document and page-entry lifecycle causes with controlled context
      replacement and exact one-pixel scroll-clamp reproductions. Wait for committed renderer UI,
      bind fixture settings within one evaluation, and settle finite page-entry geometry before
      continuity baselines. Preserve exact equality/native/authentication assertions and existing
      deadlines. Verify deterministic negative/positive regressions, targeted repeated checks,
      aggregate checks and all exact-source hosted gates before the authorized release. A collection
      count marks transport start, so require completed collection UI within the original five-second
      poll budget. Verify the held-result negative control and repeated positive checks; retain
      bounded safe geometry in job logs and keep raw equality.

- [x] 3.9 Publish the authorized v0.3.1 corrected source through all required release gates. Preserve
      the failed v0.3.0 tag without a release and the immutable v0.2.0 release. Verify exact-source
      aggregate and full Windows/Linux/seven-GNOME/both-Mac/website qualification before tagging,
      then all tag gates, the generated four-section notes since the prior published v0.2.0, all 16
      expected assets/checksums/build manifests, latest-stable metadata and no public Mac downloads.
