# Windows permanent delivery: implementation and qualification plan

Status: authorized local v0.6.0 implementation, 2026-10-14. Published main/v0.5.2 source is
2f84f429214633374e56159296b87c188d64c5f2 and remains immutable. Installer foundation and accepted UI
follow-ons are independently reviewable; production packaging/publication still requires combined
qualification. Earlier v0.5.1 prototype observations below are historical evidence, not the current
code state.

## Verified evidence and limits

The private archive preserves the exact public v0.5.1 payload: 102 regular files, 428,925,243
uncompressed bytes; archive 158,695,571 bytes, SHA256
79b2908637c6fef0792879af6ff3164964bd39cf60d241ac3f26f6b8c1fe09f2; ASAR SHA256
63fcfea4c6d325795c05717d4e97305f95be1a7743a3c1c54d168edf994247d3. First setup took 17.549 seconds:
archive hashing 0.453, extraction 3.796 and disk bundle verification 12.501 seconds, with remaining
bookkeeping/shortcut time. Download is excluded.

Three interleaved portable controls measured 12.653/13.191/13.207 seconds to completed local UI
interaction; permanent-folder launches measured 1.360/1.169/1.154 seconds (median 1.169). Every
accepted trial subsequently passed native handle, visible and non-minimized checks. The separate
native-confirmation observation was 2.578/2.394/2.496 seconds for the folder trials, including
intervening readUpdateInfo and external process/window probes. Thus 1.169 seconds is an interaction
metric with a subsequent native acceptance gate, not a measured timestamp of first native
presentation. No cold OS cache or universal startup target is qualified.

The normal task-local shortcut points directly to app/Diagnostic Hub.exe with only the isolated
profile argument. Its launched native path/window were verified. No persistent debugger, registry
integration, real-install overwrite, SSH or physical port interaction occurred.

The actual prototype activate() routine was called with the shortcut-launched app running:
PROTOTYPE_BUSY was returned before any journal/directory mutation; live and stage bundles stayed
intact. Injected exceptions after old-retained and candidate-active transitions rolled back to the
verified old bundle. Successful same-version activation, explicit rollback, profile-marker
preservation and a missing-file rejection passed. These are controlled exceptions and same-version
directory exercises; abrupt process death, reboot/power loss, all report modes and a distinct future
version remain unqualified.

Primary evidence under C:/Users/bruce/Desktop/Codex/2026-10-13/task/serial-fix-evidence:

- permanent-folder-prototype-result.json and permanent-folder-visible.log
- permanent-folder-setup-proof.json, permanent-folder-shortcut-proof.json,
  permanent-folder-safety-proof.json
- permanent-folder-busy-activation-proof.json and permanent-folder-activation-proof.json
- permanent-folder-activation-test.log
- permanent-folder-hidden-diagnostic.log and permanent-folder-hidden-diagnostic-error.txt

## Precise visibility failure and fix

The first harness spawned the interactive app with Node windowsHide:true. It completed setup and one
portable control, then rejected the direct-folder trial with "Native window not visibly usable";
that failed trial was never accepted into timings. The original error omitted raw
handle/title/visibility values, so they cannot be reconstructed retrospectively.

A separate fresh-profile reproduction of that old launch flag recorded the owned direct EXE process
with handle 0, empty title, visible false and minimized false, and failed the same gate. The
corrected timed harness launches the interactive GUI with windowsHide:false from the start, uses
fresh comparison profiles, and retains the unchanged requirement: nonzero native handle,
IsWindowVisible true, IsIconic false, plus completed real local UI input. It neither restores/shows
a failed window afterward nor relaxes the gate. Noninteractive PowerShell helpers remain hidden. The
six corrected accepted trials pass; historical failed evidence remains retained.

## Current implementation anchors

- electron/update-receipt.ts: portableExecutable deliberately requires PORTABLE_EXECUTABLE_FILE on
  Windows; generic process.execPath is not a fallback. readUpdateInfo returned currentVersion 0.5.1
  and currentPath null for the direct folder.
- UpdateReceipts uses one bounded legacy portable handoff record, a versioned
  updates/<version>/Diagnostic-Hub.exe destination, exact hash checking and app-owned
  descendant/alias checks.
- electron/updates.ts: ReleaseUpdater selects the fixed portable Diagnostic-Hub.exe and its SHA256
  asset on Windows x64, returns a single verified executable, and rejects unsupported automatic
  platforms.
- electron/update-coordinator.ts: native ownership already quiesces Serial, waits for collection,
  disconnects SSH, saves/arms reports and requests restart; restart-requested is distinct from
  successor confirmation.
- electron/update-reports.ts: clean creates no report backup; preserve retains a backup/path; smart
  parses a validated offline snapshot. Report markers are acknowledged separately.
- electron/main.ts/shared/types.ts/preload.ts: native owns paths; trusted renderer calls supply
  semantic selections. The historical pre-foundation source had no requestSingleInstanceLock. The
  current local foundation selects installed profiles before Electron initialization, canonicalizes
  userData/sessionData and requests a packaged single-instance lock; fresh native default-profile
  and distinct portable/installed coexistence are the remaining Windows tests.

