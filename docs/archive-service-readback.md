# Web/Gateway source and artifact readback prerequisite

This implements byte/schema correlation for the actual prepared web and Gateway build records. It
does not supply an authenticated GitHub transport, a job-to-upload attestation or a runtime
qualification producer. No workflow, normal package command or existing accepting consumer is
changed. No package/build/product/network/soak has run. Existing holds remain.

## Independent inputs and actual service fields

The reader takes a separately selected source commit/tree/version, producer run/attempt and job key,
workflow ID/path, job ID/display name, artifact ID/name, repository name/ID, and a distinct reader
job identity/tooling commit. These selections must come from the admitted controller, not from the
producer record or download. A display name is not silently treated as `GITHUB_JOB`.

`projectGitHubArchiveServiceObservation` projects the REST run/attempt, job and artifact field
families into a strict canonical observation. It verifies repository/head-repository identity,
run/attempt/head SHA, workflow, exact terminal successful job and selected immutable artifact
identity/digest/size/non-expiry. Unsafe numeric IDs, absent digests, changed attempts or failed
service outcomes fail. Extra raw API fields are ignored and are not copied into evidence. This
source projection has not been checked against a live response in this task.

Crucially, the artifact's `workflow_run` provides a run/head/repository association, not an
authoritative upload job or attempt. No `artifact.jobId` or `artifact.runAttempt` is invented.
Matching names, timestamps, a successful run, a producer's claimed job key, or an honest digest
cannot fill that gap. A future admitted authenticated transport and reviewed upload attribution
protocol/attestation must supply the missing proof. The `apiOrigin` string is a schema check, not
authentication. Raw HTTP parsing must preserve/reject unsafe IDs and retain the actual service
responses/provenance; this projection is not a raw wire parser or signature verifier.

## Readback sequence and custody

`observeArchiveReadback` has explicit independent service/artifact ports and no network default. The
future service port aggregates and canonicalizes the independently fetched run/attempt, job and
artifact observations; its returned handle must own every response it represents. The intended ports
must be independent of producer-held data. This library cannot authenticate which implementation a
caller supplied; both ports must be admitted outside this library. An actual adapter must enforce
exact API endpoints, credentials, TLS, redirects, deadlines and body retirement. None is implemented
or authorized here.

Each response acquisition is registered before awaiting it. Returned owner/operation/kind/resource
must match; stale/foreign acquisition does not close an unowned response or release custody. Reads
use at most 64 KiB chunks into bounded storage. Actual `close` acknowledgement is joined before the
next stage. Read failure plus close failure retains both diagnostics and the response handle.
Rejected/unknown acquisition or close retains its owner and fences reuse by immutable reader job ID,
even if run/attempt labels change. Another response cannot release its lease. There is no automatic
retry, force-close or cleanup. The port's close contract must mean actual retirement, not RPC
settlement; real adapter evidence is still required. Fake close promises do not prove real HTTP
retirement.

Service metadata is captured before and after the exact artifact byte stream and must match. The
stream's length/SHA256 must equal the selected service artifact's size/digest. This checks the
transport container, not merely a filename. Only then is its three-file carrier inspected and the
source/build record, shipping archive bytes and canonical checksum correlated. Strict parsers reject
malformed/duplicate-key/noncanonical records, source/run substitution, qualification relabeling,
inconsistent Gateway command ownership, lock references or tar census declarations.

## Bounded carrier and independent inner-byte inspection

The outer ZIP must contain exactly the selected shipping archive, its checksum and the scope's build
record. No path extraction is performed. Names are byte-checked; links, aliases, extra members,
offsets/gaps/overlap, CRC mismatch, trailing data, ZIP64 and unsupported extras fail. Supported
methods are stored ZIP and DEFLATE containing only stored blocks (a level-zero carrier). Both
ordinary and data-descriptor layouts are checked. General compressed DEFLATE fails closed without
calling a general inflater. Bounds precede allocation/copy. Compatibility with any actual GitHub
upload version/configuration remains unrun and must be demonstrated before admission.

Generated-name preflight includes the checksum suffix and rejects unsupported selections before I/O.

Carrier maximum is the existing 128 MiB shipping archive bound plus the 16 MiB build-record bound
and 1 MiB envelope reserve. Per-file archive/record/checksum bounds remain 128 MiB/16 MiB/256 bytes.
These are inspection limits, not disk quotas, storage allowance, runtime memory thresholds or
evidence cap reductions. Actual jobs must admit peak buffers/codec/build resources separately.

The exact inner shipping archive hash is matched to the producer record. The already captured
archive bytes are then independently decoded by `inner-archive-inspection.mjs`, without file
extraction, network, subprocesses or payload execution. Actual member names, sizes and hashes must
match the complete producer-declared payload. Gateway also requires the actual directory/mode/tar
census to match its declared inventory. Missing/extra/aliased members, links, special files, invalid
CRC, truncated compression, compressed suffixes, layout gaps and inconsistent declarations fail.

The reader supports the producers' conventional single-disk web ZIP profile (stored or DEFLATE, no
descriptors/extras/comments/ZIP64) and gzip with a plain ten-byte header containing canonical
Gateway USTAR. Unsupported profiles fail, rather than silently changing archive semantics. ZIP
directory/span validation precedes decompression. Synchronous standard-library raw DEFLATE uses an
explicit output bound and checks consumed compressed bytes; gzip additionally checks CRC and ISIZE.
Tar checksum syntax is byte-exact; high-bit digit or terminator aliases are rejected. The existing
128 MiB archive, 64 MiB member, 256 MiB payload and 4,096 entry limits remain. The archive/carrier
buffers and up to one member or complete Gateway tar can coexist in memory; real executor
memory/runtime admission is still required. This in-process operation has no separate child/worker
or stream lifecycle, and does not claim memory qualification.

The result is only `matches-producer-inventory-unqualified`. Producer declarations remain
unauthenticated inputs. Decoding does not establish a reviewed shipping binding, source/build
provenance, upload-job attribution, installed dependency identity or runtime acceptance. The current
`verify-website.yml` artifacts contain broader file sets and do not include these prepared records;
they cannot be silently used as this carrier. A future reviewed uploader must construct the exact
carrier and retain its authoritative upload provenance. No workflow/upload or compression-setting
change is made here.

## Mandatory remaining failures

Successful local correlation returns an opaque capability; its snapshot is `correlated-unqualified`.
Serialized or edited snapshots cannot act as capabilities. Authentication, upload-job attribution,
workflow-job-key association, terminal reader service result and runtime remain null. The inner
inspection records byte consistency only. `requireArchiveReleaseProvenance` always rejects because
no admitted authoritative implementation can fill those fields. Existing release consumers remain
fail closed; synthetic passes cannot become release evidence or grant execution/storage authority.

The tests use actual producer record generation and source-bound parsers with raw synthetic Git,
in-memory ports/handles and authored ZIP bytes. They verify failure and ownership behavior only. No
real API, artifact download, archive extraction, process, install, package or product is run.
