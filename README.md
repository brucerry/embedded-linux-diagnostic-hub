# Embedded Linux Diagnostic Hub

[![Website](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/github-pages.yml/badge.svg?branch=main)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/github-pages.yml)
[![Windows](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/windows-portable.yml/badge.svg?branch=main)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/windows-portable.yml)
[![Linux](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/linux-portable.yml/badge.svg?branch=main)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/linux-portable.yml)
[![macOS](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/macos-qualification.yml/badge.svg?branch=main)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/macos-qualification.yml)
[![Release workflow](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/release.yml/badge.svg)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/release.yml)
[![Published Mac verification](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/macos-published-verification.yml/badge.svg?branch=main)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/macos-published-verification.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A desktop and web workbench for diagnosing embedded Linux devices over SSH. Inspect system
resources, interfaces, hardware and logs with read-only checks, live graphs and local JSON reports.
Use the embedded terminal for interactive device commands.

[Download the latest release](https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest)
· [Open the website](https://brucerry.github.io/embedded-linux-diagnostic-hub/)

## Get started

1. Download `Diagnostic-Hub.exe` for Windows 10/11 x64, the AppImage/archive for Linux x86_64, or
   the complete
   [Intel Mac app](https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest/download/Diagnostic-Hub-macos-x64.zip)
   /
   [Apple Silicon Mac app](https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest/download/Diagnostic-Hub-macos-arm64.zip).
   The portable desktop needs no Node.js installation and connects over a local network without
   internet or a device agent. See [download commands and platform requirements](docs/downloads.md).
2. Launch the app, choose **Connect device**, enter your SSH credentials and verify the device
   fingerprint. Browse diagnostics, collect snapshots or use **Terminal**.

The website uses a separately deployed [HTTPS SSH gateway](docs/gateway.md). Automatic diagnostics
are read-only; terminal commands run with your SSH account's permissions and can change the device.
Mac Terminal install and launch:

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest/download/download-run-macos.sh | /bin/bash'
```

Mac apps are ad-hoc signed, not Developer ID signed or notarized. Updates are manual; macOS or
managed-device policy can block launch. See
[Mac installation and trust guidance](docs/macos-qualification.md).

## Develop

Install **Node.js 24** and npm, then run:

```sh
npm ci
npm run desktop:dev
```

Use `npm run dev` for browser development and `npm run verify` for formatting, types and unit tests.
The [development guide](docs/development.md) covers module boundaries and additional checks;
[build and release instructions](docs/delivery.md) cover packaging and deployment.

The release workflow badge shows the latest default-branch read-only audit of a published release.
New tags still run the complete publication gates, whose history remains on the workflow page.
Published Mac verification reports the separate public-command checks; the download link shows
latest-release availability. Historical failed runs remain visible; see
[delivery and verification](docs/delivery.md).

## Contribute

Contributions to diagnostics, parsers, accessibility, platform support and documentation are
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and validation expectations. For
substantial changes, open an issue describing the problem and affected environments first.

## Guides

- [Using the app](docs/usage.md): snapshots, reports, terminal shortcuts and updates.
- [Connection retries](docs/connection-retries.md) and
  [macOS installation and CI qualification limits](docs/macos-qualification.md).
- [Website setup](docs/website.md) and [gateway deployment](docs/gateway.md).
- [Architecture](docs/architecture.md), [design](docs/design.md) and
  [hardware coverage](docs/hardware.md).
- [Validation history](docs/validation.md) and [production qualification](docs/production.md).
