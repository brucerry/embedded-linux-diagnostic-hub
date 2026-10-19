# Design

## Context

The unfiltered release.yml badge reports failing, matching original v0.4.0 run 38342913511. v0.4.0 published via recovery 38352448204 (publication job succeeded), and corrected public checks 38355502298 plus all final main jobs passed at 3b91a5f. Those separate workflows cannot update release.yml.

## Decisions

- Preserve release.yml identity and all tag-push publication jobs; explicitly restrict publication entry to tag pushes.
- Add main-path/manual read-only audit jobs in that same workflow. Public metadata must be stable, non-draft, source-bound to the fetched tag and have the exact Mac-capable catalog. Download every file anonymously over HTTPS and compare actual bytes to API digests/sidecars/manifests; compare helpers to tag blobs and generated source notes.
- Audit locally in an owned temporary directory; no server mutation endpoint exists in the audit tool. Contents read is the only job permission.
- Feed verified tag/source/release ID into both existing native public command/installed SSH checks using a separate immutable source checkout and corrected current harness. No app packaging, upload-artifact or cache.
- Keep the README badge dynamic. Label release workflow health and separate published Mac verification; latest release link represents availability. Document that historical failed tag runs remain failed.
- Respect existing bounded native rate diagnostics, with optional verified release context rather than a hardcoded identity for the audit path.

## Risks and Validation

Mock malformed/private/missing/tampered catalogs and HTTP redirects; require only GET requests. Public HTTPS redirects must not carry a credential or be logged with signed queries. Verify source/helper/manifest/notes identity and real native launch; retain all assertions and deadlines. Confirm exact badge SVG and terminal release workflow, old metadata/tags, local user edit and deleted branch state. A successful audit is not a rerun or retrospective success claim for the original failed tag run.

## Accepted additional user scope

Latest stable is the normal generic default; explicit published tags resolve their own source and tagged command. The standalone Mac verification becomes version-neutral and reusable. Recovery retains its historical v0.4.0 source/gate pins but becomes manual-only with a historical generic label.

Current v0.4.0 body link formatting is explicitly authorized as a presentation exception. A separate Contents-write workflow accepts only reviewed tag/source/release ID and before/after body hashes, PATCHes body alone, and checks every asset identity/digest/timestamp. Verification jobs remain Contents-read and compare normalized link presentation, preserving all facts/destinations. Prior bodies and tags/assets remain protected.

Windows d850ce8 failed because Chromium could not download react_jsx-dev-runtime (net::ERR_NO_BUFFER_SPACE), leaving the traced page blank. The unchanged test passed ten local repetitions with its original five-second assertion. The connected integration denied a targeted Actions retry; no alternative retry route or permission expansion is used. The required follow-up source will receive ordinary Windows qualification.

## Additional final qualification correction

At c704c32, every workflow became terminal: actual release audit, generic native public verification, reviewed body formatter, Windows, Linux, website and Intel Mac passed. ARM Mac qualification failed the unchanged terminal page-scroll assertion (350 versus 345); no Mac trace artifact was retained, so the actual cause is not proven.

A controlled local entry-transform experiment reproduced 350 to 345 without wheel input as document height fell from 1400 to 1395. A follow-up reproduced five-pixel drift with wheel input, and waiting for main entry animation completion eliminated drift. This is a reproduced mechanism consistent with the CI symptom, not proof of the unavailable ARM trace.

Commit 0344878 adds only a readiness poll for main element's running/pending entry animations before scrollIntoView and geometry measurement. Every existing wheel containment assertion and deadline remains unchanged. Ten repetitions, typechecking and formatting passed. Normal main push qualification passed all thirteen jobs, including both native Mac architectures. No Actions-write permission bypass or targeted retry was used.

## Rollout

The consolidated generic/formatting scope is c704c32; the subsequent evidenced readiness-only correction is 0344878. All thirteen final source jobs succeeded, including native ARM and Intel qualification. Both capability deltas were synchronized with authoritative purposes and unaffected requirements preserved. Strict validation passed before archiving on 2026-10-13; task 1.5 was closed only after the move succeeded.
