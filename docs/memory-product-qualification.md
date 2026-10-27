# Product memory qualification handoff

Status: invocation tools and review recipe only. No actual calibration, reviewed thresholds, product
measurements, platform runs, CI dispatch, or release approval are supplied by this patch. Primary
owns product probes, lifecycle joins, the aggregate adapter and the serialized measurement window.
The platform worker owns workflow and artifact/installer edits. The machine-readable command and
coverage inventory is [memory-qualification-matrix.json](memory-qualification-matrix.json).

## Freeze and identify the candidate

Compose all accepted deltas before collecting calibration data. The input to this patch was the
immutable 519-file combined candidate, fingerprint
`6fbf7f4d4dcce9af1944a3e15e483e144653be3325740e3fd5b4c89f4e9e7e1d`, whose package version was
**0.5.2**. Neither that hash nor its development artifacts qualify a later v0.6.0 candidate.
Recompute the source inventory and artifact hashes after versioning/composition; freeze the actual
installed dependency/runtime identities too.

Use the source runner, which preserves `import.meta`. A generic CommonJS test bundle previously
failed to load the verifier and is not a substitute. No dependency-tree copy or optional SSH
accelerator is needed: the wrapper creates a content-addressed JS-only SSH profile and records its
inputs. It excludes optional accelerators from that derived profile; it does not explain or repair
the separately unresolved native-addon crash.

```sh
node scripts/memory-runtime.mjs --entry=self tests/memory-resource.test.ts tests/memory-resource-verdict.test.ts
node scripts/memory-runtime.mjs --entry=identity --identity-for=fast --out=validation/memory/fast-runtime.json
node scripts/memory-runtime.mjs --entry=identity --identity-for=scale --out=validation/memory/scale-runtime.json
node scripts/memory-runtime.mjs --entry=identity --identity-for=soak --out=validation/memory/soak-harness.json
```

Identity commands inspect the actual harness executable, flags, source and SSH profile. They do not
launch a product adapter, exercise a workload, sample memory, or identify Electron/browser/helper
roles. The fast identity includes the same `--expose-gc` setting as its enforcing child; the soak
harness identity does not add this flag. Product forced-GC hooks belong to the adapter. Environment
changes, including `NODE_OPTIONS`, invalidate matching calibration.

Only primary schedules measurements. Acquire the shared `diagnostic-hub-v060-check.lock` with
create-new semantics, recording owner/token/PID/start and purpose. Refuse an occupied lock. Never
remove another owner's marker; release one's own marker only after every owned child has joined. Do
not run lanes concurrently or dispatch CI from this packet. Put generated evidence, staged policies
and driver profiles under excluded `validation/`; do not change source during a run.

## Calibrate the Node component lanes

In primary's window, run each profile separately on the final candidate/runtime:

```sh
node scripts/memory-runtime.mjs --entry=calibrate --profile=fast --out=validation/memory/calibration-fast
node scripts/memory-runtime.mjs --entry=calibrate --profile=scale --out=validation/memory/calibration-scale
```

Each command serializes ten sampled/unsampled pairs. Each actual child performs three warmup and
twelve measured cycles: 1 MiB for fast, 64 MiB for scale. The fast child supervisor allows 120
seconds and scale 900 seconds; these are termination bounds, not observed durations or CI timeout
recommendations. Collection refuses an abnormal/signal exit, timeout, sampler failure, unexpected
mode/profile/payload, missing twelve samples, mixed identity, or non-diagnostic receipt. First
failures remain evidence; do not retry into acceptance.

The output `policy-review.json` remains `reviewed:false` with `ceilings:null`. Its hashes refer to
actual measurement files, including unsampled controls. Review all raw timelines/receipts, warmup
stability, retained heap and ArrayBuffers ranges/trends, observer time overhead, resource teardown
and actual negative-control sensitivity. ArrayBuffers overlap external memory; do not add them as
disjoint totals. Peak RSS is a roughly 250 ms sampled lower bound. Component bounds do not qualify a
complete desktop/browser/gateway product. VM orchestration tests and synthetic schema-policy
fixtures are not calibration data.

An independent review must justify any byte ceilings from actual evidence and record that reasoning
with the receipt hashes. No maxima-to-threshold promotion or arbitrary budget is implemented. Fast
and scale require separate reviewed policies, as do sampled and disabled observer modes.

