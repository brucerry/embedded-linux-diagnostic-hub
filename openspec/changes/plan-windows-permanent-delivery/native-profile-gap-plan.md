# Bounded Windows packaged profile/coexistence milestone

Use a fresh task-only package of the frozen installer foundation source
7cd8f92fce9608d0cb2ac13c74b37bba2fe0f83f based on published 2f84f429. Its runtime
installation/startup/updater files must match the current foundation; accepted UI increments remain
independently qualified and are not claimed to exist in this old-source fixture. Existing physical
pinned dependencies are reused; no dependency add/install, user preview recreation or external
device/network action occurs.

The harness uses explicit task profiles for primary/other/portable cases. The no-override case
intentionally exercises the actual native default Electron
appData/DiagnosticHub/profiles/<new installation UUID> path, verifies that it did not exist
previously, and records/preserves its owned marker. It does not redirect APPDATA or disguise a CLI
override. Never reuse the user's existing profile. Fresh source/ASAR/manifest/packaged-path
provenance distinguishes this test from released bytes.

Use the actual builder-produced portable wrapper, with only task-local TEMP/TMP for extraction.
Never spoof PORTABLE_EXECUTABLE variables. Identify its owned native inner process by unique
loopback inspector port and exact task extraction boundary; record exact PID/path/creation identity.
Recheck previously launched windows/RPC and edited-but-unsent hostname inputs after every
coexistence launch. Close only owned fixture processes, with exact identity-checked fallback and no
broad process killing. No Connect submission, SSH session, port opening or update download occurs.

Record inspector-ready, local usable interaction and subsequent native visibility confirmation as
distinct observations with probe timing bounds and cache/harness overhead. First native
presentation/cold-cache and universal 1–2 seconds remain unqualified. Native Mac/Linux, production
wizard controls/catalogue/update/crash recovery and physical hardware remain separate pending gates.
