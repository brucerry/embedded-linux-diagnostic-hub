# Mac review-before-mutation source prototype

Four-file source patch/hash packet: macos-guided-review.patch/json. Current package remains 0.5.2;
combined release target v0.6.0. No published helper, asset, tag or main commit was modified.

The helper preserves version/directory/no-launch/app arguments and stable-default
native-architecture release selection. Download/checksum/manifest/minimum-OS/archive/ASAR/ad-hoc
bundle verification now uses private temporary scratch; the selected application folder is not
created before explicit review. A native Standard Additions dialog defaults Cancel, permits
Install/Repair/Replace and an explicit Open choice, times out safely, and falls back only to the
controlling terminal when unavailable. Terminal review uses /dev/tty on fd3 with bounded read; piped
stdin is never consent. No GUI/TTY gives exact selected-release ZIP/checksum/manifest URLs and no
install. Launch remains off unless Open is selected; --no-launch removes that option.

After confirmation, the helper creates a same-volume stage, copies and re-verifies the bundle,
rechecks reviewed target inode/Info.plist and running-app refusal, then retains the existing
caught-failure rollback behavior and normal LaunchServices request. Existing settings/reports are
not migrated or deleted. No Dock/login/global integration, dependency/security installation,
quarantine stripping or Gatekeeper/signing bypass is introduced. Temporary download scratch and the
same-volume candidate copy are distinct from installed files.

Seven mocked consent/update-refusal tests pass on Windows Git Bash with no skipped cases, covering
literal quoted/Unicode/dollar paths, default launch off, explicit Open, Cancel, forced no-launch and
missing-UI/TTY rejection of piped consent. Bash syntax, TypeScript and touched TS/MJS formatting
pass. This is not native Bash 3.2 or AppleScript execution. Native fixture tests now mock consent
explicitly; the future >=0.6 published consumer is prepared to provide QA input through a real PTY
with --terminal while historical releases retain the old protocol. Those Mac consumers have not run
here.

Native x64/arm64
GUI/TTY/cancel/ownership/atomic-stage/interruption/launch/policy/minimum-OS/quarantine cases remain
required. Full discovery, offline-existing-launch and all common wizard/maintenance controls are not
qualified by this bounded review prototype. Native platform acceptance and independent source review
are pending; production adoption remains gated. Linux has not changed; next reuse the
controlling-terminal contract with its native dialog adapter, then independently validate managed
AppImage/folder ownership, durable launcher/profile/manual-update identity and native sandbox
behavior.

Dialog/default/cancel/timeout semantics follow
[Apple's dialog reference](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayDialogsandAlerts.html).
Error handling uses the form documented in
[Apple's error guide](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_error_xmpls.html).
These references do not substitute for native compilation/testing.
