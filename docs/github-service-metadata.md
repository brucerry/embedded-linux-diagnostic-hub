# Metadata-only GitHub transport preparation

This adds a real Node HTTPS metadata-port implementation compatible with the prepared readback
engine. Construction and `openService` dispatch no requests; the first handle read starts I/O. It is
not wired to a CLI/workflow and has not contacted GitHub. It has no artifact-byte downloader,
uploader, installer, token discovery or release authority. All package/storage/native/DUT/$0 holds
remain unchanged.

## Supported source of facts

The real factory fixes `api.github.com:443`, HTTPS, GET, repository/IDs from the independently
selected controller input, API version `2026-03-10`, default Node certificate/hostname verification,
`rejectUnauthorized:true`, no connection pooling and `Connection:close`. It never follows redirects,
returned archive URLs, pagination URLs or check-run URLs. Optional Bearer credentials are supplied
by the admitted caller, never read from environment or runtime-token scopes. Public metadata can use
no credential. No environment/security setting is changed. Ambient TLS-disable or runtime injection
flags are refused. Default trust-root and loaded-runtime admission remain external prerequisites;
source code alone does not attest a host's TLS trust or module provenance.

The requested routes are only:

- The exact run attempt metadata endpoint.
- Sequential pages from that attempt's jobs endpoint, with `per_page=100`.
- The selected artifact's metadata endpoint, without `/zip` or any download redirect.

The
[attempt jobs endpoint](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt)
is the supported job-to-attempt witness. Its job examples do not require a raw `run_attempt` field.
This adapter derives normalized attempt membership from the pinned request and observed selected
job, rejecting a conflicting optional raw field. It records the request path, body hash and the
explicit `check_run_url` ID; job and check-run numbers are not assumed equal. A positive membership
witness can end pagination without claiming a complete job inventory. Missing membership within the
bounded profile remains unproved, never “no such job” or a successful attribution.

The wire parser is bounded UTF-8/JSON with decoded duplicate keys rejected, including escaped-key
aliases. Object construction cannot mutate prototypes. Only canonical safe integer tokens become
numbers; unsafe/fractional/exponent spellings remain exact opaque, identity-branded lexemes for
typed rejection/preservation. Only numeric identity fields may unwrap canonical positive integer
lexemes; string fields cannot accept bare numeric tokens, and counts/sizes require safe numbers.
Malformed bare keys, trailing input, invalid UTF-8/BOM and excessive structure fail. It is not a
general-purpose replacement for application JSON parsing.

## Custody and failure handling

Each aggregate observation is registered before request dispatch. Every HTTP request is registered
before constructor/end, with listeners for request finish/close, response end/complete/close, TLS
authorization and socket close. Body/RPC completion cannot substitute for physical socket closure.
An individual request advances only after its retirement acknowledgement. Headers and framing are
checked before acceptance. HTTP status, closure flags, body size, raw byte hashes and endpoint paths
are retained as bounded facts; raw headers are not retained. Raw bodies, credential headers and raw
transport error messages are not emitted.

A deadline or explicit handle close may cancel only the newly owned HTTP request with its normal
destroy operation; it does not force a process exit or declare resource retirement. Request,
response, socket and timer acknowledgements are still joined. Unknown acquisition, rejected
cancellation or unacknowledged closure can remain owned indefinitely. No automatic retry or bounded
forced release exists. Normal acknowledged failed requests can retire with their primary code and
cleanup diagnostics intact. Old events/duplicate close cannot clear another owner. Immutable reader
job IDs fence concurrent/relabeled observers. Host-wide/DNS/runtime retirement is not asserted by
these request/socket observations and remains a separate gate.

Admission bounds are 1 MiB per raw metadata response, 32 JSON nesting levels/16,384 values, a
10-second request deadline (custody can remain pending afterward), 100 jobs/page and at most ten job
pages. A port instance admits at most the readback engine's two observations, retaining both
complete bounded ledgers. There are at most twelve requests per observation. Limits fail closed
without truncating an absence proof; they are not storage allowance or product/runtime memory
thresholds. Actual timeout cleanup and resource capacity must be admitted before execution.

The explicit model factory injects EventEmitter hosts and a fake clock. It always labels
observations `injected-model-unqualified`, even when fake TLS flags claim success. The native
factory is distinct and is only constructed inertly in tests. Neither factory grants release
acceptance. Existing readback authentication/upload attribution/runtime fields remain null and its
release gate still always rejects.

## Exact remaining provenance primitive

[Public artifact metadata](https://docs.github.com/en/rest/actions/artifacts#get-an-artifact) binds
artifact ID/digest to a run/head/repository, without an upload job/attempt relation in this
contract. [OIDC](https://docs.github.com/en/actions/reference/security/oidc) now supports
`check_run_id`, `run_id` and `run_attempt`, which can strengthen verified requesting-job identity.
Caller-selected audiences do not make GitHub attest an artifact upload. No OIDC token is requested,
decoded or accepted by this implementation.

The
[internal artifact schema](https://github.com/actions/toolkit/blob/main/packages/artifact/src/generated/results/api/v1/artifact.ts)
contains backend run/job IDs. The supported public artifact result omits them, and no documented
independent mapping from those backend IDs to public job/check-run/attempt is supplied here. Private
endpoints or decoded producer runtime credentials are not used as a workaround.

The missing primitive is an independently retrievable, service-authenticated relation joining the
selected repository/artifact ID and digest to the actual upload job/check-run and attempt, or a
supported authoritative backend-ID mapping plus independently retrievable upload attribution.
Content provenance attestations, workflow-written subject lists, names, timestamps, audience strings
and producer receipts do not supply that specific edge. The reviewed existing architecture cannot
truthfully close it. Real metadata/API compatibility, credential/runtime trust admission, artifact
transport/inner-byte inspection, terminal reader evidence and runtime qualification are also still
pending. No live request or build/product test is implied by synthetic checks.
