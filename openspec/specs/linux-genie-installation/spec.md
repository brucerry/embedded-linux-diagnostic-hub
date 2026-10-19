# linux-genie-installation Specification

## Purpose

Let Ubuntu and Debian users obtain optional native Genie support through the ordinary Linux
download-and-run command, with verified delivery and understandable setup and activation outcomes.

## Requirements

### Requirement: No Genie activation or delivery requirement

Current app launchers/builds/releases SHALL contain no Genie setup prompt, companion fetch,
extension activation/removal operation or required companion asset. Standard app integrity,
platform-library checks and sandbox-preserving launch behavior SHALL remain. Existing downloaded
apps/extensions, saved data and historical release evidence SHALL be preserved; no automatic
uninstallation migration SHALL run.

#### Scenario: Launch a verified Linux artifact

- **WHEN** the launcher downloads and verifies a supported app artifact
- **THEN** ordinary launch proceeds without optional Genie consent, Python/GLib integration probes
  or extension changes