## Recommended delivery decision

Use the complete permanent folder and included fixed EXE as the common runtime layout. Retain
portable Windows delivery. Select the production front door before implementation: archive plus
explicit verified helper (closest to the prototype), or supported per-user NSIS setup with qualified
repair/uninstall and its own identity. Do not replace the existing single-file portable asset or
silently migrate its users.

Functional v0.5.2 is published and immutable. The explicitly selected next target is one combined
v0.6.0 for installer/startup safeguards and all current UI follow-ons. Preserve independent review
increments and require production qualification before version/tag/publication.

## Proposed native identity and currentPath contract

Introduce a native discriminated DeliveryIdentity: Windows portable, Windows installed, Linux
AppImage, Mac manual bundle, and unsupported/development. The renderer receives a sanitized summary,
never an arbitrary path setter.

Installed identity schema v1 should contain product/channel, installation UUID, Windows x64 kind,
canonical root, fixed production NSIS entry point Diagnostic Hub.exe at appRoot (the historical
prototype alone uses app/Diagnostic Hub.exe), bundle version, source commit, manifest digest and
archive digest. Bounded metadata lives at the application root; the profile lives outside
replaceable appRoot. Bound its JSON size (proposed 16 KiB), enforce exact
fields/version/semver/digests, reject arrays/unknown critical schema versions, and validate regular
files and canonical descendant paths without links/junctions.

The install helper creates identity only after verifying an approved package in an explicitly
selected fresh owned root. On launch, derive the candidate root from the native packaged
executable's expected layout, validate the descriptor and actual bundle association, and cross-check
app.getVersion/architecture/native executable. A self-authored descriptor or arbitrary
process.execPath alone is insufficient evidence. This is integrity/ownership validation under normal
per-user security, not resistance to a malicious user who can rewrite all same-user application
files.

currentPath is the verified fixed included EXE for installed delivery, the original wrapper for
portable, APPIMAGE for Linux and app bundle for Mac. Missing/corrupt/mismatched installed identity
yields an unavailable installed update state and readable manual guidance; no portable asset
fallback. Retain legacy portable record reading and same behavior on Linux/Mac. Do not spoof
portable environment variables.

Proposed installed handoff record schema v2 adds transaction/installation UUID, delivery kind,
previous/expected versions and manifest digests, canonical owned root, fixed entry point,
stage/rollback relative names, phase, bounded failure detail and updated timestamp. Native selects
paths from validated identity and nonce-owned descendants. Retain v1 legacy receipts unchanged. Do
not overload a single executable hash to mean a whole bundle.

## Verified staging and activation

1. Select same-release compatible installed archive, manifest and checksum catalogue through the
   native updater. Strictly bind release tag/version, architecture, kind, source commit and allowed
   asset names. Check download length and SHA256 before extraction. SHA256 detects corruption
   against the retrieved publication; no new signing/authenticity claim is introduced.
2. Stage on the same volume outside app/profile. Apply explicit container, expanded-byte,
   file-count, path-length and per-file bounds based on measured package inventory with reviewed
   headroom. Reject traversal, drive/UNC/absolute entries, normalized collisions, Windows reserved
   names/trailing dots/spaces/alternate streams, encryption, links/reparse points and
   unexpected/missing files. Verify every regular file from disk against the manifest.
3. Acquire one transaction lock keyed to the canonical installation root. Bind PID with creation
   time/executable identity, not PID alone. Recheck stage and destination after quiescence and
   before moves. Check usable disk for new bundle plus one retained old bundle and stage overhead.
4. Extend UpdateCoordinator with a typed installed transaction; preserve collection/Serial/SSH
   cleanup and report semantics. Wait boundedly for owned processes to exit. Refuse occupied roots
   or file locks; never terminate an unrelated process. Leave download/verification separated from
   activation.
5. Run the verified native replacement helper outside app so its own executable cannot lock the
   replaced tree. The parent can request quit, but reports only handoff-requested. Write bounded
   journal records through exclusive temporary files, sync where supported, then rename; record
   phases and preserve manifests before moving directories.
6. Rename app to an owned rollback slot, then verified stage to app. Directory moves are same-volume
   operations; two renames and journal writes are not one globally atomic transaction. Recovery must
   tolerate death between any move and its adjacent journal write. Reverify actual old/new manifests
   when inspecting state.
7. Launch the included EXE normally with the approved profile. Keep one rollback bundle until a new
   native process reports the expected greater version, fixed canonical entry point,
   installation/transaction IDs and verified expected bundle. Stable filename or renderer text alone
   cannot confirm success. Distinguish launch requested, bundle activated, app observed and handoff
   confirmed.
8. If launch/verification fails, restore the verified old bundle only after the failed candidate has
   exited and its locks are clear; otherwise report recovery needed and retain both. Do not claim an
   old app is usable until its native launch passes. No device reconnection or command replay
   occurs.

## Interruption recovery

