# Non-qualifying product supervisor evidence

The soak harness retains `supervisor-evidence.json` in its private run directory. This is an
observation sidecar, **not a release receipt**. Its `qualification` and `releaseAcceptance` fields
are always false. The final staged-artifact consumer remains blocked on missing authoritative
producer contracts. No product, calibration, threshold or measurement result is supplied by this
source change.

The current emitted graph uses strict source-bound v2 parent/child schemas. The shared schema and
semantic readback API are documented in [the diagnostic contract](product-supervisor-contract.md).
V1 data cannot be relabeled into v2; all release gates remain held.

The supervisor creates a new nonce-prefixed directory under the requested `--out`, which must be
under the repository's excluded `validation/`. This allocation precedes the child's source
fingerprint; keeping it under `validation/` avoids contaminating that identity. Canonical paths are
required. `--child`, `--product-job` and `--supervisor-output` are reserved internal arguments;
external or duplicate occurrences are refused. No source-fingerprint exclusion was added.

The child uses the supervisor's directory and fixed `timeline.jsonl` path. After the existing owner
join and timeline sync/close succeed, it hashes the closed timeline and exclusively writes, syncs
and closes `child-evidence.json`. That manifest binds the job nonce and exact timeline
name/bytes/SHA256, source/adapter hashes and requested scope. The timeline starts with one exact
source/run binding record. It explicitly makes no owner-completion claim. Only then does the
existing `ProductRunOwner.finish(true)` validate custody and disconnect IPC. A manifest/hash/I/O
failure holds the owner and prevents `finish`; the unchanged total deadline is checked before and
after the evidence handoff. There is no new IPC evidence message or acknowledgement protocol.

The supervisor waits for the existing observed lifecycle outcome. Only actual normal code-zero
spawn/exit/close, with no error, timeout, cancellation request or inconsistent exit/close values,
permits reading the closed child evidence. It verifies the manifest's exact format and nonce and
rehashes the fixed timeline. Missing, malformed, foreign or mismatched evidence produces an invalid
sidecar. Unknown or abnormal closure never reads or claims a closed timeline; its references remain
null. A late close cannot upgrade the recorded snapshot, and unknown-child ownership stays attached
through the existing lifecycle observer.

The parent exclusively writes, syncs and closes the sidecar. Its status is either
`collected-non-qualifying-supervisor-evidence` or `invalid-non-qualifying-supervisor-evidence`.
Sidecar write/sync/close failure is thrown; no success is returned. Earlier failures remain first
when later sync/close operations also fail. Existing or partial evidence is retained, never
overwritten or deleted. A synchronous spawn request failure records a null lifecycle, without
asserting that no process exists.

Timeline hashing streams at most 512 MiB; JSON metadata reads/writes are bounded to 32 KiB. JSONL
lines are bounded to 1 MiB. Only canonical producer JSON/JSONL bytes are accepted, with strict
UTF-8, no BOMs or duplicate members and complete newlines. Exceeding these evidence storage bounds
fails without truncating retained bytes. Reads refuse symlinks, hardlinks, special files,
noncanonical directories and files whose identity/size/timestamps change during the read. File
sync/close follows the existing harness evidence convention; it is not a claim of directory-entry
durability through a host crash or an immutable filesystem. Future consumers must still reverify
retained bytes.

Pure tests inject an in-memory filesystem, fake clocks and EventEmitter lifecycle objects. They
exercise normal ordering, withheld joins, every I/O failure, multiple retained failures, reserved
arguments, nonce/path mismatch, aliases, mutation, growth, oversize, nonzero/signalled/error/timeout
outcomes, exit without close, late closure and missed finalization deadlines. Existing
source-verdict tests also evaluate the soak source in a VM with a fake process, filesystem and
clock; attempted process creation throws. The integration is typechecked and inspected without a
real soak entrypoint, product or lifecycle process run.

Still required: reviewed final-artifact policy/runtime/loader/soak schemas and real producers; exact
final source/artifact/runtime/profile bindings; separately reviewed normal/forced GC policies;
actual full-product coverage, at least 30 minutes and 100 measured cycles per GC mode; actual native
cleanup and descendant retirement. This sidecar supplies no substitute for those facts and cannot
remove the publication block.