Provide **exact reviewed JSON bytes** in `HUB_MEMORY_POLICY_JSON` and their independently reviewed
SHA256 in `HUB_MEMORY_POLICY_SHA256`. The metadata command writes them without reserialization to
`validation/memory-policies/<sha>.json`, checks source/runtime/flags/profile/payload/observer
identity and requires ten distinct calibration hashes. Reusing that path verifies identical bytes;
source destinations, aliases and unrelated existing bytes are refused. A policy committed into the
hashed source would create a circular source binding, so stage externally reviewed bytes in excluded
generated storage.

```sh
node scripts/memory-runtime.mjs --entry=policy --policy-kind=fast --profile=fast --out=validation/memory/fast-policy-stage.json
node scripts/memory-runtime.mjs --entry=fast --profile=fast --policy=<policyPath-from-stage-receipt> --out=validation/memory/fast-gate
node scripts/memory-runtime.mjs --entry=negative --policy=<same-reviewed-fast-policy> --out=validation/memory/negatives
node scripts/memory-runtime.mjs --entry=policy --policy-kind=fast --profile=scale --out=validation/memory/scale-policy-stage.json
node scripts/memory-runtime.mjs --entry=fast --profile=scale --policy=<separate-staged-scale-policy> --out=validation/memory/scale-gate
```

Set the environment to the matching reviewed policy before each staging operation. The enforcing
child checks identity again. The five actual negative controls retain JS, Buffers, listeners, timers
and store pins. They must exit normally with code 1 and a control-specific failure; timeout, signal,
malformed policy or unrelated setup failure cannot count as detection. Passing `--policy` now
forwards the real gate policy; diagnostic-only controls use provisional bounds and cannot establish
sensitivity for a reviewed policy.

## Collect full product calibration evidence

The default component adapters are deliberately insufficient for full product qualification. Primary
must first supply the actual product adapter, all required owner probes, complete
lifecycle/transport/export/navigation/viewer coverage and declared role identities with no
unsupported fields. Missing requirements block before the warmup. Request the viewer integration
hook explicitly for the accepted viewer candidate.

Use an explicit adapter with `--calibration=1` to collect **unreviewed** product evidence before
thresholds exist. This mode forbids `--component` and `--memory-policy`, retains the complete
product coverage/owner/scope checks, and exposes the same fixed-duration checkpoints. It never
declares a memory pass or writes thresholds.

```sh
node scripts/memory-runtime.mjs --entry=soak --calibration=1 --lane=<desktop|browser|gateway> --gc=<normal|forced> --driver=<frozen-actual-adapter> --source-sha256=<fresh-source-hash> --viewer=1 --out=validation/memory/product-calibration/<lane-gc-pair-run>
```

Run normal GC and supported forced diagnostics separately: 5 minutes warmup plus 25 minutes
measured, at least 100 measured cycles, with the existing hard cleanup/supervisor bounds. There is
no shortened calibration option. For each exact reviewed scope collect at least ten actual sampled
receipts and matched unsampled controls (`--no-sampler=1`); bind observer modes separately. Do not
manufacture calibration from driver mocks, model scenarios, component receipts or unavailable memory
metrics. `collected-product-calibration-evidence` means only that raw collection completed its
lifecycle contracts.

Preserve the `assessment-context` record's **data object** as a separate JSON file under
`validation/` for review; preserve the original timeline and its hash as evidence. It contains the
assessment identity and its source, adapter, harness, declared process scope and fixed
configuration. `quiescent-checkpoint` records retain catalog mode/count, disk bytes, cache notes and
process identities/metrics for every warm and measured checkpoint. Context identity is the SHA256 of
`JSON.stringify(context)` with the emitted key order; do not reorder or edit the context. Review its
exact file bytes and provide their SHA256 in `HUB_MEMORY_ASSESSMENT_SHA256`.

The enforced assessment needs at least three warmed checkpoints **for each matched
catalog-mode/diskRecords and PID+creation series**. A never-warmed growing catalog state or a new
renderer PID after reload cannot borrow another baseline. Primary must implement a real matching
warmup strategy and account explicitly for ephemeral roles; unresolved identity/state churn is a
qualification blocker. Never forge stable PIDs, erase retained roles, or relabel growing state to
obtain a pass. Exact owner accounting remains mandatory at each quiescent checkpoint and after full
store/driver closure.

