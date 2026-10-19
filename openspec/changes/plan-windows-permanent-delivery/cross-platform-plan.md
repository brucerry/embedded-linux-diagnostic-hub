> Current status: [v0.6.0 remaining-scope matrix](v0.6.0-remaining-scope.md) distinguishes
> implemented source from missing implementation and pending native qualification. Earlier
> checkpoints below are historical; all-platform installation is not complete.

# Guided desktop installation and retained one-line commands

Local proposal, 2026-10-14. This expands plan-windows-permanent-delivery in place so prototype
evidence and links remain stable. User direction: a wizard across supported platforms, with the
one-line commands retained. Implementation is explicitly authorized and has begun with bounded
installation/native observation contracts; no production wizard, helper integration or installer
adoption has occurred.

## Expected user result

The user runs the familiar command for their shell. The helper checks host OS/architecture and
compatible release metadata, downloads and verifies matching setup material, then presents a review
flow. The user sees where the app and data will live, shortcut options, update/removal behavior and
any trust/prerequisite limits. Nothing is installed until they choose Install. Completion reports
the real app path and offers normal launch.

Running the command again identifies the verified existing install and offers Launch, Update or
Repair; it does not create a second install or overwrite profiles by default. Ambiguous multiple
installations are listed by path/version and require selection. Cancellation leaves an existing
app/data unchanged. Offline installed launch remains available; update requests report when network
or verified local setup material is unavailable.

## Shared review flow and platform adapters

1. Welcome and compatibility: app/release, host OS/native architecture, actual supported
   minimum/qualification, portable or guided installation choice. Display publisher/signature status
   truthfully; target device UART configuration is outside setup.
2. Location: app path and separate profile/report path, space required including staging/rollback,
   user-owned writable destination. Clearly state Current user only. Existing installs offer
   maintenance instead of a default duplicate. Protected/system locations fail; no automatic
   elevation.
3. Options: application-menu shortcut recommended, desktop shortcut off by default where supported,
   launch after completion off until selected; no login/startup option. Display profile retention
   and an explicit optional report import. No automatic credential, trust-store, Serial-grant or
   connection migration.
4. Review: exact filesystem changes and any per-user uninstall registration, version/architecture,
   shortcuts, update mechanism and data retained on removal. One Install/Update/Repair confirmation;
   Back and Cancel remain available before mutation.
5. Progress: actual download bytes when known, then separate indeterminate verification/installation
   steps. Cancellation is offered only where supported; during the short replacement transaction
   display its actual state and safe recovery behavior.
6. Result: Installed/verified path, copy/show-folder actions, version, shortcut outcome and removal
   instructions. Launch requested and native app observed are distinct. A blocked launch can leave a
   verified installed app with a truthful policy message; it is not reported as running.

Use one semantic option/result schema and shared wording; native adapters own paths and OS
integration. The browser website can explain/download, but cannot claim to install host files. The
Electron app's Install/maintenance page, if added later, is not the only bootstrap surface: Mac
trust denial or missing Linux GUI libraries may prevent Electron from starting.

### Windows x64

Recommend a complete offline assisted NSIS setup EXE, built by the already installed
electron-builder toolchain, alongside Diagnostic-Hub.exe. Proposed asset name
Diagnostic-Hub-Windows-x64-Setup.exe is a new future catalogue entry, not a current URL/download
claim. Default root is %LOCALAPPDATA%/Programs/DiagnosticHub, with the normal NSIS fixed included
Diagnostic Hub.exe at the installation root and a separate UUID-scoped installed profile under
Electron appData (normally %APPDATA%/DiagnosticHub/profiles/<installation UUID> on Windows),
matching the implemented startup contract. Optional per-user Start menu/desktop shortcuts and
per-user uninstall registration are declared on Review. No PATH change, service or autorun.

Starting configuration candidates are oneClick:false, perMachine:false, allowElevation:false, and
allowToChangeInstallationDirectory:true. IMPORTANT: the installed NSIS declarations say assisted
perMachine:false still exposes an install-mode page; those flags alone do not prove per-user-only
behavior. Qualification must explicitly prevent all-users selection/elevation and validate actual
execution manifest, registry namespace, created paths and standard-user behavior before adoption.
Preserve stable installer GUID across installed upgrades without changing the portable app's
published identity.

