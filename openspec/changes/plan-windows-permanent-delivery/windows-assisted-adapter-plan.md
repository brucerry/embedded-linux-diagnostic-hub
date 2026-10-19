# Windows assisted adapter implementation decision

Use the existing pinned NSIS compiler/MUI toolchain and complete builder-produced runtime. A small
native setup worker handles bounded identity, verification, ownership and file transactions; a
current-user-only assisted NSIS adapter supplies compatibility, location, options, review and result
controls. The generated builder template has all-users/elevation and process-name/removal defaults
requiring explicit control, so the adapter must use exact owned paths/PIDs and preserve user data
instead of inheriting those behaviors. No new dependency, paid tool or security exemption is
introduced.

Worker mode is a separate native main-process entry branch before normal profile/singleton/SSH/UI
initialization, with scratch state confined to its private temporary directory. It never uses
ELECTRON_RUN_AS_NODE, changes execution policy, reads connection credentials, opens a device or
creates a renderer path-setting API. A same-volume staged transaction validates complete declared
bytes, preserves installation UUID/profile location, rejects busy/unknown targets and records
recovery state. Installed automatic updater routes remain refused. Unknown files are
retained/refused rather than recursively removed; profile/report data is always outside replaceable
appRoot and is not deleted.

The first adapter restricts chosen locations to ordinary folders within the current user's profile,
refuses aliases/protected roots and exposes existing verified version/actions.
File/shortcut/registry changes require explicit review confirmation. Menu shortcut is recommended,
desktop shortcut and launch are off by default. A new setup asset and catalogue/one-line selection
are staged only after qualification; existing portable assets and every historical tag/helper remain
immutable. Native wizard screenshots, actual launch/repair/removal, genuine
future-version/report/crash recovery, and Mac/Linux qualification are separate gates, not assumed by
a compiled script.

Acceptance recorded: parent independent review accepted the field-order fix and bounded Windows
profile/coexistence receipt. The portable case used an explicit separate profile and the frozen
foundation fixture excludes newer UI follow-ons. Interaction/visibility timing does not establish
first presentation, cold-cache or a universal 1–2-second guarantee.
