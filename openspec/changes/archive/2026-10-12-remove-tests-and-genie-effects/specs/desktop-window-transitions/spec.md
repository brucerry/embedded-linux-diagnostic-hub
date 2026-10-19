# Spec Delta

## REMOVED Requirements

### Requirement: Native-command Genie minimization

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Reverse restoration and native paths

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Preserve device and workspace lifecycle

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Display geometry and window state

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Reduced motion and platform fallback

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Interrupted transitions and recovery

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Responsive transition preparation

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Transient snapshots and idle cost

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: GNOME native Genie transitions

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: App-scoped Linux anchors and isolation

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: GNOME effect cleanup and recovery

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

## ADDED Requirements

### Requirement: Standard platform window behavior

Windows and Linux SHALL use ordinary native window minimize/restore/maximize behavior without app-owned Genie rendering, snapshot capture, native minimize interception, taskbar geometry lookup or motion IPC. Renderer content SHALL receive no new privileged window-control API. OS/user animation preferences SHALL remain unchanged. Minimize/restore SHALL preserve SSH/PTY, selected workspace and bounded output/state; native restore notifications SHALL remain available for layout recovery.

#### Scenario: Minimize and restore a connected workspace

- **WHEN** the native app window is minimized and restored while a controlled SSH shell produces output
- **THEN** one usable main window and the same authenticated shell remain, without a Genie overlay or replayed input

### Requirement: App-scoped legacy extension isolation

The new Linux app SHALL use a desktop/window identity distinct from the retired companion's exact matching identity, preserving application user-data location and normal registration semantics. It SHALL NOT uninstall/disable user or system extensions or change global desktop settings. Other applications' window behavior SHALL remain outside its control.

#### Scenario: Legacy companion remains installed

- **WHEN** a user retains the old app-specific extension
- **THEN** the new app identity does not satisfy its exact match predicate and removal performs no extension-manager operation

### Requirement: Preserve operating-system workflow coverage

The automated workflow SHALL retain the existing Windows runner and Linux build and compositor environment matrix. Retired effect assertions SHALL be replaced by native minimize/restore/resize, responsiveness/crash, persistent terminal and remaining diagnostic/security/package checks without companion installation.

#### Scenario: Retired effects no longer needed by environment qualification

- **WHEN** a Windows or existing Linux distribution/session workflow runs
- **THEN** its environment remains covered with standard window and surviving application assertions, and no retired Genie or Tests-page setup is required
