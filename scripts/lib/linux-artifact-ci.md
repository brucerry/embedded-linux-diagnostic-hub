# Manual private Linux artifact job — source only

This extends `linux-portable.yml`; no second workflow or provenance issuer is
introduced. Existing OpenSpec `plan-windows-permanent-delivery` 15.1/15.3/15.4,
16.3/16.4/18.3/20.3 distinguish source/package evidence from native adoption.
All those native/release gates and the historical cleanup incident stay OPEN.

Only `workflow_dispatch` with boolean `artifact_only:true` admits the new job.
Both old jobs explicitly reject that combination. Other events and the default
false selector preserve the old jobs/steps. Artifact mode uses run-ID-specific
concurrency with cancel-in-progress:false, never the normal group. Its first
step rejects reruns (attempt other than1), missing identities, same app/workflow
commit, foreign repository and occupied checkout slots. There is no fallback to
normal jobs on failure. No release workflow is called, tag created, contents-write
permission added, or installer/app/helper/native test/Playwright/GNOME/memory gate
selected. Normal qualification remains intact, not satisfied by this job.

## Two separate source identities

The fixed application cohort is the accepted709 files/7,203,931bytes, canonical
files-array SHA256 `f6e61516aad735db21487bcef0ce6a25ea70874c0916e3e44b4d3dec6e735ef3`.
It remains immutable at the source packet referenced in APPLICATION-SOURCE-REFERENCE.
This tooling successor changes the workflow and adds CI code; it must NOT be used
as that application commit. Future authority must freeze/push a truthful exact
application commit A and a distinct reviewed workflow/tooling commit B. No such
commits or branch exist as observed facts in this preparation.

Checkout B comes from github.sha; application checkout A comes from an explicit
validated40hex input. Checkout clean/submodules/lfs/persist-credentials/global
safe-directory changes are disabled. Script queries actual Git HEAD/tree for
both roots; actual tracked application bytes/modes/names/count must reproduce
the hardcoded accepted digest before dependencies and again in later phases.
The independently captured raw source-manifest bytes are hashed into the existing
private-source schema. Private build-info reuses linux-build-record.mjs with no
validationEvidence: validation is unperformed. GITHUB_SHA (B) is never relabelled
as application source A. Both identities and build/run IDs are retained. These
are unsigned consistency evidence, never compiledSourceProven or a signature.

## Work and exact paths (future hosted runner only)

Slots: `$GITHUB_WORKSPACE/tooling`, `application`, and
`private-artifacts/<32hex-build-id>`. Root must be fresh/canonical/user-owned under
the runner HOME. It retains upload/, home/, npm-cache/, electron-cache/ and
builder-cache/ for this run. No local VM is installed. The existing hosted Ubuntu
runner is not evidence of bare-metal execution; absolute no-virtualization would
require another environment decision.

Node24.22.0 setup precedes the admit phase. Admit requires16GiB available before
npm ci. Locked dependencies install with anonymous/minimal env into the fresh
application checkout, with dedicated new HOME/caches and no npm audit/fund call.
Dependency lifecycle scripts/native build tools and Node/Electron/builder downloads
may run; this is not an offline or OS-egress-confined operation. No credentials or
agent sockets are forwarded to these commands. No apt/sudo/system library install
or host security setting change is selected. Dependency tools execute; Diagnostic
Hub and its maintenance/review helper are never invoked by selected commands.

Pre-package rechecks exact application source, records tool package manifests and
requires12GiB available. The only package command is existing `npm run package:linux`:
typecheck, Vite, esbuild, electron-builder AppImage/tar with --publish never and the
existing build-time afterPack. No broad verify/test/verify:linux/native/update step
is selected. Build tooling may normally replace/remove its new outputs/staging,
and the runner/action service may stop children/tear down its environment. This
is NOT the local no-signal/indefinitely-retained-process contract. Old local holds
are never inspected or acted on. These future effects require scoped approval.

Finalize generates a bounded actual flat file/hash/mode inventory without archive
extraction or the archive observer. Stable no-follow regular single-link reads,
user ownership, safe integer dev/ino/mode/size, canonical names, NFC duplicates,
links/types/shared-write/special modes, file/directory/byte/control limits refuse
unsupported content. The existing verified application planner creates only
descriptor DATA; it never constructs its disk adapter or creates ROOT/app.
Empty/unexpected directory layout refuses rather than changing package semantics.
Actual ELF/ASAR/runtime/archive-member qualification remains a later gate.

