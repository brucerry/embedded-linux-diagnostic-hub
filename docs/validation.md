# Validation

Validation covers generic Linux evidence collection, shared UI behavior and portable client
packages. Automated fixtures describe output formats and failure cases; they do not qualify a
particular board, driver, electrical interface or Linux distribution.

## Automated checks

```sh
npm ci
npm run verify
npx playwright install chromium firefox webkit
npm run test:e2e
npm run test:portability
npm run test:desktop
```

`npm run verify` checks formatting, TypeScript and the unit/loopback SSH suite. Coverage includes
fixed read-only command syntax, authentication and host fingerprints, persistent sessions, report
validation, unavailable capabilities, partial LAN evidence, structured tables/trees, measurement
units, process sampling, search, prerequisite consent and release integrity. Synthetic identities
are generic; sample reports remain under `tests/fixtures/` and are not normal application data.

Browser tests exercise the shared interface and gateway through a loopback SSH server. Portability
checks serve the production website at a nested URL using Chromium, Firefox and WebKit, including
report import/export and a mobile viewport. Native smoke tests use an isolated profile and temporary
SSH server, without connecting to a physical target.

Linux native tests need a graphical session or Xvfb and Electron runtime libraries. The normal test
harness can pass `--no-sandbox`; set `HUB_TEST_SANDBOX=1` to exercise production sandbox behavior.
Production launchers never disable sandboxing automatically.

## Package checks

```sh
npm run package:win
npm run verify:package
npm run package:linux
npm run verify:linux
npm run package:web
npm run checksums
```

Run packaging checks on their applicable platform. They inspect the actual renderer/backend/icon
bundles, Linux launchers and architecture. Windows packaged tests are described in
[development.md](development.md). Linux CI targets Ubuntu 22.04 and runs both AppRun and AppImage
with sandboxing enabled; AppImage execution uses extraction instead of FUSE.

## Physical target validation

Choose an explicitly authorized Linux target and verify its SSH fingerprint. Connect with the
application, collect and export a report, then compare its recorded commands and raw outputs with
direct read-only SSH execution on that same target. Allow for time-varying counters and process
lists. Exercise unavailable tools, denied permissions, partially exposed interfaces and missing
measurement channels without treating these as a hardware health verdict.

Use `npx tsx scripts/validate-evidence.mts /path/to/report.json` to inspect the generic structured
views of an exported report. Target-specific identities, pin mappings, rail scaling and expected
hardware must come from the target's own documentation, rather than a bundled profile. Do not
install target packages, change system configuration or perform functional/stress tests as part of
read-only collection validation.

Keep raw reports and screenshots in ignored local output directories. Redact credentials, device
addresses and sensitive logs before sharing evidence. No dedicated named-board test harness or
profile is included.

## Recorded checks and limits

The 2026-10-06 verification pass completed formatting/types and 50 unit/SSH/release tests,
production nested-path checks in Chromium/Firefox/WebKit, packaged Linux AppRun/AppImage smoke under
WSLg with sandboxing enabled, and an isolated Windows 11 cold launch. Bundle checks confirmed
matching renderer/backend/icons across packaged desktop and web outputs. Download-helper checks
covered SHA-256 rejection, architecture selection, per-user paths and explicit prerequisite consent.

These checks do not establish Windows 10 clean-PC compatibility, Ubuntu 22.04/Debian physical-PC
acceptance, every Linux target distribution or functional hardware correctness. Physical OpenWrt
read-only collection was exercised during development; board-specific resources and historical notes
have been removed. Remote GitHub workflow execution, website publication, lab HTTPS gateway
deployment and signed release qualification remain separate acceptance steps.

Generated build output, temporary test libraries, caches and historical raw validation artifacts are
disposable. Keep current release distributions/checksums and written qualification evidence; see
[production.md](production.md) and [delivery.md](delivery.md).

## Removal of named-board resources

Removed board profiles, dedicated physical-board GUI/SSH harnesses, hardware-specific fixture
identities, old documentation screenshots and named-target notes from the UI and guides. Hardware
discovery continues to use the same generic capability-based commands, including optional OpenWrt
tools. The validation guide now describes reusable checks rather than a particular board setup.

The native harness explicitly sets Playwright's `chromiumSandbox` option when `HUB_TEST_SANDBOX=1`
and checks that `--no-sandbox` is absent from the launched process. Earlier smoke runs used
Playwright's default flag injection despite the test switch; the corrected packaged AppRun/AppImage
checks passed with sandboxing enabled. Launch failure now closes the temporary SSH server and
removes its profile. Browser clock fixtures install time before their pause timestamp, avoiding a
timing race under build load without changing application behavior.

The updated Windows/Linux desktop packages and portable website retain the shared layout and generic
hardware note. Temporary build/test output was removed after validation; current release files and
checksums remain. No physical device was accessed or changed for this cleanup.