The complete payload/manifest verification, installed currentPath, busy refusal, fixed shortcut and
rollback mechanics are detailed in implementation-plan.md. Keep the install helper outside the
replaced app. Never convert a portable instance silently into installed delivery. If standard
Windows policy blocks unsigned setup/app launch, report it and preserve the old install; never
change execution policy or publisher/security settings.

### macOS Intel x64 and Apple Silicon arm64

Keep complete architecture-specific .app ZIPs, their sidecars/manifests and the existing verified
helper. Mac is already extract-once: do not repackage it to imitate Windows. Add a guided mode using
built-in native folder/choice dialogs (osascript where allowed), with a terminal review fallback.
Default ~/Applications/Diagnostic Hub.app; custom destinations must be owned/writable by the user.
Do not default to /Applications or request sudo. Preserve bundle structure and verified relative
framework links; a blanket Windows no-links extraction rule cannot be copied to Mac.

Current helper selects native arm64 even from a translated terminal, uses macOS Bash 3.2/built-in
tools, verifies source/architecture/minimum OS/ASAR/ad-hoc codesign integrity, refuses running-app
replacement and performs normal open. Extend these controls rather than introducing a second
competing installer backend. GUI cancellation/AppleScript denial falls back only after clearly
explaining the available review route; no endless dialog wait. Retain --no-launch and explicit
version/directory options.

No Dock manipulation, Login Item or LaunchAgent. Finish offers Show in Finder and normal launch;
pinning remains a user action. Manual update/repair reruns the same guided verifier after quitting
the app. In-app automatic Mac installation stays unavailable.

Current manifests explicitly say ad-hoc, not Developer ID signed and not notarized. An
unsigned/ad-hoc helper or app may be refused before its wizard opens. The wizard cannot solve that
bootstrap trust barrier. Browser-quarantine, managed Mac and actual macOS-minimum acceptance remain
separate from hosted native checks. No quarantine stripping, Gatekeeper changes, re-signing on the
host, Rosetta/dependency installation or paid signing account is introduced. Apple's normal
approval/policy information is shown, without executing an override.

### Linux currently supported x86_64

Current package.json/public helper restrict Linux desktop assets to x64/x86_64, built on Ubuntu
22.04 with existing seven-case GNOME qualification. No Linux arm64/armv7 asset or native
qualification is present. Detect those architectures and offer the web workspace/manual
supported-host guidance; do not download x64 into emulation or advertise ARM desktop support.

Recommend guided per-user installation with two explicitly named choices:

- Managed AppImage: retain a verified durable AppImage and launcher; familiar portable file stays
  available. Explain that the current no-FUSE extract-and-run route extracts each launch and carries
  no Windows-style performance promise.
- Complete folder: retain the already distributed tar.gz payload once under
  ${XDG_DATA_HOME:-~/.local/share}/diagnostic-hub/installations/<installation-id>/app, with its
  AppRun entry point. Exact archive/link/permission/manifest validation and native sandbox
  qualification are required before this becomes the default.

If already present, zenity or kdialog can present native guided controls. Otherwise use a terminal
wizard through /dev/tty; do not install a GUI toolkit to display setup. Check
libraries/desktop/session before launching Electron. No terminal and no usable GUI produces a
bounded clear explanation with download-only/browser/manual alternatives.

Offer one per-user application-menu .desktop entry under the validated XDG_DATA_HOME/applications
directory. Bind Exec/Icon/StartupWMClass to the verified stable launcher and current native
identity; test spaces/Unicode/quoting and X11/Wayland grouping. Do not edit global menu entries,
PATH or login startup. User-selected desktop-file placement is optional and subject to desktop
policy; do not promise universal executable/trusted-desktop integration or run trust-setting
commands.

Preserve existing package library modes and normal sandbox requirements. No chmod/chown host-wide,
setuid bit, no-sandbox, namespace/security-policy or group-membership changes. Normal executable
bits on newly installed owned release files are declared package installation, not a host-security
workaround.

Current Linux AppImage update support assumes APPIMAGE and a verified new versioned file.
Managed/fixed shortcuts and retained directory installs need their own native identity and
pointer/replacement contract. Initially show guided manual maintenance for new installed layouts
until genuine successor/shortcut/report qualification passes. Existing portable AppImage automatic
handoff remains intact; do not spoof APPIMAGE for directory launches.

