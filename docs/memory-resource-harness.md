# Memory and resource regression harnesses

Implements the test machinery for OpenSpec `add-durable-automation-capture` 4.7/4.8. Those tasks
remain open until the exact composed candidate is calibrated, independently reviewed and qualified.
No executed result, CI dispatch, whole-product coverage or leak-free claim follows from adding
scripts.

## Fast serialized Node lane

The memory package commands use Node 24's synchronous module hook and an isolated, content-addressed
SSH JavaScript bundle. `scripts/memory-runtime.mjs` uses the already installed, lock-matched esbuild
and SSH JavaScript dependencies. Its resolver replaces optional `cpu-features`/`.node` imports with
MODULE_NOT_FOUND stubs so ssh2 takes its normal JavaScript fallback; no cipher, host-key or gateway
policy is overridden. All remaining bundle imports must be Node built-ins. No install, dependency
mutation or dependency-tree copy occurs. The ordinary installed tree may still contain a native
binary, and this profile does not assert otherwise or qualify that separate incident.

`validation/memory-runtime/<content-id>/` retains source-input/package/lock hashes, tool version,
bundle and preload hashes. The preload validates identity/content before routing the bare `ssh2`
entry to the bundle; unsupported subpaths, conflicting profiles and unreviewed NODE_OPTIONS loader
injection fail closed. The runtime preflight checks actual resolution and `bindingAvailable:false`.
Stable content paths allow repeated calibration runs in the same exact runtime; paths/platforms and
launch arguments remain part of policy identity, so cross-machine results are not interchangeable.
Direct fixture invocations without this launcher retain the legacy binary-absence preflight.

```sh
npm run test:memory:fast -- --diagnostic=1
npm run test:memory:fast -- --out=validation/memory/review --policy=/absolute/reviewed-policy.json --policy-sha256=INDEPENDENT_REVIEW_SHA256
npm run test:memory:negative -- --out=validation/memory/negative --policy=/absolute/reviewed-policy.json --policy-sha256=INDEPENDENT_REVIEW_SHA256
npm run test:memory:calibrate -- --out=validation/memory/calibration
```

The fast gate requires a reviewed `--policy`; without it the command is blocked. Explicit
`--diagnostic=1` allows provisional collection/calibration and cannot qualify a release. The
calibration runner selects diagnostic mode explicitly. The negative runner requires the exact same
reviewed policy and independent byte hash as the positive gate; it never falls back to provisional
guards. `HUB_MEMORY_POLICY_SHA256` can supply the independent hash in place of `--policy-sha256`.

The proposed Linux step follows `verify` after the unchanged `npm ci`. It uses the same derived
runtime as local memory commands, regardless of optional binary installation. `HUB_MEMORY_POLICY`
must name the reviewed exact-source/runtime policy; without it the step emits a blocked receipt and
fails. The former manual install-profile readiness variable is removed. Both memory receipts and
derived runtime manifests are proposed CI artifacts. This source change and local Windows controls
do not establish a public Linux CI pass; no CI is dispatched and no policy is supplied here.

```sh
npm run test:memory:self
npm run test:memory:gateway-interface -- --out=validation/memory/gateway-interface
```

The self controls verify real bundle resolution, reject a deliberately corrupted private derived
artifact before execution, and reject unbound/failing IPC replies. The gateway interface command
performs one small real connect/clock/disconnect and teardown. Neither command supplies final memory
calibration or a 30-minute qualification verdict. Self controls live under fixtures so the ordinary
application unit suite does not depend on a memory-specific preload.

Three complete warm-up and twelve measured cycles use 1 MiB responses. Each cycle warms/exercises
real SerialSession/FlowRunner/CaptureWriter/native-store success, four streaming exports and
explicit clear; cancel during a held append plus same-generation rearm; quota before begin and
during append. Authenticated loopback SSH uses the production stream host/client, runner, durable
credit, separate stdout/stderr, cancel while append is pending, close acknowledgement, rearm and
disconnect. All transports/servers/stores close every cycle. The same profile reopens after store
close. The optional `--profile=scale` reuses this implementation at 64 MiB; do not add duplicate
large CI jobs.

