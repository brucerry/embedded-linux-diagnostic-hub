# Final platform and artifact gates

The release workflow consumes the staged packages before publication. Passing a development bundle,
a portable launch, a model test, a different source revision or a previous package is not installer
or product qualification. All gates below are required; an absent, unsupported, skipped, failed or
unrun result blocks publication. This document describes gate infrastructure, not a claim that the
current v0.6.0 candidate has passed it.

## Retained receipt reads

`readBoundedJSON` keeps its existing 1 MiB default (64 KiB for native runtime identity) and reads
only from one opened descriptor. It requires a regular single-link file, compares exact
device/inode/mode/size and nanosecond modification/change timestamps before and after reading, and
checks that the pathname still identifies the observed file. Reads can consume at most the initial
size plus one growth-detection byte. Premature EOF, growth, replacement, invalid UTF-8, invalid JSON
and unacknowledged descriptor close fail rather than returning receipt data. Primary read/parse
failures and close failures are both retained; there is no automatic retry.

This is bounded local snapshot handling, not publisher authentication or immutable future custody.
It does not make a later pathname read safe, bind parsing to a separate hash operation, detect every
possible filesystem mutation, or establish the missing producer provenance. No receipt schema,
acceptance gate or package/native/DUT/spending hold changes. Its deterministic controls use
synthetic descriptors only; actual filesystem/platform behavior remains unqualified.

## Catalog and ordering

The canonical catalog retains every existing portable, Mac, web, gateway and helper asset. Versions
before0.6.0 keep their original24-file inventory. Starting with0.6.0 prereleases, it additionally
requires the existing packager outputs:

- `Diagnostic-Hub-Windows-x64-Setup.exe`
- Its `.sha256` checksum
- Its `.info.json` descriptor, binding version, source commit, exact bytes/SHA256 and internal
  payload-manifest SHA256

There are27 public files. The descriptor is metadata and does not acquire a separate checksum asset
or publisher-authentication claim. `scripts/lib/windows-setup-release.mjs` remains its schema
authority. The Windows build invokes the existing packager and uploads those exact outputs.

The package verifiers and standalone Windows setup producer require matching local
`dist-electron/main.cjs` and `dist-electron/preload.cjs` outputs in the repository checkout. Run
them from the repository root and retain or reproduce the build outputs for the selected package.
Missing or mismatched outputs fail the setup preflight before descriptor publication or compiler
submission; it does not rebuild automatically. This scoped byte comparison does not authenticate the
publisher or replace the native and exact-artifact gates below. Retained external cloud build
outputs are evidence, not files at those conventional local paths.

Four native staged-consumer jobs follow the existing website, Windows, Linux and two-architecture
Mac qualification workflows. They download the existing Actions assets; Mac ZIPs are read directly
from the unpublished draft. Only receipts/logs are uploaded from Mac: no new Mac binary Actions
artifact/cache is introduced. The final publisher re-downloads assets, rehashes them against all
receipts, and repeats that guard inside the publication command immediately before its final write.
The pinned historical recovery command retains its separate immutable recovery contract.

After actual publication, `published-assets` anonymously downloads every exact-tag public asset and
validates inventory, source, checksums and descriptors. Native published Mac command tests then
consume that same explicit tag. Post-publication URLs cannot substitute for prepublication native
gates, and prepublication draft URLs do not claim public availability.

## Native consumers

Run only on the named native OS/architecture:

```sh
node scripts/staged-artifact-gate.mjs consume win32-x64
xvfb-run -a node scripts/staged-artifact-gate.mjs consume linux-x64
node scripts/staged-artifact-gate.mjs consume darwin-x64
node scripts/staged-artifact-gate.mjs consume darwin-arm64
node scripts/staged-artifact-gate.mjs verify-producers
node scripts/staged-artifact-gate.mjs verify
```

The checkout must be clean and match `GITHUB_SHA`, `GITHUB_REF_NAME=v<package-version>`,
`GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`. Receipts also bind the Git tree, observer executable hash,
Node/OS/architecture, exact package/helper/metadata hashes and case logs. Required source helpers
and checksum sidecars are verified before executing an asset. Native identity records actual
packaged version, running executable/ASAR hashes, Electron/Node/Chromium versions, separated
renderer contexts, absence of page Node globals and the actual renderer sandbox (native process
metrics on Windows/Mac; Linux `/proc`NoNewPrivs/Seccomp). Missing observations fail closed. The
final readback binds each retained identity case to its fixed asset: Linux AppImage and tar
observations cannot be swapped by choosing another matching summary. The shared validator requires
all emitted context-separation, page-Node-absence, OS-sandbox and renderer-PID observations as well
as absolute executable/ASAR paths and their hashes. A `sandbox:true` summary cannot hide missing or
failed constituent observations. These checks establish consistency of the retained observations;
they do not authenticate a producer or prove that executable/ASAR bytes came from the outer archive.
Exact payload/build/runtime provenance and real native observation remain required.

