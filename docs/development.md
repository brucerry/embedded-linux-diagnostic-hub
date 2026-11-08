# Development and maintenance

## Module boundaries

`src/app/App.tsx` selects pages and assembles the application shell. `src/hooks/useDeviceSession.ts`
owns connection state, periodic scheduling, snapshots, graph history and report operations. Both
editions use these same modules. The hook selects the native preload bridge on desktop or
`src/services/GatewayClient.ts` in the browser.

Page modules render overview and diagnostic search/cards. Feature modules implement the connection
dialog, evidence tables/trees/graphs, terminal, animated transfer artwork. Common components provide
modal focus/scroll management, status badges, copy feedback and rounded icons. Preserve component
identity during live updates so focus, expanded trees and scroll positions remain stable.

## Formatting

Prettier is pinned in `package-lock.json`. `.prettierrc.json` and `.editorconfig` specify four
spaces, no indentation tabs, LF endings and a preferred 100-character wrap width. Configure your
editor to use the repository formatter; `npm run format` formats maintained source, tests,
configuration and documentation. `npm run format:check` is enforced in all CI builds. Generated
bundles, release artifacts, test recordings and the dependency lockfile are excluded from
formatting.

Keep functions focused on one responsibility and use named prop types for complex components.
Explain measurement semantics and failure handling where the code cannot make them obvious.
Formatting does not wrap literal probe commands or rewrite device-output fixtures: their exact
contents are part of the collection/parser contract.

## Add or change a diagnostic

1. Add a bounded, read-only command to `shared/diagnostics/probes.ts`; discover capabilities instead
   of choosing behavior from a board model. Preserve an installed tool's meaningful failures.
2. Add types/parsing under `shared/diagnostics/`. Keep standard output accessible even when no
   structured interpretation is suitable. Tables need meaningful columns; hierarchical values use
   trees. Plot only real numeric readings and document units and sample semantics.
3. Add parser and loopback SSH cases under `tests/`, including absent tools, partial evidence and
   malformed output. Add browser coverage when behavior changes; fixture data stays under tests.
4. Run `npm run verify`, browser tests and the desktop smoke test. Update hardware/design docs if
   coverage or interpretation changes. Explicitly authorized real-device validation supplements
   these checks; do not install tools, modify configuration or stress hardware during collection.

## Verification

Run `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`, `npm run build:web` and
`npm run build:gateway`. `npm run test:window-desktop` exercises standard native minimize/restore
alongside SSH, PTY, clock, trust, navigation and reset behavior. `HUB_TEST_EXECUTABLE` selects an
isolated packaged runtime. Automated tests remain part of development; the retired user-facing Tests
workspace is absent.

Linux CI retains GNOME 42/46/48/50 and available X11/Wayland cases in a private compositor session.
No companion setup or extension installation is required. Local Windows results do not establish
Linux compositor acceptance. Current builds require no Visual Studio C++ compiler or Koffi native
window adapter.

The private Gateway memory fixtures load historical production source from
`tests/fixtures/gateway-ownership-production.blobs.gz`. This data-only archive concatenates the 213
original Git blobs in the unchanged `gateway-ownership-production.json` inventory order. The loader
checks the historical inventory identity, every blob's length, SHA256 and Git object ID before
returning sources. Recreate it only from those exact locally available Git blob IDs, using gzip with
a zero timestamp; current checkout bytes cannot replace the frozen inputs. This keeps shallow
checkouts independent of old Git objects and network access. The archive is never executed, and
memory fixture results do not qualify native Gateway execution or release acceptance. The separate
`gateway-preimport-target.frozen` retains the original, hash-checked private wrapper from commit
`4a88f528657e023e852b41847a80f471c053530b`; it is also read only as fixture data.

The parent-toolchain memory fixture uses `preimport-esbuild-wrapper.frozen` for its modeled
`esbuild/bin/esbuild`. These are the original esbuild 0.28.2 JavaScript wrapper bytes from a locally
cached tarball whose SHA512 matched the existing lock/reference integrity. The loader also checks
the unchanged parent-package length and SHA256 pins. This models the admitted `--ignore-scripts`
installation even if the developer's normal postinstall replaced that entry with a native binary.
The fixture bytes are never executed, and the installed dependency tree is not modified.

