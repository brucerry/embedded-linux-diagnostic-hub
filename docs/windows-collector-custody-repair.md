# Windows collector custody repair

This is a separate repair candidate from the preflight-only workflow packet. Both start from the
sealed666 source and have disjoint deltas. This candidate leaves all standing workflows unchanged.
The preflight-only packet provides the proposed first hosted validation; nothing here enables it.

W-CANCEL-1: both actual entry functions install signal/disconnect/nonce-message custody before
verification or preparation. Cancellation survives held verification and controller handoff. IPC
connection/admission is rechecked after awaits and blocking preparation boundaries. A collector
requires the outer's original nonce/start/deadline; it cannot create another80-minute cohort. The
outer and inner observer/controller consume that same immutable same-host monotonic deadline.

W-HOLD-1: unknown ownership allocates and refs its retained handle before any receipt write.
Disk-full, path drift, sync/close and record failures are retained as failed persistence inside the
hold. They cannot reject out of custody, retire entry handlers, disconnect or release the marker.
Early preparation and refusal attempt every acquired log/journal closure; uncertain closure holds.

W-ADMIT-1: the actual spawn port allocates one immutable job, prepares the directory/logs/argv/env,
yields once to deliver queued IPC/signals from blocking Windows preparation, then performs final
cancellation/IPC/existing-work-deadline admission immediately adjacent to synchronous spawn. Refusal
closes every prepared descriptor and records certain non-admission; no new deadline is minted.
Controls exercise cancellation in real preparation stages and final-check exceptions.

W-PTY-1: discovered Bash is passed explicitly through TypeScript -> PowerShell -> C# Run -> the
winpty application parameter. The command line must match the same absolute Bash path. DLL, agent,
Bash, pwsh, Git and cygpath are hashed and required to be x64 PE files; PowerShell rechecks the
actual process/tool paths and hashes before compiling/invoking the bridge. A nondefault-path
argument control passes locally. Actual Windows C#/PowerShell/PTY execution remains untested and
unqualified.

W-CI-1 is handled by the independent preflight-only packet: one fenced manual job, no standing-build
dependency and no collection option. W-CI-2 remains an explicit unresolved prerequisite: a later
allocated hosted runner is not the observed host. Both the production manifest verifier and CLI now
refuse collection until an independently reviewed same-host approval/custody mechanism or host-
binding protocol exists. Test injection bypasses only validation to exercise the actual entry
functions with virtual events/clocks and no product processes; it is not a CLI execution option.

No hosted facts, native product/PTY/installer/soak, CI dispatch, commit, push, tag, publication,
security setting, dependency installation or canonical-marker mutation occurs in this repair. The
original58 protected files,211 OpenSpec files, exact live test and all sealed packets remain
preserved. Old39UI results stay historical; this non-UI repair makes no new browser/native claim.

Prepared log descriptors are retained separately from started-parent records. The shared log
allocator carries every acquired entry through a partial preparation error; final-admission refusal
carries the same entries and closure result. The controller durably records each prepared entry's
sync/close attempts before release proof. Incomplete or missing closure proof prevents marker
release and enters the attached ownership hold with entry handlers retained. A sync failure still
invalidates durability even if the descriptor closes. No retry resets attempted closure or treats an
empty replacement list as proof of closure.

Local controls use the actual helper, controller and entry with real disposable descriptors, a
modeled lease and injected sync/close failures. They do not acquire the canonical marker, start a
product child or qualify Windows/native collection. Collection remains disabled.

Outer-entry partial log preparation now merges error-carried acquired entries before cleanup and
honors incomplete or explicitly unknown closure proof. An empty local list cannot erase the shared
helper's ownership evidence. Failed sync or close retains the attached hold, cohort timer and entry
handlers; closure is attempted once per acquired entry, with no reset or blind retry of an uncertain
descriptor. Nominal second-open refusal may reject only after the acquired log has actually synced
and closed.

Regression controls invoke the imported production `runOuter`, real `CollectionEntry`, `RootGuard`,
record writer, log helper and closure helper on physical disposable files. Only principal
observation, log I/O faults, the no-launch boundary and hold timer are provided as explicit ports.
No extracted function body or native child is used. Collection verifier and CLI remain disabled; no
preflight source change is included.
