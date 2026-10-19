# Updater UX follow-up plan for this batch

Verified current behavior: ReleaseUpdater selects native-only compatible URLs/paths and stages under
app.getPath('userData')/updates/<version>/<asset>.<uuid>.part. It checks exact metadata size,
SHA256, executable header, then atomically renames to the durable launchable asset path in that
version directory. Windows asset is Diagnostic-Hub.exe; Linux is Diagnostic-Hub-linux-x64.AppImage.
The original manually downloaded executable is not overwritten. Coordinator emits only coarse string
stages and calls app.relaunch(execPath) then app.quit. That scheduling call is not proof that the
new app launched successfully. Mac/unsupported platforms have manual-update guidance.

## Plan

- Add typed native-owned progress: preparing/draining/report backup, download bytes with validated
  known total, indeterminate verification/commit/restart states and explicit failure/cancel states.
  No overall invented percentage. Metadata size is already mandatory and verified; missing HTTP
  Content-Length alone does not erase that known total. Unknown-total UI events remain
  indeterminate; do not relax release validation to manufacture an unknown-size candidate.
- Add the Cancel update icon and preserve the existing pre-start cancellation behavior. The current
  button is disabled once busy; do not claim close-dialog cancels a live native transaction. Keep
  checksum/size/signing/executable guards, serial cleanup acknowledgement, atomic rename, update
  lock, durable report behavior and no automatic reconnection.
- Show temporary staging distinctly from the actual verified next-launch path. The renderer must
  never supply an executable or arbitrary filesystem path. Add an Open folder action backed by the
  native-owned validated durable candidate/receipt path and existing trusted IPC guard.
- Persist a bounded validated update receipt even in clean mode. Show current/requested versions,
  verified final path and restart requested versus actually observed handoff. Confirm completion
  only when the new process matches expected version/location/source receipt after startup; if the
  user reopens an older manually downloaded executable, explain the verified new executable path
  rather than claiming the old app updated. No shortcuts or automatic old-executable deletion.
- Add a separate local updater specification/tasks. Test known-byte/unknown-total UI progress,
  success/cancel/failure, path validation, missing/changed candidate, restart failure/confirmation,
  clean/preserve/smart recovery and Linux/Windows versus unsupported Mac behavior. Run all full
  applicable gates and native/package handoff checks before any consolidated push.

## Integration with Automation

Update locking/serial quiescence must fence active Automation and release any temporary background
execution lease safely. Neither progress rendering nor cancellation should bypass transport
ownership or make disconnected work restart automatically. Published v0.5.0 assets remain immutable.

## Decisions

Use validated release metadata size as the download total, including HTTP responses without
Content-Length. Unknown totals remain indeterminate in the shared UI; candidate validation is
unchanged. Persist a bounded receipt in the native app-owned update directory after verification.
Successful handoff requires expected version plus actual running portable executable path; relaunch
alone is only requested. Windows packaged portable path comes from PORTABLE_EXECUTABLE_FILE rather
than the extraction process executable. Renderer cannot submit filesystem paths. Existing prestart
cancel closes the dialog; active transactions keep cancellation disabled.

## Migration

Receipt is optional and independent of the existing report recovery marker. Existing versions remain
readable and existing reports/tags/assets are preserved.

## Expanded platform qualification

The prior Linux handoff test served the current image as a fake future release. It now requires a
distinct packaged future-version fixture and asserts new-process version, durable APPIMAGE path and
SHA-256 receipt. Existing Linux CI builds this fixture before its actual handoff gate. Windows uses
the same fixture builder in its existing workflow. Mac x64/arm64 remain manual-only. Guidance
requires downloading helper/checksum from the same tag and copying only a checksum verification
command. Native location reporting resolves the .app bundle and validates directory/main executable
before folder/copy actions. Helper stages report launch requested; the installer test separately
observes a normal LaunchServices launch. The existing dual-architecture action adds installed
guidance/path coverage while retaining integrity, Gatekeeper, rollback and legacy-source recovery.
Native Linux/Mac execution is unavailable in this Windows executor. Local parameterized tests and CI
definitions are supporting evidence, not native passes. Release publication requires actual native
CI results. Automatic review rejected remote-script pipeline guidance; the revised design uses
verified saved files and no remote execution command.
