# Tasks

Implementation is authorized in this order: complete and verify prerequisite phase 0, then custom diagnostics. Bruce has required Python-free and Python-2-only targets as first-delivery cases. New measurements must use independently qualified installed shell/OS/tool capabilities with no runtime/helper deployment; actual missing safety capabilities remain explicit blockers. Only verified completed work may be checked; planning completion does not mean feature completion. Preserve unrelated UI edits and do not reinstall removed qualification environments.

## 0. Remove all existing target Python dependencies first

- [x] 0.1 Audit actual remote invocation sinks and all evaluated/generated commands; verify the inventory of one dependent feature/two invocation sites, distinguish host/test references and record exact source evidence.
- [ ] 0.2 Introduce strict native inventory/report capability versions with historical version 1 compatibility, remove live Python discovery/probe/schema gates and add peer compatibility handling; verify old report digests/content remain intact and current preparation never relies on Python flags.
- [ ] 0.3 Replace UART's target Python program with a reviewed native-utility method preserving TIOCEXCL, nonblocking/O_NOCTTY, raw settings, queue flush, partial-transfer handling, console/busy protections and restoration/closure; verify real controlled PTY success, mismatch, timeout, cancellation, busy ownership and restoration failure without interpreter calls or helper installation.
- [ ] 0.4 Trace executable remote paths across no-Python, Python-2-only and Python-3-variant/poisoned fixtures; verify all 36 collection commands, clock, discovery and preserved test workflows, distinguishing protocol mocks from real UART/process proof.
- [ ] 0.5 Update current device-prerequisite documentation and qualification tools without falsifying historical results; run focused and broader required software checks, verify unrelated dirty-file hashes and strictly validate OpenSpec before custom implementation begins.

## 1. Shared contracts and compatibility

- [ ] 1.1 Add schema 2 profile/inventory/observation types and strict version-dispatch validation in shared/testing/types.ts, profile.ts and inventory.ts; verify version 1 fixtures/digests remain unchanged and invalid/oversized version 2 input is rejected.
- [ ] 1.2 Add the reviewed definition registry with ID/version/digest, domain/channel support, typed parameter and effect/prerequisite contracts; verify unknown definitions, executable content, path overrides and unsupported parameter fields fail before target work.
- [ ] 1.3 Add discriminated numeric/boolean/enum observations, exact unit/range/equality and all-samples evaluators; verify carrier 0/1 decoding, cross-type/coercion rejection, scale/offset precedence, processed input, missing metadata, exclusive boundaries and large exact integers.
- [ ] 1.4 Extend testing transport capability negotiation across electron main/preload, gateway routes and src/services/GatewayClient.ts; verify old peers retain legacy tests and reject new measurements with a clear compatibility message.

## 2. Inventory and current resource resolution

- [ ] 2.1 Extend backend/testing/discovery.ts and inventory parsing with bounded hwmon/IIO/thermal, network, block and USB metadata with explicit storage/usb resource categories, driver/physical-parent/channel provenance and incomplete-capability evidence; verify read-only discovery fixtures, missing permissions and 2 MiB/1024-resource/4096-channel limits.
- [ ] 2.2 Extend profile mapping/preparation with physical-parent/channel identity strength and current-generation manual mappings; verify duplicate labels, renumbering, hot removal, namespace ambiguity and target replacement block or resolve as specified.
- [ ] 2.3 Separate moving measurements from structural identity comparison and group logical aliases by physical parent in preparation/runner coordination; verify a changing counter does not invalidate structural preparation and bound-driver raw I2C aliases cannot execute.

## 3. Driver measurements

- [ ] 3.1 Add driver.measurement dispatch using registry domain compatibility rather than adapter-name prefixes; verify legacy LED/UART/I2C dispatch remains unchanged and unknown domain/descriptor combinations are blocked.
- [ ] 3.2 Add reviewed hwmon temperature/voltage/fan and thermal-temperature descriptors/readers; verify allowlisted opened-resource reads, known unit variants, disabled/faulted inputs and unsupported/side-effectful driver variants without writes or fallback bus access.
- [ ] 3.3 Add reviewed IIO scalar temperature/voltage descriptors/readers with raw/processed distinction and before/after conversion metadata checks; verify busy direct-mode reads, changing metadata and absent scale/offset evidence are non-passing without buffer/trigger changes.
- [ ] 3.4 Add the declared network-driver carrier descriptor as a cross-domain extension example; verify current interface identity, bounded boolean parsing and no link configuration or traffic generation.
- [ ] 3.5 Add observed-during-case versus source-age freshness evaluation and typed timing/cache evidence; verify capability absence is Blocked, runtime stale/unknown age is Inconclusive, equal samples alone are not stale and no invented mtime/wall-clock age is accepted.

- [ ] 3.6 Add block.capacity and usb.link-speed descriptors with exact ABI units and physical/logical/topology identity; verify large capacity values, missing/invalid USB speed, hot removal, no raw media I/O/reset, and snapshot-only claims.

## 4. Reviewed installed-command recipe

