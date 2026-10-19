# First persistent console journal and actor checkpoint

Independent review withheld acceptance of this exact component for two P2 findings. The source,
patch and 20-case evidence below remain historical and frozen. See
console-component-correction-checkpoint.md for the separate correction; its review is pending.

Target v0.6.0. Task means C:/Users/bruce/Desktop/Codex/2026-10-13/task. This is tested isolated
component preparation for independent review. Original application source is unchanged; no shipping
console API/UI/capability is claimed.

Prerequisite: exact accepted SSH correction patch SHA256
25e18f0de588111c002ff3874161853b74bd3c3f4d4c378f4cea00f4a85a6bd4. Parent relayed independent
acceptance after all 431 source files/132 artifacts and both exact blocker probes were verified.
Task/ssh-console-session/ssh-correction-acceptance.json records that scope. The correction and
earlier paused journal draft remain frozen; this work uses a new workspace.

Packet: Task/serial-fix-evidence/ssh-console-actor-journal-review.json and .patch. Candidate source:
Task/ssh-console-session/frozen-qualified-source (436 files; five added files against the accepted
431-file prerequisite). The added shared schema/native journal/actor and two test files do not
modify existing product source, dependencies or the user live-test edit.

Implemented: strict schema-2 PTY/context records in console-captures-v2; exact bytes/CRC, bounded
writer/cursor/backlog, raw verification before outcome, null command exits and no context command
fabrication; interruption/corruption/read/reopen/owner handling with old/future namespaces
preserved. One bound actor opens one normal interactive shell, keeps state across explicit steps/run
IDs, accepts exact Script+CR/Enter payloads and fresh bounded literal criteria, and records
startup/idle/ shutdown through one queue. Already buffered pre-write data cannot become a fresh
response, and unfinished parser state prevents later input. Both readable ends, actual channel
close, queued IO, raw/outcome and repository close retain ownership. Known storage gaps preserve
their original cause.

Twenty focused tests pass: one real authenticated loopback shell models normally initialized cwd,
aliases/functions/environment across ten actions/two run IDs, explicit intermediate-input prompt and
two consecutive Enter actions; synthetic/native tests cover stale/startup/background and buffered
prompt suppression, ANSI/UTF-8 fragments, >1-MiB raw hash, failure/cancel/late open and
close/outcome/storage fences. The exact large PTY payload is 1,064,960 bytes. The same harness using
the retained earlier actor has three expected behavioral failures and 17 controls, without test
deadline/import failures: post-close extended bytes disappear, buffered prompt falsely advances, and
unfinished idle escape permits a write.

Strict typecheck and five-file formatting pass. A missing Buffer annotation in the test host-key
callback was the sole final typecheck defect. The repaired source's four generated positive/negative
JavaScript bundles are byte-identical to the tested 20-pass/three-negative executables; hashes are
recorded in Task/ssh-console-session/qualification-final.json. Both frozen source snapshots and
failure logs remain. The initial authorized journal run had three passes/one fixture count failure
(startup was 24 bytes, so observed count changed 200023 to 200024); no assertion or deadline was
waived. The older restricted-context rename failures remain separately preserved.

Qualification uses existing staged no-addon Node 24.21.0 dependencies, with actual loader
provenance, binary absence and bindingAvailable:false. No install/runtime update/rebuild or cipher
relaxation occurred. This is not final artifact composition, native-addon support or general memory
evidence.

Still open: production SshSession global gates and connection lifecycle, native/preload/gateway
console protocol/authorization/credit, capability/plan/runner/UI integration, browser persistence,
all export formats, legacy readers, applicable aggregate/native/browser/platform checks, real
ash/PTY and DUT, calibrated memory/CI/30-minute soaks and release/publication. Prompt observation
remains operator-defined observation with null exit status. No public CI or publication occurred.
