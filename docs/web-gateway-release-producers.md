# Shipping web/Gateway producer path

This source supplies a real, explicit **web build/archive producer entry**, not a full-product pass.
It has not been executed. The current entry supports Node24 on Linux/macOS; the existing source
provider does not support Windows executable-mode observations. Package/storage and execution holds
apply; no workflow, normal package command or publication consumer invokes it automatically.

`scripts/produce-web-archive.mjs` accepts exactly eight explicit arguments: `scope`, `version`,
`source-commit`, `source-tree`, `run-id`, `run-attempt`, `job-key` and `output`, each in
`--name=value` form once. Scope must be `web`. Source/run/attempt/job arguments must match the
admitted GitHub job environment and repository. These environment comparisons are **not independent
service provenance**; a future reader must correlate the actual terminal service run, job, attempt
and output independently. The output must be one new directory immediately under an existing
canonical `validation/` directory. An existing output directory is refused, with no overwrite, retry
or removal.

## Recorded build facts

The entry observes the complete committed-source inventory with the existing raw Git/source
provider, checks actual `package.json` bytes and version against that inventory, and captures the
actual Node builder executable file hash, versions/flags and resolved Vite entry path/hash. It then
invokes the installed Vite CLI directly with the frozen shipping `vite.config.mts`, web mode,
relative portable base and a fresh isolated site output. It installs nothing, uses no private
harness transform and starts no browser, Gateway or SSH target. Ambient Node injection and
VITE-prefixed inputs are refused; `NODE_ENV=production` and `WEB_BASE_PATH=./` are set only for the
build child.

The command now uses the bounded asynchronous direct-child owner described in
[web producer integration](web-producer-integration.md). Only an observed positive PID, spawn,
code-zero unsignalled exit, matching child close, both pipe closures and acknowledged listener
removal can advance. Its required `custody` record binds the fixed observation/output limits and
bounded output hashes. A rejected, missing or pending outcome cannot collect output or write an
archive. Failure remains latched after later closure. This is direct-child observation, not
independent descendant retirement or execution authority. The future job still needs an admitted
owner, resource/environment bounds and a separately approved whole-job failure policy. No signal,
forced cleanup, process-exit shortcut or retry is added.

Complete regular-file output is captured under the same source identity; aliases, links, special
files, unsafe member names and missing HTML/export-worker entries fail. The producer uses the
existing synchronous `fflate` ZIP encoder and roundtrips its **own newly encoded bytes** against
that captured inventory. This is not a new parser for untrusted uploaded ZIPs. The previously
reviewed separate archive-admission inspector remains the independent later readback boundary.

Source, Vite/Node observations and output are rechecked before and after exclusive archive
publication. The archive is reread through a bounded stable single-link file handle. Its canonical
SHA256 sidecar is also written exclusively and reread. `web-build.json` is written exclusively and
reread with the same byte/hash acknowledgement. A post-write failure retains existing output and
fails; it does not erase the archive or pretend publication was undone. There is no automatic retry.
Writes are not an assurance of crash durability or immutable custody after observation.

The `web-source-build-archive` v1 record binds:

- Explicit source commit/tree/version and run/attempt/job key.
- Canonical committed-source bridge bytes and their SHA256.
- The builder observation, exact fixed command and explicit build environment inputs.
- Normal returned build-command outcome and complete payload path/byte/hash inventory.
- Exact canonical ZIP and checksum-sidecar filenames, bytes and SHA256.

A `built` file can remain after a later write/readback failure. It is never a substitute for the
producer's normal terminal command/job outcome, independently correlated service metadata and exact
selected output bytes.

`status:built` means these build/archive steps completed. `releaseAcceptance` remains false, and
`productRuntime`, `loaderProvenance`, `normalGC` and `forcedGC` remain null. No standalone record
can satisfy `staged-artifact-producer`, and the existing unconditional release block is unchanged.

`validateWebArchiveBuildRecord` and the strict bounded UTF-8/JSON byte reader define this partial
record schema. They reject source/run substitution, qualification relabeling, missing/null
measurement replacement, aliases and inconsistent references. These are data checks, not a verifier
of supplied archive bytes or independent service provenance; future readback must do both.

The record does not authenticate the job, attest all installed transitive toolchain bytes or prove a
mapped process image. Source snapshots/command observations assume a trusted job workspace; they do
not defeat a malicious same-user process that swaps and restores files between observations. The
builder executable's path/hash is **not a shipping browser or Gateway runtime identity**. Nothing
here claims real browser behavior, calibration, a memory pass or normal retirement.

