# Design

## Context

See `proposal.md` for motivation. The current `WindowTransitions` chooses only the Windows
`TaskbarReader` and native HWND subclass. Linux's existing CI checks native fallback under Xvfb.
`public/download-run.sh` verifies an AppImage/archive and runs as an ordinary desktop user;
`scripts/linux-launcher.sh` offers explicitly accepted apt prerequisites and rechecks libraries. The
release asset list is strict and currently has no GNOME companion. These are observed code paths,
not evidence of GNOME compatibility.

Electron 44 cannot position/introspect global window coordinates on Wayland, and its minimize event
does not reliably represent compositor-driven native minimization. GNOME owns the window actor, icon
geometry and native animation completion. The Windows overlay is therefore retained for Windows;
Linux integration runs inside GNOME Shell. Native frame participation differs by backend.

## Goals / Non-Goals

**Goals:** make supported Ubuntu/Debian setup understandable through the existing command; animate
only the actual Diagnostic Hub window; preserve ordinary native access and device work; qualify
compositor behavior and delivery separately from headless browser/unit checks.

**Non-Goals:** installing a new desktop; automatic logout/reboot/shell restart; KDE/Xfce effects in
this change; GNOME 43 support; altering global animation or extension policy; changing Windows
rendering, the website or the connected device's packages.

## Decisions

### 1. A release-matched GNOME companion

Add original extension source under `linux/gnome-genie/`, with a fixed Diagnostic Hub UUID, an ESM
entrypoint for GNOME 46/48/50 and a legacy entrypoint for GNOME 42. Use GNOME compositor window
actors for deformation and native completion; do not replay app commands or build a fake native
minimize UI. A short prototype must establish the hook and deformation behavior under actual GNOME
before production packaging. GNOME private APIs vary, so runtime capability checks must retain
native behavior if the expected lifecycle is unavailable.

Package a dedicated `Diagnostic-Hub-Genie-<version>.zip` and SHA-256 through a new packaging script;
embed release/version identity in metadata. Extend `scripts/lib/release-assets.mjs`,
checksum/release validation, Linux artifact upload and `.github/workflows/release.yml` publication
together. The companion is generated from the same source commit and tag as the app. Do not fetch
mutable third party extension code or install unrelated global Magic Lamp effects.

GNOME 42 cannot load the modern ESM extension format. Deliver a separate release-matched legacy ZIP
with a GNOME 42-only compatibility declaration, using the same owned UUID and original deformation
rules. Keep the modern ZIP's existing asset name; define a distinct legacy asset name when
implementing packaging. Validate each format's exact allowed contents and embedded build identity,
include both in checksums/manifests/publication gates, and choose the format from the actual running
shell. Never claim GNOME 42 support by adding it to modern ESM metadata. Runtime API adapters,
status export and cleanup require independent GNOME 42 qualification.

### 2. Detect the running session, not just the distribution

Initial target systems are Ubuntu 22.04 LTS/GNOME 42, Ubuntu 24.04 LTS/GNOME 46, Ubuntu 26.04
LTS/GNOME 50 and Debian 13/GNOME 48, with vendor patch versions checked against actual runtime
capabilities. Determine the actual running shell version and session bus availability;
`XDG_CURRENT_DESKTOP` alone is insufficient. Populate the install/extension allowlist only with
qualified major versions. Other GNOME versions, including GNOME 43, retain normal app support
without claiming Genie. Wayland and available X11 sessions require separate compositor evidence. Do
not force X11 on a Wayland user or turn an unsupported version into a nominally supported one by
skipping checks.

### 3. App identity and destination belong to the native desktop

Give Linux builds a stable native desktop/application ID and matching desktop registration, checking
Electron's `setDesktopName`, packaged `.desktop` name and `StartupWMClass` together. The companion
must match that identity, not the title. Register a managed per-user desktop entry/icon from the
one-line setup when needed so standalone AppImage downloads can map to a dock icon; point it at the
persistent verified app file with correct quoting, never the temporary extraction directory.

Query the real window's current GNOME icon geometry each time. Use the current matched dock/icon
actor when exposed by Ubuntu Dock or the stock GNOME dash. Treat absent/ambiguous geometry as native
fallback; do not rely on a cached minimize anchor or assume a bottom dock. Reuse the existing
upright four-edge deformation mathematics where appropriate, without assuming physical pixels equal
GNOME logical actor coordinates. A compositor may include its decorations in the effect.

### 4. Add optional setup to the current download flow

The public one-line command remains unchanged. The helper runs optional setup after the ordinary
app's verification and before launch, selecting the companion from the same tag. Offer one plain
Genie setup explanation through `/dev/tty`, including any concrete apt package list and per-user
registration. Install only missing known utilities, rechecking them after apt succeeds. GNOME
already provides `gnome-extensions`; never install the whole GNOME desktop to obtain it. Missing
utility mapping must be based on the selected distribution's package data. Optional setup is best
effort; normal app prerequisites retain their current separate required checks.

Stage companion bytes and verify checksum, fixed UUID, release metadata and a strict archive file
allowlist before any desktop change. Reject path traversal, links and unexpected files. Store owned
integration under the user's XDG data directory. Preserve backups of a previous managed version for
rollback, reject ownership collisions and symlinked destinations, and install/update only this UUID
and owned desktop entry/icon. Routine launch must not reinstall or re-prompt for an already
compatible installation. `--download-only` skips setup; offer explicit `--no-genie` and managed
removal modes for users who prefer native behavior. An older release without the companion launches
normally and does not disable a newer managed installation silently.

### 5. Activation must be observable and reversible

