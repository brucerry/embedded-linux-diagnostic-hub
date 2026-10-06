# Development and maintenance

## Module boundaries

`src/app/App.tsx` selects pages and assembles the application shell. `src/hooks/useDeviceSession.ts`
owns connection state, periodic scheduling, snapshots, graph history and report operations. Both
editions use these same modules. The hook selects the native preload bridge on desktop or
`src/services/GatewayClient.ts` in the browser.

Page modules render overview, diagnostic search/cards and reports. Feature modules implement the
connection dialog, evidence tables/trees/graphs and animated transfer artwork. Common components
provide modal focus/scroll management, status badges, copy feedback and rounded icons. Preserve
component identity during live updates so focus, expanded trees and scroll positions remain stable.

`shared/diagnostics/` contains the fixed command catalogue, parsers, summary findings, process
sampling and history presentation. These modules must not import Electron, React or browser globals.
`shared/types.ts` describes transport/result contracts; `shared/report.ts` validates saved reports.

`backend/ssh/session.ts` performs SSH authentication and bounded read-only collection. It is shared
by Electron and the gateway, without importing either platform. `backend/ssh/monitor.ts` owns
desktop collection serialization. Native IPC, host-key prompts and report dialogs stay under
`electron/`; HTTP authentication, origins, target allowlists and session expiry stay under
`gateway/`.

Sample snapshots are **test fixtures only**, under `tests/fixtures/snapshots.ts`, with generic
hardware identities and distribution-specific output formats. The app exposes only the fixed
diagnostics, with no board profile, arbitrary device-file or shell-command API.

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

```sh
npm run verify
npx playwright install --with-deps chromium
npm run test:e2e
npm run test:desktop
npm run build:web
npm run package:win
npm run verify:package
npm run package:linux
npm run verify:linux
npx playwright install --with-deps firefox webkit
npm run test:portability
```

On Linux without a display, run the desktop test under Xvfb. WSL can use WSLg. Only the Linux test
harness normally passes Electron's `--no-sandbox`; set `HUB_TEST_SANDBOX=1` to test normal
production sandbox behavior. Linux package CI sets this option and exercises both AppRun and
AppImage extraction without FUSE. Production launchers never add `--no-sandbox` automatically.

Windows packaged checks use temporary profiles and loopback SSH, without touching saved user keys or
connected boards:

```powershell
./tests/windows-launch.ps1 -Executable "$PWD/release/Diagnostic-Hub.exe"
./tests/windows-host-verification.ps1 -Executable "$PWD/release/Diagnostic-Hub.exe"
```

The latter verifies changed-host-key cancellation/approval, remembered-key reconnect, an enabled
native window and UI cursor styles, plus valid LAN evidence retained alongside unavailable-attribute
warnings. It also requires the native cursor to stay visible when Windows reports a visible cursor
before launch. Hosted desktops without an initially visible pointer report that physical check as
unavailable; their UI and connection checks still run. Add `-RequireVisibleCursor` on an interactive
Windows PC to require physical cursor acceptance. Physical target validation is separate from these
loopback tests; follow [validation guidance](validation.md) and compare the collected report against
direct read-only SSH output on the nominated target.

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
