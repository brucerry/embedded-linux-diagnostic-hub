# Native Genie motion on Linux

Diagnostic Hub has an optional GNOME Shell companion for native minimize and restore. It deforms the
actual window toward its current app icon in about half a second. Device work continues in the same
app process.

This integration needs a release containing `Diagnostic-Hub-Genie-<version>.zip`. Earlier releases,
including v0.2.0-rc.4, use ordinary Linux window motion. Development packaging does not add assets
to an existing public release.

## Target desktops

| Distribution     | GNOME Shell | Session         |
| ---------------- | ----------- | --------------- |
| Ubuntu 22.04 LTS | 42          | Wayland and X11 |
| Ubuntu 24.04 LTS | 46          | Wayland and X11 |
| Ubuntu 26.04 LTS | 50          | Wayland         |
| Debian 13        | 48          | Wayland and X11 |

The helper checks the running shell through its session bus. Other desktops and GNOME versions
retain native window motion. GNOME 50 has no X11 backend. Missing or ambiguous app-icon geometry,
incompatible native hooks, or another extension owning the animation route also use normal motion.
Global animation and extension preferences are preserved. A hidden dock may use normal motion until
a safe icon position is available. GNOME 50 currently uses the Genie path only when the window actor
reports resource scale 1; other resource scales retain ordinary native motion. Its visual and stress
evidence comes from isolated software rendering, with physical GPU/display configurations
unqualified.

Ubuntu 22.04/GNOME 42 uses the separate `Diagnostic-Hub-Genie-Legacy42-<version>.zip`, with its
legacy module loader and shared effect and geometry source. GNOME 42.9 passed isolated Wayland and
X11 visual, native, resize/interruption and software SSH/PTY continuity checks. The helper offers
optional setup when the selected release contains its verified legacy ZIP. Complete release
acceptance and physical GPU/display qualification remain separate gates.

## Setup and activation

Use the existing [Linux download command](downloads.md#one-line-commands) as your ordinary desktop
user. After verifying the app, it offers **Set up Genie? [y/N]** on a supported desktop. The prompt
explains the per-user companion, shortcut and icon, and lists missing optional apt packages. Only
accepted package installation uses `sudo`. Python 3 and GLib command-line utilities are the optional
prerequisites; the helper never installs a desktop.

Declining, having no interactive terminal, or failing optional setup still lets a verified,
otherwise runnable app open. Required app libraries have their own existing prompt.

First installation can activate immediately or report **pending activation**. If pending, sign out
and back in during your normal workflow; setup never restarts GNOME, logs you out or reboots.
Updates can remain pending because GNOME caches extension modules. **Active** requires the running
companion's embedded version, commit and source hash to match the installed release. Installed files
alone do not establish activation. Globally disabled extensions stay globally disabled.

Repeat compatible setup reports state without prompting or re-enabling a companion you disabled. To
skip integration:

```sh
bash download-run.sh --no-genie
bash download-run.sh --download-only
```

The app and companion come from the same selected release tag. Checksums and the Linux build
manifest must agree before integration changes. Invalid ZIPs, modified managed files, symlinks and
unowned registration collisions are preserved and reported as setup failure.

## Files, space and removal

Files use your XDG data directory, normally `~/.local/share`:

- `gnome-shell/extensions/diagnostic-hub-genie@diagnostichub.desktop/`
- `applications/diagnostic-hub.desktop`
- `icons/hicolor/256x256/apps/diagnostic-hub.png`

Setup prints the actual installed bytes for the selected format. The locally built
`0.2.0-rc.5-qualification.1` packages measured 35,618 bytes compressed for modern GNOME and 35,709
bytes for GNOME 42 legacy. Observed modern installation used 83,707 bytes including registration;
retained legacy installations used 83,931 bytes with AppImage registration and 84,161 bytes with
archive registration. The installed total varies with version and launch-path length. These are
development measurements, not assets added to the public RC4 release. App downloads and system
prerequisites are separate; package space depends on what your PC already has.

The shortcut uses the persistent verified AppImage, including paths with spaces. For archive
downloads, the managed Python launcher verifies and temporarily extracts the persistent archive each
time. Shortcuts survive cleanup of previous temporary extractions.

Disable only this companion through GNOME's Extensions app, or:

```sh
gnome-extensions disable diagnostic-hub-genie@diagnostichub.desktop
```

Remove only its unmodified managed files:

```sh
bash download-run.sh --remove-genie
```

Downloaded apps, other extensions and device data remain. Shared prerequisite packages are not
automatically removed. Modified or unowned files are preserved.

## Development and qualification

Source is in `linux/gnome-genie/`. `npm run package:genie` creates the versioned ZIP and checksum
from the app's source checkout for both modern and GNOME 42 legacy formats. Each ZIP has its own
strict shell metadata, format identity, source digest and checksum. Release CI requires clean
tracked sources and records the companion hash alongside Linux app assets. The read-only endpoint is
`org.gnome.Shell`, `/dev/diagnostichub/Genie`, `dev.diagnostichub.Genie1.GetStatus`. It has no
window-control method and disappears on disable.

The Linux workflow retains Ubuntu 22.04 package/native fallback checks and adds isolated GNOME
42/46/48/50 compositor sessions. The GNOME 42 harness has run locally in isolated WSL2 sessions; the
workflow jobs have not been verified remotely. `tests/gnome-session.sh` uses private XDG directories
and a separate session bus. Its test-only unsafe Shell evaluation is never distributed in the
companion.

The harness observes real native completion, 100 minimize/restore cycles, bounds, non-target
isolation, reduced motion, route conflicts and disable recovery. An actual 42-second Bash PTY stream
runs over OpenSSH alongside live diagnostics. Logs and external-display captures are separate from
unit fixtures; Xvfb alone does not qualify the animation.

Physical GPU drivers, fractional-scale displays and physical multi-monitor docks require additional
hardware acceptance. Virtual and logical-coordinate fixtures cannot establish physical coverage.

The current development qualification is incomplete. GNOME 42.9 passed baseline Wayland and X11
checks. GNOME 46.0 and GNOME 48.7 passed extended stress on both backends. A GNOME 48 Wayland rerun
retained exact saved bounds after 400 resize requests and 200 native cycles, but an earlier
saved-bounds mismatch remains unexplained. Ten separate enabled/disabled bounds comparisons also
passed; these finite passes do not establish that the intermittent mismatch is fixed.

Independent real-app continuity passed on GNOME 42/46/48/50 with 42 ordered one-second PTY ticks,
the same Bash process and PTY, one connection and terminal channel, continued collection and clock
refresh, distinct retained connected/simulated run identities, and eligible focus on return. The
connected tests use a software inventory/read fixture over real loopback SSH. GNOME 50's continuity
result does not qualify its visual motion.

GNOME 50.1 now renders the app before motion and its outgoing effect texture contains actual app
content, but the restore texture lacks the app body and target deformation is still unqualified.
Changing desktop pixels or successful native callbacks alone cannot pass the visual gate.

Genuine locally built second-version AppImage and archive updates on GNOME 42 passed pending
activation in the cached session and active status in a fresh isolated session, without another
prompt. This uses an explicit local transport fixture and does not claim a physical/GDM login. These
finite software tests do not establish physical GPU/display coverage or release readiness.