System libraries remain distribution prerequisites. Existing launcher can offer apt installation
with a separate explicit terminal prompt. New wizard defaults to displaying missing libraries and
administrator/package-manager guidance; launching such system installation requires a distinct
reviewed action, not the broad wizard-direction approval. No sudo during app installation and no
automatic FUSE installation.

## One-line commands and compatibility

Retain the recognizable entry points in docs/downloads.md:

- Windows PowerShell 5.1+: the existing main/public/download-run.ps1 command.
- Linux Bash: the existing main/public/download-run.sh command.
- Mac Bash 3.2: the existing releases/latest/download/download-run-macos.sh command.

These are current working URLs, not newly invented setup URLs. Future zero-option helpers open the
interactive review flow. Resolve release tag, architecture, setup asset, sidecars and manifests
together; never mix latest helper metadata with a selected historical payload. Fetch only the
repository's validated HTTPS release URLs. The initial curl/PowerShell bootstrap executes trusted
repository script content over TLS; downloading a checksum from that same publisher is integrity
evidence, not an independent signature/notarization guarantee.

Preserve explicit tag selection, preview opt-in/selection and displayed resolved version. Current
Windows/Linux zero-option helpers select a published candidate from release listing (including
previews), while Mac uses latest stable; do not silently normalize that behavior under the wizard.
Recommend a clearly displayed stable default plus explicit preview choice for future guided mode,
with a documented migration and tests; legacy portable commands keep their existing version
behavior. An explicit old tag retains its original helper/asset contract; if no wizard setup exists,
offer the clearly identified legacy portable/manual route.

Existing flags:

- Windows -Version, -Directory and -DownloadOnly: explicit release/directory remain review inputs;
  retain -DownloadOnly as the existing portable-artifact download-only contract. Add an explicit
  guided-setup download option rather than silently changing downloaded filenames.
- Linux --version, --directory, --format AppImage|tar.gz, --download-only: retain explicit
  format/download-only portable behavior; directory/version can prefill a new reviewed installed
  mode. Explain which mode was selected.
- Mac --version, --directory, --no-launch and -- APP_ARGUMENTS: retain values and no-launch intent,
  pass arguments as an argv array/quoted tokens without eval, and preserve every immutable tagged
  helper. Future interactive helper/test callers are migrated explicitly.

Piped command stdin contains script bytes, not user answers. POSIX terminal fallback reads /dev/tty;
a missing TTY cannot be treated as acceptance. PowerShell -NonInteractive and headless Mac/Linux
return readable alternatives without hanging or choosing install defaults. Closing a dialog is
cancellation. Explicit unattended installation is deferred; no new silent-install flag is promised.
Unknown unattended flags are rejected. Noninteractive download-only and verified already-installed
offline launch are separate safe supported modes.

Offline installation uses a previously verified compatible complete setup/archive plus its bound
catalogue/manifest/checksum material; wrong architecture/source/version or missing local evidence
refuses replacement. Network failure does not silently downgrade to cached arbitrary bytes.
Installed launch does not check releases or collect from devices at startup.

Installation discovery uses bounded per-user app-owned records plus validation of actual
payload/location; do not crawl unrelated disks. Discovery with a changed/missing payload offers
repair after review, not automatic overwrite. Requested versions below the observed installed
version require explicit downgrade review and schema compatibility; do not assume data migrations
are reversible.

## Profiles, removal and recovery

Use separate installed profiles by default, persistent across installed upgrades; preserve current
portable/default profiles and existing Mac profile locations. Offer explicit validated report
import. Shared-profile reuse is an advanced explicit choice only after canonical profile locking is
qualified. Never automatically migrate credentials, device connections or replay queued commands.

Each adapter records only its owned paths and integrations. Remove/repair refuses running
applications; cleanup retains reports/profile by default. Windows uninstall removes its owned
bundle, optional shortcuts and its per-user registration. Mac removes the selected owned app bundle;
Linux removes the selected root and owned desktop entry. User data deletion is a separate named
choice. Keep the rollback copy until actual successor identity is observed; distinguish caught
exceptions, abrupt process death and power loss.

## Staged release recommendation

1. v0.5.2 is complete: source 2f84f429, release 412835331 with 24 published assets, normal release
   run 38583615508 successful. Preserve that immutable release and all history.
2. Next development stage: independently review this scope, command compatibility, NSIS per-user
   controls, installed identity/profile schema and Linux sandbox/bootstrap choices. Build isolated
   native prototypes on Windows, both Mac architectures and Linux x86_64. No ARM Linux scope
   expansion without assets and native evidence.
