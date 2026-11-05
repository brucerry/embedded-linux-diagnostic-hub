# Alternative attested-content provenance policy for v0.6.0

This is an **additional content-association policy**, developed without enabling signing or changing
any release gate. `verifyAttestedContent()` in `scripts/lib/attested-content-policy.mjs` returns
`verified-attested-content-only` only after fresh offline cryptographic verification of both the
actual archive and the exact canonical content record. Its qualification/release acceptance,
compiled-source, runtime and retirement flags remain false. No existing consumer invokes this API.
There is no JSON-result import, environment bypass, CLI mock flag or fallback to unsigned integrity.

The trust request is selected independently by the operator/reviewer. Never load its trust anchors
or expected digests from the artifact, producer record, bundle or a producer-supplied verifier
transcript. The request contains four closed objects:

- `policy`: exact v0.6.0/repository/issuer/predicate, SHA-pinned reusable signer workflow URI and
  revision, caller source SHA/ref, immutable repository/owner IDs, exact initiating workflow URI and
  allowed trigger (`workflow_dispatch` or `push`). The signer URI ends in its full commit SHA; the
  caller workflow URI ends in its selected ref, with its separate full commit pinned. Real IDs and
  reviewed workflow/tool/root pins must be independently resolved before actual use. None are
  invented or installed as an active allowlist here.
- `expected`: independently selected application commit/tree/source-manifest digest, archive and
  record name/length/SHA256, and exact **signer caller run** ID/attempt as positive decimal strings.
- `files`: separate canonical local archive/record paths and one selected local multi-subject bundle
  with its independent length/digest. Both subjects must be in the same attestation.
- `verifier`: native Linux `gh` executable path, exact reviewed version and SHA256; independently
  selected custom trust-root JSONL path/length/digest; and an existing empty, canonical, user-owned
  mode-0700 configuration directory. No key, token or credential is created by this implementation.

The application source and the certificate source are different axes. An isolated signer running
trusted tooling B can attest bytes claiming application A. The certificate's source digest
identifies its trigger context B; it does not establish that A was checked out, compiled or
executed. Source bridge, independent source/package association and all later qualification checks
remain necessary.

## What is verified

The backend hashes actual single-link regular files with bounded stable descriptor/path/identity
checks, invokes the exact pinned native `gh`, and rehashes inputs after version check and
verification. Archive bodies are streamed (at most 2 GiB); canonical record bytes are captured only
up to 1 MiB. Bundles/output are bounded to 16 MiB, roots to 4 MiB and the executable to 256 MiB.
Commands have 30-second timeouts and bounded diagnostics. Selected config must be empty/private and
unchanged. The child environment is an explicit allowlist with isolated config/home/cache paths; no
caller GitHub token, agent socket, plugin/config setting or PATH is inherited. There is no signing
command.

Fixed verification arguments include local `--bundle`, `--custom-trusted-root`, exact `--repo` and
`--cert-identity`, fixed issuer/host, pinned signer/source digests/ref,
`--deny-self-hosted-runners`, SHA256, the explicit content predicate type and JSON output. Custom
roots and local bundle select upstream's offline path, avoiding default API/TUF discovery; this is
not an OS egress sandbox. Only fresh successful stdout from that invocation is parsed. Supplying a
saved or producer-created `verificationResult` JSON file cannot substitute for execution. Missing
tools/roots, unsupported versions, failed execution, malformed output or observed input changes
refuse.

The policy requires exactly one verified attestation per invocation and exactly two uniquely named
SHA256 subjects: the selected archive and record. It separately verifies each actual local subject
against the same bundle and requires the same complete verification result. Missing/extra/duplicate
subjects or ambiguous multiple attestations refuse. Record bytes must match the independent digest
and the exact fixed-field-order UTF-8 `JSON.stringify` encoding plus LF; duplicate members,
alternate encodings, BOMs and malformed UTF-8 refuse. The record's archive/application values must
match the independent expected selection. Its four bounded `producerClaims` strings remain claims.

Only modern `verificationResult.signature.certificate` fields supply platform identity:

| Certificate field                                       | Required policy relationship                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `issuer`                                                | Exact GitHub Actions OIDC issuer                                            |
| `subjectAlternativeName`, `buildSignerURI`              | Complete SHA-pinned reusable signer workflow URI, exact equality            |
| `buildSignerDigest`                                     | Exact reviewed signer commit                                                |
| `runnerEnvironment`                                     | Exactly `github-hosted`, describing the signer job only                     |
| `sourceRepositoryURI`, identifier, owner URI/identifier | Exact repository URI plus independently pinned immutable IDs                |
| `sourceRepositoryDigest`, `sourceRepositoryRef`         | Exact trusted caller trigger source SHA/ref                                 |
| `buildConfigURI`, `buildConfigDigest`, `buildTrigger`   | Exact initiating workflow identity, revision and selected allowed trigger   |
| `runInvocationURI`                                      | Exact repository/run ID/attempt URL from the independently expected context |

A nonempty bounded `verifiedTimestamps` array must contain independently verified `Tlog` or
`TimestampAuthority` timestamps; `CurrentTime` is not an independent authority and is refused.
Deprecated workflow fields, predicate values, artifact names, environment strings and producer
assertions cannot fill missing certificate facts. The predicate may contain arbitrary signer claims;
it is never promoted into a GitHub-issued fact. Certificate fields and verified timestamps are
accepted only behind the real cryptographic verifier boundary, not because JSON names them that way.

