# Tasks

## 13. Shell output isolation verification

- [x] 13.1 Verify concurrent diagnostic stdout/stderr and collected kernel logs never enter PTY
      output or renderer history, including five-second live updates on desktop/web; document direct
      remote PTY output limits.

## 12. Earth rotation cadence

- [x] 12.1 Set Earth to one full rotation per second, update the existing duration check and docs,
      verify the scene, and rebuild desktop/web packages.

## 11. Prompt redraw, conditional scrolling and planetary scenery

- [x] 11.1 Refresh prompt coloring after redraw, clear, resize and scroll while respecting remote
      colors.
- [x] 11.2 Allow document wheel scrolling when the normal terminal has no scrollback; retain
      containment for scrollback and interactive programs.
- [x] 11.3 Add pixel trees behind the animals and a tilted Earth with slow rotation, preserving
      contrast, interaction and animation pausing.
- [x] 11.4 Verify regressions and responsive scenery; update docs and rebuild/verify desktop and web
      packages.

## 10. Automatic recovery after shell exit

- [x] 10.1 Replace normally exited shells on the existing connection with preserved local history,
      fresh shell state, restored visible input focus, no queued-input replay and bounded recovery;
      protect gateway stream ownership and disconnect/modal/generation races.
- [x] 10.2 Add desktop/gateway regressions for recovery, nested shells, refusal/repeated closure,
      stale events and cancellation; qualify exit/logout/Ctrl+D on real OpenSSH/Dropbear Bash/ash.
- [x] 10.3 Document recovery, measure the local Linux test disk and explain optional removal;
      rebuild desktop/web/gateway packages and verify code, terminal UI and packaged launches.

## 9. Terminal fidelity and layout follow-up

- [x] 9.1 Correct fitted viewport geometry and cursor alignment after remote Ctrl+L redraw; contain
      wheel scrolling and full-screen prompt output within the terminal.
- [x] 9.2 Restore focus after Clear terminal, keep left-drag for selection only, and open the
      Copy/Paste menu on right-click without losing the selection.
- [x] 9.3 Verify multiline continuation, subshells, loops and editing against an actual interactive
      Bash PTY; provide an explicit local demo mode for this environment without a device.
- [x] 9.4 Synchronize the pixel ball with duck/pig kicks and smooth the overview transfer completion
      for fast collections without misrepresenting collection state.
- [x] 9.5 Update docs and regression tests, rebuild packages, and verify browser/native/cold-launch
      behavior on this PC.

## 8. Requested terminal interaction refinements

- [x] 8.1 Automatically create one PTY for each live device connection, retain it across tabs,
      remove manual open/close controls and wording, and verify connection/reconnect/failure
      lifecycle without retry loops.
- [x] 8.2 Reuse copy feedback animation in a top-right terminal copy button; support highlighted
      selection, a right-click Copy/Paste menu, Ctrl+C selection copy with interrupt fallback,
      Ctrl+V paste, and trusted bounded native clipboard reads.
- [x] 8.3 Color recognizable prompts without changing the remote shell configuration; Clear terminal
      retains the current prompt/input line and clears history, while Ctrl+L and other xterm keys
      preserve remote keymap behavior. Verify representative control, navigation, paste and
      selection keys.
- [x] 8.4 Add a subtle animated pixel-art duck and pig playing behind the terminal, retaining
      foreground contrast, mouse selection and input accessibility; verify mobile and desktop
      rendering.
- [x] 8.5 Fix modal dismissal so a pointer gesture that starts inside the dialog and ends on the
      backdrop does not dismiss it, while direct backdrop clicks still do. Add a connection-form
      regression test.
- [x] 8.6 Update affected documentation and tests, run code/browser/native/production checks,
      rebuild the Windows/web/gateway packages and verify package integrity and cold launch.

## 1. Contracts and terminal dependencies

- [x] 1.1 Add compatible `@xterm/xterm` and `@xterm/addon-fit` dependencies under Node 24 and update
      the lockfile; verify `npm ci` and `npm run typecheck` succeed.
- [x] 1.2 Define shared terminal operations, event payloads, IDs, byte/queue limits, dimension
      validation, and consumption acknowledgments; verify invalid IDs, oversized chunks, and
      out-of-range dimensions are rejected in contract tests.

## 2. SSH terminal channel ownership

- [x] 2.1 Implement one remote PTY shell on the existing authenticated `SshSession` and delegate
      through `DeviceMonitor`; extend a loopback SSH fixture to verify one authentication, prompt
      delivery, byte input, resize, and coexistence with fixed-probe collection.