Windows consumes the actual portable EXE. Linux consumes both AppImage and extracted complete tar
archive. Mac consumes the actual installer-helper result. Existing desktop/native-window tests run
against the selected staged executable; no source-build/development fallback is allowed. These tests
perform authenticated loopback SSH only. They do not open local UART ports or qualify DUTs.

Outputs live under `validation/platform/` (override with `HUB_PLATFORM_EVIDENCE`). Every command
must exit normally with code0 and no signal; command evidence is bounded to16MiB per log. Failed
commands write a blocked receipt. Evidence is rehashed before publication. Runtime profiles, memory
ceilings and calibration are owned by the product qualification workflow, not chosen by this gate.

## Required installer receipt input

For each native lane, a real installer qualification producer must supply
`validation/installers/<lane>.json` (or `HUB_INSTALLER_QUALIFICATION`), with evidence paths relative
to that input directory. In Actions upload the input and its evidence as
`installer-qualification-<lane>`. The producer is not supplied by this patch; missing input blocks
publication. Existing portable/native/model tests cannot produce an installer success receipt.

Use `schemaVersion:2`, `kind:"native-installer-lifecycle"`, `status:"passed"`, the final `version`,
`sourceCommit`, `sourceTree`, exact publication `runId` and `runAttempt`, `lane`, actual `runtime`
and exact `artifacts` returned by `laneFiles(version,lane)` plus `hashFile`. The schema is exported
from `scripts/lib/staged-artifact-gate.mjs`. Runtime includes `platform`, `arch`, `osRelease`,
Node24 version, absolute observer `executable` and `executableSHA256`. An independently reviewed
receipt also includes `review:{reviewer,reviewedAt}`. That metadata records external review; schema
validation itself does not perform independent review or infer that a command was meaningful.

Every required case contains
`{id,status:"passed",command:[...],exitCode:0,signal:null,evidence:[...]}`. Evidence entries are
`{path,bytes,sha256}`; files must exist, remain inside the receipt root and match their recorded
bytes/hash. Each case additionally identifies exactly one `lifecycleEvidence` with the same three
fields, present once in its evidence list, at `cases/<layout>/<case>.json` (at most 128 KiB). Paths
and content hashes cannot be reused between cases, including supplementary logs. A shared fixture
log is not nine independent lifecycle observations. Old version-one receipts are not migrated or
relabelled. Case IDs are the following names prefixed with `windows-nsis:`, `macos-bundle:` or
**both** `linux-folder:` and `linux-appimage:`:

- `install`
- `offline-launch`
- `busy-refusal`
- `repair`
- `update-distinct-version` (manual native bundle replacement on Mac, not automatic Mac updating)
- `interrupted-recovery`
- `profile-report-preservation`
- `owned-integrations`
- `remove`

There are nine required Windows cases, nine per native Mac architecture and eighteen Linux cases.
These are actual final-package lifecycle requirements. Earlier snapshot acceptance, mock adapters,
native startup alone and portable helper Save/Open do not close them. The separate approved native
execution/installation authorization still governs running those producers.

`verifyInstallerEvidence` now runs both before input copying and on retained final readback. It
rechecks the run/attempt, exact artifacts and distinct case references, uses descriptor-bound
bounded reads, and checks canonical version-one `installer-case-observation` JSON. Each projection
contains the same `version`, `sourceCommit`, `sourceTree`, `runId`, `runAttempt`, `lane`, `caseId`,
and exact package `{name,bytes,sha256}`, plus `observation`. The package is the Windows Setup,
matching-architecture Mac ZIP, Linux folder tar, or AppImage selected by the fixed case layout.

