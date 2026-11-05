# Approved one-job diagnostic Gateway execution

Bruce approved developing the Gateway-specific runner and one public Ubuntu build/tar inspection,
including runner teardown on timeout/cancellation without graceful descendant-retirement proof.
The $0 spending block, separate package/storage holds and fail-closed release gate remain intact.
This is the implementation following the retained candidate 285 proposal, not a release producer.

The push-only branch is ci/gateway-build-diagnostic-96a56cd-20261105. One original standard
ubuntu-24.04 job, attempt 1, 20 minutes, contents-read only, no retry, dispatch, artifact or cache
upload. Exact source/parent, unchanged production bytes 96a56cd, fresh namespace, runner/public
repository and environment guards precede install/build. A fresh controller must independently
check remote branch/run absence, access, all triggers and no-spend conditions before the one push.
Successful service metadata and exactly one bounded log receipt must agree on source/run/job/attempt.
Job logs use repository retention; total log size can be checked only after retrieval.

Official setup-node/checkout actions are pinned. Initial locked npm ci disables scripts/audit/fund,
uses registry.npmjs.org and zero retries, and skips Electron binary downloads. The job checks at
least 4 GiB available workspace disk and 2 GiB available memory before dependency installation.
These are admission checks, not quotas or guarantees of peak usage. Exhaustion is a failure; no
larger runner or new spending is authorized. Dependency/runtime loader provenance is not asserted.

The diagnostic entry calls the existing Gateway producer directly, never the legacy package script
or the Gateway application. It provides explicit owned filesystem, source-provider and raw child
ports. Node/Git/npm/esbuild entries are bounded descriptor-read and hash observed; the source and
tool observations are rechecked throughout production. Only the Node-script esbuild entry is
admitted; its native compiler helper may run as a build subprocess. No application/server starts.

The Gateway-specific capability accepts exactly one fixed Node/esbuild build plan, then one
same-owner increasing-ID Node/npm offline lock-normalization plan. The latter pins fresh owned
prefix/cache/config paths and disables scripts, global/workspaces, audit/fund and online fallback.
Children receive a complete closed PATH/locale/TZ/NODE_ENV environment, no inherited HOME, secrets,
npm settings or runtime injection. Read-only Git gets the existing separately closed Git profile.

Raw command custody derives from the owned Git observer: synchronous timer/event-port returns,
registration before dispatch, actual spawn/PID/exit/child-close and both output-pipe closes, bounded
streams and late failure fencing. Limits are 8 minutes for build, 2 minutes for lock, stdout 16 MiB,
stderr 1 MiB and 4,096 chunks per stream. There are no signals, deletion, retry or force-exit ports.
Known failure rejects promptly while uncertain custody remains attached. A later acknowledged
direct closure can retire the lower observer; a rejected stage command remains conservatively held
because no successful identity-bound stage acknowledgement was returned. Neither is whole-group
retirement, and no rejected promise is treated as retirement proof.

Peer review caught an incompatible writable-handle assumption before execution. The Gateway stage
now optionally accepts an explicit whole-file exclusive transaction. It registers a pending write
before dispatch and retains it on rejection or unsupported return. The diagnostic path supplies the
existing owned filesystem writeFile({flag: wx}), which acknowledges exclusive creation, full write,
sync and file/directory close. This does not manufacture an OS handle. The old explicit raw-handle
path remains for existing engine callers. Tests exercise the real stage with the admitted filesystem,
including held and rejected closes. No shipping application bytes or destination policy changed.

The existing strict producer writes only eight files and three directories, canonical USTAR+gzip,
checksum and record. Bounds remain compressed 128 MiB, expanded 256 MiB, member 64 MiB, 4,096 entries
and record 16 MiB. The pure same-run inspector validates canonical record/context, acknowledged
successful commands, checksum and actual tar members. After all local owners are checked, it emits
one receipt of at most 16 KiB. No real archive is uploaded or downloaded by this job.

On failure, no completed receipt is emitted, no source cleanup/retry occurs, and eventual exit status
is failure without forcing process exit. The 20-minute service timeout/cancellation may tear down the
runner; it does not prove normal retirement of every child. Every diagnostic receipt retains null
wholeGroupRetirement, false releaseAcceptance and explicit teardown limitations. It supplies no
attestation/uploader proof, runtime/loader/GC/soak/performance, native or DUT qualification.
