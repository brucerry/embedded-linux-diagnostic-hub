> Current status: [v0.6.0 remaining-scope matrix](v0.6.0-remaining-scope.md) distinguishes
> implemented source from missing implementation and pending native qualification. Earlier
> checkpoints below are historical; all-platform installation is not complete.

# Design

## Context

User direction now selects guided installation across currently supported desktop platforms while
retaining the familiar one-line commands. This change remains at its original path to preserve exact
Windows prototype evidence. Windows x64 uses a portable EXE; Mac Intel/arm64 already installs a
permanent .app bundle; Linux x86_64 currently downloads AppImage/tar.gz and extracts for execution.
Linux ARM desktop support is absent from current assets/builds.

The Windows exact-public-payload prototype measured setup 17.549 seconds and UI interaction median
1.169 seconds versus 13.191 seconds for interleaved portable controls. Accepted trials passed a
subsequent native visibility gate; first native presentation and cold-cache startup remain
unmeasured. Actual busy activation refusal and controlled same-version rollback passed. Production
installed currentPath, abrupt-death recovery, distinct future versions and report modes remain
unqualified.

## Goals / Non-Goals

Goals: common reviewed setup/maintenance choices, current-user locations, truthful platform trust,
retained one-line and portable workflows, stable entry points, profile/report preservation, safe
owned staging/recovery and explicit update/removal behavior.

Non-goals: production packaging adoption before independent review/native qualification, system-wide
installation, administrator/security changes, startup services, paid services/signing, adding
unsupported desktop architectures, implementing Mac automatic updates, device UART/network
configuration, or withholding qualified functional fixes for a full installer project.

## Decisions

### Shared semantics with native adapters

Use the common compatibility/location/options/review/progress/result flow detailed in
cross-platform-plan.md. Windows gets assisted NSIS; Mac guides the existing bundle verifier through
native dialogs or a terminal review; Linux uses available native dialogs or /dev/tty without
installing a UI dependency. The installer must still provide clear alternatives when app
trust/runtime prerequisites prevent GUI bootstrap.

Only verified app-owned destinations are mutable. No arbitrary renderer path setters, eval-built
commands or silent profile migration. Show user-owned file integration separately from system
prerequisite/policy requests.

### Preserve one-line entry points and make maintenance explicit

Keep existing Windows PowerShell, Linux Bash and Mac Bash URLs. Future default interactive behavior
resolves a compatible same-release setup, shows review and waits for user Install/Update/Repair.
Repeat commands detect validated existing installs. Explicit version/format/download-only/no-launch
behavior and immutable old helpers are handled as documented compatibility contracts; missing TTY is
not consent.

No unattended installer mode is included initially. Preserve offline installed launch and local
verified setup/repair. Stable-versus-preview normalization requires explicit wording and
compatibility tests because current platform helpers differ.

### Platform-specific packaging and update boundaries

Windows assisted setup installs once into a complete user-owned app folder and retains the portable
EXE. Do not infer per-user-only safety from perMachine:false alone; the existing builder exposes an
assisted mode page, so actual no-elevation/all-users refusal needs review and native verification.

Mac retains architecture-specific ZIP/.app bundles and manual verified maintenance. Ad-hoc integrity
is not notarization or publisher trust. Preserve framework links and ordinary OS policy; do not add
a competing unqualified installer service.

Linux supports x86_64 only. Managed AppImage remains available; a permanent tar-folder choice needs
full package/sandbox/native identity qualification. No automatic installed-layout update is enabled
until its shortcut/path/bundle contract is tested; current portable AppImage handoff stays
supported. No FUSE install, no-sandbox or host permission adjustment is introduced.

### Profiles, receipts and recovery

Retain installed profiles outside app; do not alter existing portable/Mac profile paths. Recommend a
distinct installed profile plus explicit report import for new Windows/Linux layouts. Shared profile
reuse needs canonical locking. Removal retains reports/settings by default and touches only declared
owned integrations.

