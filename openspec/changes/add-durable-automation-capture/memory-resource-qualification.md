# Memory and resource lifecycle qualification

Target v0.6.0. This is a test/CI plan, not executed whole-app leak qualification. No CI run is
dispatched here.

The independent read-only coverage audit confirms that current CI uses Node 24 across platforms but
has no general memory-leak gate. Existing bounds, cleanup and stress tests are useful narrow
evidence. Windows/macOS 100-minimize cycles do not assert memory. The listener assertion in
tests/serial-desktop-smoke.ts has no package/workflow caller. tests/fixtures/capture-memory.ts is a
standalone 64-MiB forced-GC storage fixture, excluded by the tests/*.test.ts package script and not
CI. Its retained heap <8 MiB / ArrayBuffers <2 MiB checks and previously reported 305,288-byte
retained heap are historical fixture evidence, not this increment's measurements. Sampling begins
after 8 MiB and ends before store close. It does not assert peak
RSS/external/native/Electron/browser/gateway memory or repeated lifecycle teardown.

## Fast regression layer

- Extend the existing Node 24 tests/*.test.ts path with production SSH lifecycle/resource tests; do
  not add a competing new workflow or dispatch CI. Warm up once, then repeat connect/disconnect and
  run/cancel/rearm. Assert exact owned channels, session owners, connections and pending readers
  return to the expected baseline after acknowledged cleanup; verify listener/timer/handle
  accounting wherever the production boundary exposes ownership. Include store close and
  fixture/server teardown, not just a capture-complete sample.
- Reuse existing storage bounds/integrity tests and the reviewed 64-MiB fixture. Wire a deliberately
  named fast memory diagnostic/regression command only after comparing the audit's actual callers
  and supported Node/Electron runtimes. Do not duplicate that large fixture under several test names
  or silently label a standalone script CI-covered.
- Record heapUsed/heapTotal, external, ArrayBuffers and RSS separately at startup, warm-up, steady
  cycles, immediately before/after store close and after complete teardown. Track peak samples
  during work separately from retained samples after quiescence. Forced GC is an optional
  child-process diagnostic and must never be a product requirement or substitute for unforced memory
  behavior.
- Derive retained-memory budgets and trend tolerances from repeated matched-runtime baselines and
  allocation scale; keep raw samples, payload/source/runtime/config hashes and failures. Regressions
  should fail on reproducible growth exceeding an evidence-backed budget or an exact unreleased
  owner/resource. Do not invent a tiny universal RSS threshold, use a single noisy sample as proof,
  or claim zero leaks from a pass. Intentional caches and persisted disk records must be accounted
  for explicitly.

## Longer qualification outside the fast per-push suite

Use an explicitly invoked, bounded soak with warm-up plus repeated matched batches and complete
teardown. Qualify Node/gateway, Electron main and renderer, and Chromium/Firefox/WebKit where the
feature is supported. Record each process and native buffer/RSS boundary; renderer JS heap alone
cannot cover Electron main, native SQLite, SSH buffers or browser download workers. Start sampling
before warm-up and continue through store closure, window/browser/server shutdown and final handle
settlement.

Cover repeated connect/disconnect; run/cancel/rearm at async boundaries; transport/page switch and
true unmount; capture/search/selection/export/cancel/clear/reopen; stalled and failed sinks;
reconnect with stale callbacks; and graph open/drag/export/close once implemented. Include timers,
DOM/EventEmitter/IPC listeners, HTTP readers, pending RPC waits/ACKs, handles, sockets, workers and
storage/read/export leases. Persist results intentionally, verify expected disk growth separately,
then explicitly clear only test-owned records and distinguish reusable caches from unreachable
allocations. Do not fill a user's disk or force OS memory pressure.

For every soak, retain sample timelines and exact resource counters plus
duration/cycle/payload/runtime/OS/source/config, warm-up policy and baseline. Report
pass/fail/skipped/not-run and the strongest conclusion supported by the observations. Use stable
plateaus or batch-to-batch growth, not an arbitrary zero-growth requirement. Longer soak may become
a separately authorized scheduled/manual CI job after source review and stable local baselines; no
runner purchase, workflow dispatch or publication is authorized by this plan.

## Current execution status

This plan adds no executed memory results. The new production SSH tests exercise durable flush
credit and cleanup ordering; their forthcoming source-specific logs will be separate evidence.
Whole-app memory/native-buffer/RSS/browser/Electron soak qualification remains open, as do actual
DUT/driver/platform acceptance and any unsupported runtime.

## Incorporated independent implementation-ready plan

The read-only reviewer supplied Task/serial-fix-evidence/v0.6.0-memory-resource-regression-plan.md,
SHA256 54cfc1acf99bbf84ecb7082cc39c9a47628c65ed874763b74d78cc9b922ea3cb. It supplements this
document and adds no executed tests or CI wiring. Its concrete work is represented by tasks 4.7/4.8;
do not replace existing ownership or duplicate the 64-MiB storage fixture under several names.

Proposed (not present): npm run test:memory:fast, invoking node --expose-gc --import tsx
tests/fixtures/memory-resource-regression.ts --profile=fast. Run one serialized <=2-minute lane
after verify in an existing Ubuntu Node 24 job, separately from parallel unit/browser work. Use
three complete warm-up cycles plus 12 measured 1-MiB cycles through real
repository/writer/runner/implemented transports. Rotate successful capture/export/clear,
cancellation during append plus real rearm, and quota before begin/during append. Each measured
cycle joins producers/readers/pins/exports/ACK/RPC/HTTP/input/cleanup, closes stores/SQLite and
sockets/servers, and proves a child exits naturally. Exact test-owned factory/disposer counters and
acknowledged closures are primary; process.getActiveResourcesInfo is supplementary and misses some
handles and unreferenced timers. Do not expose production debug IPC or use private global-handle
assertions.

Sample before warm-up, during work, around store close and after complete teardown. Keep unforced
samples separate from two quiescent forced-GC samples with event-loop turns. ArrayBuffers overlap
external memory, so do not add them. Compare matched closed-cycle first-three/last-three medians,
slope and all samples at constant payload/cardinality/state. Existing 8-MiB heap/2-MiB ArrayBuffer
ceilings are provisional Node diagnostics; require ten clean matched-runtime runs and a reviewed
per-runtime policy before new lifecycle budgets become mandatory. RSS/external stay diagnostic until
independently calibrated. Preserve failures and never raise ceilings automatically.

Required opt-in detection controls retain distinct 1-MiB JS allocations, 512-KiB Buffers, and omit
listener/timer/pin releases separately; each must fail its corresponding check. A bounded external
roughly 250-ms RSS/process sampler records observed peak as a lower bound, streams JSONL and
compares observer overhead with a no-sampler control. Capture failure-only heap snapshots only from
stopped nonsecret synthetic sessions; release inspected Playwright/CDP handles.

Longer lanes are 30 minutes: five representative warm-up minutes plus 25 measured minutes and at
least 100 completed cycles. Normal GC and separate forced-GC diagnostics are separate outcomes.
Cover run/cancel/rearm and every async boundary; real adapters/independent streams and manual PTY
separation; navigation/true unmount/reload/versionchange; >32-MiB slow capture,
search/page/selection, every export format and failure/clear/reopen; graph lifecycle/exports after
implementation; and full store/UI/process teardown. Include a constant-cardinality profile and a
bounded growing catalog (e.g. 500 rows/64 MiB) to distinguish legitimate disk/cache scaling. An
exited process is terminated, not a fabricated zero-byte heap sample.

Measure Electron main/renderer/GPU/utility/PDF and browser/gateway processes separately with stable
PID+creation-time identity and documented unit normalization. Unavailable Firefox/WebKit heap
instruments are unsupported, not zero. Start with Windows Electron 44.5.1, then applicable Linux,
macOS Intel/ARM and Chromium/Firefox/WebKit. Keep
source/policy/config/runtime/GC/warm-up/cycle/disk/ resource/sample/peak/median/slope/failure
evidence bounded and hashed. Actual driver/DUT/ash/PTY, OS cache and universal leak freedom remain
separate.

The new SSH milestone contributes exact focused resource assertions and real close/reopen evidence,
not this calibrated general memory harness. None of the proposed memory lane, negative controls,
calibration, serialized CI wiring or 30-minute soaks has run or been implemented here.

## Retained native-addon incident and shipping profile qualification

The independent follow-up is Task/serial-fix-evidence/ssh-stream-review-followup.md, alongside
runnable suspension/cancellation probes and their JSON results. It preserves the original
production-completion-corrected.log (SHA256
dc1d321ece9f7e4aa993adba9982a5a680c1e70c14863e96ab22fc3a0688949b), which identifies plain Node
24.21.0 and an AES-GCM ObjectWrap cleanup-hook abort. Current runtime/addon hashes are not verified
crash-time hashes. Later green tests do not establish causation or erase the failure.

The reviewer found the matching upstream bug class and fixes, then verified Electron 44.5.1's patch
inventory already carries both cleanup-hook corrections. Its embedded Node version alone does not
justify updating Electron. Node 24.22.0 is an upstream-fixed comparison candidate for a separately
authorized native-addon investigation, not an installed or tested runtime here. No blanket
runtime/dependency update, rebuild or host-policy change is indicated.

The inspected retained v0.5.2 installer excludes the native addon in ASAR and unpacked payload; the
documented fresh gateway install uses ignore-scripts as well as omit-optional. Those facts and the
staged cryptoBindingAvailable:false dependency tree support an intended JavaScript-only profile.
They do not prove future v0.6.0 packaging, a fresh Linux deployment or native-addon support. The
unrelated release/win-unpacked ASAR is version 0.3.0 and must not be cited as current.

Keep task 4.9 open for two separate claims: final artifact/profile containment and supported
production lifecycle qualification; optional native-addon causation/support qualification. For final
artifacts inspect both desktop payload locations and actual gateway archive/fresh dependency tree,
hash artifacts and dependency modules, record runtime/ABI/loader provenance, assert binary absence
and inspect bindingAvailable from the production backend's actual module context. A caught ABI load
failure is not binary absence. Run serialized deadline-bounded short stdout/stderr, nonzero exit,
pending-data cancel/finalize/disconnect cases with truthful gaps and normal process exit. No DUT or
physical UART is required for these local fixtures.

If native mode will be supported, separately retain build headers, runtime/addon hashes, ABI, actual
loaded binding and negotiated cipher. Use upstream context-free-GC regression plus six to ten
isolated production lifecycle children under an authorized matched old/new runtime. Require
reproduction of the same old assertion and a new green result before claiming the local incident
fixed. Green old runs leave causation unproven. Never relax cipher/host-key policy or assume a
system-Node binding is Electron compatible. Final JavaScript-only shipping gates can close when
their own artifact/lifecycle evidence is complete; that does not close native-addon support or the
calibrated memory/soak gates.
