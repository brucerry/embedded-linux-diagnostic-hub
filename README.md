# Embedded Linux Diagnostic Hub

[![Website](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/github-pages.yml/badge.svg?branch=main)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/github-pages.yml)
[![Windows](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/windows-portable.yml/badge.svg?branch=main)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/windows-portable.yml)
[![Linux](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/linux-portable.yml/badge.svg?branch=main)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/linux-portable.yml)
[![Release](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/release.yml/badge.svg)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A shared desktop and web workbench for developers and test engineers diagnosing embedded Linux over
SSH. Inspect real device identity, system resources, interfaces, hardware discovery and logs through
read-only checks, structured evidence views, live graphs and local JSON reports.

The desktop ships as **one portable Windows x64 `.exe`** for Windows 10/11 and a **Linux x86_64
AppImage**, with a portable Linux archive alternative. It works over a local network without
internet, an installed JavaScript runtime or a device agent. The portable website works on static
HTTP(S) hosts and uses a separately hosted HTTPS lab gateway for live SSH. Neither edition changes
device configuration or provides arbitrary device-file access.

Current releases are engineering previews. Windows/Linux 32-bit desktop binaries are unsupported;
use the website on those clients.

---

## Prerequisites

- **Users:** a reachable Linux SSH service and credentials. Download your platform package from
  [Releases](https://github.com/brucerry/embedded-linux-diagnostic-hub/releases), launch it, select
  **Connect device**, and verify the device fingerprint.
  [One-line download commands](docs/downloads.md) verify and launch the release without
  administrator elevation. Linux checks missing libraries and asks before installing prerequisites;
  that separate installation may require `sudo`.
- **Developers:** Node.js 24 and npm. Windows is recommended for Windows packaging and signing;
  Linux/WSL supports development and unsigned cross-builds. Electron tests need a desktop display;
  Linux also needs the Chromium/Electron runtime libraries.
- **Website operators:** GitHub Pages enabled and a lab server that can reach devices over SSH.
  Configure its HTTPS gateway using [the gateway guide](docs/gateway.md).

---

## Develop and run

```sh
npm ci
npm run desktop:dev
```

| Command                                    | Purpose                                             |
| ------------------------------------------ | --------------------------------------------------- |
| `npm run dev`                              | Browser development at `http://127.0.0.1:5173`      |
| `npm run build && npm start`               | Run the built desktop application                   |
| `npm run build:web && npm run preview:web` | Preview the production website locally              |
| `npm run gateway`                          | Run the lab gateway using your local `.env.gateway` |

Connect once to collect evidence. Live updates reuse the SSH connection; switching them off enables
manual snapshots. **Disconnect device** retains the displayed evidence. **Import report** and
**Export report** work locally in both editions. Running snapshots and graph history stay in RAM.
Reconnecting appends to the retained graph history, which holds the latest 120 samples per window.
Graphs separate different endpoints with a **Collection source** selector. Explicit report exports,
update report backups and trusted desktop SSH fingerprints are saved to disk. The red **Reset
session data** button clears the current snapshot and graph history from RAM, shows a blocking cover
while cleanup runs and the first fresh live snapshot is prepared. With live updates off, the
existing cards remain with cleared readings. It keeps the current page, SSH connection and saved
report files.

The desktop header offers **Check for updates**, including prereleases. Choose **Update without
saving**, **Save report & update**, or **Save, update & reopen report**, or cancel. Updates wait for
active collection, disconnect SSH, verify the download and restart without reconnecting. Saved
reports remain in the user's application data folder under `update-reports`. Clean update keeps
existing backups and trusted SSH fingerprints.

---

## Development structure

```text
src/
    app/                Application shell and page selection
    hooks/              Connection, collection and report lifecycle
    pages/              Overview, diagnostics and reports
    features/           Connection dialog, evidence views and transfer artwork
    components/         Shared UI controls and icons
    services/           Browser gateway client and error handling
    styles/             Shared desktop/web styling
shared/
    diagnostics/        Fixed probes, parsers, findings, graphs and search
    report.ts           Report validation and serialization
    types.ts            Shared contracts
backend/ssh/            Platform-independent SSH session and monitor
electron/              Native window, trusted IPC, preload and host verification
gateway/               Authenticated HTTP API and lab deployment files
scripts/               Packaging, validation and release utilities
tests/                 Unit, SSH, browser, download and native desktop verification
docs/                  Detailed design, deployment and validation guides
```

See [development guidance](docs/development.md) for module boundaries and how to add a diagnostic.

---

## Build and verify

```sh
npm run verify
npx playwright install chromium
npm run test:e2e
npm run test:desktop
npm run package:win
npm run package:linux
```

Windows output is `release/Diagnostic-Hub.exe`; `win-unpacked/` is intermediate output. Only the
`.exe` is needed by Windows users. Linux output is `release/Diagnostic-Hub-linux-x64.AppImage` and
`release/Diagnostic-Hub-linux-x64.tar.gz`; `linux-unpacked/` is intermediate output. Generate
distribution checksums with `npm run checksums`.

Use `npm run build:web` for GitHub Pages in `dist-web/`, `npm run package:web` for a relocatable
website ZIP, and `npm run package:gateway` for the lab server archive. Builds share the same UI;
desktop, website and gateway use separate output directories.

For Linux/WSL cross-packaging and signing, see [delivery instructions](docs/delivery.md). Unsigned
builds may show Windows publisher warnings; trusted signing requires a code-signing certificate.

---

## Deploy

| Trigger                            | GitHub Actions result                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| Pull request                       | Verify website, Windows and Linux; upload build artifacts                               |
| Push to `main`                     | Verify all platforms; deploy the website to GitHub Pages                                |
| Manual workflow run                | Build artifacts; website deploys when run on `main`                                     |
| Push `v<package.json version>` tag | Verify all platforms; publish desktop packages, web ZIP, gateway, helpers and checksums |

Set **Settings → Pages → Source → GitHub Actions** once. The expected website address is
[brucerry.github.io/embedded-linux-diagnostic-hub](https://brucerry.github.io/embedded-linux-diagnostic-hub/).
Versions with prerelease suffixes are published as prereleases. Optional repository secrets
`WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` enable Windows signing. The gateway is deployed
separately on your lab server; GitHub Pages hosts the GUI only.

See [release procedure](docs/delivery.md), [website configuration](docs/website.md) and
[gateway deployment](docs/gateway.md).

---

## Maintain

Use four spaces per indentation level and the repository formatter:

```sh
npm run format
npm run verify
```

Keep UI behavior shared, add capability-based diagnostics with parser fixtures, and verify changes
through browser and native tests. Do not commit credentials, exported device reports or build
output. Update release versions and validation evidence together; keep one current `.exe` in local
`release/`.

Details: [hardware coverage](docs/hardware.md) · [architecture](docs/architecture.md) ·
[design](docs/design.md) · [validation history](docs/validation.md) ·
[production qualification](docs/production.md).

---

## Contribution

Contributions to diagnostics, parsers, accessibility, platform compatibility and documentation are
welcome. For substantial changes, open an issue first with the problem, proposed behavior and any
affected client or target environments.

1. Fork the repository, clone your fork and create a branch for one focused change. Install Node.js
   24 and run `npm ci`; use the development commands above to preview your work.
2. Follow [development guidance](docs/development.md) and the existing module boundaries. Keep the
   desktop and website UI shared, use four-space indentation and run `npm run format`.
3. Make new diagnostics capability-based and read-only, with bounded output and explicit unavailable
   results. Add meaningful parser/SSH fixtures for structured data, missing tools and partial
   failures. Keep sample data under `tests/fixtures/` and out of normal application startup.
4. Run `npm run verify` and the checks relevant to your change. UI changes need `npm run test:e2e`;
   desktop changes need `npm run test:desktop`. Hosting or packaging changes should also run the
   applicable portability/package checks in the development and delivery guides. Install Playwright
   browsers before browser tests; native tests need a graphical desktop or Xvfb.
5. Update affected documentation. Report the client OS, target distribution, commands tested and
   results, distinguishing automated fixtures from real-device validation. Never commit credentials,
   private keys, access tokens, exported device reports, generated builds or caches; redact
   sensitive information from submitted logs.
6. Open a pull request describing the problem, resulting behavior, validation and remaining limits.
   Link any related issue and keep dependency or formatting changes focused on the contribution.
   Required CI checks must pass before merging.
