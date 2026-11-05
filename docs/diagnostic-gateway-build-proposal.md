# Proposed diagnostic Gateway build and same-run tar inspection

Preparation only. No Gateway build, lock-normalization command, server, package execution or
workflow has run. No active workflow or native command adapter is added by this preparation.
This proposal does not reuse the completed web job's one-run permission.

## Source and job scope

The preparation starts at local tooling commit e156caf4985c3b4544cfdb24e4e06d737f996ad6,
tree 1ba507eed463b9b8b36c76072881dfc6e59ccca3. Shipping production bytes remain those of
96a56cdbb462320c54fe74022d7436e665a31d31. The final executable tooling commit must be reviewed
and frozen separately; this document does not invent that future SHA or run ID.

Proposed repository: brucerry/embedded-linux-diagnostic-hub, public. Proposed new branch:
`ci/gateway-build-diagnostic-96a56cd-20261105`. One push-only workflow, one original
`gateway_archive` job on standard `ubuntu-24.04` GitHub-hosted Linux x64, first attempt only,
20-minute job cap, concurrency without cancellation, no retries or manual dispatch. Contents-read
token only; no secrets, signing, attestation, write permission or release. The exact branch must be
absent and all push/create/downstream triggers inspected before publication. No runner upgrade,
budget change or paid commitment. The $0 spending block remains in place; stop on any service block.

Use the same independently resolved official checkout/setup-node action commits as web 284,
reverified at action time. Checkout exact SHA, full history, no submodules/LFS, no credential
persistence, no clean and no safe-directory override. Verify source commit/tree, reviewed parent,
complete source inventory and unchanged shipping roots before setup or project-output writes.
Reject a pre-existing `validation/gateway-diagnostic` leaf or dependency directory. Never adopt or
delete previous work. Read-only Git controls do not change hooks or persistent Git settings.

## Network, commands and files

The proposed setup downloads Node 24.22.0 and locked dependencies from the official Node/npm
distribution paths used by setup-node and registry.npmjs.org. Initial npm ci must use ignored
lifecycle scripts, disabled audit/fund, zero fetch retries and Electron binary download disabled.
Check all lock URLs/integrities before install. No SSH, DUT, website, browser, native app, debug
endpoint or Gateway server is started. No external release artifact is read.

Use the existing `produceGatewayArchive` engine, not `npm run package:gateway` or
`scripts/package-gateway.mjs`. The legacy script has a global temporary directory, synchronous
spawn, online lock preparation and recursive forced removal; none is part of this proposal.

The engine creates exactly one new leaf under canonical validation/, with owned build, stage,
cache, config and artifacts directories. Existing HOME and user configs remain untouched. It
creates two new empty npm config files. No chmod, chown, cleanup or security bypass is proposed.

The only producer commands are:

1. Selected Node plus descriptor/hash-bound Node-script esbuild entry, frozen gateway/main.ts,
   `--bundle --platform=node --format=cjs`, owned build/main.cjs output, external ssh2.
2. Selected Node plus descriptor/hash-bound npm-cli.js, `install --package-lock-only --offline
   --ignore-scripts --omit=optional --no-audit --no-fund --global=false --workspaces=false`,
   with exact owned prefix/cache/userconfig/globalconfig paths from the issued stage plan.

There is no online fallback during lock preparation. An unsupported or native esbuild entry is
refused rather than run through Node. Read-only local metadata currently shows a 9,350-byte
Node-shebang esbuild entry and a separate native linux-x64 helper; hosted installation must be
observed afresh. Invoking that helper during compilation is a build subprocess, not Gateway
application execution. Hashes of the Node/npm/esbuild entry files are observations, not proof of
every loaded tool/dependency. Real offline npm compatibility remains untested.

The exact eight payload files and three directories use the existing canonical USTAR writer,
independent strict tar census, gzip round-trip and source/lock checks. Final archive, checksum and
build record are exclusively written, synced, closed and descriptor-reread. Same-run inspection
must parse the strict build record, verify expected source/tree/run/attempt/job, successful build
and lock direct-child acknowledgements, canonical checksum and actual compressed/member bytes.
The new pure inspector emits only source identities, hashes, counts and diagnostic limitations.

## Bounds, ownership and failures

Proposed command acceptance ceilings: build 8 minutes, offline npm normalization 2 minutes,
each read-only Git request 30 seconds; total job 20 minutes includes install and service teardown.
Bound each build/lock stdout to 16 MiB, stderr to 1 MiB and each stream to 4,096 chunks; drain with
latched failure and retained ownership if a bound is exceeded. The implementation must reject
asynchronous timer registration, register custody before launch, and never synthesize spawn,
exit, close, PID or success from promise settlement. Node heap option, if used, is only a Node
setting and cannot be described as a native-child memory quota.

Existing archive admission bounds are 128 MiB compressed, 256 MiB expanded/payload, 64 MiB per
member, 4,096 visited entries and 16 MiB for the build record. These are not disk quotas or peak
memory limits. Installation, cache, intermediate files and codec copies use the disposable standard
runner's available disk and memory; capacity must be checked before work. Resource exhaustion fails
the job. No larger runner or increased spending is allowed.

The receipt is at most 16 KiB and goes to the job log. No Actions artifact or cache upload, package
retention or archive download is proposed. Job logs follow repository retention, potentially up to
90 days; total log/download size is not capped by the receipt bound and is checked after retrieval.
Read only the approved original job log, bind independent service run/job/attempt/source/status,
require one receipt and no failure, and stop on absent, ambiguous, over-bound or conflicting evidence.

The producer already retains file handles/stage/command custody on unresolved operations. A future
executor must preserve that behavior and never retry uncertain dispatch or hide primary errors.
No source-level kill/delete/force-exit escape is proposed. Timeout or cancellation may rely on
GitHub's disposable runner teardown, which does not prove graceful normal retirement of every
descendant. Even a successful directly observed child close is not whole-group retirement.
Emit `wholeGroupRetirement: null`, `releaseAcceptance: false` and
`github-hosted-diagnostic-teardown-unproved-group-v1`; no completed receipt on known failure.

## Remaining implementation and decision

The pure inspection function and negative tests are ready. The Gateway engine still has no default
executor. Before execution, a reviewed diagnostic-only native entry must supply bounded raw child
streams/timers, fixed command/environment/one-attempt admission, descriptor-bound toolchain
observations and source provider, then check all owners before receipt emission. Reusing web's
capability directly is unsafe: its only build allowance is Node/Vite, whereas Gateway has two
different issued commands and an offline npm configuration/cache namespace. The current raw child
observer's default SIGTERM/SIGKILL behavior must not be silently inherited; diagnostic timeout custody
and runner teardown must be explicit. Local synthetic checks do not prove that native adapter.

Smallest user decision after the executable controls are prepared and reviewed: permit one
artifact-free diagnostic Gateway build and offline lock/tar inspection under the above limits,
including runner teardown on timeout/cancellation without graceful whole-group proof, and bounded
receipt-log retrieval. The earlier specific approval was one web build, not a standing Gateway
execution or package permission. General routine CI/debug permission does not erase this explicit
retirement/package boundary. Do not push or dispatch under this preparation request.

Success would establish same-run source/build/archive consistency only. It would not supply
independent uploader/attestation provenance, installed loader identity, Gateway runtime behavior,
soak/GC/performance, normal group retirement, Firefox/WebKit, native or DUT qualification. Release
consumers remain fail closed, package/storage holds remain unchanged, and real-device acceptance
ordering is not changed.
