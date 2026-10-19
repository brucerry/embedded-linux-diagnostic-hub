# Spec Delta

## MODIFIED Requirements

### Requirement: Reverse restoration and native paths

Restoring a window minimized through the native-command Genie effect SHALL play the reverse
transition when supported, including restoration through its taskbar entry. It SHALL return to the
prior bounds and normal or maximized state without a visible full-size flash before the transition.
Win+D and other Windows OS-controlled paths that bypass the system minimize command SHALL continue
to work using native behavior; restoration following those paths SHALL NOT require Genie animation.
The Windows animated content excludes the OS-drawn frame; supported Linux compositor transitions can
include native decorations. Support boundaries SHALL be stated in the usage documentation.

#### Scenario: Restore from the taskbar

- **WHEN** the user restores a Genie-minimized application using its taskbar entry
- **THEN** the content expands back into its previous window geometry and the live workspace becomes
  usable without a preceding full-size flash

#### Scenario: Use a system minimize action

- **WHEN** Windows minimizes the app through a path bypassing its system minimize command
- **THEN** native minimize and restore remain usable without a stale overlay or delayed forced focus

### Requirement: Reduced motion and platform fallback

With system reduced motion enabled, the desktop SHALL use immediate native minimize and restore
instead of the Genie distortion. Linux desktops without an active compatible Genie integration and
browser editions SHALL retain their existing native window/browser behavior; browsers SHALL NOT show
an app window-minimize control. Supported GNOME integrations SHALL respect disabled desktop
animations. Capture failure, unsupported transparency or unavailable rendering SHALL fall back to
native behavior. This policy SHALL apply only to desktop window transitions and SHALL NOT alter
existing page and hover motion.

#### Scenario: Reduced motion

- **WHEN** the user minimizes or restores with system reduced motion enabled
- **THEN** the native operation completes without Genie distortion or an animation delay

#### Scenario: Rendering cannot start

- **WHEN** snapshot capture or overlay initialization fails
- **THEN** the requested native operation still completes and the application remains recoverable

#### Scenario: Linux companion unavailable

- **WHEN** Linux Genie integration is absent, disabled, incompatible or pending activation
- **THEN** ordinary native minimize and restore work without an in-app replacement control

#### Scenario: GNOME animations disabled

- **WHEN** the GNOME desktop animation preference is disabled
- **THEN** the companion does not introduce Genie motion or change that preference

### Requirement: Responsive transition preparation

The Windows desktop's minimize and restore preparation SHALL overlap independent taskbar lookup,
snapshot capture and encoding, and transient renderer startup instead of adding their waits
sequentially. Each direction SHALL use fresh taskbar geometry and current content, retaining the
approximately 500 ms effect, existing bounded recovery and snapshot/resource cleanup. Optimization
SHALL NOT introduce idle capture, drawing loops, stale taskbar-button positions or a retained idle
animation surface. Supported Linux compositor transitions SHALL use current window content and fresh
destination geometry without requiring the Windows snapshot-overlay preparation path.

#### Scenario: Start an initialized native transition

- **WHEN** the user requests native minimize or an owned restore after metadata initialization
- **THEN** independent preparation overlaps before the authorized first frame, the normal effect
  proceeds, and cancellation releases pending payload waits and the transient surface

## ADDED Requirements

### Requirement: GNOME native Genie transitions

On a supported GNOME session with an active compatible companion and enabled desktop animations, the
Linux desktop SHALL animate Diagnostic Hub's real native minimize and restore using a Genie
deformation lasting approximately 500 ms. Native window controls and dock/task-list restoration
SHALL remain the entry paths. The same real window SHALL finish in the requested native state with
its saved normal or maximized geometry and no preceding full-size restore flash. It SHALL include
visible terminal content, preserve the existing device/workspace lifecycle and introduce no in-app
motion button, simulated dock, separate taskbar window or renderer window-control authority.

Qualification SHALL cover Ubuntu 22.04/GNOME 42, Ubuntu 24.04/GNOME 46, Ubuntu 26.04/GNOME 50 and
Debian 13/GNOME 48, using Wayland and available X11 sessions. The legacy GNOME 42 implementation
SHALL provide the same native motion, isolation, anchor, completion and recovery behavior; modern
runtime results SHALL NOT substitute for its qualification.

#### Scenario: Native minimize and dock restore on GNOME

- **WHEN** the user minimizes Diagnostic Hub through native controls and restores it through the
  dock or task list on a supported GNOME Wayland or X11 session
- **THEN** the real window follows outgoing and reverse Genie motion and the same usable workspace
  returns without replacing the window, SSH connection, PTY or test run

#### Scenario: Native transitions on Ubuntu 22.04

- **WHEN** the qualified legacy companion is active on Ubuntu 22.04/GNOME 42 with animations enabled
- **THEN** native minimize and restore use the same approximately 500 ms outgoing/reverse Genie
  behavior, retaining window geometry and device work without an in-app replacement control

### Requirement: App-scoped Linux anchors and isolation

The GNOME effect SHALL identify Diagnostic Hub using its stable native application identity, not
window-title text or terminal content, and SHALL leave other applications' transitions unchanged.
Every minimize and restore SHALL use current uniquely identified app-icon geometry and its actual
dock edge when exposed. A supported dock approximation SHALL be documented and SHALL NOT select
another app or guess an unknown edge. When safe geometry cannot be resolved, the native transition
SHALL continue without Genie. Display scaling, negative coordinates, maximized windows, dock
relocation and icon reordering SHALL be accounted for without modifying the real window's saved
bounds, and geometry changes during a transition SHALL cancel safely.

#### Scenario: Another application minimizes

- **WHEN** a different app minimizes, including one with the same visible window title
- **THEN** the companion leaves that app's existing animation and window state unchanged

#### Scenario: Dock or icon moves

- **WHEN** the dock edge or Diagnostic Hub icon position changes while its window is minimized
- **THEN** restoration uses the fresh matching geometry or native fallback rather than a stale or
  unrelated anchor

#### Scenario: No usable dock anchor

- **WHEN** GNOME exposes no safe app icon or uniquely identifiable dock geometry
- **THEN** native minimize/restore completes without a Genie animation toward a guessed location

### Requirement: GNOME effect cleanup and recovery

Rapid requests, window resize, display changes, app close, extension disable/update and effect
errors SHALL release Diagnostic Hub's transient deformation and restore actor visibility, opacity
and native completion callbacks without altering unrelated window effects. A stalled effect SHALL
complete or recover within two seconds while the shell main loop is responsive. No drawing loop or
retained app image SHALL remain while idle or minimized. The companion SHALL NOT read device data,
persist or transmit window images, register an app control IPC endpoint or intercept terminal input.

#### Scenario: Disable during restoration

- **WHEN** the companion is disabled while the app is restoring
- **THEN** the same app window becomes usable, all owned effect resources are released and future
  transitions use native behavior

#### Scenario: Interrupt or close during motion

- **WHEN** the app is repeatedly minimized/restored, resized or closed during a transition
- **THEN** the requested final native state completes without a stuck actor, duplicate completion or
  orphan effect