## Collection responsiveness (2026-10-08)

Formatting/types, 69 unit tests and 40 Chromium UI tests passed. A 1,500-process fixture (about 213
KiB of process output) confirmed that numeric history runs in a background worker while bits and
card hover animations remain active. Worker-restricted collection also passed using the yielding
fallback. Existing checks cover bit arrival/draining, reduced motion, copy feedback, paired graph
hover, dense-history scrolling and stable focus/scroll positions during live updates.

Native and packaged Linux Electron loopback SSH checks confirmed background workers load on
`app://`, along with the existing connection, reset, report and update behavior. The portable
production website and its worker loaded from an arbitrary nested URL in Chromium. These are
software regression checks; native Windows GPU performance and physical-PC qualification remain
separate. No animation styling was removed or changed for this performance fix.

A follow-up native Windows check, made directly through CDP without Playwright media emulation,
reported `prefers-reduced-motion: reduce` and `animation-name: none`. Earlier automation had masked
the disabled-motion behavior. Desktop and web now always enable the original effects, independent of
OS motion preferences. There is no animation selector or stored display choice; values saved by the
temporary selector are ignored. The host's accessibility settings remain unchanged.

Regression checks cover full-motion hover/page transitions under system reduced motion, ignored
legacy preferences, animated collection and bit draining. Packaged Linux loopback SSH/report/update
checks and the nested production website check passed. Native Windows 10 and physical Ubuntu/Debian
acceptance remain separate from these software regression checks.

The final fixed-motion build passed 69 unit checks and all 42 UI checks. Three UI checks were rerun
separately after correcting a navigation selector and avoiding concurrent suites sharing the trace
directory. Raw CDP against the rebuilt Windows portable executable confirmed page animation and
brand hover on the host's actual reduced-motion setting, with no selector. Reloading with the old
saved reduced preference left animation enabled. Current Windows/Linux package and icon checks
confirmed matching desktop/web assets; the OS settings were not changed.

## Reset progress and release link (2026-10-08)

Formatting/types, 69 unit checks and the full 46-test UI suite passed. Reset now preserves the
current page and live-update setting, uses a blocking progress dialog for collection draining and
RAM cleanup and first fresh snapshot preparation. Tests cover a held collection, keyboard/scroll
blocking, a slow first post-reset snapshot, fresh graph history, failed cleanup, collection failure
without an automatic retry, and paused/imported sessions. The reset control uses a circular arrow.
The update note exposes a fixed GitHub releases link with an external-window icon; native IPC opens
only that destination.

The development Electron loopback SSH/report/reset test and nested production website check passed.
Clean-machine acceptance and physical-device timing remain separate from these regression checks.

Packaged Windows and Linux loopback SSH/report/reset/update checks also passed, including the new
fixed releases IPC link. Windows ran from an isolated local temporary folder with a private test
profile. Native/renderer/icon bundle checks confirmed desktop and website assets match. Temporary
applications and development servers were stopped after verification.

## Reset cover completion (2026-10-08)

The reset cover now remains through collection draining, RAM cleanup and preparation of the first
fresh live snapshot. A fast paused reset paints the cover for at least 300 ms. The current overview
and report components remain mounted with cleared fields; reset does not substitute a connection or
fresh-record guide. Snapshot/history references are cleared before fresh collection starts.

Formatting/types and 70 unit checks passed. All 48 UI checks passed, including retained card DOM
identity, a held fresh collection, paused cleanup with unavailable values, keyboard blocking,
collection failures, graph recovery and unchanged initial connection guidance. The cover was also
visually inspected from a test screenshot. The development Electron SSH/report/reset smoke and
nested production website check passed. Physical-device timing remains a separate qualification.

Packaged Windows and Linux smoke checks passed with explicit assertions for the visible reset cover,
retained overview cards and absence of the connection/fresh-record section. Current Windows/Linux
bundle/icon verification confirmed matching desktop/web assets. Tests used private loopback SSH
profiles and did not access or modify a physical target device.

## Graph retention across reconnects (2026-10-08)

Formatting/types and 71 unit checks passed. All 66 UI checks passed across targeted suites and a
rerun with a 60-second overall limit for the longer workflows. Repeated reconnects with Live updates
On or Off append real samples instead of replacing history. Failed connection attempts and report
imports preserve earlier samples. Different endpoints remain selectable as separate graph sources;
new connections break graph lines and restart process CPU sampling. Explicit reset clears all
retained history, within the existing 120-sample window limit.

Packaged Windows and Linux preload/IPC/loopback SSH/report/reset/update smoke checks passed with
explicit reconnect point-count assertions. The nested portable production website check passed, and
bundle/icon verification confirmed matching desktop/web assets. Tests used isolated profiles and
private loopback SSH fixtures. Clean-machine and physical-device qualification remain separate.
