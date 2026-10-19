# Setup review remediation checkpoint

The three independent P2 findings are addressed as source: candidate ownership includes a unique
transaction ID (same-byte Repair no longer confuses the old slot with the new stage); native
successor acceptance ignores decorative titles and binds PID, executable, version, creation time,
current visible/non-minimized window and canonical dedicated profile; INI responses use verified
plain parent identity, bounded regular single-link files, an exclusive fsynced temporary file and
atomic rename. Existing/dangling file aliases, hardlinks, replaced parents and oversized requests
have focused regressions.

Removal now saves an immutable digest-bound ownership/file/integration snapshot outside the app tree
and journals the move into the retained slot before exact-ledger deletion. If interrupted, setup
offers only explicit finishremove, including when individual installation metadata files have
already disappeared. Profiles and reports are separate and untouched. Unknown files/aliases and
active app paths refuse. Integration ownership is validated before moving or deleting the app;
additional registry values are preserved and registry subkeys are never recursively deleted. The
root is not recursively removed. A harmless orphaned snapshot may remain if the process dies after
the journal commit marker is unlinked.

Further checks revalidate reviewed identity after acquiring maintenance, refuse startup while its
maintenance lock exists before creating a normal profile, restore the previous version/identity
after a partial integration callback failure, and check the complete candidate bytes plus current
successor again under the maintenance lock before releasing its backup. The production worker
exposes no phase or process-exit injection.

Validation: typecheck passed. Affected setup/installation/startup/updater suite: 48 total, 47
passed, 1 skipped, 0 failed. The skip is the existing native Mac framework case on Windows. Nine
actual Node child exits cover four install/Repair and five removal journal boundaries with synthetic
app bytes and fake native/integration callbacks. These are process-death filesystem proofs, not
power-loss, physical device, real future-version, native registry or packaged GUI qualification.
Exact logs: setup-lifecycle-review-typecheck.log and setup-lifecycle-review-tests.log.

NSIS source fixes use unique Hub-prefixed variables, correct escaped command-line quotes, standard
FileVersion metadata and explicit finishremove recovery choice. package-windows-setup.mts now treats
compiler warnings as errors. Compiler-only evidence uses the old unqualified
83a54c1a2a777680d81493cad3390cc0ebca88ce runtime, so it must not be executed or presented as the
updated engine. Any prior 04b6f114 setup EXE remains unqualified. No wizard screenshot, native
install or runtime acceptance is claimed here.

An additional recovery boundary remains open: interruption while rollback removes a staged candidate
or finalize deletes a retained prior payload can delete that slot's own metadata before cleanup
completes. Remaining app/user data is preserved, but subsequent automatic cleanup/replay of that
partial slot needs an external ledger/committed-cleanup state and regression qualification. This is
explicitly a release/native-mutation gate, not claimed covered by transition-only child exits.
Review these source fixes and this remaining boundary before a fresh frozen current-source package
is used for native mutation tests.

Exact incremental source patch: setup-lifecycle-review.patch, compared with private fixture
83a54c1a2a777680d81493cad3390cc0ebca88ce; full source hashes and constraints:
setup-lifecycle-review.json. Separate tests/ui/live.spec.ts four-line edit hash is unchanged
(07dd490a4abff47fc24fcd86ceb63a3ff5fa0d7605b427420a08c1af2043376b) and excluded. Main remains
2f84f429214633374e56159296b87c188d64c5f2, package version 0.5.2; v0.5.2 and every historical
published asset/tag are untouched. No new dependency, push, publication, user preview, host
permission/configuration change, device interaction or physical port opening occurred.

Compiler-only completion: corrected canonical NSIS script compiled with /WX (warnings fatal), exit 0
and zero warnings. Artifact SHA256 22aec44f2b3193336159b44487a29e8b0b42256bcc6750664e1b66d09f0af8be,
236683737 bytes; receipt setup-nsis-script-compile.json and log setup-nsis-script-compile.log. The
payload is still old private 83a54c1/0.5.2, unexecuted and unqualified. OpenSpec strict 20/20 and
focused format check passed.
