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
