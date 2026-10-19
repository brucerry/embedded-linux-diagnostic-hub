# Native Windows qualification plan

## Current gate and evidence rules

Use only a frozen, fully inventoried runtime and its matching setup manifest/compiler receipt. The
ancestor review baseline is 869d7d7ae88e30162046af670b9591f0957b6961; the follow-up wizard UX is
frozen separately at 4221cab765564a21f2ea5eec08a269f4a5a95293 and requires its own compiler/UI
receipts; actual package version is 0.5.2, release scope is combined v0.6.0. Private fixture
evidence does not qualify a public v0.6.0 release. Source hashes, ASAR, native executable version,
setup checksum and source commit must agree before each case. The ancestor-boundary source fix
passed independent source review. Native install/launch remains blocked by the repeated action
approval rejection; removal/permanent deletion is outside the pending install/launch-only approval.
No retry or alternate route is permitted while unresolved. Presentation, cancellation and read-only
probe are separately permitted. Do not reuse old compiled prototypes for destructive cases.

All roots live under a fresh short task-owned setup-qa directory, with a case ownership file and
exact canonical allowlist. Ordinary default installed profiles reside in actual Electron
appData/DiagnosticHub/profiles/UUID and are recorded/preserved. Additional-profile/coexistence cases
use distinct explicit task profiles. No user profile migration, credential reading, device
connection, automatic replay, host permission/security-policy change, broad process termination or
paid service/signing is permitted. No step follows a symlink or deletes unknown content. If the host
blocks unsigned execution under normal policy, report unavailable; do not bypass the policy.

## Separated native cases

| Case                     | Controlled action                                                                                                                   | Required result and evidence                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 compiler/provenance   | Build sealed current-source setup with pinned NSIS and /WX; never run it during this case                                           | Exit 0, zero warnings, complete regular-file payload inventory, source/ASAR/setup SHA256, native version and unsigned observation. Compiler success alone proves no UI or install behavior.                                                                             |
| P1 presentation/cancel   | Open the identified private setup; capture Welcome, location/options/review only; cancel before crossing ReviewLeave into apply     | Owned PID/path/creation identity and native screenshots/UIA text; installation destination, task registration and shortcuts unchanged; only bounded private extraction/probe scratch is expected. Stop if page identity is unclear.                                     |
| P2 read-only probe       | Select a fresh task folder and inspect actions/default choices; negative alias/nonempty/profile-overlap/protected target cases      | Correct actions/version/profile location; Start menu recommended, Desktop/launch off; no appRoot/profile/integration mutation. Missing/denied/unsupported is a clear refusal.                                                                                           |
| I1 initial install       | After source acceptance, explicitly confirm fresh task root with launch off                                                         | Exact sealed payload/ownership/UUID and user registration/selected shortcuts; no native app window yet. This is installed-files success, not healthy-launch success.                                                                                                    |
| L1 native default launch | Launch the installed root EXE without user-data-dir override; use only owned UI/CDP harness                                         | Actual UUID-scoped appData profile, same-profile second-writer refusal; visible/non-minimized native window with matching PID, creation time, path, native version and trusted main-frame readUpdateInfo. Keep report/profile marker. No device/SSH Connect.            |
| C1 successor cleanup     | While the matching successor is visible, request finalize and inspect old material                                                  | Full candidate verification plus current successor match; only owned prior transaction bytes are removed; profile/report marker unchanged; record acknowledgement and committed cleanup independently from launch.                                                      |
| R1 same-version Repair   | Close every owned affected slot; repair same bytes, then separately remove/corrupt a harmless declared task payload file and repair | UUID/profile stable; complete restored payload; old bytes/ledger retained until separately observed new boot. Repaired files and healthy/finalized app are separate outcomes. No report migration/cleanup is invented.                                                  |
| B1 busy slots            | Start only owned copies with separate task profiles from root/stage/previous; attempt the relevant operation                        | Every affected running path refuses before destructive mutation; newly attempted slot startup observes the logical maintenance lock. Track PID/path/creation for all cases; close only those exact processes. Never kill by executable name.                            |
| F1 refusal/fault cases   | Add exact task canaries, hold an owned file handle, use task-created intermediate aliases and changed-ledger fixtures               | Unknown data survives, aliases/locks/permissions refuse and recovery identity remains. No ACL or permissions are changed. Undo only each fixture-owned fault.                                                                                                           |
| X1 actual interruption   | Terminate only an attested task helper at observable copying/retained/committed cleanup boundaries                                  | Old/new app state classified from real native observations and complete inventories; rerun matching setup, resume the committed decision, retain profiles/reports. Do not add a production fault switch. Synthetic 27-death evidence does not substitute for this case. |
| U1 removal               | Close all owned slots; run the matching uninstaller and explicitly confirm                                                          | Only exact owned app bytes/integrations removed; every profile/report marker retained; unknown/active paths refuse. Actual removal, modified-integration preservation and interrupted finishremove are independent results.                                             |
| V1 true future version   | Build a separately pinned private future-version package with a genuinely different app/native/manifest version                     | Qualify real earlier-to-later activation, observed native successor, recovery and refusal of downgrade. Current 0.5.2 same-version fixtures do not complete this gate. Do not tag or publish private fixtures.                                                          |

