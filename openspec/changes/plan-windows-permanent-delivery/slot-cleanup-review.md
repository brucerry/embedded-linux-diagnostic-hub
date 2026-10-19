# Rollback/finalize slot recovery checkpoint

Both requested source gaps are addressed: rollback/finalization cleanup now survives deletion of its
own slot metadata, and running stage/previous paths are checked before destructive work. Independent
review of this new four-file delta remains required before native mutation acceptance.

Rollback and confirmed-update cleanup share one immutable external cleanup ledger. Its journal-bound
digest identifies the transaction, installation, final root, cleanup decision, slot role and
validated Owned snapshot. Deletion paths are derived from the root and transaction UUID; a ledger
cannot supply an arbitrary filesystem destination. The ledger is durably written through an
exclusive temporary file and atomic rename before the journal commits rolling-back or
candidate-confirmed. An orphaned full ledger before that journal transition can be matched and
reused; no orphaned file or directory is broadly deleted. Removal reuses the same snapshot validator
and bounded purge routine while retaining its previously accepted external removal snapshot.

Recovery replays the exact manifest, tolerating already-missing owned entries. It does not read
identity from partially deleted internal metadata. All known files are handled individually,
directories are derived from declared file parents and removed only when empty, and no deletion
routine discovers or recursively visits added directories. The journal commit marker is removed
before optional leftover acknowledgement/ledger cleanup, so an orphaned bounded metadata file does
not require a deleted boot acknowledgement to finish a committed update. Profiles/reports remain
separate and untouched.

Once candidate-confirmed is persisted, rollback is unavailable because previous bytes may already be
gone; the UI action inventory offers launch/finalize to resume that committed decision. rolling-back
offers rollback to finish the prior decision. Matching native acknowledgement, full candidate hash
and current successor checks still gate finalization. A newly launched candidate can acknowledge
candidate-confirmed after a prior helper interruption.

Fresh busy checks cover root/stage/previous immediately before installation/recovery moves, and the
actual cleanup slot immediately before every file unlink and directory removal. An initially active
previous slot refuses before finalization commits. A slot becoming active between individual
deletions refuses the next mutation and retains the external recovery identity. The startup guard
recognizes only bounded, matching installation ownership for stage/previous UUID slots under the
derived maintenance folder; those slots also observe their original logical installation lock before
creating a profile. No per-slot lock hierarchy, background watcher/service or new dependency was
added. Actual OS process-inspection/startup behavior still needs native qualification.

The simplifying design is one shared bounded purge and immutable ledger replay, with no per-file
progress cursor or per-file journal writes. Repeated fresh process inventory is intentionally
conservative; its impact on native setup duration remains to be measured before any optimization.
This changes maintenance, not startup payload hashing or automatic installed updater refusal.

Validation: typecheck passed; affected setup/installation/startup/updater suite 54 total, 53 passed,
1 pre-existing Mac-native skip, zero failures. Eighteen additional actual Node child exits (code 87)
cover every file and directory deletion in two nested synthetic slot payloads, including
ownership/record/manifest metadata and the final empty root. Each resumes from the unchanged
external ledger and verifies version bytes, installation/profile ID, retained report marker, and
completed journal/slot cleanup. Along with the prior nine phase-boundary exits, this is 27 actual
Node process deaths. These use synthetic EXE bytes and fake native/integration callbacks, not
physical packaged process, power-loss, registry, device or future-version qualification. Busy,
new-content, alias and changed-ledger regressions are separately asserted. Logs:
slot-cleanup-typecheck.log and slot-cleanup-tests.log.

Fresh private runtime: 5ddfa609b5be2238082576cfd0c7b877404f32b7, actual package version 0.5.2,
native ProductVersion 0.5.2.0, ASAR SHA256
d515283f9d7a63dcb8ed85f12af1ee792c0740a40523753041bd6239846d1668. The four changed files exactly
match the frozen source; ASAR dependency inventory and compiled new-fix markers passed, and the
archive differs from the old 83a54c1 prototype. Windows reports NotSigned; no signing credentials
were supplied. Nothing in this runtime was executed or installed, and a new setup EXE has not been
compiled yet. Old private setup binaries remain unqualified and were not reused. Native mutation
qualification remains gated on review.

Exact delta: slot-cleanup-review.patch, compared against the independently accepted 12-file receipt;
baseline hashes for all four files were verified. Current hashes, all 18 death-case coordinates,
build and constraint evidence are in slot-cleanup-review.json. Build source/provenance, package
audit, unsigned native file observation and logs are in
C:/Users/bruce/Desktop/Codex/2026-10-13/task/serial-fix-evidence/windows-assisted-native-0b9a90c2.

Main remains 2f84f429214633374e56159296b87c188d64c5f2, package version 0.5.2; v0.5.2
refs/assets/history remain untouched. The user's separate tests/ui/live.spec.ts four-line edit
retains SHA256 07dd490a4abff47fc24fcd86ceb63a3ff5fa0d7605b427420a08c1af2043376b and was excluded
from the private fixture. There was no push, publication, new user preview, dependency addition,
signing, host permission/configuration change or physical port/device interaction. Release scope
remains the combined v0.6.0.
