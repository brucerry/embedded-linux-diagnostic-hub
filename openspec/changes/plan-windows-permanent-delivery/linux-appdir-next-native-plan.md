# AppDir next native milestone and review gates

This is a plan, not executed acceptance. Use only the approved existing Linux x64 environment/free
runner and pinned dependencies. Keep the present 24-file implementation draft isolated until
independent source review. No public push, release workflow dispatch, dependency install, sudo,
sandbox override, host-policy changes or physical device/network interaction.

1. Review the draft before packaging. Inspect `linux-appdir-draft-review.json/.patch`, compare every
   candidate SHA, and confirm `git apply --check` against the current original tree. Windows
   transaction behavior is covered separately; do not copy the whole mirror or its older Windows
   helper over the repository. Preserve the user's separate four-line live UI test edit.
2. Inspect a normal pinned native Linux unpacked output before changing packaging support. Record
   regular-file/link/mode inventory, Electron runtime/library availability and the RunAsNode fuse
   capability. Unsupported links/setuid bits or executable-mount policy must stop cleanly. Do not
   rewrite security modes or configure the host to make acceptance pass. Use the existing
   tar.gz/AppImage formats; the draft capability must be attached only to exact source-bound private
   artifacts.
3. Finish successor confirmation before calling AppDir maintenance complete. Prefer a small
   authenticated local IPC observation from verified Electron main code that reports only current
   installation/root/digest/version/default-profile/native PID/creation identity/window
   visibility/minimized state. No renderer-supplied readiness, debugger/TCP endpoint, arbitrary
   commands, filesystem setters, or zero-exit success. The proposed Linux journal capability is
   private and ephemeral; bound frame sizes/connections/timeouts, freshness/nonces and authenticated
   responses, and independently check current-UID kernel executable/start identity. Close the
   observer outside a pending candidate transaction. Review its trust boundary under X11 and Wayland
   before implementation/adoption. If native observation is unavailable, retain previous bytes and
   provide explicit recovery instead of claiming success.
4. In one fresh task-owned native root, use isolated XDG data/config locations and a normal user.
   Capture exact artifacts/hashes/source commit. Exercise native GUI and controlling-TTY
   destination/action/menu/final default-cancel flows, including no GUI/TTY, piped `yes`, cancel,
   timeout, missing libs/Node mode and unsupported package states. Assert no
   destination/menu/profile mutation before explicit Apply. Keep cache `--directory` separate from
   persistent `--install-directory`, and verify literal spaces, quotes, Unicode, percent and shell
   metacharacters.
5. Exercise actual install -> close -> offline installed launch -> same-version reinstall/Repair ->
   update -> native-confirmed cleanup -> explicit rollback/removal where applicable. Before/after
   hash the isolated profile/report files and record the UUID; directory inventory alone is
   insufficient evidence of profile preservation. Verify direct installed executable/menu startup
   selects the same UUID profile, separate installations coexist, same-profile startup focuses the
   existing process, and custom-profile launch cannot authorize default-profile cleanup. Confirm no
   extraction or network is needed for ordinary offline launch; offline Repair requires a distinct
   verified source.
6. Exercise foreign files/directories/incomplete ownership, aliased or replaced
   original/missing/leaf parents, menu edits/collisions/hard links, source mutation, active
   app/fd/cwd/maps access, process identity reuse, inaccessible live current-user process, low
   space, interrupted copy/activation/menu/removal/rollback/finalize and
   stale/forged/foreign-profile readiness. Preserve artifacts on uncertain identity; never terminate
   application processes. Show that only declared owned bytes/integrations are removed and
   profiles/reports remain.
7. Return source/model/mock/native evidence separately, including exact failing conditions and
   unqualified cases. Only after independent review and the remaining
   managed-AppImage/catalogue/workflow/docs/platform gates should the parent consolidate the v0.6.0
   version/release changes and pushes. Current v0.5.2 assets, tags and main-only history stay
   unchanged.

Windows native setup/install/launch remains a separate pending direct confirmation after automatic
review denial despite forwarded implementation approval; this Linux plan does not authorize a retry
or alternative Windows execution route.