The original source-backed semantic projection is `macos-owned-offline-launch/v1` for
`macos-bundle:offline-launch`. Its `prequit` and `closed` values are the existing native adapter's
prequit/closure record shapes. It compares owner/PID, packaged version and offline readiness, normal
exit/close, both pipe EOFs, normal quit acknowledgements, closed transports and zero pending
custody. The original emitter explicitly declares `physicalDescendantClosure:false`; this limitation
cannot be relabelled into proof. The parser returns **unqualified** even when these direct-child
facts are consistent. It does not authenticate that a record is real, bind installed executable/ASAR
bytes, or independently approve native work. Other case projections remain
`observation:null`/unsupported. Diagnostic/helper schemas are refused.

The [retained offline-launch producer](macos-offline-lifecycle-producer.md) additionally connects
the existing installed-payload sample and shipping build-info to those same closure facts as
`macos-owned-offline-launch/v2`. It re-reads four exact retained records at both existing consumer
entry points. This supplies named-file/payload consistency, not loaded-code, service/run provenance
or native qualification. Both versions remain unqualified; automatic native CLI wiring remains
blocked on independently selected run context and separately admitted native execution.

There is no admitted qualifying installer producer yet. The semantic installer gate therefore
rejects publication unconditionally after consistency checks, alongside the unchanged full-product
gate. Existing Mac action/helper records remain explicitly unverified; Windows/Linux admission stays
disabled. Actual per-case producer wiring, all remaining lifecycle semantics, exact payload/runtime
binding, independent native retirement/review and platform execution remain required. Synthetic
contract fixtures exercise rejection and consistency only and cannot issue a release verdict.

### Mac shipping payload identity

The existing Mac packager now inventories its verified input bundle and the fresh `ditto` roundtrip
of the shipping ZIP. It compares the complete canonical path/file-data/mode/link-target identity,
including the main executable and ASAR, and rehashes the ZIP after extraction before writing its
existing build-info file. `payloadIdentity` in that file is the resulting bounded inventory digest,
entry/file/data-byte counts and executable/ASAR hashes. This adds no release asset or upload. It
does not authenticate the build-info file: source/build/service provenance and the separately
reviewed attested-content policy are still required.

Current Mac native input admission requires its supplied complete inventory to reproduce that
shipping binding. It never fills a missing build identity from the inventory itself. Historical
build-info files remain unchanged; an old prior package without this field stays legacy ASAR-only
and unqualified. Where a prior package supplies the binding, it is also checked. A current build
without it refuses before SPENT/allocation or native actions.

After a successful current-package installation the existing adapter compares actual `tree()`
samples to the admitted shipping identity, and exclusively publishes a small case/source/archive-
bound `installed-payload-N.json` sample. These use existing evidence ownership and byte caps. They
remain `qualification:false`: they sample installed named files and do not prove later loaded code,
filesystem race exclusion, xattrs/resource forks/ACLs, parent retirement, run/attempt custody or
native acceptance. Binding those samples into the final per-case lifecycle producer/readback and
obtaining real native execution evidence remain separate unfinished work.

The read-only inventory uses descriptor-bound 64 KiB reads with close acknowledgement, at most
16,384 entries, 512 MiB per payload file and 2 GiB aggregate named file data; archive hash reads are
capped at 1 GiB. These are read/admission bounds, not disk quotas or additional storage approval.
Unknown close, changed bytes/metadata, escaping links, hardlinks, ambiguous paths and unsupported
file types refuse. No package/native execution or held resources are enabled by this preparation.

## Required full-product artifact inputs

Primary-owned real product drivers must supply `validation/products/<lane>.json` (override
`HUB_PRODUCT_QUALIFICATION`) uploaded as `artifact-qualification-<lane>`. Scope is `desktop-<lane>`.
The consumer copies verified input evidence into its own receipt bundle.

Web and gateway producers supply `validation/platform/web.json` and `gateway.json`, with evidence
relative to `validation/platform/`, uploaded as `artifact-qualification-web` and
`artifact-qualification-gateway`. Both exact final archives and checksum sidecars are mandatory.
There is no checksum-only promotion or receipt fabrication in the workflow. Producer jobs remain
primary-owned integration work; until they emit actual evidence the new release jobs remain blocked.

