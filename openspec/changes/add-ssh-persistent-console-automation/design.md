# Design

## Context

See proposal.md. `backend/ssh/automation.ts:captureCommand` calls `client.exec` once per request.
`backend/ssh/session.ts:runAutomation` holds per-command activity ownership and generation checks;
its Terminal uses a different persistent `SshTerminal`, with input blocked while Automation owns
activity. `shared/automation.ts` currently permits explicit Enter-only only for Serial, and the
runner requires genuine exits for SSH. These are coherent independent-script semantics and must not
be weakened to make an empty exec look successful.

The user's screenshot is evidence of independent cwd reset and an unavailable `ll` in exec, not
proof of where the target defines the interactive alias. No DUT connection is authorized. The Serial
byte-block correction is a separate review packet; its bounded algorithm and provenance contract can
inform a console implementation only after review, with an explicit SSH/PTTY variant.

## Goals / Non-Goals

**Goals:** a visibly selected persistent SSH console mode, one flow-owned PTY across steps/repeats,
normal target interactive initialization, explicit Script/Send Enter and completion criteria,
stateful cwd/environment/aliases, bounded capture and honest prompt/exit evidence across desktop and
gateway clients.

**Non-Goals:** borrowing the existing Terminal, rewriting aliases, injecting profile sourcing,
changing target configuration/PS1, automatic confirmation of interactive programs, inferring exit
codes from shell text, reconnect/replay or real target qualification during implementation.

## Decisions

1. **Preserve the compatible mode.** Add optional SSH mode metadata whose absence means
   `independent-script`. Console mode requires advertised bridge/gateway support. Older runtimes
   show an unsupported state; never fall back to exec, the existing Terminal or a blank helper
   command. Keep Serial's existing explicit Enter intent backward compatible.

2. **Use a dedicated owned shell.** A console owner binds authenticated connection generation,
   flow/run identity and an unpredictable channel capability. Open one ssh2 PTY shell through the
   ordinary server shell request; close that owned channel on normal completion, cancel, disconnect,
   ownership loss or unsafe scheduling interruption. Do not close the authenticated connection or
   unrelated Terminal. Hold activity/input ownership through step delays and unfinished cleanup, and
   reject concurrent opens/writes. Extend the runner's lease lifecycle to await asynchronous
   acquisition/release while retaining its existing synchronous backend path. Check generation both
   before and after each await. A replacement connection always requires a new explicit arm and new
   shell.

3. **Define intent before encoding.** A Script remains nonblank user text, preserved as one payload
   with an explicit displayed submit CR. Send Enter has no script text and writes exactly `0d`.
   Derive bytes again at the execution boundary from validated intent. Freeze mode, intent, payload
   and completion settings at arm time. Independent-script Enter remains unavailable;
   empty/whitespace scripts remain invalid. Do not substitute `true`, `:` or send Enter to the
   existing Terminal.

4. **Make waiting explicit.** Configure bounded literal tail criteria (at most eight nonempty
   literals, each at most 256 characters), with per-step overrides and an explicit role:
   shell-prompt or intermediate-input-prompt. No regex or automatic generic `#`/`$` fallback. Show
   the exact criteria and quiet/timeout policy in the preview. Use fresh per-step decoder, capture
   counters and visible-tail state, plus bounded input settlement before sending. A stale prompt or
   startup banner cannot complete a new step. Do not send step one until a bounded initial
   shell-ready criterion is observed. Incomplete UTF-8/ANSI cannot authorize advancement. Quiet
   completion is an observed criterion, not proof of command success.

    Prompt changes after `cd` are explicit: operators can configure the known prompt alternatives or
    the next step's exact expected literal. The UI explains this requirement; it never silently
    guesses a new prompt from arbitrary output or broadens the matcher. For interactive commands,
    the preceding step must explicitly wait for that program's input prompt before a subsequent Send
    Enter. Otherwise timeout/cancel pauses the flow without an automatic confirmation.

5. **Retain shell context without modifying it.** Use the target's normal interactive shell
   initialization. Cwd, variables, aliases and functions persist naturally within the owned PTY. If
   the normal shell does not define `ll`, show its actual response; do not hardcode `ll` to `ls`,
   source guessed files or claim that an alias exists. Local tests model an ash-like shell whose
   ordinary fixture initialization defines an alias and function; that is model evidence, not a
   statement about the user's exact profile files.

6. **Export the execution truth.** Store SSH mode, Script/Send Enter intent, exact request bytes,
   owned console/run identity, the matched criterion/role, combined PTY output and prompt-observed
   completion with `exitCode: null`. Do not describe PTY output as independently observed stdout and
   stderr. Reuse a bounded byte-block algorithm only with a distinct, validated SSH-console
   representation and truthful first/last host receive observations/read counts. Preserve raw bytes,
   ordered clock-jump evidence, truncation and uncertainty. Version new export semantics explicitly
   while keeping legacy independent-script records and genuine exit policy compatible.

