# Tasks

## 1. Contracts and compatibility

- [ ] 1.1 Add explicit independent-script/console plan and capability contracts; verify legacy plans
      remain independent and unsupported desktop/gateway versions refuse console without fallback or
      commands.
- [ ] 1.2 Add frozen Script/Send Enter intents and exact request-byte derivation; verify Enter is
      exactly CR, consecutive Enter works, and accidental blank scripts/independent SSH Enter remain
      invalid at UI and execution boundaries.
- [ ] 1.3 Add bounded literal criteria, per-step overrides/alternatives and shell/intermediate-input
      roles; verify malformed, missing, overlarge and overly broad implicit criteria cannot arm.

## 2. Owned persistent SSH backend

- [ ] 2.1 Implement one flow-owned PTY with authenticated connection/generation/channel capability
      fencing and asynchronous cleanup ownership; verify one shell open across steps/repetitions,
      concurrent writes/opens refuse and unfinished close keeps the lease.
- [ ] 2.2 Extend session activity/collection/manual-input gates and explicit close/cancel paths;
      verify normal completion, timeout, cancellation, disconnect, reconnect and stale callbacks do
      not send later input, reuse a replacement connection or close an unrelated Terminal.
- [ ] 2.3 Add desktop IPC/preload and gateway capability/open/step/close adapters with strict
      bounded validation; verify authenticated/origin checks and owner identities on every path.
- [ ] 2.4 Implement fresh streaming prompt observation and fragmentation-independent storage-backed
      raw capture with bounded memory with explicit receive-block provenance; verify UTF-8/ANSI
      fragmentation, stale/startup output, incomplete parser state, output beyond the former total
      cap and bounded-queue/storage failures stop before the next action.

## 3. Flow UI and evidence

- [ ] 3.1 Add explicit mode and Script/Send Enter editing/preview, per-step completion criteria and
      truthful unsupported/pending states; verify keyboard editing and immutable armed snapshots.
- [ ] 3.2 Bind the runner's whole console flow to its one owned PTY while retaining independent exec
      behavior; verify Script → Enter → Enter → Script, step delays, repeated flows and explicit
      rearming without overlap or stale-prompt advancement.
- [ ] 3.3 Record/export mode, intent, exact payload, criterion/role, combined PTY output, null exit
      status and bounded first/last receive provenance; verify JSON/CSV/Markdown/text round trips
      and legacy independent-script exports without invented exit/stream evidence.

## 4. Stateful shell acceptance and bounded review

- [ ] 4.1 Add an interactive ash-like local channel fixture with ordinary initialization, cwd,
      aliases/functions and changing prompts; verify `cd /` → `pwd` reports `/`, initialized `ll`
      and functions work, and production sends no alias rewrite/profile source command.
- [ ] 4.2 Verify the same independent-script fixture retains cwd-reset behavior and genuine `ll`
      exit 127 where no exec alias exists; verify console shell errors are retained without fake
      exit codes or assumptions about the user's actual alias file.
- [ ] 4.3 Verify explicit changed-prompt criteria after `cd`, wrong/missing criteria, interactive
      intermediate input, timeout/cancel/reconnect and no automatic confirmation using mock-only
      backend and browser tests; retain traces and exact raw/provenance evidence.
- [ ] 4.4 Run applicable aggregate checks and prepare an independently reviewable source packet,
      compatibility matrix and acceptance evidence; adopt only after bounded review. Actual DUT
      behavior stays pending explicit target authorization, and v0.6.0 publication remains gated.

## 5. Storage coordination and truthful shell qualification

- [x] 5.1 Complete the independent SSH/gateway streaming prerequisite in
      add-durable-automation-capture before console integration; preserve ordered stream identities,
      durable ACKs, backpressure and compatibility refusal.
- [ ] 5.2 Add typed startup/idle/shutdown console-context segments and one ordered sink actor;
      verify exact bytes across step/delay/repeat boundaries, no phantom command outcomes and no
      startup/stale prompt advancement.
- [ ] 5.3 Qualify a real local ash/PTY fixture when an authorized runtime is available, separately
      from the mock channel tests. The current selected environment's WSL access denial is a blocker
      to this gate, not authorization to install or change policy.

## 6. Bounded prerequisite-safe preparation