The ordinary test glob also loads the desktop retirement and updater memory cases through scoped
Node 24 loader wrappers. Their unchanged `.cases.ts` modules keep the alias-identity skip guards;
the `.test.ts` wrappers install the matching SSH or filesystem memory ports for fixed production
importers before loading cases, then deregister hooks. A canary and required-alias checks reject
missing wiring rather than silently claiming coverage. Real SSH2 and unaudited filesystem imports
are refused in those scopes. Native/platform and opt-in runtime skips remain separate.

The original historical private product observer identities describe commit
`96a56cdbb462320c54fe74022d7436e665a31d31`. Their pure source-admission and inverse tests use
`memory-product-96a-sources.blobs.gz`, a data-only corpus of the 25 exact historical targets. The
loader checks the manifest, archive, complete decoded bytes and each target hash before
materializing bounded, read-only temporary source data. The historical observers and native build
admission continue to reject changed checkout bytes; tests never compile or execute this corpus.

`memory-product-current-source.json` defines a separate version-2 source-only subset: the 25
explicit targets plus the browser export non-admission helper. Its verifier checks all 26 paths and
carries the exact manifest, commit, realm and pins through a source-verification receipt. The
mandatory `nativeAdmission: false`, `runtimeAttestation: false` and
`completeDependencyClosure: false` fields cannot be promoted by a caller. This inventory omits
runtime dependencies such as SSH channel custody and native update coordination. It therefore does
not enable current-source runtime observers or establish shutdown, process retirement or release
qualification. A future runtime binding needs reviewed ownership-producer dependency coverage and
separate identity propagation through host, native-state and shutdown validators.

The integrated checkout retains that `afd9260` source subset unchanged. The separate
`memory-product-e5-source.json` records the newer `e5fb2fd` 26-file subset, including its changed
main-process and quit-cleanup bytes, with the same three refusal flags. Neither manifest represents
the complete integrated tree. The separately retained `current-e9bb9bc` runtime profile remains
immutable: its unchanged renderer and Gateway guards can still be checked, while its older native
main-process pins reject this checkout. These source/model checks do not requalify native execution.

Updater temporary names are reservations until exclusive creation returns a handle. A collision does
not authorize removing the existing entry, and a rejected create with an uncertain outcome retains
blocked custody. A successful rename consumes the acquired source name; cleanup must not remove a
later entry at that name. Fake filesystem controls cover these boundaries separately from descriptor
closure, destination publication and application restart.

## Dependencies and generated assets

Use Node.js 24 and `npm ci` for repeatable builds. Update dependencies intentionally, commit the
manifest and lockfile together, and run the same browser/native/package checks as CI. Recheck the
embedded Electron runtime and Windows compatibility when updating Electron.

Icons are generated by `npm run generate:icons` from the shared brand source. Review generated icon
changes and verify the packaged icon sizes. Keep device reports, `.env.gateway`, SSH private keys,
certificates and `validation/` outside source control.

## SSH to the client host

The desktop accepts `localhost`, `127.0.0.1` and `::1` as SSH targets. The host must run an SSH
server on the selected port, and you must supply a valid local account and verify its host key.
Windows desktop loopback reaches Windows; a Linux desktop launched in WSL reaches that WSL
environment. Use the other environment's reachable address when it is the intended target. Linux
diagnostics need a Linux SSH shell; connecting to a Windows SSH shell does not provide procfs/sysfs.

For the website, the gateway opens the SSH connection. Loopback addresses therefore identify the
gateway's host or container, not the computer displaying the browser. Configure that exact address,
port and trusted fingerprint in `HUB_TARGETS_JSON`, then select it in the connection dialog. A local
gateway can diagnose the same Linux host if its SSH server is reachable from the gateway process.

The unit, desktop and website gateway tests use temporary SSH servers bound to loopback ports. They
exercise real SSH authentication and collection against synthetic evidence without requiring a
system SSH service or changing the host's configuration.

## Update and reset verification

The native update coordinator owns collection draining, SSH disconnection, report backups, verified
downloads and relaunch. Its lock prevents new SSH connections or collections until the restart, and
releases on failure without reconnecting. `UpdateReports` keeps durable JSON backups separate from
the acknowledged recovery marker. The shared renderer owns RAM reset and graph history; reset keeps
the existing transport open.

`tests/update-coordinator.test.ts` covers all modes, active collection, overlapping requests,
backup/download/relaunch failures and bounded recovery. The browser update/reset tests cover
cancellation, report restoration, collection pause/resume and fresh graph history. The native
AppImage test performs a real coordinated smart update from a connected loopback device and checks
the imported report with SSH disconnected after restart. Release-note tests use an isolated Git
repository to cover direct and merged commits between published version tags. Keep public release
notes in `docs/releases/<tag>.md` to a few important changes and links to detailed guides. The
release page uses those notes and links the full comparison against the previous published release.