Read the current shell extension state via its supported session API/tool, checking enabled state,
error state and active release identity. A successful file install is not active runtime evidence.
Add a read-only session-bus status endpoint that reports the enabled instance's embedded build
identity and supported capabilities. It exposes no window actions, images, device data or input
methods; installed metadata alone cannot establish the loaded code's version. The shell may cache an
older loaded implementation until a new session. Report `active`, `pending activation`, `skipped`,
`unsupported` or `setup failed` with plain next steps. If immediate activation is unavailable,
explain the next login and launch the app normally; do not run an automatic shell restart, logout or
session termination. Preserve `disable-user-extensions`, other enabled extension IDs and the desktop
animation preference.

After accepted setup, persist enablement of only the owned UUID so the next normal login can finish
activation without a separate expert setup command. On an update that cannot load fresh code,
disable only the old owned effect before staging the new version and keep it inactive in the current
session; do not call a stale loaded implementation newly active. Restore the previous managed state
on installation failure. Respect globally disabled extensions instead of enabling the global switch.

Disabling/uninstalling the companion restores only its own actor transformations, signal handlers
and hooks. The managed removal command leaves downloaded apps, other desktop entries and SSH/device
data intact. Report the small companion/registration byte count from actual installed files and
separate any apt package sizes; do not promise a size before the artifact exists.

### 6. Native completion and continuity have their own qualification

Use scoped deformation on the existing compositor actor, with no disk/network image capture or
app-command IPC. Track one effect generation per owned window. Every completion, cancellation,
resize, geometry change, destruction and extension disable must release owned resources and notify
GNOME exactly once. Preserve existing actor transforms/opacity and other effects. A two-second
watchdog covers a stalled effect while the shell's main loop remains responsive; it cannot recover a
crashed or blocked desktop compositor. Respect GNOME's disabled-animation policy.

Test in disposable GNOME sessions using isolated XDG directories/session buses; never install a
qualification extension into the user's real desktop or stop the existing Linux SSH environment. Use
the documented nested Wayland launch for GNOME 48 and earlier, and the GNOME 49+ devkit approach
where needed. Build dedicated Ubuntu/Debian qualification jobs/environments rather than replacing
the existing Ubuntu 22.04 package/fallback workflow. Require actual native frame/dock actions,
intermediate frame evidence, a non-target app control, maximized/scaled/dock relocation cases,
reduced motion, cancellation/disable and 100-cycle native/resize stress. Repeat connected SSH/PTY,
collection and test-run continuity in the same real app. Xvfb without GNOME is fallback evidence
only.

Add separate GNOME 42 Wayland and available X11 compositor jobs for Ubuntu 22.04 while retaining the
existing Ubuntu 22.04 package/fallback job. The full qualification matrix remains mandatory; GNOME
50 black headless captures are a pending visual gate, not grounds to drop that target or count
successful callbacks as visible motion. Physical coverage and fixtures remain distinct.

## Risks / Trade-offs

- GNOME API and package variation → capability checks, explicit runtime major allowlist and separate
  Ubuntu/Debian compositor gates; record unsupported/unavailable physical cases honestly.
- New extension discovery or cached code needs a new session → pending activation status and a
  next-login instruction, with normal app access now.
- Other animation extensions override the same path → limit ownership to Diagnostic Hub, restore
  only owned hooks, detect incompatible routing and use native fallback without disabling others.
- Dock geometry is absent or stale → fresh native matching plus fallback; never claim precise icon
  anchoring from a mock or choose another application.
- Optional apt/network/activation failures → retain prior managed integration and verified app; keep
  root privileges limited to accepted package installation.
- A GNOME extension runs in the compositor → bound work, failure cleanup and native stress tests; a
  source-level test alone cannot establish shell safety or visual correctness.

## Migration Plan

Prototype and qualify native GNOME motion first; then package the companion and optional setup.
Preserve the existing app asset names and one-line URL. Test current and older release selection,
first install, update, pending activation, skip and removal. Document supported systems and size in
linked guides with a concise README. Publication requires later explicit delivery authorization; do
not move the existing `v0.2.0-rc.4` tag. Keep owned evidence/planning local and clean only generated
qualification output after checks.

The user paused implementation on 2026-10-11 and requested removal of disposable qualification
installations and generated files. Retain compact evidence and the existing SSH test server;
recreate isolated GNOME environments when work resumes. No new runtime allowlist entry, legacy
implementation or release support claim is authorized as part of this planning/cleanup turn.

## References

- [Electron native window limitations](https://www.electronjs.org/docs/latest/api/browser-window).
- [GNOME extension development and nested sessions](https://gjs.guide/extensions/development/creating.html).
- [GNOME 46 window-manager lifecycle](https://github.com/GNOME/gnome-shell/blob/gnome-46/js/ui/windowManager.js),
  [GNOME 48](https://github.com/GNOME/gnome-shell/blob/gnome-48/js/ui/windowManager.js),
  [GNOME 50](https://github.com/GNOME/gnome-shell/blob/gnome-50/js/ui/windowManager.js).
- [Ubuntu 24.04 GNOME packages](https://packages.ubuntu.com/noble/gnome-shell),
  [Ubuntu 26.04](https://packages.ubuntu.com/resolute/gnome-shell),
  [Debian 13](https://packages.debian.org/trixie/gnome-shell).
- [Ubuntu 22.04 GNOME packages](https://packages.ubuntu.com/jammy/gnome-shell) and
  [GNOME's incompatible ESM format change](https://gjs.guide/extensions/upgrading/gnome-shell-45.html).
