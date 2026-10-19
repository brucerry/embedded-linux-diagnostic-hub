# Tasks

## 1. Establish the Windows handoff

- [ ] 1.1 Build a small local native capture/transparent-overlay prototype using the installed
      Electron version. Verify outgoing Genie and taskbar-triggered reverse animation on this
      Windows PC toward the detected taskbar edge without a full-size flash or duplicate visible
      native motion; record observations before integrating the native command hook, and surface a
      failed feasibility gate rather than weakening specs.
- [x] 1.2 Implement display/taskbar anchor geometry and snapshot scaling as independently testable
      helpers. Verify all four edges, negative monitor origins, scaled images, source/destination
      endpoints, exact app-button centers, autohide clamping and per-display selection with focused
      tests.

## 2. Implement the transient renderer

- [ ] 2.1 Implement dimension-independent canvas-strip Genie rendering with approximately 500 ms
      duration in each direction and deformation following all four taskbar edges without rotating
      content. Verify initial/final geometry and visually review intermediate frames containing
      terminal text; preserve applicable upstream attribution in the delivered source.
- [x] 2.2 Add the locally bundled overlay HTML, renderer and dedicated preload; update desktop
      esbuild entries and `vite.config.mts` inputs as needed. Verify production assets load over
      `app://`, development assets load locally, and `build:web` retains its existing main entry and
      base paths.
- [x] 2.3 Configure the overlay as non-focusable, mouse-ignoring and absent from the taskbar with
      strict sender/frame/URL/generation validation. Verify attempted hub API access, navigation and
      stale completion callbacks are rejected by native integration tests.

## 3. Coordinate native window state

- [ ] 3.1 Implement the transition controller with on-demand capture, opacity handoff, real minimize
      and owned restore, querying current native taskbar geometry for each direction through a
      bounded, read-only adapter, with unique app-identity button matching and serialized startup.
      Verify taskbar/button relocation while minimized, native-helper lifecycle, controller tests
      covering each state, preserved bounds/maximized state and unchanged main-window identity, plus
      a real Electron outgoing/reverse smoke check.
- [x] 3.2 Add generation cancellation, request coalescing and the two-second main-process watchdog.
      Verify capture rejection, renderer death, missing completion, rapid restore, reload, geometry
      change and close/quit leave the intended native state, normal opacity and no leaked overlay.
- [x] 3.3 Add reduced-motion and platform checks with native fallback, scoped only to window
      transitions. Verify Linux/unsupported rendering uses native behavior, preference changes
      cancel safely, and existing `tests/ui/motion.spec.ts` still passes unchanged in behavior.
- [x] 3.4 Release per-direction snapshots, canvas resources, timers and overlay listeners. Verify
      repeated transitions do not accumulate windows/resources, idle/minimized states perform no
      capture or animation work, and snapshot bytes never enter reports, storage or logs.

- [x] 3.5 Reduce the pause before native minimize/restore by overlapping fresh geometry lookup,
      snapshot capture/encoding and transient renderer startup. Batch fresh taskbar properties and
      match in compiled helper code. Measure request-to-ready latency and frame pacing, then verify
      queued payload cancellation, security/recovery, resize stress and packaged behavior without
      retaining idle surfaces or stale snapshots/geometry.

## 4. Integrate native controls

- [x] 4.1 Remove the renderer minimize API and header action. Keep only the optional typed restore
      notification for device-clock refresh. Verify external/overlay frames cannot request window
      operations and existing bridge fixtures remain compatible.
- [x] 4.2 Attach a Windows-only owned-HWND native subclass through a compiled C message gate.
      Intercept the title-bar/system-menu minimize command before native minimization, keep native
      controls and taskbar restore, suppress duplicate DWM motion per window, and detach callbacks
      safely before destruction. Verify native-message queue activation and fallback paths.
- [x] 4.3 Preserve eligible prior focus and workspace identity across handoff. Verify Terminal
      input, a connection modal, JSON profile edits, selected page and scroll positions survive,
      without bypassing modal blocking or stealing focus from another application.
- [x] 4.4 Replace JavaScript window-procedure callbacks with a compiled native message gate. Verify
      external-process resizing, resizing during restoration, 100 repeated/interrupted native cycles
      with forced GC, and native close leave no crashes or leaked overlays. Package and run the
      native DLL on this Windows environment; document the build-only compiler prerequisite.

## 5. Qualify continuity and compatibility

- [x] 5.1 Extend native smoke coverage using existing loopback SSH/PTY fixtures. Verify one
      authenticated connection and PTY survive minimize/restore, sustained output remains consumable
      while minimized for longer than the 30-second stall deadline, and commands are never replayed.
- [x] 5.2 Exercise a running simulated test and loopback-backed connected test plus active live
      collection across minimize/restore. Verify identical run identity, real progress, no duplicate
      requests, ordinary collection scheduling and device-clock refresh on return to visibility.
- [x] 5.3 Run `npm run verify`, relevant browser checks, `npm run test:desktop` and
      `npm run build:web`. Verify the suite still identifies the authoritative main window when an
      overlay exists, and Linux desktop fallback passes where a Linux desktop test environment is
      available.
- [ ] 5.4 Build the Windows portable package and run native/package smoke checks. Visually review
      taskbar restore, native title-bar minimize, Win+D, maximized restore and reduced motion;
      qualify left/top/right/bottom placement, autohide and multiple displays/DPI where available
      and explicitly record any unavailable configurations.

## 6. Document and finish

- [x] 6.1 Update `docs/usage.md`, `docs/design.md` and `docs/development.md` with supported entry
      paths, content-only/native-frame scope, dynamic taskbar anchor, reduced-motion exception and
      recovery. Verify documentation matches tested behavior and keep the README concise.
- [x] 6.2 Record qualification evidence and clean up only owned generated prototype/build/test
      artifacts after verification. Verify source/planning files and installed development
      dependencies remain, and identify any qualification limits before marking this change
      complete.

## Archive qualification notes

The user approved archiving and prerelease delivery with documented qualification limits on
2026-10-10. Unchecked tasks retain their original acceptance conditions; no unperformed check is
marked complete. Current implementation and automated evidence are recorded in
`.codex/genie-prototype/qualification-2026-10-10.md` and
`.codex/genie-prototype/latency-2026-10-10.md`.

- 1.1: no recorded visual acceptance before native integration; this historical order cannot be
  verified retroactively.
- 2.1: geometry and endpoints are covered, and the user reviewed the motion; dedicated visual review
  of intermediate terminal-text frames remains unrecorded.
- 3.1: lifecycle, native commands and current app-button centers are covered; physical
  taskbar/button relocation while minimized remains unrecorded.
- 3.3: completed after packaged Linux native fallback passed in CI run `38055557284`, together with
  local reduced-motion and existing browser motion checks. Local Linux compositor review remains
  unavailable and is not claimed by the Xvfb check.
- 5.4: packaged automated and user motion review exist; the full physical Win+D/taskbar/autohide
  configuration matrix remains unrecorded. Top taskbars, both monitors, negative origins and 125%
  scaling were qualified; other edges/autohide have geometry coverage only.
- 6.2: complete after exact-commit main and tag workflows passed and `v0.2.0-rc.4` publication, all
  16 assets, checksum files, build identities and concise notes were verified. Final delivery
  evidence is in `.codex/genie-prototype/release-rc4-2026-10-10.md`. Owned generated profiles, stale
  unpacked output, build output and test caches were recycled; source, evidence, dependencies, the
  review executable and reachable Linux SSH environment are preserved. The four qualification gaps
  above remain explicitly unchecked.