Common producer fields are `schemaVersion:2`, `kind:"staged-artifact-producer"`, `status:"passed"`,
`scope`, final source/version/tree/run/attempt, actual observer `runtime`, exact `artifacts`, and
`qualificationScope:"full-product"`. Include `runtimeProfileSHA256` and separate
`normalGC`/`forcedGC` records. Each names its exact `gcMode`, `policySHA256`, GC-specific
`assessmentIdentity`, composed `sourceSHA256`, `adapterHash`, measured timeline `receiptSHA256`,
separate `achievedWarmupMs` and `achievedMeasuredMs`, `totalMs`, and `completedCycles`. Each mode
requires at least five warm-up minutes **and thirty measured minutes**, with at least 100 measured
cycles. Warm-up cannot count as measurement; total elapsed alone and legacy
shared-policy/version-one summaries are rejected. The measured admission ceiling is 33 minutes
within the unchanged 40-minute owner budget and one-minute cleanup reserve. A source/configuration
change invalidates prior assessment/policy identities; no historical receipt or calibration is
migrated.

Normal and forced policies, assessment identities and timeline payloads must be distinct. The
resource-qualification case must retain each exact policy and timeline once, and all referenced
bytes remain bounded, rehashed and checked after a stable descriptor read. The reader consumes the
existing harness policy and canonical JSONL assessment/checkpoint/measurement-window/receipt
records: GC mode, policy/assessment hashes, non-overlapping process-monotonic timing and counted
measured cycles must agree. The runner emits the timing window separately from warm-up, with its
exact start and end observations. This consistency check does not authenticate independent review,
reassess memory budgets, bind a final artifact/runtime/job, or prove parent/process retirement. It
always remains unqualified and still reaches the unconditional final-artifact block. Native addon
absence and exact loader provenance remain required for Gateway/desktop runtime profiles.

Case IDs:

| Scope            | Required case IDs                                                                                                  | Additional fields                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `desktop-<lane>` | `desktop-production-runtime-profile`, `desktop-product-resource-qualification`                                     | `electronVersion:"44.5.1"`, `optionalNativeAddon:"absent"`, `loaderProvenanceSHA256`; native OS/architecture must match lane |
| `web`            | `web-archive-source-integrity`, `web-chromium`, `web-firefox`, `web-webkit`, `web-product-resource-qualification`  | Actual nonempty `browserVersions.chromium/firefox/webkit`                                                                    |
| `gateway`        | `gateway-archive-source-integrity`, `gateway-production-runtime-profile`, `gateway-product-resource-qualification` | `optionalNativeAddon:"absent"`, `loaderProvenanceSHA256`                                                                     |

The same command/evidence schema applies. `producerFiles` and `producerCases` export exact scopes.
Component passes do not qualify full product. The producer must bind underlying policy/runtime/soak
receipts into the retained case evidence; their review remains required.

`validateProducerReceipt` validates the summary schema only. Every publication consumer also calls
`verifyProducerEvidence`, which rehashes the retained bytes, requires an unambiguous file for each
reference and refuses payload reuse across evidence roles. It checks the mode-specific policy and
measurement facts above, then **blocks**: this source has no authoritative final-artifact
policy/runtime/soak/loader evidence contract or real producers for it. Hash membership and passed
summary labels cannot supply that missing semantic contract. In particular, the existing harness
`MemoryPolicy` is bound to a GC-specific assessment identity, and the harness runtime-inspection and
JSONL soak formats do not establish final artifact/run/profile identity or durable parent
exit/cleanup. They must not be promoted into release evidence by relabeling. Version two forbids the
obsolete shared `reviewedPolicySHA256` field; per-mode byte/assessment bindings do not supply
missing final-artifact authority.

The web path additionally reads the existing final-web startup emitter's fixed retained build and
three browser observation files through the
[narrow startup evidence consumer](final-web-startup-evidence.md). It correlates their actual parsed
bytes, final source/archive identity and public startup facts. Its successful result remains
unqualified and does not remove the unconditional full-product block.

The [observer/source-bridge-bound supervisor v4 contract](product-supervisor-contract.md) now
supplies diagnostic source/run/observer/byte/lifecycle graph checks, shared with the actual source
emitter. Its verifier always returns non-qualifying evidence. It does not authenticate a real
producer, bind shipping artifacts or interpret memory/policy results, and it is not an acceptance
path around this release block.

Before removing this block, supply and independently review the real producer schemas, then consume
the exact retained payloads against final source/artifacts/runtime/profile, separately reviewed GC
policies, passed full-product measured results (at least 30 minutes and 100 measured cycles per GC
mode), required retention, normal exit and cleanup. No accepting replacement schema, thresholds or
qualification data is introduced here. Synthetic positive summary fixtures remain schema checks
only.

This patch has run only synthetic gate/catalog regressions and static checks locally: no
current-source platform installer, packaged consumer, native resource lane, calibration, public CI
or published-URL check is claimed.
