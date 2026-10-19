# SSH independent-stream review correction checkpoint

Target v0.6.0. Task means C:/Users/bruce/Desktop/Codex/2026-10-13/task. Independent review accepted
this exact correction. Original application source adoption remains pending. Console work resumed
separately on this accepted baseline.

The reviewed 430-file milestone remains immutable; its patch SHA256 is
677239e7c20ac83e3690787f52886adcb14aa3adfa629a1066975b85aa4d73aa. Review independently reproduced
two blockers with unchanged runnable probes in Task/serial-fix-evidence. Both were rerun against
that baseline and the correction; the JSON receipts are retained separately.

The correction manifest/patch are Task/serial-fix-evidence/ssh-stream-review-correction-review.json
and .patch. Frozen source is Task/ssh-stream-review-corrections/frozen-source: 431 files, five
modified production files and one added regression file. No dependency, runtime, UI layout, command
timeout, physical-port, target or host-permission change is included.

- P1: the runner passes its original freshness guard through backend execution. The backend checks
  after initial capability lookup, optional clock sampling (outside its failure-swallowing catch)
  and storage initialization; the stream client checks after final capability await immediately
  before dispatch. No resetting of the arm baseline or dependence on timer ordering is allowed. The
  exact reviewer probe changes from one delayed start to zero, with an explicit paused state.
- P2: stop accounts for unsent accepted observations; already-observed queued stdout/stderr adds
  known lost bytes and bounded io failure evidence. Sent data remains client-owned and is not
  counted twice. Interrupted read/ACK marks possible loss without inventing an observed count; an
  existing writer failure keeps its original cause. Completion/finalize still joins actual channel
  close and pending IO. The exact 23-byte probe changes from complete/zero/zero to incomplete/zero
  committed/23 observed with an explicit io gap.

Qualified correction results and exact commands/hashes are in
Task/ssh-stream-review-corrections/qualification-final.json. Eighteen new focused cases pass; the
same harness with five original production modules produces 11 expected behavioral failures and
seven controls, without import/fixture/time-limit failures. Existing serialized protocol, production
loopback and cleanup cases pass in the staged no-addon profile, with runner regressions, actual
hidden sandboxed Electron IPC, typecheck, local builds and focused formatting recorded in that
receipt. No broad browser or long-output rerun is claimed for this correction. Earlier evidence
remains scoped to its historical source. The initial new fixture-readiness failure log is retained;
its five-second test deadline was unchanged when polling was repaired for native IO.

The retained optional crypto abort remains unexplained. The reviewer's report distinguishes
Electron's already patched runtime, historical v0.5.2 payload inspection and documented fresh
gateway/staged JavaScript-only profiles from unqualified future artifacts and native-addon mode.
Final exact artifact addon absence/loader/runtime/profile and bounded lifecycle checks remain
required; see verification-matrix.md and memory-resource-qualification.md. No runtime update,
dependency reinstall, native rebuild or cipher-policy change was performed.

Independent review verified all 431 source files and 132 artifact hashes, reran both exact probes
and reported no new actionable findings. Both blockers are closed for this exact patch. Tasks
3.2/3.3 are restored. The trusted acceptance receipt is
Task/ssh-console-session/ssh-correction-acceptance.json. This supplements the frozen manifest's
historical pending status without rewriting it. Whole-app calibrated memory/CI/30-minute soaks,
console/PTY/context implementation, actual ash/driver/DUT/platform and final release gates remain
open. No push, publication, branch/tag/history edit, release-asset change or original application
source adoption occurred. The separate user live-test edit and all frozen predecessor packets remain
preserved.
