# Proposal

## Why

Diagnostic Hub's native Genie motion currently works only on Windows. Users want the same native
minimize/restore experience on Ubuntu and Debian, with the existing one-line Linux download command
handling necessary setup instead of requiring knowledge of desktop extensions.

## What Changes

- Add an optional GNOME Shell companion that animates only Diagnostic Hub's real native window, on
  supported Wayland and X11 GNOME sessions, including dock restoration and current app anchors.
- Extend the existing Linux one-line download flow to detect compatibility, offer the needed
  packages and per-user integration, and verify the companion from the same release as the app.
- Distinguish active, pending session activation, skipped and unsupported setup; launch the normal
  app even when Genie is unavailable. Never restart the user's session automatically.
- Preserve device/terminal/test continuity, reduced motion, bounded recovery and existing Windows
  behavior. Document disabling/removing the companion and retained installation size.
- Qualify the full matrix: Ubuntu 22.04 LTS/GNOME 42, Ubuntu 24.04 LTS/GNOME 46, Ubuntu 26.04
  LTS/GNOME 50 and Debian 13/GNOME 48. Add a separately packaged legacy companion for GNOME 42;
  other unqualified shell versions and desktops keep native fallback.

## Capabilities

### New Capabilities

- `linux-genie-installation`: verified release delivery, compatible session detection, optional
  package/per-user setup, truthful activation state and reversible removal through the Linux flow.

### Modified Capabilities

- `desktop-window-transitions`: add GNOME compositor-owned native Genie, app-only identity and fresh
  anchors; replace the unconditional Linux fallback with supported integration and safe fallback.

## Impact

New GNOME extension source, packaging and installer modules; Linux application identity and desktop
integration; `public/download-run.sh`, Linux launcher integration, release asset/checksum
verification and publication; downloader/unit/native GNOME tests and Linux CI; linked
download/usage/development documentation. No new required desktop environment, global animation
setting, app window-control IPC or device-side package is introduced. OpenSpec artifacts remain
local under the existing exclusion.

## Continuation decision - 2026-10-11

The user retained the full target matrix and added Ubuntu 22.04. Implementation is paused at the
user's request until a later session. Preserve source changes, planning and compact qualification
evidence; remove disposable development/test installations, downloads and caches now. Existing
modern-GNOME evidence does not establish GNOME 42 support or complete GNOME 50 visual qualification.
