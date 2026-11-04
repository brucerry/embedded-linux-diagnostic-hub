# Source-bound diagnostic supervisor contract

`scripts/lib/product-supervisor-contract.mjs` is the shared schema authority for the **v3 diagnostic
supervisor graph**. It does not define an accepting staged-artifact producer contract. The release
consumer's unconditional block is unchanged, and every graph result has `qualification:false` and
`releaseAcceptance:false`.

The source binding has its own `schemaVersion:2`, kind `product-supervisor-source-binding`, false
qualification flag, job nonce, source fingerprint, adapter file SHA256, lane, GC mode, viewer flag
and `requestedMode` (`full-product`, `component` or `calibration`), plus a harness-observer digest.
These are requested collection settings and static bytes observed, never achieved coverage, memory
results or policy approval. All schema fields are exact; missing/unknown fields, types, versions and
substituted kinds fail.

Before creating output or spawning, the parent independently fingerprints its source and hashes the
adapter file, requires the caller's source pin to match and captures its own
`nodeRuntimeIdentity()`. The child independently performs its source/adapter reads and its own
`nodeRuntimeIdentity()` call. Each constructs the binding from its observations and internal job
nonce. Existing `argumentsOf` presence semantics are preserved: e.g. `--viewer=0` is still present.
Calibration requires `--calibration=1` and forbids component mode and an enforcement policy. Parent
static reads count against the unchanged job deadline; work admission is rechecked before output and
immediately before spawn. The child rechecks admission after static reads and immediately before
adapter import, including after the initial timeline writes. There is no deadline extension or
execution authorization here.

The `harness-observer-runtime` envelope has `schemaVersion:1`, `role:"harness-observer"` and
`qualification:false`. It retains exactly the existing identity function's executable realpath and
on-disk SHA256, Node/platform/architecture, complete versions map, ordered `execArgv` and exact
`NODE_OPTIONS` value (null remains distinct from empty). Snapshots copy and freeze all nested
collections. Only version-map keys are sorted for the canonical digest; flags, duplicates and
environment text are never trimmed or rewritten. Strings, version entries and flags are bounded, and
the complete envelope is at most 16 KiB. The current schema covers the existing Node24 observer
scope on Linux/Mac/Windows x64/arm64 and checks platform-specific absolute paths, including Windows
paths during offline readback on Linux. Missing, extra or inconsistent identity fields fail.

The first timeline record is exactly one `supervisor-source-binding` record. The streaming verifier
requires its complete binding, including nonce, to match the independently supplied expected
context, including its observer digest. The second record is exactly one
`supervisor-harness-observer` containing the full independently observed child envelope, which must
match the expected observer and bound digest. Any existing `identity` record must be unique and
agree on job nonce, source, adapter, lane, GC mode and viewer. Its other fields are not
production-runtime qualification. Other timeline records are checked for JSONL framing only: no
metrics, policy, assessment, ownership, coverage or pass label is interpreted or promoted.

The child manifest and parent sidecar use `schemaVersion:3` and retain that binding and their own
observer envelopes. Their fixed file references, exact bytes/SHA256, nonce/job, source/mode context
and actual normal lifecycle are semantically linked by
`verifySupervisorEvidence(job, binding, observer, io)`. The expected job, binding and observer must
come from independent trusted observations, never by reading them out of the input sidecar. The
verifier checks the parent header/lifecycle before reading child files, then rehashes and parses the
child manifest and timeline. Invalid or unknown lifecycle cannot cause a live timeline read. Its
result kind is `verified-non-qualifying-supervisor-graph`, with both qualification flags false. Old
v1/v2 sidecars and v1 source bindings are refused without fallback or relabeling.

Metadata is bounded to 32 KiB and must be the producer's `JSON.stringify(value) + '\n'` bytes. JSONL
lines must be canonical `JSON.stringify` bytes, each at most 1 MiB, with a complete final newline.
Streaming retains the existing 512 MiB total timeline limit. Duplicate JSON members, BOMs, malformed
UTF-8, alternate encodings, malformed/partial JSONL and duplicate/missing/foreign binding records
are refused. Existing single-link, canonical-directory, stable-handle read checks and exclusive
write/sync/close ordering remain. Exceeding a bound never truncates retained evidence.

Synthetic controls demonstrate accepted diagnostic shapes for both GC modes and all requested
scopes, rejection of context/run/byte substitutions and continued release blocking. They are not
calibration, actual product observations or genuine release evidence. Schema verification does not
authenticate who produced an input file. Matching static adapter hashes do not prove the dynamic
import or its dependencies executed unchanged, and a workspace fingerprint is not yet a reviewed
bridge to the final committed source tree or shipping artifact inventory.

The retained identities describe the harness at capture time. On-disk executable bytes and flags do
not prove the process's mapped image, dynamic loader behavior, production desktop/browser/Gateway
roles, installed-artifact provenance or native-addon absence. No real identity collection or product
execution is supplied by this source change; tests use explicitly synthetic complete identities.

The [committed-source bridge](committed-source-bridge.md) now maps observed source bytes to
explicitly supplied immutable commit/tree identities and the exact fingerprint traversal. It remains
non-qualifying and supplies no staged artifact records. Final composition must still be frozen and
observed independently. Exact shipping runtime/loader producers remain missing, along with final
source/artifact mapping, independently reviewed per-GC policy/assessment/calibration evidence, real
full-product metrics and coverage, at least 30 minutes and 100 measured cycles per GC mode, and
actual cleanup/retirement.