## Risks / Trade-offs

- Prompt-shaped output can satisfy a chosen literal → require explicit unique criteria, complete
  streaming parser state and a bounded quiet interval; label completion as observation and never as
  a genuine exit. Operators needing exit-status decisions use independent scripts.
- Interactive initialization differs by target → use only normal shell startup and preserve
  errors/banners; no implicit profile commands or alias substitutions.
- Cancellation may not undo remote effects → stop future input, close only the owned PTY and report
  unavailable remote termination certainty. Never reconnect or replay automatically.
- A failed close may still own a channel → retain the lease until cleanup is complete; expose
  actionable pending/failed state without freeing the next flow prematurely.
- Mixed desktop/gateway versions → negotiate explicit capability and reject unavailable console
  operations; no silent downgrade or relaxation of existing authentication/origin checks.

## Migration Plan

Add backward-compatible mode/intent validation and capability fields first, then the owned backend
channel and desktop/gateway APIs, then runner/editor/exports. Preserve old plans as independent
scripts and keep the current Serial UI/capture packet separate. Test with local mock channels and
loopback fixtures; perform no DUT operations. Prepare a bounded independent review packet before
adoption. Rollback keeps old plans/independent scripts usable and marks new console plans
unsupported without executing them in a different mode. Target v0.6.0 only after source and
applicable gates.

## Open Questions

The target's actual `ll` initialization and exact prompt variants require future user-authorized
target evidence. They do not change the selected design: normal interactive startup and explicit
operator-provided completion criteria remain the contract.

The later full-output request supersedes small total-output caps: coordinate the future console
capture with the storage-backed capture design, bounded memory and truthful storage failure/export
semantics. The current 64-KiB Serial block packet is an interim correctness checkpoint, not final
full-output acceptance. Preserve the single Cancel run UI and all phase-disarm semantics when
composing this change with the current v0.6.0 deltas.

## October 15 storage and sequencing reconciliation

Use add-durable-automation-capture as the full-output storage contract. First implement independent
SSH/gateway streaming with durable acknowledgements, then the dedicated console protocol and UI. The
original small total capture cap is superseded; bounded blocks, queues, prompt parser and preview
remain. Do not silently fall back to legacy capped JSON when streaming is unsupported.

One ordered sink actor owns the console byte stream across startup, step boundaries,
waits/repetitions and shutdown. Preserve observed bytes outside a command in typed console-context
segments with phase, flow/console identity and receive provenance. Such a segment has no invented
command, ordinal, AutomationOutcome or exit status. Boundary markers are ordered with queued bytes
and durable seals; create an idle segment only if bytes arrive. A prompt-shaped startup/background
observation cannot complete a later step. This is planned data/protocol work, not existing code.
Version the context/PTTY representation explicitly and validate every adapter; the existing manual
Terminal remains separate and ephemeral.

The ash-like channel fixture is model evidence. Real ash/PTY qualification is separately pending:
ash/busybox/docker were absent from PATH and read-only WSL enumeration returned Wsl/E_ACCESSDENIED
in this selected environment. That does not establish whether the host has distributions. Do not
install a runtime, change host permissions, use a DUT or claim real-shell acceptance from a mock.
See Task/ssh-storage-console-preparation/implementation-sequence.md for code locations and the
bounded implementation order.

## Isolated contract and fixture checkpoint

The four-file preparation now exists against the qualified accepted 411-file capture composition. It
validates explicit intent/criteria and models a normally initialized interactive shell through real
local ssh2 protocol sessions, while retaining genuine current independent-exec behavior. Its 26
focused cases and strict build/typecheck/format pass. No shipping consumers/capability
advertisement, production stream API or persistent console have been added; tasks 1.1-1.3/4.1 remain
open. See ssh-contract-fixture-checkpoint.md and
Task/ssh-console-contract-fixtures/implementation-and-test-plan.md for exact locations and sequence.

Before console persistence implementation, review a precise versioned combined-PTY/context schema
and old-reader compatibility. Current CaptureFrame permits stdout/stderr/serial and command headers
require command metadata; execution.mode=ssh-console alone cannot truthfully represent combined PTY
bytes or startup/idle/shutdown context. Do not label PTY as child stdout or fabricate commands to
fit the old schema. Independent exec can use the accepted stdout/stderr storage representation
first.

## Functional independent-stream prerequisite

