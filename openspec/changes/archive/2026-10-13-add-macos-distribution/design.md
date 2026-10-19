# Design

## Context

See proposal.md. Mac CI already builds full ad-hoc .app directories and verifies architecture,
signature, icons, ASAR/source bytes, packaged SSH and 100 native cycles. Release publication currently
requires Windows, Linux/seven GNOME and website artifacts; shell downloading is Linux-only. Local
OpenSpec is private and the user has a separate four-line live.spec.ts edit.

## Goals / Non-Goals

**Goals:** Reuse qualified native app bytes, verify a complete archive after extraction, offer a
Bash 3.2-compatible Mac installer with built-in OS tools, and preserve existing-platform behavior.
**Non-Goals:** Developer ID/notarization, Rosetta/system-package installation, Gatekeeper changes,
in-app Mac automatic upgrades, SteamOS and physical/quarantined-browser-download acceptance claims.

## Decisions

- **Full bundles and provenance:** Produce Diagnostic-Hub-macos-x64.zip and arm64.zip using ditto
  to preserve bundle links/resources. Each has a SHA-256 sidecar and macos-build-info-<arch>.json
  containing version, source, architecture, bundle identifier, minimum OS, archive and ASAR hashes,
  ad-hoc integrity and explicit non-notarization. Extract and re-run the existing bundle verifier.
  Publishing a bare executable would omit required Electron frameworks and resources.
- **Mac helper:** Add public/download-run-macos.sh; keep the Linux script unchanged. Use native
  Bash 3.2, curl/plutil/shasum/ditto/codesign/lipo/open and lsof, without Python/Node installation.
  Prefer physical arm64 hardware even from translated terminals. Resolve one stable/exact tag and
  fetch all checksum/manifest/archive files from that tag with HTTPS restrictions.
- **Replacement transaction:** Default to ~/Applications. Normalize/reject unsafe targets, privately
  stage on that volume, preflight ZIP roots/link targets, verify extracted identity/OS/architecture/
  codesign/ASAR, and refuse replacement of a running app. Move an existing bundle into an owned
  backup, then atomically move the verified bundle into place. Interrupt/failure restores the old
  bundle; no userData directory is removed. --no-launch supports manual installation. On launch
  refusal restore the old bundle if present; a fresh verified install remains for explicit platform
  approval. Never run xattr removal, spctl disabling or sudo.
- **Shared qualification:** Extract existing Mac build/check steps into a composite action used by
  the read-only main workflow and a separate release Mac workflow. Preserve all browser/native/
  SSH/clock/reset/trust assertions and original deadlines; test the actual archive and helper,
  then run packaged smoke and 100 cycles using the helper-installed app.
- **Zero added Mac Actions storage:** Standard public macos-15/intel runners remain guarded.
  A new-tag draft is created only after tag/version validation; Mac jobs attach only their
  architecture-specific verified ZIP/sidecar/manifest using the existing GITHUB_TOKEN with
  job-scoped contents:write. Main jobs remain contents:read. No Mac upload-artifact or cache is
  added. Official Releases docs have no total storage/bandwidth quota and files are below 2 GiB;
  REST docs limit draft listings to push access. Explicit anonymous metadata/download checks
  enforce privacy. Alternatives: persistent Actions artifacts have an unverified account allowance;
  publishing files early would expose partial distributions.
- **Final publication:** The publisher depends on all platform gates, downloads Mac draft files
  authenticated without printing signed URLs, merges existing Windows/Linux/web artifacts,
  recomputes every hash and source manifest, generates four-section notes since published v0.3.1,
  attaches the remaining files and changes only the verified new draft to published/latest.
  Guard every mutation against a published or mismatched-source release.
- **Actual public-command check:** Add dependent post-publication Mac jobs to the same workflow
  (GITHUB_TOKEN-generated release events do not reliably start another workflow). They stream the
  published helper through the documented one-line pipeline with controlled profile/directory
  arguments, check the real launch via CDP and run installed packaged smoke. CLI downloads are
  explicit CI evidence, not Safari-quarantine or managed-device acceptance.

## Risks / Trade-offs

- Ad-hoc distribution can be blocked by Gatekeeper/MDM -> explain trust limits and explicit
  user/administrator approval; no automated bypass, no claim of trusted notarization.
- Interrupted replacement or malicious archive structure -> private same-volume stage, preflight
  path/link rejection, codesign/source verification, rollback and focused failure controls.
- Draft visibility or partial upload -> source/tag/draft guard, anonymous 404 verification,
  complete-asset checks and publish only after all required producers pass.
- Mac-only utilities cannot be executed on Bruce's Windows host -> test portable validation locally
  and real bundle/helper behavior in both existing free native CI architectures before tagging.
- Published-command failure -> preserve public immutable release, diagnose actual evidence and
  report a verified defect/version decision rather than silently overwriting it.

## Migration Plan

