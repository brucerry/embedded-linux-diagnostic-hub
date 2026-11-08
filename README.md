<div align="center">

# Embedded Linux Diagnostic Hub

[![Website](https://img.shields.io/github/actions/workflow/status/brucerry/embedded-linux-diagnostic-hub/github-pages.yml?branch=main&label=Website)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/github-pages.yml)
[![Release](https://img.shields.io/github/actions/workflow/status/brucerry/embedded-linux-diagnostic-hub/release.yml?label=Release)](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/release.yml)
[![MIT license](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Platform checks:
[Windows](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/windows-portable.yml)
·
[Linux](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/linux-portable.yml)
·
[macOS](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/macos-qualification.yml)
·
[Published Mac verification](https://github.com/brucerry/embedded-linux-diagnostic-hub/actions/workflows/macos-published-verification.yml)

A desktop and web workbench for diagnosing embedded Linux devices. Collect read-only evidence over
SSH, inspect live graphs and save local reports. Use the SSH terminal or local Serial terminal for
interactive access.

[Download the latest release](https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest)
· [Open the website](https://brucerry.github.io/embedded-linux-diagnostic-hub/)

</div>

---

## Get started

1. Choose the Windows, Linux or Mac package in the
   [download and installation guide](docs/downloads.md). Desktop packages include the runtime;
   Node.js is needed only for development.
2. Launch the app and follow [the usage guide](docs/usage.md). For SSH diagnostics, choose **Connect
   device** and verify the device fingerprint. For local UART access, choose **Serial**; an SSH
   connection is optional.

Desktop SSH sessions work over the local network without internet or a device agent. Website SSH
requires a separately deployed [HTTPS gateway](docs/gateway.md). Automatic diagnostics are
read-only; interactive commands and armed Automation scripts can change the device. See the platform
guides for launch requirements, trust checks and updates.

---

## Develop

Install **Node.js 24** and npm, then run:

```sh
npm ci
npm run desktop:dev
```

Use `npm run dev` for browser development and `npm run verify` for formatting, types and unit tests.
The [development guide](docs/development.md) covers module boundaries and additional checks;
[build and release instructions](docs/delivery.md) cover packaging and deployment.

---

## Contribute

Contributions to diagnostics, parsers, accessibility, platform support and documentation are
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and validation expectations. For
substantial changes, open an issue describing the problem and affected environments first.

---

## Guides

- [Using the app](docs/usage.md): snapshots, reports, terminal shortcuts and updates.
- [Serial terminal](docs/serial.md), [network insights](docs/network-insights.md) and
  [Automation](docs/automation.md).
- [Windows setup and maintenance](docs/windows-setup.md): development contract and qualification
  limits.
- [Connection retries](docs/connection-retries.md) and
  [macOS installation and CI qualification limits](docs/macos-qualification.md).
- [Website setup](docs/website.md) and [gateway deployment](docs/gateway.md).
- [Architecture](docs/architecture.md), [design](docs/design.md) and
  [hardware coverage](docs/hardware.md).
- [Validation history](docs/validation.md) and [production qualification](docs/production.md).