The production independent SSH stream, durable credit, actual cleanup fence, native/gateway adapters
and stored SSH UI are now implemented/tested in a separate 28-file packet; see
../add-durable-automation-capture/production-ssh-streaming-checkpoint.md. It is pending bounded
independent review and original source adoption. Existing Git Bash 5.3.15 real-process exec is
qualified through local SSH pipes; winpty is installed but actual PTY and ash remain unqualified.
Precise versioned combined-PTY/context persistence and compatibility precede dedicated flow console,
Enter/criteria/runner integration. The 30-minute memory lanes/CI gate remain planned.

## First isolated journal and owned-actor implementation

The exact six-file independent-stream correction is accepted; its frozen manifest is supplemented by
Task/ssh-console-session/ssh-correction-acceptance.json. No native-addon or broader release gate is
closed by that acceptance.

The separate first console component checkpoint now implements a strict schema-2 journal in
console-captures-v2 and one ordered owned-shell actor. Typed startup/idle/shutdown contexts have no
invented command or outcome; command records carry explicit payload/criterion and null exits. The
native writer streams bounded PTY observations with channel/extended-data origin, verifies the raw
segment before its immutable outcome, and retains store ownership through close. Version-1 and
unknown future namespaces remain unchanged. This is a candidate for bounded schema/component review,
not a shipped schema migration or console capability advertisement.

The actor uses one normal client.shell PTY request, no profile/alias/env injection, and delegates
exclusive session ownership, authenticated generation and original arm freshness to a mandatory
binding. It joins both readable drains, actual channel close, queued observations, pending input and
repository close before releasing that binding. It drains pre-write buffered bytes before fresh
matching and refuses input with unfinished UTF-8/escape state. Only an explicit action writes
Script+CR or exactly CR; intermediate-input observation does not confirm automatically. Quiet
literal matching is observation and can still match deliberately prompt-shaped application output;
it never supplies a real exit status.

See console-actor-journal-checkpoint.md for exact source/patch/test lineage. Session global gates,
strict native/gateway console protocol/credit, browser schema-2 persistence, whole-flow runner/UI
and all export formats remain to be implemented and reviewed. Tests use real loopback ssh2 with a
modeled shell plus synthetic channels/native temporary storage; real ash/OS PTY/DUT/platform and
general memory/soak qualification remain separate.

## Preparation versus input dispatch and complete-byte correction

The component reviewer verified the exact 436-file/508-artifact packet but withheld acceptance for
two reproduced P2 findings. The original source remains frozen. A separate correction preserves the
20 existing cases and adds eight focused cases, with seven exact-old-source behavioral negatives.

Complete native metadata must have observedBytes equal retained bytes, both before finish publishes
complete and during replay validation. Greater/unknown counts are refused, with existing raw files
retained. Non-complete interrupted/failure evidence keeps its explicit counts and uncertainty.

The unpublished schema-2 candidate now records preparation separately from command output. Calling
start(command) while a persisted idle context is active records frozen intended input and a reserved
index, without replacing that context. Incoming pre-write bytes remain idle observations. A later
command segment-start carries inputSent with the preparation sequence, prior context index and
disposition write-dispatched; that ordered boundary closes the context and opens command output. It
records a dispatched write attempt, not remote delivery, execution success or callback success. No
await separates the original freshness check and the actual write. The queued marker precedes any
synchronous response callback and is committed before subsequent response observations. A cancelled
unsent preparation has preparation-end and no command outcome. Reserved indices may be reused after
cancellation; preparation identity is its record sequence, not a fabricated command.

These are pre-release candidate semantics; valid earlier records without dispatch metadata remain
readable with dispatch evidence absent. There is no shipped schema migration or capability fallback.
Future browser/native/gateway adapters must implement the corrected operations and strict validation
before advertising support. See console-component-correction-checkpoint.md.

A separate permitted installed-tool check established a real local Windows/MSYS PTY: Git Bash 5.3.15
through winpty, both stdin/stdout confirmed TTYs, profiles disabled. The first tty utility lookup
was absent from PATH; the built-in follow-up exited zero. Evidence is
Task/ssh-console-integration/local-pty-probe.json. This establishes local availability, not
Linux/ash, normal-profile aliases, a real OS-PTY-through-SSH fixture, driver/DUT or broader platform
acceptance. No installation or host configuration change occurred.

## Every implicit seal preserves its outgoing integrity fence

inputSent must verify the existing activeStart prefix before it commits the command transition and
replaces activeStart. That prefix includes idle context, durable preparation and pre-write data. The
later command-segment check cannot replace verification of the preceding context. Failure poisons
the writer, records truthful incomplete/integrity evidence and prevents outcomes and later input.
This is a post-dispatch persistence fence: the first requested write cannot be undone. The same rule
is required in the future browser/remote-storage implementation. See
console-idle-integrity-checkpoint.md for the exact two-file follow-up and regression evidence.