Test-only factory tokens identify pending repository calls, active writers, read iterators, pins,
exports, subscriptions, RPC/ACKs, channels and producers. Tokens end after actual
completion/release. Private-field test probes deliberately fail when a source change invalidates the
exact store/session ownership contract. Async hooks track referenced and unreferenced Timeout
allocations independently of supplementary `process.getActiveResourcesInfo()` type counts. Port
locks, session owners/queues, catalog closure and same-profile reopen are asserted. This does not
inspect all native allocations.

Samples include startup, after warm-up, during work/exports, before/after store close and complete
teardown. Closed-cycle comparisons occur after the cycle function has returned, two event-loop
turns, an unforced sample and two separated forced-GC samples. Heap, heapTotal, external,
ArrayBuffers and RSS are separate; ArrayBuffers overlap external. The external sampler streams
roughly 250 ms RSS samples to JSONL; timestamps reveal OS-call overhead. Observed peaks are lower
bounds. Sample start/completion/latency timestamps, owned PID, attempt/usable/unavailable counts and
peak are checked. All-null sampled RSS, missing/nonfinite required memory metrics, malformed stage
order, dirty teardown, truncated evidence and collector errors are invalid collections. A legitimate
RSS zero remains zero. Disabled observer controls require an empty sampler file.

No private global handle API or forced `process.exit()` is used. The fast leaf's unchanged total
120-second observation budget reserves its last second for direct-handle TERM/KILL cleanup; scale
retains its separate 900-second budget. Actual spawn, exit and close must all be observed with
matching exit/close code and signal. Exit alone never clears the close deadline. Sync and close are
attempted on every evidence handle despite earlier errors, and the child acknowledges durable
timeline closure separately. Unknown closure produces INVALID and never qualifies. A pathological
unkillable attached OS handle may outlive the observation budget; it is not detached or hidden.
Collector I/O and serialized OS sampler-call latency are recorded separately from the leaf budget. A
timeout never counts as negative-control detection or qualification.

The calibration and negative wrappers establish one same-host monotonic deadline before the
regression parent's preflight. The parent and resource leaf inherit that exact job nonce, deadline
and budget; fast remains 120 seconds and scale remains 900 seconds, with the existing final
one-second cleanup reserve. Preflight consumes this budget instead of shifting the leaf deadline
later. At the deadline, wrappers send nonce-bound cancellation over their owned IPC channel and
never TERM/KILL the middle owner. Parent SIGTERM/SIGINT, cancellation or loss of that channel
forwards cleanup to the directly owned leaf. The parent retains its cancellation handlers and
attached ownership until actual leaf close. A deadline snapshot with unknown close stays INVALID
even if close arrives later; there is no deadline extension or pass promotion. No process-outage
survival is established.

8 MiB heap / 2 MiB ArrayBuffers are **provisional diagnostic guards**, not a newly calibrated
universal gate. Every closed sample is checked against the warmed baseline. First/last-three
medians, slope and all twelve samples are retained; RSS/external remain diagnostic. `--no-sampler=1`
is the matched observer control. Calibration runs ten serial sampled/unsampled pairs, stops at the
first failure, and writes an unreviewed policy draft with raw receipt hashes, ranges and overhead.
It never chooses or increases ceilings. Review clean matched source/runtime receipts and negative
controls, explicitly supply justified ceilings and mark `reviewed:true`. A fast policy must match
source hash, profile/payload, observer and GC mode, exact runtime identity (resolved executable path
and SHA256, Node/platform/arch/versions, execArgv and NODE_OPTIONS), and ten distinct clean receipt
hashes. The full contract additionally binds driver, collector, lifecycle, evidence, validator and
invocation file hashes; checkpoint/workload/deadline protocol; generated SSH manifest, preload,
bundle and their verified package/loader inputs; and actual file-backed launch inputs. Nonempty
NODE_OPTIONS is refused in this finite lane. The calibration draft retains those fields, with the
declared sampled/disabled comparison axis checked on each run and normalized only for cohort
comparison. Recalibrate when the identity or memory-relevant launch configuration changes; no policy
or newly calibrated ceilings are supplied by this patch.