Two source archives are stably hashed and copied with explicit retained-handle
writes, never copyFile/unlink fallback, into the new upload directory. Copy space
must cover actual combined asset bytes plus2GiB reserve plus10MiB metadata. Partial
files remain on failure; no upload step runs after a failed producer. Source/output
readback identities and hashes are checked; no atomic filesystem-to-upload snapshot
or protection against a malicious same-UID build process is claimed. Independent
downloaded-artifact verification remains necessary.

## Upload/evidence accounting

Exact14-file success cohort: AppImage/tar.gz, two SHA256 sidecars, source-manifest,
private-source, tooling-identity, admission, pre-package, flat-inventory,
diagnostic-hub-setup-payload, private linux-build-info, build-result, upload-accounting.
Per asset<=2GiB. Source-manifest<=1MiB; each source/build/tool record<=64KiB;
inventory/descriptor<=4MiB each; result/accounting/admission<=8KiB; sidecars<=256B.
All metadata, including the complete serialized accounting file, must total<=10MiB;
raw staged upload inputs at the final checked snapshot therefore<=4GiB+10MiB. The receipt hash-list excludes itself to
avoid circular hashes; actual final accounting includes its bytes and a second
complete stable read/account check before exit0. Unknown/missing/duplicate/alias
names refuse. Files are exclusively published/synced/read back, no overwrite or
cleanup. No unbounded recursive upload is admitted: exact directory names/file set
are checked first; the action receives fourteen explicit filenames, never a
recursive wildcard/directory upload. New staged files become0400 before the last
read/account snapshot; no source/package input is chmodded. Same-UID malicious
mutation between that check and the provider read is not atomically confined;
the staged-byte bound is not a hard provider-transfer limit.

R1 final consistency: the first13-file name/length/SHA256 table is independently
retained/frozen before accounting publication, together with the exact serialized
accounting bytes' length/SHA256. After the14-file readback, every retained fact and
the accounting file itself must match before any upload-accounted/completed success.
Cap-valid same-length digest drift is a CI_CHANGED refusal. No circular self-hash,
new artifact, budget, retry or provider-atomicity claim is introduced. AC13–16 are
new finite fake definitions; all tests remain unexecuted in this source preparation.

Upload is success-only, overwrite:false, compression0, requested7-day retention.
It creates an Actions artifact, not a public release. Repository/provider retention
and serialization/network overhead are not controlled by raw byte accounting.
Failed/timeout/upload-failed runs may retain only GitHub job/step logs, not packages;
unuploaded runner files can disappear during normal teardown. No failure-evidence
upload bypasses the accounting gate. Provider console logs are not asserted to
obey the old local64KiB capture cap or the10MiB artifact-metadata ceiling. Those
ordinary CI log/teardown/expiry effects must be explicitly included in later approval.

Existing overall job ceiling30min clips step ceilings2/8/2/12/5/5min; they are not
additive allowances or measured performance. Git queries have10sec/64KiB limits
and may terminate their own Git child on timeout/overflow. Setup/cache downloads,
builder temporary peak disk, heap and physical termination remain unproved.
16/12GiB are conservative admission headroom, not a hard quota or qualification
threshold; capacity failures stop. Maximum retained app/archive/upload duplication
can approach10GiB plus dependencies/caches/staging. No cleanup/cap increase/retry
or alternate environment is an automatic recovery path.

## Source validation still pending

New AC1–12 definitions use only pure JSON/hash/flag/space/accounting operations,
injected memory tree observations and assertions. CLI import main guard is false;
no actual filesystem/Git/process/platform query, package/preparation/codec/native
action, timer/listener or cleanup occurs. Exact proposed native-TS command and a
separate no-emit typecheck need independent review before execution. Static diff
and normal-path preservation checks are not YAML-service/shell/native validation.
No command, commit, push, dispatch, package or upload ran during this preparation.

## Npm config collision correction — later source-only successor

The preceding preparation statements describe the earlier snapshot. Its actual
private run40442668169 subsequently refused npm's duplicate `/dev/null` config
identity before installation; it did not build an artifact. Application commit
`dfbf2753d035bb48b0eb4d37a0399e104166ba0c` remains the same709-file cohort.
This successor proposes two new empty0600 regular single-link config files,
`npm-user.npmrc` and `npm-global.npmrc`, under the already fresh job output root.
Admission exclusively creates/syncs/closes and stably reads them, rejects shared
dev/ino, and records independent identities. Both npm commands select those
distinct paths; later phases recheck emptiness/private metadata and original
identities before proceeding. No ambient user/global npm configuration is read
by this change. A partial pair is retained; no overwrite/delete/retry is added.
There are still14 upload files: configs remain job-local, with zero content bytes
and a bounded identity addition within the existing8KiB admission receipt.
Native/release/actual second-run qualification remains unperformed. AC17–22 are
new fake definitions only; all successor validation requires independent review.
