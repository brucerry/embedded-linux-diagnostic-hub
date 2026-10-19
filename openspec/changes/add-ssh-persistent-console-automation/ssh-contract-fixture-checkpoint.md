# SSH contracts and local fixture preparation

Target v0.6.0. Task means C:/Users/bruce/Desktop/Codex/2026-10-13/task. This is a bounded four-file
addition against the accepted, qualified 411-file capture composition. Frozen source has 415 files;
every baseline byte is unchanged.

Manifest: Task/serial-fix-evidence/ssh-console-contract-fixtures-review.json. Patch:
Task/serial-fix-evidence/ssh-console-contract-fixtures-review.patch. Patch SHA256:
2001776d1d76152d9b0066a4524d0fe3039f9e4b0b7868a576a2df7a9b36887d; 39412 bytes; clean git apply
--check. Frozen source: Task/ssh-console-contract-fixtures/frozen-source. Plan:
Task/ssh-console-contract-fixtures/implementation-and-test-plan.md.

The four additions are shared/ssh-console.ts, tests/ssh-console-contract.test.ts,
tests/fixtures/ssh-console.ts and tests/ssh-console-fixture.test.ts. Shared validators prepare
legacy independent mode, capability refusal, explicit Script/Send Enter, exact byte encoding,
bounded literal roles/readiness and immutable defaults/overrides. They have no shipping consumers
and advertise no runtime capabilities. Unknown/accessor/symbol metadata and sparse/invalid literal
lists refuse.

The fixture uses authenticated, host-key-pinned local ssh2 sessions. Its shell is a deterministic
ash-like model with ordinary startup cwd/alias/function/environment, changing and intermediate
prompts, explicit consecutive CR and no per-command PTY exits. It does not establish real ash or
user profile behavior. Current production SshSession tests retain independent cwd reset, genuine
exit 127, execution-owner/manual-input exclusion and cancellation without closing manual Terminal.
PTY refusal cannot substitute exec, and the connection remains usable afterward.

A clearly test-only stdout pump feeds actual accepted NativeCaptureStore/captureToRepository. The
large case retains exact 2,113,536 bytes by SHA256 with bounded preview and genuine exec exit.
Initialization quota failure sends no command; later append quota failure retains an incomplete
committed prefix, joins the owned exec close and leaves the connection usable. This is feasibility
evidence, not a production both-stream/durable-credit adapter or product heap qualification.

Final exact source: 26 focused passes (five new contracts, seven new loopback cases, 14 existing
regressions), zero failures/skips. Strict typecheck, build and four-file formatting pass. The
initial nine-pass/three-failure fixture source/logs and missing-Buffer-annotation typecheck failure
are retained in the manifest; fixes preserve byte and cleanup assertions. Those are intermediate
development failures, not intentional negative controls or product acceptance.

Only task 6.1 is complete. All 17 production/acceptance tasks remain open, including 1.1-1.3 and
4.1. Next: negotiated owned independent SSH stdout/stderr streaming and durable ACK adapters, then
reviewed PTY/context schema/compatibility, dedicated flow console, runner/editor/stored SSH UI and
exports. Real ash/PTY, full combined product/platform/memory/download/installer/DUT/release gates
remain pending. Independent review of this preparation packet is pending.

No original application source adoption, new dependency/runtime installation, permission change,
external SSH/DUT/physical port, CI, push/tag or publication occurred. Eleven frozen predecessor
packets, accepted capture source/logs and the user's live-test SHA remain verified unchanged.