Opt-in controls retain a distinct 1 MiB JS array or 512 KiB Buffer per measured cycle, or
intentionally omit an actual listener, timer or store-pin release. The control runner requires the
matching failure message, outer exit 1/null signal, and diagnostic child exit 1/null signal/no
timeout with `childExit=normal-failure`, actual close evidence at both levels, matching policy hash,
closed evidence and `EXPECTED_NEGATIVE_DETECTED`. The receipt validator checks all 344 positive, 345
allocation-negative or 89 owner-negative timeline rows. JS/Buffer detection must reproduce the
specific numerical violation from raw closed samples under the exact selected ceilings. Signals and
Windows abnormal numeric exits cannot count as detection even when an assertion string was printed.
Exit receipts distinguish normal success/failure, signalled, unexpected code and timeout
termination. Unrelated failures fail the control. Smaller/different leaks may escape. Ordinary
`npm test` includes inexpensive ownership/statistics self-tests; these are not memory qualification.
Receipts are append-only per fresh run; reruns preserve earlier failures.

The pure tests in `tests/memory-fast-contract.test.ts` use impossible `test/fixture/mock` runtime
identities and tiny in-memory ceilings. Their schema fixture `reviewed:true` flag is never a real
policy approval. They establish validator behavior, not a calibrated memory result. See
`docs/nonproduct-lifecycle-probe.md` for the separate, unexecuted dummy lifecycle candidate.

## Thirty-minute lanes and integration hook

```sh
npm run test:memory:soak -- --lane=desktop --gc=normal --component=1 --source-sha256=SOURCE_HASH --out=validation/memory/soak
npm run test:memory:soak -- --lane=browser --gc=normal --component=1 --source-sha256=SOURCE_HASH --out=validation/memory/soak
npm run test:memory:soak -- --lane=gateway --gc=normal --component=1 --source-sha256=SOURCE_HASH --out=validation/memory/soak
```

Repeat separately with `--gc=forced`. Set `HUB_MEMORY_ELECTRON` to the already installed Electron
executable, and `HUB_MEMORY_BROWSER=chromium|firefox|webkit` for browser/gateway. The scripts use
existing Playwright browsers; they do not install anything. Forced Chromium/Electron renderer GC is
a separate reachable-retention diagnostic. Firefox/WebKit forced heap instrumentation is
unsupported; their normal lanes still use actual lifecycle and OS process sampling. Normal runs
collect unforced CDP heap data where available. No CDP remote object handle is retained.
Main/native/GPU memory remains separate from renderer heap; Electron metrics carry documented KiB
units, OS RSS records bytes.

