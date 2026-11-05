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

The new asynchronous custody covers only the Vite child. The default source-provider Git timeout,
command-local configuration, executable/file reads and exclusive publication adapters have not
acquired the same custody proof. Full default producer execution remains held. The recorded fixed
environment overlay is not the entire inherited child environment; admit that separately.

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
