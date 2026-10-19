# Foundation sealing and payload correction checkpoint

The independently reviewed P2s are corrected in an isolated five-file delta against the frozen foundation. This correction is ready for independent review and is not adopted.

- Native sealing streams and verifies every committed frame's CRC, observation sequence/ranges, byte/frame totals and receive-time provenance while the existing writer mutation ownership remains held. It rechecks the journal size and synchronizes/closes it before publishing complete metadata. Native reads share the same bounded verification routine.
- IndexedDB sealing verifies one frame at a time, including exact frame keys, CRCs, sequence/ranges and all aggregate metadata. Verification and complete metadata publication occur in the same readwrite transaction while writer/Web Lock ownership remains held. Missing, extra, corrupt or reordered blocks abort publication.
- The script budget remains 8192 UTF-8 bytes. The transmitted payload budget is separately 8194 bytes to preserve a valid maximum script followed by CR or CRLF. Tests cover none/CR/LF/CRLF, ASCII, multibyte UTF-8 and over-budget input.
- Same-length corruption and frame reordering make CaptureWriter.finish reject, retain incomplete evidence, and block a later command. The actual FlowRunner is exercised in the native regressions.

Qualification: 23 native/shared/broker tests pass; 50 browser checks pass across Chromium, Firefox and Windows Playwright WebKit, including all three >32-MiB captures/authenticated downloads, six new seal corruption/reorder cases, rich Markdown rendering and all 14 arming cancellation cases. Existing 120-second large-output deadlines are unchanged. Typecheck and focused formatting pass. Negative controls against an unmodified foundation reproduce all three new shared/native failures and both Chromium IndexedDB failures; these expected failures and traces are preserved.

Frozen patch: C:/Users/bruce/Desktop/Codex/2026-10-13/task/serial-fix-evidence/capture-seal-correction-review.patch
SHA-256: daaa847d40369dc2bc44836e426dc6c6e1c9828582573e35e471d6137fea4e96
Manifest: C:/Users/bruce/Desktop/Codex/2026-10-13/task/serial-fix-evidence/capture-seal-correction-review.json
Candidate: C:/Users/bruce/Desktop/Codex/2026-10-13/task/capture-storage-correction/workspace

The previous foundation packet/source/logs/screenshots and native installation evidence are unchanged. Original main remains 2f84f429214633374e56159296b87c188d64c5f2; the user's separate tests/ui/live.spec.ts +4/-0 edit has the expected SHA-256 and was not copied or modified. No dependencies, installations, DUT interaction, ports, SSH targets, pushes, tags or release publication.

Automation UI/IPC/native catalog and transport integration remains a separate unadopted work in progress at C:/Users/bruce/Desktop/Codex/2026-10-13/task/capture-storage-integration/workspace. Those exploratory edits are not part of this packet or qualification. Full-output production tasks remain incomplete. Unexpected midstream native-download failure UX in Firefox/WebKit remains an explicit release gate; successful preflight checks do not qualify it.