## Bounds and effects

Vite custody remains separate from whole-producer/descendant proof. Opt-in async Git and owned
file/publication capabilities are now prepared, but default native execution has no capability grant
and remains held. The record's fixed environment overlay is distinct from the new selected
complete-profile digest; real environment/toolchain/OS admission is still required.

The existing archive-admission bounds are retained: 128 MiB compressed archive, 256 MiB total
payload, 64 MiB/member, 4,096 entries and 1,024 UTF-8 path bytes. Stable file reads use 64 KiB
chunks. The combined build record has a separate 16 MiB storage bound. Exceeding a bound fails
without truncating evidence. These are inspection/storage admission bounds, not device limits,
resource pass thresholds or CI disk quotas. Encoding holds the captured payload, decoded self-check
and archive in memory; a future job must admit that memory plus build/toolchain resources
explicitly. The entry refuses a shared/symlinked `node_modules` directory and requires the resolved
Vite entry inside that local dependency tree. A future job must use its own fresh checkout and
installed toolchain. No dependency installation or permission/security change is requested here. The
inspected Vite loader can create/remove generated configuration files under
`node_modules/.vite-temp`, with a fallback beside its config file, and its unlink callback ignores
errors. Future execution admission must cover those tool-owned scratch effects and independent
cleanup checks. No scratch cleanup or dependency modification has been exercised in this task.

## Gateway and release blockers

The normal `scripts/package-gateway.mjs` command now reuses `projectGatewayLock` before allocating
its staging directory and `validatePreparedGatewayLock` on npm's returned lock before archive
publication. The shipping path therefore rejects changed dependency identities, extraneous packages
and incorrect required/optional flags rather than treating npm exit zero as proof of a pinned lock.
This is a packaging input guard, not installed-dependency provenance, runtime qualification or a new
release receipt. Its focused tests execute the actual script with memory-only filesystem and child
ports; no npm command or filesystem archive write runs. The normal packager and prepared producer
now share the canonical eight-file USTAR writer. Payload snapshots use the existing bounded
descriptor reader, retain the validated manifest/lock, and normalize archive ownership, timestamps,
modes, paths and end padding. Node's bounded synchronous gzip replaces external tar; the strict
readback consumer is unchanged. This is byte compatibility, not provenance, retirement, runtime or
release qualification.

Gateway requests through this web CLI fail before build or allocation. A separate prepared Gateway
engine now exists in `gateway-archive-producer.mjs` and `owned-gateway-stage.mjs`, with staged-lock
validation and a source-bound tar census. Its safe synthetic checks do not supply an admitted live
executor or actual package/job evidence. The final-tar and retained-dependency observers and the
separate instrumented ownership entry are likewise preparation, not a shipping Gateway pass.
Borrowing a web ZIP record, private JS-only SSH profile or Node harness observation is unsupported.

Next execution prerequisites include independent service/artifact readback, actual admitted package
bytes, owned executor/OS-group retirement and separate instrumented versus shipped CLI evidence.
Actual loader and installed-dependency provenance, browser engines/applicability, per-GC reviewed
calibration/policy, full-product measured results (at least 30 minutes and 100 measured cycles per
required GC mode), retention and acknowledged normal cleanup remain required. Ten installer/product
output declarations and authoritative accepting semantic consumers are still missing from the
release graph. No upload name, schema-shaped fixture or diagnostic supervisor graph fills those
obligations.

Tests use raw synthetic Git objects/source data, fake build outcomes/runtime/filesystem handles and
the actual synchronous ZIP codec. They do not execute this CLI, a compiler, package, Node product,
server, browser, native application or device. Real producer execution remains unqualified and held.

## Explicit final-ZIP startup engine lanes

`playwright.final-web.config.ts` now connects the existing exact-archive host and public startup
observer through `produceFinalWebStartupCase`. The actual test is outside the default UI test
directory. No historical workflow, default verification command or publication consumer is changed.
The lane does not build, download, extract or substitute an archive. It requires a strict
`web-build.json`, its exact ZIP and canonical checksum produced by the existing web archive
producer. The ordinary `package:web` output alone does not provide that record.

