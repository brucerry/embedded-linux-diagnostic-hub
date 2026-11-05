# Managed Docker observation adapter — prepared, not admitted for execution

This non-shipping adapter has no Docker client, HTTP/socket implementation, process API,
credentials, container creation/start/stop/delete, native timer or filesystem fallback. A future
source-owned caller must supply transport and clock/timer ports. No live container was queried
or created in its development. Existing product bytes, workflows and release gates are unchanged.

The caller supplies one complete 64-hex container ID, its exact Docker image/config ID, creation
string and a bounded nonempty expected-label set. These are an external custodian's registration,
not proof of creation ownership or source/artifact provenance. A matching label can be copied.
The image/config ID must not be described as an OCI manifest digest or final archive identity.

One observer issues only three sequential GETs on API v1.51: inspect, one-shot nonstreaming
statistics, inspect. It never lists containers or follows names, short IDs, redirects or a
replacement ID. Identity/image/creation/labels are checked in both inspections, restart count must
be zero, and the execution's StartedAt must remain identical. Concurrent restart/removal is
unsupported and fails closed. State transitions during the sample are recorded as separate
before/after observations; the PID count is a non-atomic intermediate sample, not a final-state
or full-subtree-empty assertion. Selected numeric wire tokens must be canonical safe integers
(unsigned PID/count/restart, signed exit code). JSON reviver source context is required; fractions,
exponents, non-finite and rounded-into-safe tokens fail closed. Older engines lacking that context
are unsupported. Other numeric fields are ignored, not projected. A terminal state, zero PID sample or exit code
zero never proves normal retirement or qualification. Daemon error text, environment values and
unrelated response data are not emitted in observations.

Request acquisition is registered before dispatch. The explicit port receives a unique local
request token, the fixed GET path, response-byte bound and 30-second observation deadline. It must
enforce the byte bound while reading, pin the documented local managed service, and bind response
and closure to that same request. The symbol is local correlation, not a Docker API field. Each
response is checked again for size, fatal UTF-8 decode, JSON object shape, HTTP 200 and token. The
observer waits for acknowledged request and response closure before issuing the next read.
Full-body in-memory fake tests do not establish bounded real transport buffering.

There are at most three requests, 64 KiB per inspect and 256 KiB for statistics. The injected
30-second timer bounds observation acceptance, not kernel resource lifetime or CPU/heap usage.
Only synchronous timer acquisition and void clear acknowledgement are supported. Promise/thenable
returns are observed for rejection but stay held; their settlement is not a retirement ack.
Timeout fails the result without cancellation, signals, retries or further dispatch. Uncertain
request acquisition, rejected/mismatched RPC closure or uncertain timer retirement remains held.
Late known RPC closure may retire local observation custody but cannot reverse the original
failure. The first error is preserved, including a port error as its cause; parser/schema failures
discard diagnostic exceptions that could expose body fragments or mismatched strings. Transport
errors remain the port's responsibility and are not safe to log indiscriminately. Snapshots expose
only fixed failure codes, including secondary failure codes. Pending leases and their returned
transport custody handles stay reachable until acknowledged local retirement. No automatic
close/clear retry is performed.

`waitForRpcRetirement` refers only to this adapter's read requests and timer. Every observation,
snapshot and local retirement result preserves `wholeGroupRetirement: null`; observations always
set `normalRetirementProved: false`, `creationOwnershipProved: false` and `releaseQualified: false`.
Nothing is wired into the web producer's real launcher or its release consumer.

## Remaining independent observation

The successful metadata query established Docker 28.4.0/API 1.51, cgroupfs/v2, built-in seccomp and
cgroup namespaces. It did not test container creation, actual limit enforcement or any owned
container's lifecycle. The documented API supplies inspect/state, wait status and Linux PID-count
statistics. It does not provide the required normal-versus-forced whole-scope retirement receipt.
Namespace PID1 exit can kill remaining descendants. A service-owned observer must bind the owned
scope before launch and prove its full subtree empty after normal closure while distinguishing
forced/timeout/OOM disposal; parent-owned streams/files still need their own acknowledgements.
No self-reported child counter or a synthetic RPC acknowledgement substitutes for that boundary.

Sources: Docker Engine v28.4.0 API v1.51 schema (ContainerState, ContainerPidsStats,
ContainerWaitResponse): https://raw.githubusercontent.com/moby/moby/v28.4.0/docs/api/v1.51.yaml ;
Linux PID namespace init semantics: https://man7.org/linux/man-pages/man7/pid_namespaces.7.html .
All execution, package/storage, native/DUT, security and $0 spending holds remain.