- [x] 2.2 Add connection generations, duplicate-open prevention, and idempotent close handling;
      verify disconnect during opening, late output, target replacement, shell exit, and PTY refusal
      cannot affect a replacement terminal or healthy diagnostic connection.
- [x] 2.3 Implement ordered bounded output/input and backpressure with a stalled-consumer timeout;
      verify high-output and slow-consumer tests keep queues within limits and close only the
      terminal on capacity errors.

## 3. Desktop terminal transport

- [x] 3.1 Extend the isolated preload bridge and trusted main-process handlers for
      open/input/resize/close, output events, and consumption acknowledgments; verify native tests
      reject untrusted frames, stale IDs, malformed payloads, and invalid acknowledgment sequences.
- [x] 3.2 Integrate terminal cleanup and input blocking with app closure, SSH loss, and update
      transactions; verify native lifecycle tests preserve diagnostic-only update backups and leave
      no active shell or subscription after disconnect.

## 4. Gateway terminal transport

- [x] 4.1 Add authenticated terminal lifecycle routes and a no-store streaming output endpoint with
      header flush, byte-preserving events, and keepalives; verify real loopback gateway tests
      deliver the initial prompt, Unicode split across frames, input, and resize without an
      additional login.
- [x] 4.2 Add per-session input/resize rate and byte limits, stream backpressure, bounded parsing,
      and explicit terminal-only transport errors; verify normal typing exceeds the old
      control-route budget successfully while abusive requests and stalled streams remain bounded.
- [x] 4.3 Implement `GatewayClient` terminal operations with ordered batched input, streamed display
      delivery, and abort cleanup; verify invalid token/origin, expired/deleted sessions, aborted
      streams, page exit, gateway shutdown, and unsupported older gateway responses in integration
      tests.

## 5. Shared embedded terminal UI

- [x] 5.1 Add a lazy-loaded Terminal tab/page and a focused xterm component with Open terminal,
      Close terminal, Clear display, live target identity, and visible status; verify desktop and
      gateway browser fixtures show the correct active device and disable opening for
      disconnected/imported evidence.
- [x] 5.2 Keep the terminal controller/display mounted across tab changes and fit the display/PTY
      when shown or resized; verify working-directory and running-program state survive navigation
      and live diagnostic rerenders without duplicate shells.
- [x] 5.3 Support keyboard input, arrows, Ctrl+C, ordered multiline paste, ANSI rendering, and
      Unicode; verify browser interaction tests and a real native PTY smoke test exercise input and
      output end to end.
- [x] 5.4 Add accessible labeling, visible focus, screen-reader support, and a keyboard path to
      navigation; verify modal/reset overlays prevent input and device control sequences cannot
      trigger clipboard writes, external navigation, or page script execution.

## 6. Session data and documentation

- [x] 6.1 Bind terminal state to `useDeviceSession` live connection identity/generation and
      close/clear it on disconnect, reconnect, report import, and transport loss; verify lifecycle
      races never route old input/output to a new target and do not change retained diagnostic
      evidence behavior.
- [x] 6.2 Clear local terminal history during Reset session data while retaining the shell/SSH
      connection and keep transcripts out of report exports, logs, browser storage, and update
      backups; verify reset/export tests observe no extra remote commands or persisted terminal
      data.
- [x] 6.3 Update the narrow affected README, architecture, design, development, website,
      gateway/proxy, and qualification sections; verify blanket no-shell claims are replaced with
      precise diagnostic-versus-interactive behavior and terminal/proxy instructions match the
      delivered APIs.

## 7. Integrated verification and local build

- [x] 7.1 Run `npm run verify` and relevant terminal/gateway/browser tests under Node 24; record
      pass/skip results and verify existing diagnostics, report import/export, and update workflows
      still pass alongside terminal cases.
- [x] 7.2 Build desktop, website, and gateway artifacts, package the Windows executable, and run
      `npm run verify:package`; verify bundled terminal assets and desktop/web asset parity without
      adding runtime prerequisites for portable users.
- [x] 7.3 Extend and run native and packaged `tests/desktop-smoke.ts` terminal checks plus the
      portable cold-launch test; verify actual packaged PTY input, resize, terminal-only close, and
      reconnect cleanup on this Windows PC, with source changes limited to the feature and local
      OpenSpec files excluded from delivery.