3. The user selects one combined v0.6.0 for the cross-platform guided setup and startup/profile
   safeguards plus timestamp output/exports, field validation/focus and islands/crabs artwork.
   Independent increments remain reviewable separately; publication waits for relevant
   platform/source/catalogue gates and does not create v0.5.3.

The new Windows setup adds a future payload/sidecar and possibly bundle/installer manifests. Derive
the new release inventory from the reviewed asset contract; do not assume the old 24-asset count,
change historical catalogues or bolt on DMG/deb/rpm/pkg/AppImage ARM variants without scope
approval. Keep source identity across all generated artifacts, no paid services/signing/runners, and
no dependency installation during planning.

## Focused acceptance gates before production

- Shared flow: keyboard/accessibility, location/review/cancel, compatible architecture, multiple
  install selection, profile/data defaults, truthful progress, installed-versus-launched results.
- Commands: actual documented one-line launch on each native platform; piped stdin versus /dev/tty,
  explicit tags/preview rules, download-only exact filenames, unknown flags, no GUI/no terminal,
  network/metadata failure, offline local setup and repeat launch/update/repair.
- Windows: real standard-user assisted wizard, no all-users/elevation choice, fixed EXE and
  shortcuts, per-user registration/removal, spaces/Unicode/policy refusal, actual busy activation
  and abrupt interruption recovery, greater-version handoff and all report modes.
- Mac x64/arm64: guided helper cancel/selection, Bash 3.2 and translated-terminal architecture,
  same-release source/ASAR/codesign verification, safe framework links, custom owned
  location/running refusal/manual update/no-launch, normal native launch; browser quarantine/managed
  host remain separate.
- Linux x86_64: current Ubuntu baseline plus existing GNOME matrix, GUI-present versus tty-only
  versus neither, prerequisites and headless/noexec/sandbox denial, safe tar links and manifest
  bounds, launcher quoting/grouping, permanent-folder currentPath unavailable until native installed
  identity qualifies, legacy AppImage handoff unchanged.
- Integration: source/asset catalogues, complete same-release checksum/manifests, historical tag/old
  helper compatibility, profiles and clean/preserve/smart recovery, idempotent repair/removal, no
  system config or device interactions.

All repository checks remain focused on new behavior. Independent review must complete before
production packaging code; none has begun.

## Evidence and primary references

Local observations: package.json; public/download-run.ps1, download-run.sh and
download-run-macos.sh; scripts/linux-launcher.sh and package-macos.mjs;
scripts/lib/release-assets.mjs; docs/downloads.md, delivery.md and macos-qualification.md;
tests/macos-installer-smoke.mjs; installed
node_modules/app-builder-lib/out/targets/nsis/nsisOptions.d.ts and
templates/nsis/assistedInstaller.nsh. Windows prototype measurements and integrity proofs remain
linked from implementation-plan.md.

Apple explains normal Developer ID/notarization and managed policy checks:
[Safely open apps on your Mac](https://support.apple.com/en-us/102445). This does not authorize the
installer to execute any approval override.

AppImage documents that extract-and-run extracts, runs and cleans up, and may be expensive:
[AppImage FUSE alternatives](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).

Per-user Linux data/executable paths and desktop entries follow
[XDG Base Directory](https://specifications.freedesktop.org/basedir/latest/) and
[Desktop Entry](https://specifications.freedesktop.org/desktop-entry/latest/) conventions. Actual
desktop trust/launch policy still requires native tests.

## Accepted foundation review gates

Before main/helper wiring: classify actual native delivery and pass it to the updater, whose
check/download/coordinator-start/executable/handoff paths must refuse unqualified installed or
unknown delivery without network or lifecycle side effects. A UI flag alone is insufficient.
Lightweight path/version/local-metadata observation is separate from declared-payload hashing and
cannot claim integrity or publisher authentication; full verification never gates first paint.
Select an actual dedicated profile before Electron initialization and obtain a canonical-profile
single-writer lock. Use normal NSIS root-EXE layout for production; prototype app/ layout remains
separately identified. Qualify native Mac framework links, approved ancestor aliases versus rejected
payload aliases, actual profile launches/locking and native installed-update refusal. Complete
extraction inventory and OS publisher trust remain separate from self-consistent local records.
