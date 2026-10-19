# Desktop Window Transitions

## Purpose

Provide a macOS-inspired Genie minimize and restore enhancement for the Windows desktop while
preserving native window access, active device work and reliable recovery.

## ADDED Requirements

### Requirement: Native-command Genie minimization

The Windows desktop SHALL apply Genie to its standard native title-bar and system-menu minimize
command, without introducing an in-app motion button or renderer window-control API. When motion and
rendering are available, this command SHALL visibly contract a snapshot of the application content
into a narrow shape toward the current Windows taskbar over approximately 500 ms, and leave the real
application minimized with its normal taskbar entry. The existing native window frame and its
controls SHALL remain available. The effect SHALL include terminal rendering when Terminal is
visible and SHALL NOT require a simulated desktop or dock.

#### Scenario: Minimize the active workspace

- **WHEN** the user activates native title-bar or system-menu Minimize on a supported Windows
  desktop with normal motion
- **THEN** the current application content visibly follows the Genie transition and the real window
  ends minimized, without disconnecting the device

### Requirement: Reverse restoration and native paths

Restoring a window minimized through the native-command Genie effect SHALL play the reverse
transition when supported, including restoration through its taskbar entry. It SHALL return to the
prior bounds and normal or maximized state without a visible full-size flash before the transition.
Win+D and other OS-controlled paths that bypass the system minimize command SHALL continue to work
using native behavior; restoration following those paths SHALL NOT require Genie animation. The
animated content excludes the OS-drawn frame, and support boundaries SHALL be stated in the usage
documentation.

#### Scenario: Restore from the taskbar

- **WHEN** the user restores a Genie-minimized application using its taskbar entry
- **THEN** the content expands back into its previous window geometry and the live workspace becomes
  usable without a preceding full-size flash

#### Scenario: Use a system minimize action

- **WHEN** Windows minimizes the app through a path bypassing its system minimize command
- **THEN** native minimize and restore remain usable without a stale overlay or delayed forced focus

### Requirement: Preserve device and workspace lifecycle

Minimize and restore SHALL NOT close or replace the main workspace, authenticate again, disconnect
SSH, restart its PTY, reset a test run, inject or replay terminal input, or fabricate diagnostic
evidence. Output consumption and acknowledgments SHALL retain existing bounded behavior while
minimized. Existing visibility-based painting and clock scheduling SHALL remain effective, and
ordinary live-collection scheduling SHALL NOT be accelerated by the transition. Restoration SHALL
preserve selected page, scroll positions and editable values, and restore eligible prior focus
without bypassing a modal or other input block.

#### Scenario: Keep an interactive shell alive

- **WHEN** a connected shell is minimized and restored after producing output
- **THEN** the same SSH connection and PTY remain, output is retained within existing limits, and no
  queued command is replayed

#### Scenario: Keep a board test running

- **WHEN** the application is minimized and restored during a board test
- **THEN** the same run continues with its real progress/results and no extra start or confirmation
  is sent to the device

### Requirement: Display geometry and window state

The transition SHALL query current Windows taskbar geometry for each minimize and restore, using the
uniquely identified application button on the application's display when exposed and a matching
button on another taskbar otherwise. Its destination SHALL be a small anchor at the current app
button's center on the detected left, top, right or bottom taskbar; both the direction and
deformation SHALL follow that edge without rotating or mirroring the content. When the shell does
not expose a unique app button, the destination SHALL use the detected taskbar center as a
documented approximation rather than selecting another app. Window bounds, work area and display
scaling SHALL be accounted for. Moving between displays, negative display coordinates, mixed DPI and
maximized windows SHALL NOT stretch, offset or crop the source snapshot. A geometry change during a
transition SHALL cancel safely into native behavior if it cannot be reconciled.

#### Scenario: Minimize on a secondary scaled display

- **WHEN** the app is on a secondary display with different scaling or a negative screen origin
- **THEN** the snapshot starts at the actual content bounds and contracts toward that display's
  taskbar anchor when available, without changing the real window's saved geometry

#### Scenario: Taskbar at any desktop edge

- **WHEN** Windows positions the taskbar on the left, top, right or bottom edge
- **THEN** the content contracts toward that taskbar edge and restores from it with the content
  remaining upright and readable throughout the transition

#### Scenario: Taskbar moves while the app is minimized

- **WHEN** the user changes the taskbar edge before restoring the application
- **THEN** the restore effect uses the newly detected edge rather than the earlier minimize anchor

