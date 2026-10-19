# Console outgoing idle integrity fence

Target v0.6.0. Task means C:/Users/bruce/Desktop/Codex/2026-10-13/task. Minimal follow-up
preparation; independent acceptance and original application adoption are pending.

The prior five-file correction (patch SHA256
959355e0f6f406d90eadcae9b272f1845a219c8b6ceb357689a6520efed0934a) fixed complete-byte equality and
pre-write context attribution. Independent review verified all 437 sources/59 artifacts and
confirmed those fixes, but reproduced an implicit-seal integrity regression: two prompt-observed
outcomes/two writes preceded final detection of a damaged idle frame. Its exact report/probe are
Task/serial-fix-evidence/ssh-console-component-correction-independent-review.md and
ssh-console-correction-integrity-probe.cjs. Previous packets/probes remain unchanged.

Follow-up manifest/patch: Task/serial-fix-evidence/ssh-console-idle-integrity-review.json and
.patch. Frozen source: Task/ssh-console-idle-integrity/frozen-source, still 437 files. Exactly two
files change: native console-journal.ts and the existing console-component-review.test.ts. The
writer requires activeStart and verifies that outgoing idle prefix before committing inputSent and
replacing the fence. Verification replays context/preparation/pre-write observations with the
original cursor. No mode/protocol/actor/schedule/payload/timeout/dependency change is included.

Thirty positive cases pass (28 existing plus channel/extended fault cases), no failures/skips. Each
new case corrupts one retained base64 byte without changing size/CRC immediately before inputSent.
The first step rejects, no outcome is committed, a second input refuses, one already-dispatched
write remains, incomplete/integrity evidence is saved, the damaged raw bytes stay unchanged, and
actual channel/readable/write/store cleanup releases ownership. The exact old native module fails
only these two behavior assertions and passes 28 controls. The unchanged reviewer diagnostic now
exits one at first-step rejection. This fence cannot undo that first dispatched write.

Strict typecheck and focused formatting pass. Exact commands, source hashes, receipt identities and
profile are in Task/ssh-console-idle-integrity/qualification-final.json. Existing equal-count,
context/preparation/dispatch, legacy records, cancel/late-open/write/store fences, normal modeled
loopback cwd/aliases/Enter and 1,064,960-byte capture tests remain green. No assertion or deadline
was waived, and no broad/native-browser/CI qualification ran.

The separate six-file integration draft is preserved in
Task/ssh-console-integrated/paused-for-idle-integrity-review.json. It has no Session/API/runner/UI/
export wiring or browser behavior qualification. Its browser inputSent must mirror this fence. The
installed winpty DLL/Bash TTY pipe probe separately passed with fixed dimensions, child exit zero
and drained output; its failed zero-dimension CLI probe is retained. The real OS-PTY-through- SSH
fixture is written but unrun. This is not Linux/ash/driver/DUT/platform or release acceptance.

Task 6.2 stays open (console 2/19); durable stays 11/20. Accepted independent SSH corrections, all
frozen source/evidence, the user live edit, main-only refs and 132 canonical/archive/config specs
are preserved. Original source adoption, integration, real PTY/ash/DUT/platform, calibrated memory/
CI/30-minute soaks, native-addon causation, final shipping profiles/artifacts and publication remain
separate gates. No installs, host-policy/device/network changes or external/physical targets.

## Accepted component and resumed integration (October 15)

Independent review now accepts the exact minimal outgoing idle-integrity correction for its
post-dispatch persistence-fence contract. The 437-file source manifest SHA256 is
e05538c996a0ca701d145f7638b81fd56920df2df3b11b4fe1ce6affa93d00ee; the two-file patch SHA256 is
3e35d6cc0510db3d180a04f22a65ec3462a5826dc1f0eb4d09bd6a5b1fa3e29f. The original component and all
correction packets remain frozen. Task 6.2 is complete as accepted component preparation; all 16
shipping implementation/acceptance tasks remain open. This is not original application adoption.

The independent earlier-timing corruption probe confirms the boundary: corruption injected at zero
writes can still be followed by one explicit write; the step then rejects, commits no outcome or
inputSent record, stops subsequent input, persists incomplete/integrity and completes cleanup.
Missing dispatch metadata in incomplete evidence therefore means dispatch is uncertain, not that
nothing ran. UI and exports must preserve that uncertainty and must not automatically replay it. See
Task/serial-fix-evidence/ssh-console-idle-integrity-independent-review.md and the saved prewrite
timing probe/results for independent evidence and exact retention paths.

After the separately approved cleanup, isolated integration resumed in
Task/ssh-console-integrated/workspace. Its two native source/test files now match the accepted
correction exactly; the browser draft mirrors the outgoing-prefix verification but has not yet
received behavioral qualification. The first real installed Windows/MSYS PTY-through-SSH fixture
failed its startup criterion, and bounded diagnostics were added without increasing its timeout.
That failure remains retained; no passing real-shell claim follows from the earlier direct DLL
probe. Session/API/runner/UI/export composition, ash/DUT/platform and product memory/soak/release
gates remain open. Publication requires all required tests to pass on the exact combined candidate
and artifacts. The morning target cannot waive failed, skipped, blocked or unrun software checks.
