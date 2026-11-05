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

## Acquisition reconciliation and the six remaining fields

The checked-in `verifier-admission-candidate.json` now preserves the exact thirteen observations
from the acquired selection (compact JSON SHA256
`06ac141289976e5375e3f81d497dd14e936277a2273672ad3926e53eaf202163`). This is a historical, PGI-only
data selection under the selected publisher/bootstrap policy, not a fresh admission. Native/package,
bootstrap, signed metadata and source-derived JSONL associations were already recorded in the
private acquisition; they are not newly authenticated or executed by these source tests. Four of the
thirteen observations are the individual metadata role records. The original all-unknown example
remains in Git history. No one of the six remaining fields is closed.

| Missing field                       | What retained evidence establishes                              | What is still required                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `freshness.checkedAtMs`             | Acquisition and conditional validation timestamps               | The time of a real current security/advisory/revocation review; a local file-read timestamp is not that review                                                                     |
| `freshness.advisorySnapshotSHA256`  | Publisher release/index signatures and selected package bytes   | Exact retained current advisory/compromise sources and their bounded review; release metadata is not an advisory snapshot                                                          |
| `freshness.denylistSHA256`          | No current compromise/revocation assessment                     | A reviewed exact denylist snapshot/policy; hashing an invented empty list is insufficient                                                                                          |
| `freshness.leaseUntilMs`            | Signed role expiries and a proposed 24-hour consistency ceiling | Explicit action-time admission lease under the reviewed security policy, covering the complete operation; root expiry does not mint a lease                                        |
| `process.ownerImplementationSHA256` | The model's exact source hash and fake-port tests               | Reviewed actual file/process owner and native adapter, independently supportable retirement observations, stable scope across both subjects; a model source hash cannot substitute |
| `process.requestBindingSHA256`      | Fixed command/environment proposal                              | Exact selected subject/archive/record/bundle/root/tool/config identities, arguments, environment and nonce bound to the admitted owner; release artifact access remains held       |

Identity-preserving use remains unsupported: the current model hashes a selected descriptor, closes
it, then supplies path arguments to the executor, with later rechecks. Those checks can detect
persistent replacement but cannot exclude substitution during execution followed by restoration.
Merely retaining a descriptor would still not bind the bytes consumed by an executable or path-based
input parser. No `/proc` descriptor remapping, implicit trusted-parent policy, inode-as-content
identity, hardlink creation, permission change or launch adapter is adopted here. Default execution
is denied before file/process access, even if a payload claims identity preservation or retirement.

The 271 tests establish **model custody**, including held/rejected closes, held dispatch, missing
streams/exit/close/group observations, forced/contradictory groups, acknowledged observer disposal
and stale callbacks. They do not establish that native file or descendant-group observations can be
supplied. Source tests now also bind the actual acquired selection, require its six nulls, reject
its stale reuse, and show that filling the six fields with model/template/invented hashes still
confers no authority. No unchanged custody suite is new native evidence.

Separate decisions/actions remain: (1) authorize a concrete current read-only security/root review
and define the admission lease/remembered rollback policy; (2) choose and independently review an
identity-preserving native adapter, or expressly approve a precise threat-model assumption for
immutable/trusted inputs; (3) once capability and evidence exist, separately approve exact stage-B
verifier and selected-artifact access. Permission alone cannot supply missing OS/process-group
observations. All execution, artifact, package/storage, native/DUT and spending holds stay in force.