On the next helper/normal launch, obtain the owned lock and inspect journal plus actual directory
identities. Prepared-only keeps the old app; old-retained with no app restores a verified old
rollback; candidate-active with unconfirmed new app checks native identity before either confirming
or restoring. A success write interrupted after the new app appears must not downgrade based solely
on stale journal state. Missing, corrupt, ambiguous or locked trees stop with bounded diagnostics
and retained evidence; never guess or delete a user's directory.

Test exception injection and abrupt helper termination separately at each journal write/move
boundary. Repeat recovery to prove idempotence. True power-loss durability requires additional
filesystem/host qualification and must not be inferred from caught exceptions.

## Reports, profiles, portable migration and coexistence

Default recommendation: a dedicated installed profile outside app, preserved for all installed
updates, and an explicit optional report import for portable users. Keep the existing portable file,
shortcut and profile untouched. Do not automatically copy credentials, SSH known-host trust, session
ownership, Serial grants or caches. If the user instead selects sharing an existing profile, add and
qualify a canonical-profile lock before allowing either delivery to write it; that is a
consequential scope decision.

Different profiles may coexist. Enforce one writer per canonical profile and one transaction per
installed root; a same-profile second instance focuses/refuses appropriately. Update receipts
identify their delivery/installation so reopening portable cannot falsely confirm installed handoff.
Uninstall/removal only touches the chosen owned app root; profile/report deletion requires an
explicit separate choice.

Qualify clean/preserve/smart using the actual new process: clean has no new recovery marker while
existing user backups are not erased; preserve exposes the validated backup without automatic
import; smart restores the validated offline snapshot and acknowledges only after successful UI
consumption. No mode restores network connections or replays automation. Rollback must understand
any changed report/schema state or keep the original durable backup available; version rollback
cannot assume profile migrations are reversible.

## Implementation order and acceptance matrix

A. Identity/types/UI availability: legacy portable receipts, installed currentPath, explicit
unavailable states, trusted IPC selectors, no path fallback. B. Package catalogue/manifest/helper
layout: isolated bundles, source/ASAR provenance, safe archive validation, front-door namespace and
profile choice. C. Native transaction/journal: lock ownership, quiescence, activation, rollback,
crash recovery and report recovery. D. Actual distinct-version handoff: two isolated source-built
packages with different real app.getVersion values; verify source/manifest/version/path in the
successor. Do not edit immutable tags or publish test releases. If fixture versions use a test-only
build version, assert real packaged metadata and keep them outside the production asset catalogue.
E. Focused native/browser and release preflight, then broader repository checks only for changed
behavior.

| Gate                  | Required evidence                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity/receipts     | Legacy v1 accepted; malformed/oversized/unknown v2 rejected; alias/arbitrary/temp EXE/descriptor mismatch unavailable; portable/Linux/Mac unchanged                                                                                  |
| Package integrity     | Truncated/hash mismatch/missing/extra/changed files, traversal, case collisions, reserved names, symlinks/junctions, zip bomb/limit rejection before live mutation                                                                   |
| Ownership             | Two requests, concurrent normal launch, owned busy process, PID reuse, unowned process/file lock, read-only destination, disk exhaustion, timeout: no unrelated termination or overwrite                                             |
| Activation/recovery   | Exceptions and abrupt kill at all journal/move boundaries; old/new native usability, idempotent recovery, stable shortcut, retained profile marker; no false confirmation                                                            |
| Future version        | Real different packaged versions and bundle manifests; expected native greater version/path confirms; old/wrong version at same filename does not                                                                                    |
| Reports               | clean/preserve/smart with actual successor and rollback; invalid/oversized backup; acknowledgement interrupted; offline restoration and no replay                                                                                    |
| Migration/coexistence | Portable preserved; explicit report import; separate profiles; same-profile lock; old shortcuts/receipts safe; repair/uninstall rules for chosen front door                                                                          |
| Windows matrix        | Local Windows 11 x64; supported Windows CI x64 native packaged tests; standard account; path spaces/Unicode; normal unsigned/policy denial; managed-PC acceptance remains separate                                                   |
| Other delivery        | Existing portable Windows, Linux AppImage handoff and Intel/arm Mac manual behavior regressions                                                                                                                                      |
| Startup               | Setup/hash/extract/verify separately; interleaved fresh/reused profiles, native gate plus input; preferably persistent native observer to timestamp visibility without spawned-probe overhead; cold-cache only if actually qualified |

Production acceptance requires no dependency additions, elevation, permission changes, security
exemptions, services/autorun or physical ports. Existing focused hosted checks for functional main
are green; do not rerun them merely to qualify this design.

## Remaining decisions and blockers

- Production front door: archive/helper versus supported per-user installer.
- Profile migration: recommended separate installed profile/report import versus explicitly shared
  profile with new locking.
- Production delivery is blocked on explicit installed identity, compatible package assets, crash
  recovery and genuine future-version/report-mode qualification. The prototype's null installed
  currentPath honestly demonstrates the gap.
- This is a reviewable implementation plan; no production adoption or release version change has
  been performed.
