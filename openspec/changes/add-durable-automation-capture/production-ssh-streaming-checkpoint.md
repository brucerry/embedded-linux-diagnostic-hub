# Production independent SSH streaming checkpoint

Independent review initially withheld acceptance for P1 stale preparation dispatch and P2
accepted-byte loss. It subsequently accepted the exact six-file correction; see
ssh-stream-review-correction-checkpoint.md. The original source/patch/tests below remain historical
frozen evidence. Current accepted isolated composition is the corrected 431-file source; original
application adoption and final product qualification remain pending.

Target v0.6.0. Task means C:/Users/bruce/Desktop/Codex/2026-10-13/task. This is a functional
isolated implementation, independently reviewable before the next large console/context stage.
Original application source remains unchanged; package version remains 0.5.2.

Manifest: Task/serial-fix-evidence/ssh-independent-stream-review.json. Patch:
Task/serial-fix-evidence/ssh-independent-stream-review.patch. Patch SHA256:
677239e7c20ac83e3690787f52886adcb14aa3adfa629a1066975b85aa4d73aa; 139356 bytes; clean git apply
--check. Frozen source: Task/ssh-independent-streaming/frozen-source (430 files, 28 changed/added
against the independently accepted 415-file foundation/preparation). The manifest hashes source,
commands, logs, runtime staging, actual native receipt and retained failure/source/trace evidence.

## Implemented behavior

- Versioned bounded stdout/stderr observations preserve callback receive source/time and exact byte
  boundaries across 16-KiB frames, sequence/range/CRC validation and one outstanding credit. No
  small total-output cap or execution fallback is used. Explicit capability negotiation refuses
  older runtimes. A generation nonce rejects starts negotiated before navigation/reset, while a
  separate private capability binds ongoing reads/ACK/cancel/finalize to the current execution.
- The producer pauses both receive streams; the client awaits sink append and actual store flush
  before ACK. Actual owned-channel close and pending local IO are joined. Execution ownership
  survives genuine exit through raw seal and immutable outcome; timeout/cancel/reconnect/failure
  cannot authorize another command. Stopped sinks reject already queued callbacks instead of
  reopening a cancelled pipeline. Rejected backlog observations have bounded failure evidence.
- Native trusted IPC/preload and authenticated/origin-fenced gateway routes/GatewayClient feed the
  real repository. The actual runner/editor now uses stored independent SSH capture; the persistent
  scoped results UI supports full search, raw-safe export, reload and explicit clear.
  Transport-specific job ownership survives transport switching. The manual Terminal stays separate.
  Console/Enter/PTY behavior is still unimplemented.

| Final exact-source gate                                             | Outcome                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary installed Node 24.21.0 focused run                         | 45 passed, zero failed/skipped: 10 new production, nine new contract/cleanup, 26 existing SSH/runner/Serial cases                                    |
| Longer two-stream output qualifier                                  | Exact 33,587,200 bytes; independent stdout/stderr SHA256; 2050 observations; genuine exit within unchanged 90 seconds                                |
| Actual hidden Electron 44.5.1 native IPC                            | Exact 2,113,536 bytes, owner retained until outcome/finalize, delete; actual sandbox/context isolation true, renderer Node unavailable, noAsar false |
| Actual authenticated gateway UI in Chromium/Firefox/WebKit          | Three passed: capture, full search/export beyond preview, reload, transport switch and explicit clear                                                |
| Original ordinary Serial UI cohort                                  | Nine passed with original test/config/payload/three workers/five-second assertion                                                                    |
| Desktop, web, gateway, strict typecheck and changed-file formatting | All passed                                                                                                                                           |

The production cohort also runs an already installed real Git Bash process through loopback SSH:
separate stdout/stderr and genuine exit 7. That test uses pipes, not a PTY or ash/DUT. Git Bash
5.3.15 and winpty are installed; successful version/help reads do not establish PTY qualification.
No runtime was installed or host policy changed.

## Resource evidence and unresolved limits

Implemented new fast resource assertions cover 40 deterministic producer run/cancel cycles with
connection/abort listener and referenced resource-type baselines. Eight actual loopback connection
cycles join channel/session close and store close/reopen. Unforced heap/external/ArrayBuffer/RSS
samples are diagnostic; eight disk records intentionally remain during that check. They are not
calibrated retained-memory or peak-RSS budgets. These tests are in tests/*.test.ts and passed
locally; there was no CI dispatch. The proposed test:memory:fast harness/serialized CI call and
30-minute normal/forced-GC native/browser/gateway soaks are not implemented. The script named
test:ssh-soak is only the >32-MiB output qualifier, not the proposed 30-minute memory/lifecycle
soak.

Retained failures include initial credit/preview validation defects; the initial synthetic server
not awaiting stderr writes before EOF (90-second timeout retained); the first browser test selecting
a hidden control after successful capture/export (all three traces retained); and development
typecheck/staging/context failures. Corrections preserve all byte, deadline, cleanup and security
assertions. These are development failures, not relabelled intentional negative controls.

One earlier Node process aborted inside the installed optional ssh2 native AES-GCM addon. The final
ordinary 45-case run passes, as does the separately staged intended JS dependency runtime (desktop
packaging excludes the optional binding; documented gateway setup ignores build scripts). The cause
of that abort is unresolved and tracked under 4.9; no dependency or cipher was changed.

Independent review/adoption, precise typed PTY/context persistence, dedicated console/Enter and
completion criteria, actual PTY/ash, calibrated memory/CI/soak, product index mode/heap/lifecycle,
unexpected midstream Firefox/WebKit download feedback, native platforms, graph after design review,
Bruce-only DUT/installer and final release gates remain. Twelve frozen predecessor packets, user
live-test edit, main-only history and published assets remain untouched.