`uploaderJob` is always `{status:"unknown",jobID:null,...}`. The supported certificate authenticates
the signer workflow/caller run and attempt, not the job that uploaded an artifact. `github-hosted`
does not prove which runner built/uploaded the archive. The artifact API exposes workflow-run
association and digest, not an authenticated uploader-job ID. Producer build/job/run assertions stay
under `producerClaims`, even if they happen to equal platform values. No SLSA build-level or
compiled-source claim is made by signing these data.

## Signer isolation and exact permission decision still required

No file under `.github/workflows/`, repository permission or credential changed in this patch. The
future workflow must be frozen and independently reviewed before any permission action. Merely
moving signing into a later step of the untrusted build job is insufficient: job permissions cover
all steps. The proposed concrete topology is:

1. Keep `linux-portable.yml`'s build/producer execution unprivileged (`contents: read` only, as
   now), without OIDC or attestation-write permission. Its data/claims remain untrusted input.
2. Add a distinct caller job, proposed ID `attest-content`, after the selected artifact-producing
   job, calling a separate reusable signer workflow proposed at
   `.github/workflows/attest-content.yml` using an exact reviewed full commit SHA. Use a fresh
   hosted runner in the called workflow. Do not inherit producer secrets, environment, workspace,
   credentials, caches or processes.
3. Download selected artifact/bundle/records strictly as DATA using independently selected IDs and
   digests. Run only reviewed pinned verification/canonicalization tools from the trusted signer
   source. No downloaded/producer script, package lifecycle, npm/build, application/helper, archive
   executable or caller-provided command/action may execute in the signer job. Do not extract
   content as code into the tooling path. All checkout/download/attest actions and tools require
   exact reviewed commit/executable digests. Do not use mutable action tags as trust pins.
4. Sign exactly the two selected content subjects with the explicit custom content predicate. Make
   no built-by/source/runtime/retirement assertion beyond observed association with these bytes.
   Reject PR/untrusted ref/event contexts and caller-controlled code execution. Preserve failure
   evidence; do not add cancellation/cleanup that violates retained ownership obligations.

The **exact future permission additions**, scoped only to the caller reusable-workflow job and its
called signer job, are:

```yaml
permissions:
    contents: read
    actions: read
    id-token: write
    attestations: write
```

`id-token: write` is the OIDC signing-identity authority. `attestations: write` permits persistence
of attestations in the repository; `actions: read` is for reading the selected artifact data.
`contents: read` is for trusted pinned source. Both caller and called workflow must allow the
delegated job's permissions; no workflow-wide grant is proposed. No `contents: write`,
`packages: write`, repository secret, PAT, long-lived signing key, publish/deployment permission or
build-job grant is needed or approved. The distinct caller/called job changes, exact complete
workflow/action/tool/root/source pins, selected artifact/run/attempt and storage effects must be
presented together for separate action-time approval. This document is the permission change
specification, not an activated workflow or approval.

A same-workflow `needs` relationship may associate jobs with a run, but does not authenticate which
job uploaded specific bytes. A separate signer workflow's certificate identifies its own caller run;
never relabel it as an earlier build run. Offline URI/name checks cannot detect repository rename or
name reuse; immutable certificate repository/owner IDs remain mandatory.

## Preserved gates and limits

Existing Linux private/published unsigned consistency validators, committed-source bridge, archive
member census/descriptor/tree/byte binding, retained ownership/retirement restrictions,
source/runtime profiles and unconditional release-producer block are unchanged. Historical
cleanup/retirement gaps remain open. The alternative policy result cannot supply those facts or
waive any failed gate. Reviewed per-GC policies/calibration, full product coverage, at least 30
minutes and 100 measured cycles per GC mode, runtime/loader/native-addon identity, normal exit and
actual cleanup/retirement remain held where previously required. No CI dispatch, package, product,
real soak or publication was performed to develop this source.

Pre/post observations do not establish an atomic snapshot or confinement against a malicious
same-UID process that swaps and restores paths. Signer isolation is therefore an operational
prerequisite to review in the pinned workflow, not a certificate inference. Local verification
presently supports Linux only. Real crypto integration remains unperformed here: installed `gh`
2.46.0 lacks attestation support; a reviewed pinned `gh` 2.x (minor 102 or newer) and selected trust
roots/bundles are still missing. No new cryptographic implementation, credential, signature or
attestation was fabricated to replace them. Tests exercise actual hashes/schema/policy logic and
fixed verifier behavior with source-owned fake filesystem/executor or a VM backend seam; synthetic
positives are not genuine release evidence.

## Authoritative references reviewed

- [GitHub CLI verification contract and authority boundaries](https://cli.github.com/manual/gh_attestation_verify).
- [Workflow identity-prefix advisory, fixed in gh 2.102.0](https://github.com/cli/cli/security/advisories/GHSA-wjmr-j3rp-mh2g).
- [Pinned Sigstore certificate summary](https://raw.githubusercontent.com/sigstore/sigstore-go/v1.4.0/pkg/fulcio/certificate/summarize.go)
  and
  [extension fields](https://raw.githubusercontent.com/sigstore/sigstore-go/v1.4.0/pkg/fulcio/certificate/extensions.go).
- [Pinned Sigstore verification result and timestamp types](https://raw.githubusercontent.com/sigstore/sigstore-go/v1.4.0/pkg/verify/signed_entity.go).
- [Fulcio OIDC extension mapping](https://raw.githubusercontent.com/sigstore/fulcio/main/docs/oid-info.md).
- [GitHub reusable-workflow identity](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows).
- [GitHub attestation permissions and reusable workflows](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/increase-security-rating).
- [GitHub artifact API schema](https://docs.github.com/en/rest/actions/artifacts).

The bounded descriptor reader accumulates the first four ELF magic bytes across short reads.
Malformed or truncated magic still fails even when the selected file digest matches; complete size,
hash, metadata, recheck and close requirements remain unchanged.
