# Verifier and trust-root admission for attested content

Original source-only research snapshot: 2026-11-05; later acquisition reconciliation is recorded in
[verifier-custody.md](verifier-custody.md). Statements below about unobserved bytes describe that
original research step, not the later quarantined acquisition. This prepares an admission decision;
it does not install, execute or admit software. No binary, package, attestation bundle, TUF
metadata, trust-root target or product artifact was accessed. Public release metadata, documentation
and pinned source were inspected. The new pure inspector always returns `executionAllowed:false` and
`artifactAccessAllowed:false`, including when every selected field is present. A JSON plan is never
an execution capability.

## Concrete verifier candidate

Pin **gh v2.103.3**, source commit `63837fb778d6a39f02be0ce76ff89f2bc8d74bdc`. The official release
was published 2026-10-26 and is marked latest and immutable in the research snapshot. No published
LTS/maintained-minor matrix was established. The earlier minimum v2.102.0 addresses known
signer-path/source-ref matching defects; it is not admission of an open-ended version range. A
newer/different release needs a new review.
[Release](https://github.com/cli/cli/releases/tag/v2.103.3),
[security policy](https://raw.githubusercontent.com/cli/cli/v2.103.3/.github/SECURITY.md).

These are **published package digests**, not authenticated local observations or native executable
hashes. The inspector supports the corresponding package names as review selections only:

| Package                         | Official metadata SHA256                                           |
| ------------------------------- | ------------------------------------------------------------------ |
| `gh_2.103.3_linux_amd64.deb`    | `e3bafef96328d1a67de3a968bdfe1cc2ffd58cf6aba8b5e201356897ed06bb3d` |
| `gh_2.103.3_linux_amd64.tar.gz` | `4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d` |
| `gh_2.103.3_linux_arm64.tar.gz` | `ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63` |

[Official asset metadata](https://github.com/cli/cli/releases/expanded_assets/v2.103.3). No asset
link was opened. Exact native `gh` SHA256, package byte lengths, numeric release/asset IDs and local
architecture compatibility remain unobserved. Automatically generated source archives are not proof
of binary equivalence. The release workflow/packaging instructions do not establish reproducibility.

Prefer a staged Linux x64 bootstrap: authenticate official signed APT/package metadata with an
already trusted verifier and independently approved PGP anchor, obtain the exact selected `.deb`,
check its authenticated digest, and perform bounded extraction without installation or maintainer
scripts. Pin the extracted native binary's actual bytes separately. Official Linux documentation
publishes fingerprints `2C6106201985B60E6C7AC87323F3D4EA75716059` and
`7F38BBB59D064DBCB3D84D725612B36462313325`; those published strings still need an accepted
independent anchor. No host keyring, package source or trust-store change is proposed.
[Official installation source](https://raw.githubusercontent.com/cli/cli/v2.103.3/docs/install_linux.md).

Alternatively, an independently admitted Sigstore-capable verifier and authenticated trust roots can
verify the official immutable release/build attestation covering the selected archive. A candidate
binary verifying its own download is circular. A matching checksum from the same unauthenticated
download channel is insufficient. These routes require separate provenance receipts, not a
`verified:true` field. The selected package and receipt must describe the same delivery route; a
signed `.deb` does not by itself authenticate a different tar archive.
[Immutable release integrity](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity).

## Exact offline behavior and trust material

For v2.103.3, local `--bundle` avoids attestation API retrieval/authentication, and
`--custom-trusted-root` constructs custom verifiers before automatic TUF initialization. This
selects an offline verification path; it does not enforce an OS network sandbox. The isolated
configuration/host, complete certificate identities and two-subject policy from the
[attested-content contract](attested-content-provenance.md) remain mandatory. A custom-root file
therefore needs its own authentication/freshness admission before use.
[Versioned verifier](https://raw.githubusercontent.com/cli/cli/v2.103.3/pkg/cmd/attestation/verify/verify.go),
[custom-root implementation](https://raw.githubusercontent.com/cli/cli/v2.103.3/pkg/cmd/attestation/verification/sigstore.go).

Stable v2.103.3 pins sigstore-go **v1.3.0** and go-tuf **v2.4.2**. Its root parser accepts
`application/vnd.dev.sigstore.trustedroot+json;version=0.1`; the newer protobuf schema spelling must
not be presumed compatible. The JSONL reader requires final LF. Reject unsupported/ambiguous roots
rather than silently selecting or merging another issuer. Existing certificate-field and timestamp
checks remain valid; old trunk references were not evidence of the stable dependency set.
[Dependencies](https://raw.githubusercontent.com/cli/cli/v2.103.3/go.mod),
[stable parser](https://raw.githubusercontent.com/sigstore/sigstore-go/v1.3.0/pkg/root/trusted_root.go).

Distinguish three records:

- TUF bootstrap `root.json`: independently trusted role keys/thresholds, never bootstrapped by an
  arbitrary downloaded hash alone.
- Authenticated TUF metadata and `trusted_root.json` target: signed chain, target hash/length and
  version/freshness state. Public-good mirror is `https://tuf-repo-cdn.sigstore.dev`; GitHub's
  mirror is `https://tuf-repo.github.com`. Select allowed instances from independently established
  repository visibility and policy. Do not add an unrelated authority as fallback.
- Exported `trusted_root.jsonl`: CA/log/TSA key material transformed by the pinned exporter. Bind
  exact target metadata and bytes to exact exported bytes, instance order and conversion receipt.
  Raw target and compact JSONL hashes need not be equal. The exporter refreshes its TUF clients with
  cache validity zero; that alone does not authenticate its initial bootstrap.

[Versioned exporter](https://raw.githubusercontent.com/cli/cli/v2.103.3/pkg/cmd/attestation/trustedroot/trustedroot.go),
[GitHub TUF setup](https://raw.githubusercontent.com/cli/cli/v2.103.3/pkg/cmd/attestation/verification/tuf.go).

Current deployed bootstrap keys, quorum sizes, versions, expiry times, target bytes and root/export
hashes remain **unknown**: this task did not access live trust material. Do not fill them from a
sample or documentation schedule. The original checked-in example retained `null` for these facts.
It now records the historical acquired observations described in
[verifier-custody.md](verifier-custody.md), with six remaining fields still null; this does not
establish current admission. Its selected floors (root14, others0) do not establish authenticated
persisted rollback history; its public-good instance is a proposal pending independent
repository-visibility selection.

## Update, expiry and revocation decision

The currently published TUF specification is 1.0.37. A future trusted validator must verify the
continuous root chain, each N+1 transition under old and new quorums, final-root validity, all role
thresholds/expiry and referenced version/hash/length constraints. Keep prior trusted version floors;
a new empty cache does not establish rollback history. Expired intermediate roots can participate in
a valid update chain, while the admitted final metadata must be fresh. The pure inspector checks
only the _selected_ final-role versions/expiry; it does not implement TUF cryptography or
delegations. [TUF specification](https://theupdateframework.github.io/specification/latest/).

GitHub says the offline export has no built-in global expiration and cannot reveal revocation that
occurs after export. Regenerate and authenticate roots whenever importing new signed material.
Successful old offline verification therefore does not establish current revocation status.
Historical certificate/key validity at an independently verified signing timestamp is a separate
question; do not reject a valid historical signature merely because the leaf certificate is expired
now.
[Offline update guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline),
[Sigstore timestamps](https://docs.sigstore.dev/cosign/verifying/timestamps/).

This proposed local review policy caps an offline admission lease at **24 hours**. This is an
application policy choice, not an upstream guarantee. Lease end must be no later than the earliest
of the authenticated metadata expiry, root export time plus 24 hours and current security-review
time plus 24 hours; it must cover the whole operation. Refresh advisory/denylist knowledge at
import/use. Any known compromise, unsupported root schema, revoked selected key/identity/content,
stale review, clock uncertainty, rollback or expiry blocks new use. Preserve old evidence and record
the new refusal; never rewrite a prior result into current acceptance. An unavailable update channel
outside a valid bounded lease cannot be waived with cached data or an ignore-expiry switch.

The model rejects denied selected SHA256 references, including metadata and evidence/owner/request
references. This does not replace independently authenticated key/identity/time-range revocation
handling. `revocationStatus` stays `not-established` even for a complete consistent model. Offline
operation cannot prove absence of a change after its last authenticated snapshot.

## Process retirement and live-path block

The prior fallback's `execFileSync` timeout can send SIGTERM and still wait indefinitely; output
limits can also terminate the child. It blocks the event loop and does not prove descendant or stdio
retirement. The 30-second value was a nominal model setting, not a hard elapsed-time guarantee.
[Node 24.22 API](https://raw.githubusercontent.com/nodejs/node/v24.22.0/doc/api/child_process.md).

The real filesystem and child-process imports/defaults are now removed. A default call to
`verifyLocalAttestation(request)` throws before request cloning, filesystem access or execution:

> Live verifier blocked: independent binary/root admission and owned process retirement unavailable.

Both own filesystem and executor ports must be supplied directly in source for unit-model use.
Request JSON, inherited ports, environment, CLI flags or the admission-plan output cannot enable a
live backend. Production `verifyAttestedContent()` passes the request alone and consequently remains
blocked. No old runtime path silently falls back. The plan inspector has no IO/process imports.

A future asynchronous owner must bind exact request/tool/root/bundle/subject/config identities,
command arguments/environment and an operation nonce. It must retain descriptors/process/listeners
on uncertainty. Four sequential commands maximum (version and verify for each subject), no retries,
30-second work allocation and 5-second close reserve per command, within a proposed **180-second**
whole-operation observation budget including file reads, are review requirements—not implemented
wall-clock enforcement or permission to kill. Proposed output caps are stdout16MiB and stderr1MiB.
The model fixes `owned-no-signals`, an empty signal list, and retain-custody/no-retry on
uncertainty.

Actual spawn, normal exit0/null signal, stdin/stdout/stderr closure and independent descendant
retirement evidence are required before advancing. PID disappearance, code0 alone, a kill return
value or a dispatched signal is insufficient. At deadline/overflow/error/missing close, hold and
invalidate; do not infer retirement, detach/unref, retry or clean up. Existing `observeOwnedChild`
has default termination behavior and cannot be reused unchanged as a no-signal owner. Any later
TERM/KILL/process-group policy requires exact separate authority; no such signal is authorized now.
A pure model or JSON lifecycle record does not implement custody or prove real retirement.

## Minimum later action-time approvals

No approval is requested or inferred by this source preparation. To progress later:

1. **Acquisition/bootstrap only:** approve retrieving the exact selected official package and its
   bootstrap verification metadata/public keys plus selected TUF bootstrap/chain/targets. Specify
   destinations, byte bounds, approved independent anchors and already trusted validator/reader.
   Permit bounded safe extraction/hash observation without installation, maintainer scripts,
   candidate execution, host keyring changes or credential creation. Any validator subprocess needs
   its own reviewed custody implementation first. Record actual package/native/root digests and
   authenticated chain receipts; their values remain unknown today.
2. **Exact verifier operation:** after those facts and an independently reviewed source-owned owner
   exist, approve the exact native binary hash, local archive/record/bundle/root/config paths and
   digests, four arguments/environment-bound operations, deadlines/output bounds and retained
   custody/no-signal policy. This approval includes subject artifact access, currently prohibited.
   Stop if the reviewed facts, revocation window or source changes.

Offline verification needs no GitHub credential, signing permission or CI dispatch. Future signing
OIDC/attestation grants remain a different decision under the prior permission specification; no
such grant is bundled here. All source/archive/runtime/retirement/product-measurement/publication
obligations remain held. No executable or root has been admitted by this plan.

## Action-time requirements, distinct from selection completeness

`inspectVerifierAdmission` now reports eight fixed `unverifiedRequirements` even when all nineteen
selection observations are present. This inspector does not authenticate those requirements and
cannot clear them through JSON claims. Live execution remains disabled. Six selection fields remain
null in the acquired record; these implementation blockers are separate from that field count.

GitHub recommends fresh trust material for each intake; an export has no global expiry or knowledge
of later revocations. A local 24-hour ceiling neither establishes refresh for this intake nor
promises a safe reuse interval. With a custom-root file, the pinned CLI reads that file instead of
refreshing TUF; verification success cannot refresh its own trust input.
[GitHub offline guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline),
[pinned CLI implementation](https://raw.githubusercontent.com/cli/cli/63837fb778d6a39f02be0ce76ff89f2bc8d74bdc/pkg/cmd/attestation/verification/sigstore.go).

TUF requires sequential root updates authenticated under old/new thresholds, rollback and expiry
checks, and durable trusted metadata. Persist the authenticated state, not merely user-selected
version floors. The acquired chain does not establish subsequent persisted update history. This
change implements no TUF client, metadata deletion, cache writing or automatic trust update.
[TUF client workflow](https://theupdateframework.github.io/specification/latest/#detailed-client-workflow).

Offline name matching cannot distinguish a replacement repository reusing the same name. Existing
`attested-content-policy.mjs` already compares the verified certificate's numeric repository and
owner IDs to independently selected expectations; its existing missing/foreign-certificate cases
cover both fields. The inspector cannot authenticate that selection, so numeric repository identity
remains an explicit prerequisite rather than a new claimed result.
[Numeric identity guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline#confirming-the-repository-in-an-offline-environment).

The selected 2.103.3 is newer than the published fixes for signer-workflow prefix matching
(2.102.0), source-ref case matching (2.102.0), and predicate-mismatch exit status (2.67.0). This
limited advisory comparison is not a universal security clearance, revocation snapshot or new
admission lease. The last advisory's affected-version display is open-ended; its explicit fixed
version supplies the resolution rather than an invented upper bound.
[Workflow advisory](https://github.com/cli/cli/security/advisories/GHSA-wjmr-j3rp-mh2g),
[source-ref advisory](https://github.com/cli/cli/security/advisories/GHSA-4mq3-hpgx-9cx8),
[exit-status advisory](https://github.com/cli/cli/security/advisories/GHSA-fgw4-v983-mgp8).

The remaining fixed prerequisites are current security/revocation review, an explicit bounded
admission lease, identity-preserving native custody, independently observed process retirement, and
exact request/explicit execution authority. Existing package/storage, artifact-access, native/DUT,
spending and publication holds are unchanged. No fixed byte/age/version alone satisfies them.
