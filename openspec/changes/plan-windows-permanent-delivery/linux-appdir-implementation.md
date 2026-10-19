# Permanent Linux AppDir: isolated implementation milestone

Status: implementation draft in
`C:/Users/bruce/Desktop/Codex/2026-10-13/task/linux-appdir-draft/workspace`; no adoption into the
reviewed repository source, package publication, native Linux acceptance, or new packaging variant.
Target remains the combined v0.6.0 release; current package version remains 0.5.2.

Implemented source

- The shared transaction engine handles Linux `linux-folder` payloads in `ROOT/app`, private
  transaction/stage folders, bounded ownership/inventory metadata, source verification, stable
  installation UUIDs, same-version Repair, versioned Update, retained previous bytes, explicit
  rollback and profile separation. Unknown files/directories, incomplete identity and busy
  transaction slots refuse maintenance. Windows transaction behavior remains covered by its existing
  focused tests.
- Linux context enforces ordinary Linux x64/current UID, canonical user-owned application/source/XDG
  locations, fixed original and missing parent identities across Review/Apply and every guarded
  mutation, and read-only `/proc` process identity/activity checks. No process is killed. No host
  permissions, policy, sudo, PATH, autostart or network/device settings are changed.
- A bundled worker uses the existing Electron runtime's supported Node mode; no end-user Node
  installation or dependency addition is required. It presents an editable permanent destination,
  actual detected maintenance choices, an explicit application-menu option and a final
  default-cancel review. GUI uses Zenity with literal escaped data; fallback reads only bounded
  `/dev/tty` through Bash, never piped script stdin. UI prompts expire. There is no silent CLI apply
  option. Normal launch clears Node/AppImage environment variables and uses the installed persistent
  AppRun.
- The UUID-specific XDG application-menu entry uses a static shell program and a base64 path argv
  item, preserving literal Unicode/quotes/percent/shell characters. Ownership records declare writes
  before effects. Exclusive activation refuses foreign collisions. Menu updates/deselection preserve
  foreign edits. Exact declared two-link activation pairs can be recovered; arbitrary hard links
  refuse. Installed native desktop identity uses the same UUID.
- The existing `tar.gz`/AppImage packaging hook has an explicit private
  `DIAGNOSTIC_HUB_LINUX_FOLDER_DRAFT=1` gate. It bundles worker/adapter/icon into the existing app
  directory and emits a bounded payload descriptor; existing package formats and production default
  packaging remain unchanged. The Linux metadata producer can include the descriptor hash and an
  explicit unqualified-draft capability. No native package has been produced by this milestone.
- The isolated one-line helper defaults to permanent tar-based delivery only when the selected
  release has the complete bound folder capability. It verifies source/version/arch/archive
  checksum/descriptor hash and conservative archive inventory before dispatching the bundled worker.
  `--portable`, explicit `--format`, and original `--download-only` contracts remain portable.
  `--directory` remains cache meaning; `--install-directory`, `--menu`/`--no-menu`, `--terminal`,
  and `--no-launch` are explicit. Historical releases without capability stop with an explicit
  same-release portable route. There is no silent delivery fallback.

Evidence boundaries

- Real temporary-filesystem transaction models demonstrate install/repeat detection, damaged-byte
  same-version Repair, update/explicit rollback, stable UUID/external report marker, and
  foreign/busy refusal. Native ownership/process/integration callbacks in those engine models are
  modeled; they are not native Linux installation acceptance.
- Adapter tests exercise real filesystem parent replacement, descriptor generation, real owned menu
  creation/update/removal/foreign refusal, interrupted activation-pair cleanup and strict CLI
  parsing on this Windows host.
- Whole-helper tests use fake HTTP, a genuine synthetic tar archive and a shell recorder replacing
  the packaged runtime. They demonstrate capability refusal and exact destination/menu dispatch
  after verification. They do not execute Electron, install an application or establish native
  readiness.
- The worker is source-bundled with existing esbuild only. The Windows helper P2 fix is separate in
  `windows-noninteractive-forms-review.json/.patch`: accepted host abbreviations/slash forms are
  refused before network or launch; all process launches are intercepted in the fixture.

Incomplete work and release blockers

1. The Linux native boot/window/profile observer is not implemented in this draft.
   `successorObserved` deliberately returns false, Finalize is not offered, and previous bytes are
   retained. An update can be launched or explicitly rolled back, but normal maintenance cannot be
   considered fully complete until independently verified native successor confirmation/cleanup
   exists. No fake readiness or zero-exit success substitute is used.
2. Native Linux package/library/runtime-fuse/executable-mount/sandbox behavior, `/proc` visibility,
   Zenity and controlling-terminal flows, private directory modes, menu recognition/WM_CLASS/Wayland
   identity, profile coexistence, update/repair/rollback/removal/interruption and post-confirmation
   cleanup remain unqualified. Link/special-mode archive contents (including a possible setuid
   chrome-sandbox) fail closed; inspect a native pinned package before deciding support. Do not
   change host policy or silently rewrite security modes.
3. Offline installed launch uses the permanent app and existing dedicated profile. Offline
   Repair/reinstallation requires a separate verified source envelope; running the installed adapter
   against its own source/destination is refused. There is no bundled offline maintenance/discovery
   UI yet.
4. Registered managed AppImage delivery, production release catalogue/workflow adoption,
   site/download documentation and final combined release qualification remain separate unfinished
   scope. No distro installer variants are introduced.
5. Automatic reviewer denial despite forwarded implementation approval; direct isolated Windows
   install/launch confirmation is requested and pending. No retry or alternate execution route
   occurred in this milestone.

Review references: Electron production `ELECTRON_RUN_AS_NODE`
https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node ; RunAsNode
fuse https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode ; Desktop Entry Exec and string
decoding https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html and
https://specifications.freedesktop.org/desktop-entry/latest/value-types.html . These establish
design contracts; they do not qualify the native draft.

Final bounded verification update: ordinary original-source npm run verify passes with 358 tests,
346 passed, zero failed, 12 platform skips (windows-noninteractive-verify-isolated.log/result.json).
The earlier concurrent run is retained: 345 passed, one unchanged tar fixture failure at its
15-second subprocess deadline, 12 skips; that exact unchanged fixture subsequently passed alone, and
the ordinary rerun passed with no code or timeout changes. Load/timeout attribution is an inference
because the old assertion did not record the child's error. The isolated AppDir engine/adapters pass
32/32 plus the separate missing/empty destination review test; earlier isolated integration run
passed30/30. Final source typecheck/format and compiled-worker receipts are separate from native
acceptance.

Compatibility refinement: explicit original --directory, explicit --format, --portable and
--download-only retain portable delivery intent. Permanent delivery uses the default without those
legacy portable choices, optionally with --install-directory and explicit menu choices. Conflicting
cache/permanent options refuse before network. No original option is silently reinterpreted as an
application install location.