After independent review produces a policy bound to the actual assessment identity and
per-role/metric delta and slope evidence, stage it and enforce:

```sh
node scripts/memory-runtime.mjs --entry=policy --policy-kind=soak --assessment-context=<reviewed-context-file> --driver=<same-frozen-adapter> --lane=<lane> --gc=<normal|forced> --viewer=1 --out=validation/memory/product-policy-stage.json
node scripts/memory-runtime.mjs --entry=soak --lane=<lane> --gc=<normal|forced> --driver=<same-frozen-adapter> --source-sha256=<fresh-source-hash> --memory-policy=<policyPath-from-stage-receipt> --viewer=1 --out=validation/memory/product-gate/<lane-gc>
```

Staging validates the assessment identity, current source/harness/driver entry bytes, full
configuration, non-component scope, roles and reviewed policy schema. It does not import the adapter
or confirm the runtime role identities. The actual driver must rediscover them, and the enforcing
soak recomputes the assessment identity before measurement. Transitive adapter code is covered by
the frozen source/artifact inventory. Product roles must include applicable renderer, main,
helper/utility/GPU, gateway and synthetic target processes with real executable/launch identity and
engine/OS/session flags. Missing/unsupported metrics are null with a reason; termination is a
distinct state, never zero memory. A fully instrumented durable disk checkpoint cannot be null.

Cache retention and durable disk cardinality must be explained and compared at matching states
separately from abandoned ownership. Keep the existing 500-record/64-MiB product disk safety bound;
it is not a memory leak threshold. Firefox/WebKit forced-GC applicability needs a genuine supported
adapter hook or an explicit reviewed applicability decision; Chromium evidence cannot qualify
another engine.

## Workflow adoption contract (platform owner)

The current Linux workflow calls memory after `npm run verify`, but takes `HUB_MEMORY_POLICY` as a
path, floats Node `24`, allows three minutes for that step, and caps the entire build job at thirty
minutes. Those settings do not establish reproducible calibration and cannot contain a thirty-minute
soak plus startup/cleanup. No workflow is changed here. Pin the actual calibrated Node patch,
runner/container, installed inputs and artifact scope when reviewed evidence exists. Keep the fast
gate serialized after verify; put six product lanes in deliberately scheduled jobs with adequate
complete lifecycle budgets. Avoid a parallel matrix competing for one host/window.

The following Linux step body is an invocation contract for the workflow owner, not a dispatched or
validated hosted run. Supply reviewed JSON/SHA via the workflow's reviewed configuration; retain all
output even on failure. Validate the stage command's normal success before invoking the gate.

```sh
node scripts/memory-runtime.mjs --entry=identity --identity-for=fast --out=validation/memory/ci-runtime.json
node scripts/memory-runtime.mjs --entry=policy --policy-kind=fast --profile=fast --out=validation/memory/ci-policy-stage.json
node -e 'const fs=require("node:fs"),cp=require("node:child_process");const p=JSON.parse(fs.readFileSync("validation/memory/ci-policy-stage.json","utf8"));if(p.status!=="staged-reviewed-policy-bytes")process.exit(1);const r=cp.spawnSync(process.execPath,["scripts/memory-runtime.mjs","--entry=fast","--profile=fast","--policy="+p.policyPath,"--out=validation/memory/ci-fast"],{stdio:"inherit",windowsHide:true});process.exit(r.error||r.signal!==null||r.status!==0?1:0);'
```

Use the workflow shell's fail-on-error behavior. A missing policy produces a bounded
`failed-metadata-check` receipt and exit 1; it does not start a memory workload or fall back to
diagnostic mode. Upload `validation/memory/` and `validation/memory-runtime/` with `if: always()`;
do not overwrite first-failure evidence. Package aliases already route through
`scripts/memory-runtime.mjs`; this patch adds metadata entry points without modifying
package/workflow owners' files.

## Remaining qualification gates

All actual measurements remain unrun in this packet: final combined source freeze, complete product
adapter/role scope and warmed-state strategy, per-runtime calibration review, fast/scale positive
and five real negative controls, six 30-minute product lanes, and Windows/Linux/macOS plus
browser-engine/shipping-artifact applicability. Native-addon causation and installation/EPERM
failures remain separately unresolved. Release readiness and any leak-free claim are not established
by a passing test suite or raw collection status.