Terminal verification lives in `tests/terminal*.test.ts`, `tests/ui/terminal.spec.ts`, and the
native smoke suite. Browser interaction cases also cover automatic startup before tab selection,
clipboard shortcuts/menu/feedback, representative xterm keys, prompt-preserving clear, pixel
animation, mobile layout and connection-form drag dismissal. Shell key bindings remain device-owned;
see [xterm's terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/) and
[GNU Readline](https://www.gnu.org/software/bash/manual/html_node/Command-Line-Editing.html).
Additional transport checks live in the native desktop smoke test. Loopback PTY fixtures cover byte
input, shell state, Unicode, resize, concurrent diagnostics, host API validation, bounded output,
gateway authentication, rate limits and cleanup. The terminal remains mounted during page
transitions. Reset clears its local display history but keeps the remote shell open; report and
update backup schemas remain diagnostic-only. For an isolated browser test port, set
`HUB_TEST_ORIGIN` to the test server origin when using a local Playwright configuration; the default
remains `http://127.0.0.1:5173`.

Terminal regression checks fill scrollback to test the bottom prompt and wheel containment, verify
Clear terminal focus, right-click selection menus and synchronized sprite kicks. An opt-in
`HUB_BASH_PTY_TEST=1` browser qualification uses the local ignored `.codex/bash-shell.cjs` adapter
when installed to exercise actual interactive Bash continuations, subshells, loops, editing,
interrupts and Ctrl+L redraw through SSH/gateway/xterm. The ordinary fixture deliberately imitates
only a few commands and cannot qualify shell syntax. This PC's local demo supports `--bash` for Git
Bash through a real Windows PTY; commands then run on the developer's PC, with diagnostic readings
still synthetic. Production always runs the connected device's shell.

Clock coverage lives in `tests/device-clock*.test.ts`, `tests/ui/device-clock.spec.ts`, the native
smoke suite and production website portability tests. It covers minimal GNU/BusyBox output,
authenticated access, time/output bounds, query cancellation, terminal/report isolation, older
gateways, independent minute polling, resume/reset/reload/reboot activity and late session replies.
Use the existing Linux SSH qualification environment when available; record unavailable tool/server
combinations explicitly rather than claiming they passed.

Reset scheduling is paused by its internal lock without changing the user's live-update setting. The
progress dialog is rendered outside the inert app shell, so keyboard focus and scrolling stay inside
the overlay. Reset waits for collection to finish, clears renderer/native RAM, retains the current
page, and keeps the overlay up until the first fresh live snapshot is ready. Failed cleanup releases
the lock and preserves evidence. A collection failure during the wait remains paused. `openReleases`
opens one fixed GitHub releases URL through the trusted native bridge.

Once a workspace has displayed evidence, reset preserves its page components when data is cleared.
Overview/report fields become unavailable without substituting a connection or fresh-record guide.
The cover paints for at least 300 ms for fast RAM-only cleanup, blocks interaction throughout fresh
snapshot/history preparation, and is released on success or failure. Failure leaves cleared values
and an actionable error rather than stale readings.

Native-cycle qualification confirms each resize/maximize/unmaximize/minimize request before
proceeding and records Electron events plus actual compositor states. Linux restoration is requested
through the owned GNOME window manager, matching native desktop/window-switcher behavior; client
`BrowserWindow.restore()` can leave the actual surface minimized even after its local flag clears.
Both state assertions retain the five-second deadline. The app exposes no privileged restore control
or workaround.

## Serial, network insights and Automation

v0.5.0 includes [Serial](serial.md), [WLAN/LAN insights](network-insights.md) and
[ordered Automation / QA exports](automation.md). Published v0.4.0 assets remain unchanged. Target
UART enablement/operation belongs to the user; physical ports and Linux/macOS drivers are separate
qualification gates. Automation operator scripts are distinct from the fixed observational
diagnostic catalogue.

Focused local gates: tsx --test tests/network.test.ts tests/serial-_.test.ts
tests/automation_.test.ts; playwright test tests/ui/network.spec.ts tests/ui/serial.spec.ts
tests/ui/automation.spec.ts; tsx tests/serial-desktop-smoke.ts; tsx
tests/automation-desktop-smoke.ts. Native proof uses synthetic chooser descriptors with the Chromium
sandbox and no physical opens. Full verify/e2e/desktop/window/portability checks remain required.