The Windows implementation-plan.md gives bounded identity/receipt schemas, exact verified staging,
quiescence, fixed entry points, two-rename recovery and genuine successor evidence. Extend those
semantic guarantees through platform-specific validators rather than assuming Windows link rules or
activation mechanics apply unchanged to Mac/Linux. A helper reports launch requested separately from
observed native success.

### Stage release scope

v0.5.2 was published independently and remains immutable. The user explicitly targets one combined
v0.6.0 for all current follow-on work: cross-platform guided setup and retained one-line commands,
installed startup/profile safeguards, receive-timestamp output/detailed exports, accessible field
validation/focus, and the revised Serial islands/crabs artwork. Review these increments separately
and release together after applicable gates; do not create v0.5.3 without a new user decision.

## Risks / Trade-offs

- Wizard bootstrap may itself be blocked by unsigned Mac/Windows policy or unavailable Linux UI
  libraries; show actual limits and bounded manual/download-only alternatives.
- Existing one-line helper flags/candidate rules differ; protect historical helpers and avoid
  silently changing download-only files or preview selection.
- All-users NSIS controls, Linux sandbox and native links require actual platform review;
  configuration flags alone are not acceptance evidence.
- Profiles and shortcuts can outlive app replacement; explicit installation identity, profile locks
  and compatible receipts prevent false confirmation or duplicate installs.
- Power loss and asynchronous OS launch cannot be qualified by caught exceptions or successful
  launch requests alone.
- Additional Windows setup assets expand the next catalogue; prior 24-file releases remain
  immutable.

## Migration Plan

1. Review cross-platform-plan.md and delta requirements independently before implementation.
2. Preserve the completed v0.5.2 publication (source 2f84f429, release 412835331, 24 assets) and all
   historical assets/tags.
3. Build isolated native wizard prototypes using current toolchains/helpers; test
   review/cancel/command compatibility and policy/prerequisite denials.
4. Implement owned installation identities, compatible assets/profile locks, integration/removal and
   platform-specific recovery.
5. Qualify actual distinct-version handoff, report modes and all native command/platform gates
   before the next installer milestone.

## Documents

- cross-platform-plan.md: complete UX/platform matrix, expected one-line outcome, compatibility,
  staged release and acceptance gates.
- implementation-plan.md: retained detailed Windows replacement mechanisms and completed prototype
  evidence.
- tasks.md: completed prototype tasks plus pending independent review and production gates.

## Implementation checkpoint

User implementation approval and parent review permit a staged start. shared/installation.ts and
electron/installation.ts implement bounded metadata, platform/layout/entry checks and native
declared-payload verification. Eight new installer contract tests plus sixteen existing
updater/receipt tests pass, with TypeScript checking. These modules are not yet wired into startup,
helpers, GUI, NSIS or release catalogues; no automatic installed update is enabled. Exact archive
inventory, native signatures, transaction/profile locking and all-platform install/repair/removal
remain separate qualification tasks.

## October 15 functional scope reconciliation

Retain accepted Serial bird removal, distant muted tree islands and optional static crabs (task
7.1); these are implemented, not new work. The next high-effort visual batch removes only left
foreground palms/trees/coconuts, preserves right/distant artwork, adjusts Serial-only
foreground/ANSI/selection/cursor contrast, and adds a few pointer-inert soft pixel clouds with
reduced-motion support. SSH already renders terminal-stars/terminal-star; inspect height/visibility
refinements against that baseline and preserve fit, scroll/input and lifecycle contracts. No scene
source is changed by this plan.

Compose identical complete Isolated bounded transport execution deltas with
add-ssh-persistent-console-automation so future synchronization cannot restore exec-only behavior.
Legacy detailed export schemas v1/v2 remain legacy; stored observations/outcomes use the new
explicit version. See add-durable-automation-capture for complete persistence/recovery/retention and
add-automation-flow-viewer for optional read-only graph behavior. Historical implementation
checkpoint paragraphs above retain their original scope; later exact native acceptance/tasks and the
current audit supersede broad stale status claims without extending qualification to this newer
candidate.