Generate `SOURCE_HASH` with `node --import tsx tests/fixtures/memory-resource-identity.ts .`. The
soak verifies that fingerprint against the actual source before launching. Generated/dependency
directories are excluded; sorted source paths and contents are hashed. Electron's units and process
identity are documented in
[MemoryInfo](https://www.electronjs.org/docs/latest/api/structures/memory-info) and
[ProcessMetric](https://www.electronjs.org/docs/latest/api/structures/process-metric).

The built-in **component** adapter launches a private sandboxed Electron capture IPC fixture, or a
private browser with actual IndexedDB/Serial classes, or browser GatewayClient/authenticated HTTP
SSH. It repeatedly captures >32 MiB, re-arms, streams all exports to a slow bounded sink,
clears/reopens and disconnects. Process identities are PID plus creation time, descendants are
sampled, and final shutdown must leave no owned process. Fixture output is synthetic. Captures are
deliberately cleared; cache/disk state is reported separately. No user database/profile/download is
deleted.

Process history uses distinct PID/creation-time instances, so a replacement descendant stays owned
after PID reuse and reparenting. Unreadable process identity/liveness, including Linux EACCES, fails
measurement; it is not verified termination. A live process with unavailable RSS reports null and a
reason. A root that was never observed cannot silently pass an exit assertion.

The built-in gateway fixture shares the observer Node process, outside the browser descendant tree.
**Gateway Node memory qualification is explicitly unsupported in this adapter.** Browser component
collection cannot qualify that process. A future product adapter must provide an owned isolated
gateway host/role, executable/launch identity, Node memory checkpoints and matched observer
controls.

Every lane requires five representative warm-up minutes, 25 measured minutes and at least 100
complete cycles. A bounded additional five minutes may reach the cycle count; the receipt records
actual duration, and failure to achieve coverage fails. One shared monotonic 40-minute deadline
includes startup and reserves its last minute for cleanup. The supervisor sends nonce-bound IPC
cancellation; it never terminates the harness that owns product descendants. Cancellation stops new
work, starts the adapter's idempotent teardown, and joins outstanding operations, process history
and actual harness exit and close. Unknown closure or failed evidence sync/close stays INVALID with
the owner attached. It does not promise a forced return from stalled I/O or startup. An independent
serialized OS-history observer starts before teardown. The live CDP sample joins before inspection
retires; OS RSS diagnostics continue through store/window/server closure and actual descendant
joins, followed by a final terminated-history sample. Unavailable allocation breakdowns stay null
with a reason; shutdown issues no new CDP/RPC or forced GC. Invalid, missing, late or undurable
observations fail collection. Terminated processes have null memory, never fabricated zeros. The
matched `--no-sampler=1` control disables work-phase continuous sampling; it retains the same
mandatory shutdown history and closed-cycle checkpoints. The assessment config declares both.

Direct `--child=1` requires an IPC supervisor and the exact serialized `--product-job` identity.
This ownership seam alone does not approve a full product execution: a separately reviewed outer
collector must enforce the exclusive marker, bounded journals and actual outer pipe closure, and
sync/close native inspection evidence. Missing native mandatory coverage still blocks warm-up.

Without `--component=1`, required product coverage is exhaustive and missing capabilities fail
before the warm-up. Use `--driver=/absolute/composed-product-adapter.ts` implementing
`QualificationDriver` from `tests/fixtures/memory-resource-core.ts` to add run/repetition/delay and
cancellation at every boundary, quota/timeout/owner loss, pending opens/blocked writes, stale
generations, manual PTY separation, active navigation/hide/true unmount/reload/versionchange,
catalog/search/offscreen selection, export abort/failure and bounded growing catalog (500 rows / 64
MiB). The built-in component driver explicitly marks these missing; its pass status is
`collected-component-lifecycle-evidence` and cannot close a memory or whole-product gate. Per-cycle
zero owner counts mean _abandoned_ owners relative to the adapter's documented mounted
cache/repository baseline, not a demand to destroy a legitimately mounted app.

`--viewer=1` additionally requires the viewer coverage IDs. `ViewerQualificationHook` and the
browser fixture's `attachViewer` integrate exercise/snapshot/dispose without production IPC. Qualify
live open/close, pointer/keyboard/Escape/cancellation/reduced motion, SVG/PNG/PDF exports/failure,
and unmount. Its snapshot must cover RAF/timers/observers/listeners/pointer
capture/workers/canvases/Blob URLs/native PDF windows. Warm modules/fonts, preserve pixel/page
budgets and compare unchanged command/ACK/watchdog traces; no execution deadline extension is
permitted. Absence is unsupported, never borrowed coverage from the component fixture.

Viewer requirements apply even with `--component=1`. Both viewer coverage and exact listener/timer,
RAF/observer/pointer/worker/canvas/Blob/PDF owner probes must be present before warm-up. Advertising
only base component capabilities or dropping viewer owner keys cannot satisfy an explicit viewer
run.

## Reviewed soak memory assessment

Product mode additionally requires `--memory-policy=/absolute/reviewed-soak-policy.json`. Missing
policy or an incomplete/unsupported driver memory scope is blocked. Collection of peaks and
lifecycle coverage alone never yields a memory pass. Default component drivers remain unqualified
collectors.

A complete driver's `memoryScope` declares every retained process role, per-role executable path and
SHA256 plus launch/GC configuration, and explicit unsupported scopes. The assessment identity hashes
that scope, driver/source/versions, the actual harness executable and launch environment, and fixed
lane/GC/observer/payload/duration/grouping configuration. The policy must be reviewed and bind that
identity. Each assessed role/metric budget contains `maxDeltaBytes`, `maxSlopeBytesPerCycle` and at
least ten distinct clean calibration receipt hashes. There are no default soak budgets. RSS/external
remain diagnostic unless separately calibrated and included explicitly for that role.

The bounded assessment consumes fresh quiescent samples after acknowledged cycle teardown,
separately from continuous peak observation. It requires three matching warmed checkpoints per
catalog mode/record-count/process instance and compares every measured retained sample to its warmed
median. It also checks a stable online slope and reports first/last-three medians. Every declared
retained role needs measured checkpoints; unavailable required metrics, new/unwarmed identities or
unmatched catalog state keep the assessment unqualified. Available heap/ArrayBuffer metrics cannot
be silently left outside the reviewed assessment. Warm-up alternates representative constant/growing
modes; legitimate cache/cardinality changes need matched states and reviewed budgets, not an
automatic leak label or fabricated zeros. Bounded state/identity limits fail rather than
accumulating observations without limit.

Only complete coverage, owners, duration/cycles, process exit and reviewed memory assessment can
yield `passed-reviewed-memory-scope` (or the explicitly narrower
`passed-component-reviewed-memory`). The receipt lists unqualified/diagnostic metrics separately;
assessed metrics do not qualify them. Failed, blocked, unqualified collection and diagnostic
outcomes remain distinct. Synthetic verifier tests exercise reported runaway growth, PID
reuse/reparenting, denied process reads, crashes/wrong exits, missing viewer coverage/probes and
healthy controls; they allocate none of the reported growth and run no actual resource cycles.

Full product driver composition, reviewed numeric policies, negative controls, observer controls and
all final platform lanes remain required on the combined candidate. Windows Electron first, then
applicable Linux/macOS and Chromium/Firefox/WebKit. Record headless/GPU/allocator/runtime/artifact
differences. Native-addon causation, real ash/OS PTY/hardware and universal leak freedom remain
separate. Do not mark OpenSpec 4.7/4.8 complete based on this patch or component-only passes.

## Gateway process measurement interface

The built-in gateway component lane now forks the real `createGateway` in an owned Node process and
places its synthetic loopback SSH target in a second owned Node process. The observer retains
neither role's payload allocations. Private test-only IPC is not added to the production HTTP API.
Requests are bounded, serialized and bind a nonce, monotonic request id, PID and role. Replies
include actual `process.memoryUsage()` heap/external/ArrayBuffer/RSS values and runtime
executable/launch identity; OS samples bind PID plus creation time and preserve helper descendants
as separate RSS-only rows. Unavailable helper allocation metrics remain explicit. Continuous
sampling uses normal GC; only a quiescent checkpoint requests two separated forced collections in a
forced lane.

Fixture counters report target clients/channels/pumps, HTTP requests/sockets, servers, async-hook
Timeouts, IPC listeners and active resource types. Live servers/keep-alive sockets/cleanup timers
are documented service state, never fabricated zeros. Full shutdown must join close/destroy/pump
notifications and report zero resources before IPC release; release removes the fixture's message
and disconnect listeners, acknowledges their zero counts and then exits with code zero/no signal.
The parent separately asserts every observed descendant exited. Timeout, missing metrics, protocol
mismatch, signal/nonzero exit or forced cleanup fail the interface. The observer queue is bounded.

This interface closes the observer-process attribution gap. It does not expose the production
gateway's private session/attempt/stream/ACK/reader ownership; a composed adapter or primary-owned
read-only test hook must supply those exact probes. The component driver still declares incomplete
browser/native/loader retained-allocation scope and cannot accept a reviewed whole-product memory
policy. Loader caches, bounded gateway caches and durable store retention require separately matched
warm states; two samples from the interface smoke cannot establish a leak or a calibrated bound.

## Node HTTP Date-cache teardown acknowledgement

Node 24's automatic HTTP Date header uses one process-global, unreferenced cache-expiry Timeout that
naturally fires at the next wall-clock second. Closing every gateway connection does not cancel that
runtime cache. Counting it as an abandoned gateway timer after a fixed number of event-loop turns
produced a real false failure. Optional stack collection changed the timing of observation; it did
not establish a production leak or prove teardown by itself.

The gateway fixture ledger still tracks every referenced/unreferenced Timeout. It identifies this
specific runtime owner only from unref-at-init plus the Node internal setUnrefTimeout/cache/utcDate
stack chain. After all fixture servers/connections/requests/pumps close, unknown timers immediately
fail. At most one identified runtime cache may be pending; shutdown joins its actual callback and
async destroy acknowledgement, then requires total timers zero. It does not clear or ignore the
cache, extend the existing parent RPC deadline, change Date headers/clocks, or relax execution
watchdogs. Changed/unrecognized provenance fails closed. Records retain creation/callback/destroy
times. Only ids and bounded provenance metadata are retained, never Timeout resource objects.

```sh
npm run test:memory:self
npm run test:memory:gateway-interface -- --out=validation/memory/gateway-date-control --fresh-date-cache=1
```

The fresh-date control completes real authenticated connect/clock/disconnect, then schedules a real
HTTP health request near the start of a second without patching time or headers. It requires exactly
one live runtime cache to be joined and normal process teardown. If the intended timing condition is
not observed, it fails rather than claiming the regression was exercised. Supplementary self
controls create actual long referenced/unreferenced timers and reject an unreleased resetCache-named
lookalike. They do not replace the real gateway regression or the final calibrated negative-control
matrix. Historical failed receipts remain failures; this correction explains the reproduced false
positive.

Gateway host startup and cleanup distinguish an actual exit event from failed start (error plus
close with no assigned PID) and unknown liveness. A failed start never fabricates a normal exit.
Both release and forced-cleanup waits are bounded by the existing ten-second maximum; unknown
termination, failed send/kill and surviving observed descendants remain failures. The original
failure is retained when cleanup also fails. Startup sampling registers each assigned root before
its initialization RPC and retains independent creation/descendant history for each host, including
a host whose initialization fails. Self controls include a real missing-executable fork plus
explicit mocked error/close/no-exit, send/kill, second-host and abnormal-termination scenarios.

## Startup process history and partial starts

Each PID-backed fixture root is registered and sampled before its initialization RPC, including a
PID assigned by a later spawn event. Its creation identity and descendants have independent history;
platform-table reads are shared across the concurrent root observers. An initialization error
refreshes every available history while roots are still alive, then terminates the owned root
handles and checks all observed descendants. One unreadable root cannot suppress another root's
history. A known error/close with no PID remains a failed start, never a fabricated process exit.

Missing/changed PID, unavailable creation identity, failed observation, root exit before the final
history refresh, or partial fork uncertainty permanently marks cleanup unverified for that run. A
later clean table does not erase the gap. The original failure and cleanup details remain linked.
There is no attempt to find or kill ambient processes by name or reparented processes of unknown
ownership. Assertions cover observed history; they cannot prove that an OS process never existed
between snapshots.

Normal teardown refreshes all active roots before closing any host and again after each shutdown
acknowledgement while that root still exists, before releasing its IPC/exit permission. This
captures helpers created during shutdown. Unsolicited replies record a failure for manager cleanup
instead of killing a root before its history can be refreshed. Final assertions require complete
known history plus exit of every observed descendant. Accepted HTTP Date-cache accounting, timer
zero requirements, actual-exit semantics and existing deadlines are unchanged.

The additional focused controls use the actual manager and ProcessSampler with synthetic child
signals/process rows. They cover first/second-host init failure, helpers created during init and
shutdown, clean versus surviving helpers, delayed/missing/changed identity, denied reads, missing
creation time, premature root exit, partial fork uncertainty and unsolicited replies. Those are
ownership-bookkeeping regressions, not actual OS orphan incidents or final memory qualification.

The driver enters its closed state only after the final history/descendant assertion succeeds. A
failed close cannot subsequently publish zero owners as though cleanup had been verified.

Startup cancellation and the same monotonic work deadline propagate into browser/native/gateway
helpers. Each subsequent resource admission is checked after awaited build/listen/launch stages.
Already admitted handles remain owned until cleanup; an unreturned stage stays unknown and attached.
Private gateway children receive the same deadline and nonce-bound startup cancellation before
opening their private fixture listeners. No deadline is extended and no owner is killed.