Prepare v0.4.0 version/docs and focused checks; qualify one exact main source across all platforms;
create a new annotated tag only after success. Keep v0.3.1/v0.3.0/v0.2.0 unchanged. Failed tag gates
leave only a private draft. After publication verify all 24 assets (10 payloads/10 sidecars/4 manifests),
latest metadata, source identity, one-line commands and old-release preservation; then sync/archive
the new private change. No package version change in dependencies.


## Immutable-tag recovery after documented draft discovery failure

The v0.4.0 tag remains at b0f94d7d49d36fecc97b87d516724280d840e727. Its first tag run passed all twelve non-Mac gates and both full Mac app/installer/SSH/100-cycle qualifications, then failed only while looking up a draft through the published-only tag endpoint. Publication remained skipped and the draft stayed private.

Corrected operational source uses authenticated paginated listing and stable-ID reads with the same tag/commit/body ownership and draft assertions. Privacy requires a public published-release JSON 200 control, anonymous actual draft-ID 404 and each actual asset URL 404; the published-only tag endpoint is not draft-privacy evidence. Only confirmed quota responses may wait for the server reset/Retry-After within bounded attempts/time. Ambiguous responses fail closed.

Recovery run 38348257545 completed both full native app/installer/SSH/100-cycle qualifications and uploaded all six Mac files. Intel staging passed; ARM failed after successful uploads because a redundant tag probe returned 403. A read-only diagnostic later demonstrated exhausted anonymous quota (60 requests/hour, remaining zero, reset 2026-10-13 05:38:52 UTC), including on the public positive control, while all six actual asset URLs remained 404. This does not retroactively identify the lost original response body.

Operational source 92e7c6126c64807727d72363cc3c50e12ad23864 pins the existing draft ID 411238491, all six asset IDs/sizes/digests and both archive hashes from the completed native logs. It validates original exact-source gates/artifacts and native run provenance, requires all thirteen main jobs for the operational repair, downloads and rechecks existing Mac bytes/signatures/ASAR/source, repeats installer/SSH/100 cycles on both native Macs without repackaging, and reuses original tested Windows/Linux/web artifacts. Source-app and release-tooling SHAs are distinct and logged; no app/helper/version bytes are substituted behind the tag.

Fresh central privacy evidence passed in recovery 38352448204, job 115147744377, at 2026-10-13 05:39:03 UTC: published v0.3.1 ID 410956079 returned 200, actual draft ID 411238491 returned 404 and all six actual draft asset URLs returned 404. Final complete-file privacy passed at 06:01:31 UTC and the same guarded release ID published at 06:01:36 UTC with all 24 files. Independent downloads verified every asset digest, all ten sidecars, four source manifests, both ZIPs/plists/native executables/ASARs, exact tag-sourced helper bytes, four-section notes with three commits since v0.3.1 and stable/latest metadata. Prior v0.3.1/v0.2.0 release metadata/assets and all three prior tags remained unchanged; v0.3.0 remained unpublished.

Both original postpublication jobs failed before installer execution because tsx treated the TypeScript test as CommonJS and rejected fifteen top-level awaits. This is a test-harness defect, not an observed installer/app failure. Operational harness source 4c22b3b2f230ea098778c5df2de170e98159e4fb wraps the exact original statements in an async entry point; token comparison confirms all assertions/deadlines/imports are unchanged and local actual tsx execution reaches its macOS platform guard instead of failing transformation. A read-only follow-up verifies unchanged consumer bytes and public command/installed SSH on both native runners without packaging or republishing. Failed historical jobs are preserved; successful follow-up checks are recorded separately.

The first corrected follow-up observed ARM curl 403 without enough telemetry to classify it; Intel successfully downloaded/launched the app but its harness compared macOS's /private/var canonical executable path with the /var alias. Harness source 3b91a5ff4301cf1c119a24f0b19f226477a36044 canonicalizes the owned temporary directory with realpath, preserves every original assertion/deadline, and adds credential-free bounded native curl status/body/rate diagnostics with server-reset waits only for confirmed throttling. No consumer/helper/asset/tag bytes changed. Successful follow-up run 38355502298 passed ARM job 115157317255 and Intel job 115157316915: actual latest-helper pipeline, version/source/ASAR/native architecture, packaged visible app and renderer bridge, running-app update refusal and installed SSH/trust/clock/reset/unsupported updates. Both hosted systems were macOS 15.7.9. New diagnostics returned public metadata/helper 200s; they do not retroactively classify the earlier ARM 403. Quarantined browser, managed-device and older/physical-Mac acceptance remain outside observed evidence.

Only recovery evidence/artifact readers receive per-job Actions read access to the existing source run. Approved Contents write remains guarded to the owned unpublished release. No account settings, persistent credentials, paid runner or additional Mac Actions artifact/cache changes. The original failed run remains historical evidence; final acceptance records the unchanged app source, qualified operational source, original successful gates and successful recovery/published-command jobs separately.

## References

- https://docs.github.com/en/rest/releases/releases (draft listings require push access).
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api (anonymous quota and reset/Retry-After).
- https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases (asset limits).
- https://docs.github.com/en/billing/concepts/product-billing/github-actions (standard public runners).
- https://support.apple.com/en-us/102445 (trust and managed-device restrictions).