A controller must supply a canonical single-line JSON selection, ending in LF, at
`validation/web-startup-selection.json` (or that fixed filename in one new validation leaf). Its
only fields are `artifactDirectory`, `context` and `observer`. The directory is one canonical
existing leaf directly under `validation/`. `context` is the independently selected producer
scope/version/source commit/tree/run/attempt/job key; `observer` supplies the actual reader
run/attempt/numeric job ID and tooling commit. The controller must resolve those identities rather
than deriving them from the build record or inventing future service IDs. This manifest is a
selection, not authentication or uploader attribution.

The global setup reads the three fixed input names through the existing bounded stable-descriptor
reader, validates actual compressed/member bytes and records an input fingerprint before browser
fixtures run. The test rechecks that fingerprint, serves only the unchanged ZIP members on IPv4
loopback, runs the existing real public-UI observer, and requires page-close event/acknowledgement
and normal host listener/socket/response closure. Primary errors and cleanup errors remain distinct;
uncertain custody stays attached with no automatic retry or forced teardown.

Prepared command, **not run or admitted by this change**:

```sh
HUB_FINAL_WEB_SELECTION=validation/web-startup-selection.json \
HUB_FINAL_WEB_OUTPUT=validation/web-startup-UNIQUE_NEW_LEAF \
node node_modules/@playwright/test/cli.js test --config=playwright.final-web.config.ts
```

The output leaf must be absent under a trusted canonical validation parent. Playwright owns its new
test scratch/report directory and may remove its own generated scratch; this is not permission to
remove existing data. The config selects exactly one case for one engine per invocation, one worker,
zero retries, 90 seconds per case and 120 seconds globally. `HUB_FINAL_WEB_ENGINE` accepts exactly
`chromium`, `firefox` or `webkit`; omission preserves the original Chromium selection. Chromium
keeps its explicit sandbox flag. Firefox and WebKit receive no Chromium-specific launch flags;
actual OS sandbox and executable identity are not inferred from SDK selection. There is no dev
server, screenshot, trace, video, artifact/cache upload or new workflow trigger. The case attachment
is at most 1 MiB. The SDK JSON report and provider logs are separate outputs, not disk quotas or a
pre-download size promise. A controller must check the terminal command outcome and the complete
report, including global setup/teardown errors; an attachment alone cannot establish a passed job.

The case reader verifies exact archive/build/source/observer identity and each observed response
against the payload inventory, rejecting extra fields, substituted content and fabricated process
retirement. Its result is explicitly `artifact-bound-startup-only`, never full-product acceptance.
The SDK reports a browser version; this is not an executable hash or authoritative runtime profile.
The caller still owns the browser context/process, and their retirement is not inferred from page
closure. The SDK may terminate its own disposable browser on failure/timeout; that is not observed
as graceful whole-group retirement. This prepared lane supplies neither an execution grant nor a new
containment capability. No private app hook is installed. Off-origin resource observations fail, but
the observer is not network egress containment; future execution admission must account for browser
traffic.

Current blockers remain concrete: no final-source ZIP/build-record selection has been supplied for
this lane, no real browser case has run, strict native producer admission and independent
service/content provenance remain held, and actual Firefox/WebKit runs, final runtime profiles,
separately reviewed GC policies and measured full-product results are still missing. The existing
publication consumer continues to reject missing or unsupported evidence. Existing source-specific
receipts and the package/storage, native/DUT, spending and denied-publication holds are not
superseded.

The case producer and strict case reader require the independently selected engine to match the
SDK-reported browser type, the engine-specific case ID and the retained observation. Their default
remains Chromium: a Firefox/WebKit record cannot be silently read as a Chromium pass. The actual
Playwright test forwards its single configured browser fixture identity through both boundaries.
There is no all-engine project matrix or default three-case dispatch. Each additional engine still
needs a separately admitted invocation, its supported browser installation, exact final input and
owned runtime/retirement scope. This preparation has executed only source-bound event-double and
configuration checks; it has not discovered or launched any real browser.

This is public-startup artifact evidence only. It does not establish Firefox/WebKit forced-GC
applicability, a shared cross-engine memory policy, browser executable hashes or whole-process
retirement. Normal and forced-GC policies/assessment identities and measured durations must be
validated separately. Warm-up is not measured duration. The startup observation leaves all those
fields null and cannot qualify disabled installer behavior or substitute an instrumented Gateway
host for the unchanged shipping tar CLI.