#### Scenario: Autohide taskbar

- **WHEN** the taskbar is hidden using Windows autohide
- **THEN** the effect uses the taskbar's registered edge and does not infer a bottom-edge
  destination merely because the desktop work area is no longer inset

#### Scenario: Taskbar buttons are reordered

- **WHEN** the app's taskbar button moves before minimizing or restoring
- **THEN** the transition uses its freshly queried button center in both axes

#### Scenario: Grouped app button

- **WHEN** Windows exposes one group button for the application identity
- **THEN** that group button is the anchor without opening a group menu or selecting another window

#### Scenario: App button is unavailable or ambiguous

- **WHEN** the shell does not expose a unique matching application button
- **THEN** the effect uses the detected taskbar center as a documented approximation and never
  chooses another app's button

#### Scenario: Taskbar position cannot be determined

- **WHEN** current taskbar geometry is unavailable and the work area does not identify a single edge
- **THEN** the requested native operation completes without a Genie animation toward a guessed edge

### Requirement: Reduced motion and platform fallback

With system reduced motion enabled, the desktop SHALL use immediate native minimize and restore
instead of the Genie distortion. Linux and browser editions SHALL retain their existing native
window/browser behavior; browsers SHALL NOT show an app window-minimize control. Capture failure,
unsupported transparency or unavailable rendering SHALL fall back to native behavior. This policy
SHALL apply only to desktop window transitions and SHALL NOT alter existing page and hover motion.

#### Scenario: Reduced motion

- **WHEN** the user minimizes or restores with system reduced motion enabled
- **THEN** the native operation completes without Genie distortion or an animation delay

#### Scenario: Rendering cannot start

- **WHEN** snapshot capture or overlay initialization fails
- **THEN** the requested native operation still completes and the application remains recoverable

### Requirement: Interrupted transitions and recovery

Repeated minimize/restore requests SHALL be coalesced into one coherent final state. Closing,
quitting, reloading, changing display geometry, or losing the animation renderer SHALL cancel its
transient work. No failure SHALL leave an invisible restored main window, an orphan overlay, an
extra taskbar entry, or a surface that blocks other applications. A transition that stops responding
SHALL recover to the requested usable native state within two seconds of its start.

#### Scenario: Restore before minimize animation completes

- **WHEN** the user requests restoration during the outgoing animation
- **THEN** one usable restored window remains, with no duplicate animation surface or lost focus

#### Scenario: Animation renderer fails

- **WHEN** the animation renderer stops responding or exits during restoration
- **THEN** the main window becomes visible and usable through native recovery within two seconds

#### Scenario: Close during animation

- **WHEN** the application closes during a transition
- **THEN** all animation surfaces and callbacks are released and ordinary application shutdown
  releases its device resources

### Requirement: Responsive transition preparation

Minimize and restore preparation SHALL overlap independent taskbar lookup, snapshot capture and
encoding, and transient renderer startup instead of adding their waits sequentially. Each direction
SHALL use fresh taskbar geometry and current content, retaining the approximately 500 ms effect,
existing bounded recovery and snapshot/resource cleanup. Optimization SHALL NOT introduce idle
capture, drawing loops, stale taskbar-button positions or a retained idle animation surface.

#### Scenario: Start an initialized native transition

- **WHEN** the user requests native minimize or an owned restore after metadata initialization
- **THEN** independent preparation overlaps before the authorized first frame, the normal effect
  proceeds, and cancellation releases pending payload waits and the transient surface

### Requirement: Transient snapshots and idle cost

Animation snapshots SHALL remain in process memory only, SHALL NOT enter reports, logs, persistent
storage or network requests, and SHALL be released at transition completion or cancellation. The
effect SHALL capture on demand, perform no periodic screen capture, and run no animation loop while
idle or minimized. Its transient surface SHALL be absent from the taskbar, non-focusable and
non-interactive. Only the trusted application SHALL request window operations; terminal output,
embedded markup and external frames SHALL NOT obtain window-control authority.

#### Scenario: Transition finishes

- **WHEN** minimizing or restoring has completed or been cancelled
- **THEN** snapshot references and animation resources are released, and no capture timer or drawing
  loop continues

#### Scenario: Untrusted content requests a window action

- **WHEN** an external frame or remote terminal content attempts to control the application window
- **THEN** the request is rejected without changing native window state
