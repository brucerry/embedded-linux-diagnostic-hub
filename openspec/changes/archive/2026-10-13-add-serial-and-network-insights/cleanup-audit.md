# v0.4.0 cleanup audit

On 2026-10-13, pre-feature dist, dist-electron, dist-gateway, dist-web, dist-site and test-results
trees were moved to C:/Users/bruce/Desktop/Codex/2026-10-13/task/v040-cleanup-quarantine.
inventory.json records source/destination/count/size. These outputs are rebuilt by maintained
scripts; nothing was permanently deleted. Restore by moving the quarantined tree back only when its
repository destination is absent, or after separately preserving newer output.

Preserved: release/ (published-package copies), all tags/history, archived OpenSpec, .codex
qualification images/logs and recovery evidence, installed dependencies, all tracked source/tests
and the separate live.spec.ts edit. Only current feature source is untracked outside ignored output;
it is retained.

Review candidate: .github/workflows/release-recovery.yml hardcodes v0.4.0 and its qualified original
SHA. It remains manual/guarded and was left untouched because removal affects active recovery
tooling and useful tests. scripts/release-recovery-check.mjs, scripts/lib/release-recovery.mjs and
associated fixtures remain useful provenance. No workflow/script removal was performed.

Retained reusable tooling: release-note-format.yml and format-release-links.mjs enforce explicit
tag/body-hash authorizations and support reviewed historical formatting. Published-release
verification and general release/draft tools remain current. No historical v0.4.0 references were
blindly removed.

Reviewable retirement patch: review/retire-v040-recovery-workflow.patch deletes only the hardcoded
historical workflow. It is intentionally not applied. Rationale: v0.4.0 is already published and
qualified; the workflow is tied to its original source/private-draft recovery. Preserve reusable
recovery libraries/tests and all assets/tags/history. Applying the patch requires review of active
workflow retirement; the patch can be discarded without changing the checkout.
