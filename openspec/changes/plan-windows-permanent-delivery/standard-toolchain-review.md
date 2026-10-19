# Standard toolchain reconsideration

The ordinary assisted installer remains the simpler solution for ordinary install/uninstall. The
pinned electron-builder NSIS types expose oneClick, perMachine, allowElevation, directory choice and
appData retention controls (out/targets/nsis/nsisOptions.d.ts:76-103,185). The generated uninstaller
also explicitly supports customRemoveFiles (templates/nsis/uninstaller.nsh around160), and process
checks have customizable hooks. Those options/hooks should be acknowledged; this design does not
claim standard NSIS cannot be customized.

The approved stronger contract changes the required sequence and ownership model: preserve an old
verified payload until a matching native/UI successor, recover interruption after individual
metadata deletion, preserve unknown app-root content, keep stable UUID-scoped profiles and permit
independently owned locations/profiles without global app-id uninstall side effects. Pinned
installSection.nsh invokes uninstallOldVersion before installApplicationFiles and before
customInstall. Its default registry/shortcut bookkeeping uses the global application identity.
uninstaller.nsh's default branch uses RMDir /r at line187 and optional appData deletion at237-243;
it also handles shortcuts/registry outside customRemoveFiles.
allowOnlyOneInstallerInstance.nsh:65-105 contains prefix/name-oriented process termination
fallbacks. Defaults can be replaced, but replacing those policy/order points would still require the
transaction/ownership implementation.

| Component                                       | Why it remains for the approved behavior                                                                                               | Standard functionality retained / complexity bound                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| electron-builder packaging and pinned NSIS/MUI  | Produce native runtime/version resources and familiar wizard/uninstaller presentation                                                  | No custom compiler, package format, signing service or dependency.                                                                                                                                     |
| Small assisted NSIS script                      | Explicit location/options/review plus install/launch/repair/recovery actions must call one reviewed engine in the correct sequence     | Reuse MUI pages/controls and normal current-user execution. Standard settings cover several preferences; the custom part is orchestration, not a new UI framework.                                     |
| Metadata/startup adapter                        | Installation UUID/layout/version determines a separate canonical profile before Electron initialization                                | Reuse normal Electron profile locking and existing updater refusal; no profile migration and no startup payload hashing.                                                                               |
| Headless worker and bounded INI channel         | Run existing JS validators/ownership code from a clean temporary runtime before normal GUI/SSH/Serial initialization                   | Reuse bundled Electron; no installed system Node dependency, run-as-node/security switch or renderer path-setting API.                                                                                 |
| Transaction journal and external Owned snapshot | Recovery after individual deletions cannot depend on the deleted slot's own metadata; previous payload must survive until acknowledged | One immutable cleanup decision and shared bounded purge, no per-file cursor/journal, no recursive delete, watcher/service or per-slot lock hierarchy.                                                  |
| Shared mutation-path module                     | Same parent/leaf invariants must apply to payloads, metadata, moves, shortcuts and temporary cleanup                                   | Consolidates formerly scattered fragile checks; one small set of filesystem primitives is audited.                                                                                                     |
| Exact integration and process ownership         | Preserve customized/unowned data and separately owned roots; refuse affected active paths without broad process killing                | Use current-user OS facilities and known GUID-derived keys/paths. Fresh-query cost is measured rather than hidden.                                                                                     |
| Trusted successor acknowledgement               | Installer exit or existence of an EXE does not prove the new visible, correct-profile app is usable                                    | Reuse trusted main-frame readUpdateInfo plus actual native PID/path/creation/version/window checks.                                                                                                    |
| Self-contained uninstall runtime                | A partially deleted app must still have a working recovery engine                                                                      | Current packaging duplicates substantial runtime data; footprint is a known cost. Relying on the files being deleted would weaken recovery. No new bootstrap/service is added to optimize prematurely. |

Recommendation: retain the standard packaging/MUI shell and centralize only the policy required by
the approved recovery/preservation contract. Do not add an event watcher, custom native process
service, cached inspection or cross-platform abstraction merely to optimize the prototype. If the
product deliberately relaxes native-ack retention, strict unknown-content refusal and multi-location
UUID ownership, a configured standard assisted installer with limited hooks could remove much custom
lifecycle code; that is a contract change, not an equivalent implementation, so it must not happen
silently. The current source review and native acceptance gates remain necessary.

This review is grounded in the installed pinned templates, not a claim about every past/future
version of electron-builder. Re-evaluate hooks and behavior when upgrading the toolchain. No
additional service, paid runner/signing, dependency or security exemption is proposed.
