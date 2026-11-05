# Verifier custody model — no live execution authority

This source-only model accompanies `a508828`'s blocked verifier. It cannot authenticate an admission
record, enable policy verification, launch a process, read a native file, or supply
release/retirement proof. The production policy continues calling the default verifier without ports
and is refused before request access.

`createVerifierCustody` requires source-owned filesystem, process dispatch, independent
group-observer and monotonic clock ports. The clock contract supports only synchronous integer timer
IDs and synchronous `undefined` clear acknowledgements; uncertain/throwing acquisition or
unsupported asynchronous clear stays fenced. It is not a native timer adapter. There are no native
defaults. JSON, environment variables and the acquired package do not create these ports. The model
invokes the actual verifier's validation/read/argument/output logic. The executor seam now awaits a
promise; its public execution errors remain sanitized, while the owner keeps original
errors/diagnostics separately; the old synchronous fake executor remains supported. A future live
adapter needs a separate review and grant.

One attempt is admitted before any await. Its `completion` can report a primary error or
cancellation while its `retirement` remains pending. Admission remains fenced until the actual
verifier continuation, all port calls and all file/process owners retire. Later diagnostics are
available from the attempt, separate from its primary error. State exposes counts, never
file/process capabilities. Final model retirement is explicitly not platform retirement proof. No
cancellation, deadline or rejected promise signals a process, forces a close, retries, or releases
unknown custody.

Each file open is registered before dispatch. A rejected open without an explicit no-acquisition
observation retains unknown custody. A fulfilled close retires that descriptor only after the
outstanding close call settles. A rejected close retains its handle; a matching later source-owned
closure observation can retire it without replay or retry. Observations must bind the exact returned
handle and an already-dispatched close. Contradictory no-acquisition followed by a handle fails and
retains custody. Outstanding reads/stat/open/close calls are joined separately. A future adapter
must document how it can actually supply late closure/no-acquisition observations; unsupported
observations must stay blocked.

Process dispatch receives an attempt-specific sink. The port must adopt its actual handle/PID before
delivering lifecycle events; an unacknowledged or rejected dispatch remains owned even if its
direct-child events already arrived. Success requires observed spawn, matching zero exit/close
without a signal, both stream closures, a separately injected normal group-retirement observation
for that PID with zero remaining members, and acknowledged observer disposal. Exit, child close, an
opaque hash and command-promise settlement alone are insufficient. Fully acknowledged nonzero
failures can retire with their original error; missing, forced or contradictory group observations
remain blocked. Stale sinks cannot retire replacement attempts. Output is bounded (selected stdout
maximum, 1 MiB stderr); overflow fails and continues consuming callbacks without retaining excess
output. Work/close deadlines are 30/35 seconds, total allocation 180 seconds. They report failure,
not forced recovery. Observer-disposal rejection also stays owned indefinitely; no automatic retry
is offered.

These are fake-port contracts, not claims that a Linux/SDK adapter can provide independent
process-group observations. The model does not solve path replacement between a stable descriptor
read and later path-based executable/input access. Actual runtime requires an independently reviewed
identity-preserving launch/read strategy or an explicitly approved trust assumption. No
executable/ASAR, process tree, endpoint, native behavior, cryptographic verifier or crash durability
is qualified by the tests.

Acquisition handoff `libfile_83f54ca82ff081919b9c65dca7b6ff62` (archive SHA256
`a42b38b7366f02d500a03c9afb42d307fba9a933c3fcf9d3d2effab0bc3a5321`) remains quarantined data. Its
139 listed members were size/hash checked. Its observed admission review still lacks
`freshness.checkedAtMs`, `freshness.advisorySnapshotSHA256`, `freshness.denylistSHA256`,
`freshness.leaseUntilMs`, `process.ownerImplementationSHA256`, and `process.requestBindingSHA256`.
This new model does not fill those fields or establish remembered authenticated TUF rollback
history, latest-root/revocation status, current leases, ultimate anchor approval or real process
retirement. Its acquired selections must be revalidated at action time; the prior conditional
TUF/package observations are not a live authorization.