- [x] 6.1 Prepare and qualify isolated shared validators plus a real local ssh2 protocol fixture
      against the accepted 411-file capture integration: exact Script/CR/Enter bytes, explicit
      criteria/roles and immutable snapshots, model cwd/alias/function/environment behavior,
      unchanged production independent-exec/ownership behavior, PTY refusal and full-storage/quota
      feasibility. Freeze only the four added files with clean patch application, 26 focused passes
      and strict build/typecheck/format evidence for independent review.

- [x] 6.2 Prepare and qualify a separate schema-2 native PTY/context journal and owned persistent
      shell actor on the accepted corrected 431-file streaming baseline. Verify normal modeled shell
      initialization, same-shell cwd/aliases/functions/environment across run IDs, explicit
      CR/Enter, fresh bounded prompt observation/null exits, startup/idle/shutdown bytes, >1-MiB
      exact output, raw/outcome/store/actual-close fences, cancellation and failure cases. Freeze
      five added files with 20 passing focused cases, three expected retained-source failures,
      strict typecheck/format and exact executable identity after a test-only type fix. This is
      component preparation for review, not shipping Session/API/runner/UI/browser/export adoption.

## Accepted prerequisite and first console component checkpoint

The four-file preparation and exact six-file streaming correction are independently accepted. Task
5.1 records the accepted isolated prerequisite, not original application adoption. Its patch SHA256
is 25e18f0de588111c002ff3874161853b74bd3c3f4d4c378f4cea00f4a85a6bd4. Both confirmed blockers are
closed; native-addon causation, final shipping-profile/artifact checks and broader memory/CI/soaks
remain open.

Console work resumed in Task/ssh-console-session/workspace from that exact 431-file source. The
prior three-file paused draft and its failed logs remain unchanged. The new five-file journal/actor
checkpoint has 436 frozen source files and is reviewable separately; see
console-actor-journal-checkpoint.md. Preparation task 6.1 and prerequisite 5.1 are checked; 6.2 is
reopened for the two component review findings. All 16 remaining shipping implementation/acceptance
tasks stay open: capability/plan/UI/API, Session global activity gates, runner timing/repeat/cancel
integration, browser persistence, exports, compatibility and real PTY/ash/platform/DUT acceptance
are unfinished. No public CI, publication, dependency install or original source adoption occurred.

## Component correction review hold

Independent review withheld the five-file component packet after reproducing two P2 invariants:
complete metadata accepted a known/unknown observation gap, and output buffered before input was
written was assigned to a command. The original 436-file/508-artifact packet remains frozen. Task
6.2 is reopened pending review of the separate five-file correction; see
console-component-correction-checkpoint.md. Twenty existing plus eight new tests pass, with seven
expected behavioral failures and 21 controls against the exact original production modules. The
unchanged count diagnostic now rejects invalid completion; the unchanged actor diagnostic reports
pre-write context/idle and one exact write. Typecheck/format pass. No release acceptance or shipping
integration is implied.

The integration draft is paused in Task/ssh-console-integration/paused-for-component-review.json:
two new storage draft files, typecheck only, no session/API/runner/UI/export wiring or behavioral
qualification. The accepted independent SSH corrections remain unchanged. Durable
memory/native-addon/ profile gates and the 16 shipping console tasks remain open.

## Outgoing idle-prefix integrity follow-up

The reviewer confirmed the prior completeness/context findings fixed, then withheld acceptance for
inputSent moving activeStart without verifying the outgoing idle segment. Task 6.2 remains open. The
minimal two-file follow-up verifies that existing prefix (including preparation and idle data)
before committing the implicit transition. Thirty cases pass; the exact old native module fails the
two new channel/extended corruption assertions and passes 28 controls. The exact saved probe now
rejects the first step; one write was already dispatched, no prompt-observed outcome is committed
and no second input is allowed. See console-idle-integrity-checkpoint.md. Original packets remain
frozen.

The six-file storage/real-PTY integration draft is paused in
Task/ssh-console-integrated/paused-for-idle-integrity-review.json. Its browser inputSent
implementation must mirror this prefix check before integration acceptance. Installed winpty 0.4.3
DLL/Bash PTY through managed pipes passed a bounded TTY probe with drained output and process exit;
the new real-PTY-through-loopback-SSH fixture is written but unrun. No shipping integration, broad
matrix, CI/publication, installation or target/platform acceptance is inferred.

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
