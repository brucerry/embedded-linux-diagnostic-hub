# Windows front door and Linux P2 milestone

Completed bounded outcome: seven-file windows-setup-frontdoor-review.json/.patch and separate
two-file linux-p2-integration-review.json/.patch. Ordinary npm run verify passes: 354 tests, 342
passed, zero failed, 12 platform skips. Log/result: windows-frontdoor-and-linux-p2-verify.log and
windows-frontdoor-and-linux-p2-verify-result.json.

The actual Windows download-run.ps1 now selects the same pinned release's setup, descriptor and
checksum, verifies source/version/architecture/hash/size, and requests the ordinary reviewed wizard.
Original -Version/-Directory cache semantics/-DownloadOnly portable behavior remain; -Portable,
-SetupDownloadOnly, -NoLaunch and -InstallDirectory make choices explicit. Strict JSON, HTTPS-only
bounded streaming, native ancestor/file identities, exclusive cache writes/non-overwriting moves,
sealed read locks and declared-only cleanup are implemented. No installation consent is passed.
Setup exit zero is not application readiness. The PowerShell 5.1 full-helper fixture covers 28 cases
with fake HttpClient and intercepted Start-Process; a separate actual -NonInteractive process
refuses before network/launch. Six descriptor tests plus the two helper wrappers pass (8/8). The
legacy-child PSModulePath correction is child-only and evidenced by
windows-powershell-modulepath-probe.json. NSIS /D argument placement follows
https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage; actual native prefill/held-file
compatibility remains unqualified.

Linux P2 fixes: ln -T -- refuses a target directory inserted after the guard without creating a link
inside it. Every fetched metadata document is validated independently. Checksum-only fallback
accepts only empty/missing HTTP 404/410 documents; denied, partial or damaged responses stop. Three
focused tests pass, zero skipped: linux-reviewed-p2-tests.log. Native Linux execution remains
unqualified. Prior MSYS fixture/retirement-test fixes were accepted separately.

No process is stalled or left running. No denied Windows action was retried, no real
installer/program was executed by these tests, no NSIS compilation, dependency install, host-policy
change, physical-port access, push or publication occurred. Main and user live-test hash remain
preserved. No release catalogue/workflow adoption is included yet.

Permanent Linux AppDir is deliberately separate and NOT complete. A first unfinished generalization
draft of setup-transaction.ts/setup-paths.ts is saved under
C:/Users/bruce/Desktop/Codex/2026-10-13/task/linux-appdir-draft with status.json and its editing
script. Both repository files were restored byte-for-byte from their exact pre-draft copies, so the
reviewable tree matches the completed milestone. No AppDir worker/helper/lifecycle integration is
claimed. The two agreed Linux layouts mean complete-folder/AppDir from the existing tar.gz and
managed use of the existing AppImage, not extra distro/package variants. AppDir is the next
implementation priority; managed AppImage startup remains refused.

Remaining native gates: real Windows helper/setup
CLI/cancel/install/launch/profile/integration/rollback and new compiler descriptor emission;
current-source native Mac/Linux GUI/TTY/policy qualification; permanent Linux implementation and
final release catalogue/docs/workflow adoption. Native application readiness is not established by
mocked launches.

Windows native install/launch remains automatically denied despite forwarded implementation
approval. Direct confirmation for the isolated action is requested and pending; no retry or
alternate route occurred.
