# Disposable hosted-CI synthetic metadata fixture policy

Policy identifier: `github-hosted-windows-synthetic-metadata-v1`. This is a proposed, separately
reviewable source policy for one bounded functional metadata-I/O validation. It grants no run,
collection, release or user-machine approval. The accepted evidence from run 39107781069 is
retained; there is no new broad token, ancestor-permission or installed-tool investigation in this
change. The existing unrelated metadata inspections remain unchanged. The former 14-directory
observation is no longer invoked by the production entry point.

The trust boundary is one fresh GitHub-hosted Windows VM and the reviewed job code, actions and
lockfile dependencies running in it. SYSTEM (`S-1-5-18`), Administrators (`S-1-5-32-544`) and the
exact current runner user SID are explicitly trusted within that boundary. Hostile co-resident
processes, malicious same-user code and malicious administrators are outside this synthetic test
claim. The policy neither establishes user-machine privacy nor measures effective access, enabled
token groups, privileges, MIC, SACL or CAP. Path identity equality cannot exclude ABA or establish
atomic or continuing custody. A completed prior VM is not approval for a future VM.

Admission requires Windows x64, `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`, the exact
repository `brucerry/embedded-linux-diagnostic-hub`, manual dispatch, attempt 1 and the existing
metadata-only flag. The production entry already requires pinned Node24.22.0x64 and source/runtime
identities. These environment values are assertions about the trusted job configuration, not a
cryptographic attestation or a sandbox for arbitrary code.

The sole payload parent is the existing physical
`C:\Users\<current USERPROFILE>\AppData\Local\Temp`. The profile must be exactly one component under
`C:\Users`; LOCALAPPDATA must identify its physical `AppData\Local`. The canonical `os.tmpdir()`
spelling must have the same device/file identity as this profile Temp. Long/short spellings may
identify the same directory. Aliases/reparse points and a substituted parent fail without fallback.
All existing ancestry components are checked by physical lstat/realpath identity. No D workspace,
runner-work Temp, arbitrary path argument, globally Administrators-owned directory or substitute
root becomes an admitted payload parent.

The code creates one unpredictable UUID-v4 child named `diagnostic-hub-ci-metadata-<nonce>` with
exclusive nonrecursive mkdir. It never adopts a collision. Normal creation inherits security from
the existing parent; the code supplies no replacement security descriptor and changes no ACL, owner,
inheritance protection, privilege, UAC, policy, environment variable or machine setting. TEMP and
TMP remain unchanged and are checked for drift. The canonical marker remains at its original
canonical temporary path; it is only checked for absence, never acquired, moved or cleared.

Before any fixture payload access, one existing hash-pinned, isolated System32 WinPS5.1 child reads
only the parent and fresh child descriptors. Its already prepared 25 pure decoder/serializer cases
run first; its strict bounded report and all ordered raw capture records are retained. Source,
script and executable identities are rechecked. The controller verifies parent/child path identities
and their ancestry before creation, after the descriptor command and before each payload operation.
Any unavailable/partial/unsupported descriptor, identity change, cancellation, deadline or source/
runtime failure blocks payload admission.

For each of these two specific directories, the accepted inherited DACL must contain exactly three
standard access-allowed ACEs: one each for SYSTEM, Administrators and the exact observed runner SID.
Each ACE must have flags `0x13` (object-inherit, container-inherit and inherited; not inherit-only),
mask `0x001f01ff` (`FILE_ALL_ACCESS`), canonical SID-only bytes and no trailing application data.
Missing/null/empty DACLs, extra or duplicate grants, unknown/object/callback/deny ACEs, different
masks or flags and a stale runner SID are refused without repair. This is an exact-shape recognizer
for this fixture policy, not a general ACL or effective-access evaluator. The observed group must
remain the same from parent to child. Owner may be one of the three explicitly trusted identities in
this specific fixture context; owner equality with the runner user is not required. Accepting SID544
ownership elsewhere is not part of this policy. The prior owner-equality observation remains in the
report with `ownerSIDEqualityRequired=false`.

After descriptor admission, only the existing three disposable-file controls run in the child:
nominal, one injected sync failure and one injected close failure. Each uses a fresh exclusive nonce
file and fixed nonsecret synthetic bytes, with writable read/fsync/close/reopen, byte checks, actual
close outcomes and unlink proof. The two injected faults remain explicit expected controls; they are
not reported as successful sync/close calls. No real terminal transcript or user capture payload is
written.

The fixture controller waits for each probe result and admits no later control after a failed one.
Cleanup uses the reserved cleanup path without admitting new payload work after cancellation or
deadline. It still verifies the bound identities, ancestry, marker absence and unchanged
environment. The file helper's default cleanup check is unchanged for existing callers; only this
controller supplies its separate cleanup check. A handle with unconfirmed closure, an unexpected
pending probe, identity loss, unknown directory contents or removal failure retains the fixture and
an explicit failure receipt. Only the exact still-bound empty child can be removed with nonrecursive
rmdir. There is no recursive cleanup, adoption or deletion of unrelated entries. Report/journal
closure remains independently synced/closed and any uncertainty blocks the parent attempt.

Existing limits remain: 300000 ms shared budget, 30000 ms cleanup reserve, 10000 ms and 65536 bytes
per command, 128 journal rows, 65536 bytes per journal row, 262144 journal bytes, 524288 report
bytes, and 32768 bytes for the provider descriptor result. Transport retains at most 65536 decoded
bytes per stream in the unchanged indexed chunk protocol. The fresh fixture has only the bounded
three probe files, used serially, plus no user data. No capacity reservation, quota or collection
overshoot claim follows from this test. D report output remains explicitly nonsecret synthetic CI
metadata; it is not labeled private capture storage.

All collection guards, protected originals and OpenSpec files remain unchanged. Passing this
functional fixture does not approve native/PTY/product/browser/installer/soak/build work, another
job, a rerun, calibration, shipping or a future continuation/custody protocol. No permission repair
is authorized or implemented. The exact source, policy and proposed single-run scope must be
reviewed before publication or any Windows run.

References:

- [GitHub-hosted runner VM and administrator boundary](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Default GitHub runner variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)
- [Standard access-allowed ACE layout](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-access_allowed_ace)
- [ACE inheritance flags](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-ace_header)
- [Filesystem access masks](https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants)