Installed guided setup currently promises profile/report retention. Clean/preserve/smart choices
belong to their existing delivery/update contract and must be qualified on the appropriate actual
delivery; do not silently claim those modes for retain-only installed setup. Installed automatic
updater refusal is itself a native case and must happen before fetch/quiescence. Future report-mode
acceptance requires real report-store fixtures, not only an arbitrary marker file.

Use native UI Automation/Win32 controls and screenshots scoped to the attested owned window; record
page identity before invoking a control. Cancellation/probe never invokes the final apply control.
Use the existing native startup/coexistence harness for trusted app RPC and input/visibility checks,
extending it only as needed. Capture process identities before any owned cleanup; prefer normal
close and verify path/creation again before any permitted fallback. Preserve profiles and evidence.
Record failure/unavailable honestly rather than substituting helper exit code, a CDP object, an old
screenshot or a synthetic callback for a native result.

## Performance boundary

Current source measurement: 24 unchanged fresh read-only queries across 12 synthetic deletions,
median 452.8 ms/query, full synthetic rollback 11.24 seconds versus 0.11 seconds with a stubbed busy
predicate. Projected full-payload inspection is 52.5 seconds, not a measured native installer time
or startup delay. Measure actual progress/latency at P/I/R/C/U separately. Keep every current check;
no stale snapshot, reduced frequency or missing-parent shortcut is approved. A persistent bounded
read-only inspector could be considered only after native timing and separate lifecycle/IPC review
while retaining a fresh query per boundary; it is not implemented now.

## Release/platform gates

After Windows cases pass, independently qualify Mac Intel/ARM manual guided helper and Linux x86_64
guided-folder/portable cases under normal platform security. WSL/headless or synthetic results
cannot qualify native Mac/Linux UI. Retain every one-line/portable contract and historical asset;
new setup selection/catalogue/checksums must be reviewed together. Only the final qualified combined
source may be versioned/tagged/published as v0.6.0 after consolidated review. No release push is
authorized by this plan.

P0 compiler result: passed for private 869d7d7ae88e30162046af670b9591f0957b6961/0.5.2 with zero
warnings, verified checksum/full descriptor; every runtime/UI/mutation case remains
unexecuted/pending its gate.

Exact native allowlist must name the canonical application root and every derived sibling
maintenance location: maintenancePaths(appRoot).work (.DiagnosticHub-maintenance-<20 hex> under the
application parent), its bounded lock/journal/ack files and immutable removal/cleanup snapshots,
plus stage-<transaction UUID> and previous-<transaction UUID> directories. Do not treat only appRoot
descendants as the complete mutation scope. Keep new shortcut/HKCU identities and the new UUID
profile in separate explicit integration/profile allowlists. The actual derived paths and
transaction UUID must be recorded before each case, with ordinary profile/report contents preserved.
A profile directory-name inventory is not a content-preservation check; use dedicated task
markers/inventories for profile acceptance rather than claiming personal profile contents were
checked.
