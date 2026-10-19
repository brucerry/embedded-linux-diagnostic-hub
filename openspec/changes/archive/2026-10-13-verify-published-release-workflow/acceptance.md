# Acceptance evidence

## Qualified sources

The generic release-verification and authorized body-formatting implementation is c704c3292ae2d9985c8f6d8b66722d017e0cf2a6. The final readiness-only test correction is 0344878ad9b6d0fc54d53923b03771fea8d905f3. The published v0.4.0 consumer source remains b0f94d7d49d36fecc97b87d516724280d840e727; its annotated tag remains 7fd92c94d22420dbc3c8ab30c159205c6505f842.

## Actual verification

- Read-only release workflow audit 38367165010 succeeded, including all 24 public files and both native published-command checks. Original failed tag publication 38342913511 remains failed under the same workflow ID 376377429.
- Generic published Mac verification 38367164593 succeeded on Intel and ARM64. Latest stable is the default; explicit published tags resolve their own source and tagged command. Historical recovery remains manually triggered with its historical qualification pins.
- Reviewed body-only formatter 38367164508 succeeded. Current v0.4.0 release ID 411238491 has the reviewed body hash 6637e56c21604ddb1e92dac76162110783c24d11770518330999ac59db3e1216. All four Links labels are meaningful Markdown, with exact original destinations and all factual sections preserved.
- Final source main qualification has 13 successful jobs: Mac 38371359451 (ARM job 115208881103 and Intel job 115208881426), Windows 38371359510, Linux 38371359493 (build plus all seven GNOME jobs), website 38371359773.
- Both final Mac suites passed 97 browser tests with one existing skip, including the exact terminal containment test. Each architecture passed installation, packaged SSH/trust/update checks and 100 native window cycles.
- Actual dynamic badge titles at the exact original query-free endpoints are "Publish verified release - passing" and "Verify published Mac commands - passing". These report new audits; historical failures are preserved.

## Failure diagnosis and scope

The earlier Windows trace showed a blank page after react_jsx-dev-runtime failed with net::ERR_NO_BUFFER_SPACE. The unchanged affected test passed ten local repetitions; later ordinary required source pushes passed Windows qualification. A targeted Actions retry was denied by the integration. No alternative retry route or permission expansion was used.

The c704c32 ARM failure observed scrollY 350 versus 345. No original Mac trace artifact was retained. Controlled local checks reproduced 350 to 345 without wheel input as ending a 5px entry transform reduced document height from 1400 to 1395; the wheel control also drifted, while animation completion before geometry measurement eliminated drift. This is a reproduced mechanism consistent with the symptom, not proof of the unavailable original ARM trace.

The final correction adds only a readiness poll before geometry measurement. Every existing containment assertion and deadline remains unchanged. Ten local repetitions, typechecking and formatting passed before the single-file commit/push.

## Preservation and limits

Final readbacks preserve all 24 current release asset IDs, sizes, digests and timestamps; prior release bodies/assets; all four relevant annotated and peeled tag references; v0.3.0 remains unpublished. Only the reviewed current body presentation changed. Public API immutable is false; protection is policy and validation, not a claim of GitHub-enforced immutability.

The user's separate live.spec.ts edit remains unchanged and uncommitted. Remote main is the only branch; the removed diagnostic branch remains recoverable from its existing bundle. No further public changes or pushes are required.

Hosted macOS launch is qualified. Physical Mac, browser quarantine, managed-device and older-OS acceptance are not claimed; Developer ID/notarization is not claimed.

## Canonical closeout

Both canonical deltas were semantically synchronized and verified: one requirement added to macos-desktop-distribution and only Exact release page format updated. Authoritative purposes, all six prior Mac distribution requirements, the page comparison requirement, nine unaffected canonical raw hashes and Git exclusion were preserved. Strict validation passed all eleven canonical specs and the active change before archive. The change was archived as 2026-10-13-verify-published-release-workflow after the explicit user completion authorization. Task 1.5 was marked complete only after the archive move succeeded; all five tasks are now complete.

## Local evidence pointers

- C:\Users\bruce\Desktop\Codex\2026-10-11\task\final-main-0344878-acceptance.json
- C:\Users\bruce\Desktop\Codex\2026-10-11\task\final-release-preservation-0344878.json
- C:\Users\bruce\Desktop\Codex\2026-10-11\task\final-dynamic-badges-0344878.json
- C:\Users\bruce\Desktop\Codex\2026-10-11\task\arm-scroll-drift-investigation-checkpoint.json
- C:\Users\bruce\Desktop\Codex\2026-10-11\task\v040-meaningful-links-verified.json
