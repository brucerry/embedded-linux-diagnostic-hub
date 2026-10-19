# Design

## Context

See proposal.md. The Tests feature is wired through React useBoardTests/TestsPage, desktop preload/main IPC, gateway routes and SshSession TestController/discovery/adapters. The reported Invalid DT property error belongs to this separate inventory parser. Diagnostic probes and the device clock use independent fixed commands/parsers.

Windows Genie uses WindowTransitions, transient renderer/preload assets, native subclass DLL/Koffi and taskbar discovery. Linux optionally packages and activates an app-specific GNOME extension matching diagnostic-hub.desktop plus WM_CLASS diagnostic-hub. Existing installed extensions must not be uninstalled by this task.

## Goals / Non-Goals

Goals: remove retired user-facing/remote paths, use native platform window behavior, retain surviving security/session/report/update behavior and meaningful automated coverage, and preserve evidence/user edits.

Non-goals: reproduce/fix the OpenWrt parser on hardware, continue UART replacement/custom diagnostics, install packages/distributions/helpers, uninstall extensions, modify published assets or release/commit work.

## Decisions

1. Remove application reachability end-to-end, not just hide a nav button. Delete Tests UI/hook and desktop/gateway transport operations, remove SSH test controller construction/cancellation/collection gating, and remove unused backend adapter/discovery/executor code. Retain pure historical report validation coverage only where it has no live callers. Diagnostic snapshot import/export remains separate.
2. Remove the motion controller/assets/build dependency entirely. Keep a normal BrowserWindow and a native restore notification. Linux uses the existing diagnostic-hub.desktop and class diagnostic-hub-native so the retired extension's exact predicate cannot match; app product name/user-data remain stable. No D-Bus/extension-manager changes occur.
3. Remove optional companion packaging and downloader management from current builds. Preserve checksum/tag/source validation for ordinary app/web/gateway assets and platform-library/sandbox checks. Do not alter old published binaries/manifests or historical release notes; this is unreleased local source.
4. Preserve unique uncommitted source before deleting it; tracked feature-only source/tests remain recoverable in Git. Archive the superseded OpenSpec plan with incomplete checkboxes intact and skip applying its unimplemented deltas. Store a retirement receipt identifying the completed audit and unverified candidate. No saved user-report or external evidence directories are cleaned.
5. Replace obsolete Genie/Tests integration test entry points with retirement, native-window/session-continuity and negative-API checks. Keep general automated unit/UI/security/update/launcher tests. Retain the Linux compositor matrix but run ordinary native-window tests without companion installation/effect assertions; local matrix execution may be unavailable and must be reported honestly.

## Risks / Trade-offs

- Installed legacy extension would recognize the old identity -> change only this app's Linux identity, preserve user data and document possible launcher regrouping.
- Removing test coordination could accidentally affect terminal/collection/reset -> verify surviving lifecycle paths and both desktop/gateway APIs.
- Historical tests import retired modules -> preserve Git history and unique uncommitted source, retire only feature-specific runners and keep/adapt relevant regression coverage.
- Stale generated assets could ship -> exclude/remove owned generated motion assets from packaging and verify built bundles for forbidden entry points.
- Page removal might be mistaken for parser repair -> report that no reproduction/fix occurred and audit remaining live dependency graph separately.

## Migration Plan

Snapshot unique uncommitted source and original dirty-file hashes; archive old unfinished plan without syncing specs; implement UI/backend and native window removal; update current launch/build/docs/workflows; run strict OpenSpec validation, type/build, unit and UI/native checks. No user-data migration or system extension operation is required. Linux window grouping may change due to the new class; desktop ID, executable and launcher stay stable; existing app data/reports remain. Rollback is source restoration from Git/snapshot, not modifying immutable release tags.