- [ ] 4.1 Add fixed POSIX-shell execution over the existing SSH transport with typed positional arguments, bounded start/control/framing and backend-owned parsing; verify no-Python/Python-2-only/Python-3-variant cases invoke no Python, untrusted text never enters script source and no installation/upload occurs.
- [ ] 4.2 Add executable resolution/version/fingerprint/pinned-object execution and fixed argv/environment policy; verify unsupported versions, symlink/object replacement, option-shaped parameters and interpreter/config/command overrides are rejected before invocation.
- [ ] 4.3 Add ip.link.rx-packets with reviewed fixed link-query arguments and fixture-backed supported-version/JSON counter parsing; verify one resolved interface, exact large counters, missing/duplicate fields and unsupported formats, and document that this is a snapshot rather than throughput qualification.

- [ ] 4.4 Add independently probed driver-read and recipe capability profiles for BusyBox and other installed-tool variants; verify byte-bounded FD reads/identity, supported timeout alternatives, missing hash/fd-exec/ip features affecting recipes only, read-only/noexec targets and precise unsupported-capability errors.

## 5. Bounded lifecycle and recovery

- [ ] 5.1 Add anchored app-owned group supervision, durable pre-GO nonce/boot/start handshake, independent remote deadlines and confirmed child/watchdog cleanup; verify signal delivery differences, cancellation bounded wait, timeout/output overflow, no GO on failure, PID reuse and lost acknowledgement without stale-PID signaling.
- [ ] 5.2 Add a bounded durable non-secret intent/completion ledger before new live measurement dispatch, with unresolved ownership gating all affected functional tests; verify crash windows, flush/write failures and clean completion without storing profiles, observations, reports or credentials.
- [ ] 5.3 Integrate sampling feasibility, sample/deadline/evidence budgets and common verdicts into runner.ts; verify cancellation skips later cases, 10-minute run bounds include termination and incomplete or exit-zero malformed data cannot pass.
- [ ] 5.4 Add startup/reconnect/reset recovery reconciliation and target-scoped quarantine; verify restart, missing/corrupt ledger, lost start acknowledgement and incomplete process visibility fail closed, positively distinct targets remain separate, and no unidentified/other-client process is signaled.

## 6. UI and simulation

- [ ] 6.1 Extend guided Tests setup with shared resource/channel/definition selection and explicit units/ranges/freshness/effects/prerequisites; verify invalid and unknown intent is visibly blocked and discovery does not invent board-specific acceptance limits.
- [ ] 6.2 Extend DirectTests.tsx/direct.ts/TestJsonEditor.tsx validation and readiness invalidation for version 2 while retaining single-action Run JSON; verify complete requests need no additional agreement and profile/source/identity changes invalidate dependent preparation.
- [ ] 6.3 Add independent simulated measurement/recipe fixtures for normal, mismatch, ambiguous, stale, parse, timeout and cancellation cases; verify synthetic runs invoke no live transport and maintain source-specific UI state and labels.

## 7. Reports and evidence

- [ ] 7.1 Add version 2 evidence/export and application-owned current/historical contract validation; verify exact raw-to-converted recomputation, typed criteria, self-consistent forged descriptor/digest rejection, unknown contracts, retired executable definitions with retained trusted semantics, legacy digests and claimed-origin labels.
- [ ] 7.2 Extend HTML/native PDF/browser print presentation with expected-versus-observed units/ranges and source/identity/freshness limitations; verify escaping, long evidence, finite document bounds, simulated/imported labels and unknown legacy fields.

## 8. Integration and support evidence

- [ ] 8.1 Extend tests/testing*.test.ts, testing-ssh.test.ts, testing-executor.test.ts, testing-report.test.ts and tests/ui/testing.spec.ts for both editions and both input modes; run the repository's relevant type/build/test checks and verify legacy adapters, native/gateway authorization, terminal/collection coordination and simulation separation remain correct without altering unrelated UI files.
- [ ] 8.2 Deliver documented schema 2 examples, definition-extension review guidance, supported ABI/tool-version matrix, interface coverage/extension matrix and read-only/deferred boundaries; verify each example validates and every supported combination has software evidence or an explicit unqualified limitation.
- [ ] 8.3 Produce a qualification evidence record distinguishing fixture/simulation results from physical-device acceptance; with separately authorized available hardware, record exact board/kernel/driver/tool versions and observations, otherwise record physical acceptance as not performed with the affected support envelope unqualified. Verify no environment reinstall or universal hardware claim occurs.
- [ ] 8.4 Re-run strict OpenSpec validation, review spec/task coverage and preserve original dirty-file hashes before requesting acceptance of implemented work; verify every scenario has evidence or an explicit remaining blocker and no unchecked physical qualification is described as passed.
- [ ] 8.5 Implement the review-fixtures.json capability matrix as controlled software/SSH fixtures; verify no Python, Python 2 only, Python 3 variants, BusyBox applet differences, missing identity/deadline/fd-exec/recovery capabilities, architecture metadata and zero target staging, without calling synthetic fixtures physical qualification.
