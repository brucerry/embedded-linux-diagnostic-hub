# Finite hosted Windows readiness pilot

This candidate is prepared for independent source and policy review. It has not been executed on
Windows. The manual `windows_native_pilot` selector is separate from `windows_preflight_only`;
selecting both refuses before dependency restoration or native startup. Ordinary workflow triggers
and the standing build remain available with both selectors false. Full collection remains disabled,
with its ordinary Windows principal predicate unchanged.

The pilot requires four explicit identities: the frozen source digest, the digest of
`scripts/lib/hosted-pilot-policy.json`, and exact externally reviewed native coverage JSON plus its
digest. The coverage document must bind this source, Windows x64, Electron 44.5.1, native files and
disposable SQLite, and the existing native generation/reopen, Save cancel and Save read-failure
cases. Hashing a draft does not confer review. The workflow obtains no collection capability from
these inputs.

The repaired provider assigns `ConvertFrom-Json` directly and validates a flat one-to-three-record
plan before any provider call. Paths and kinds must already be scalar strings. Actual filesystem
items and their attributes must be scalar before the retained reparse and
DirectorySecurity/FileSecurity checks. The old wrapper exists only in a failing, read-only red
control.

Before any future native enrollment, the entry runs the real System32 x64 Windows PowerShell 5.1
provider contract in the same job. Its 30 cases include the exact old two-directory failure, three
green provider shapes and 26 rejection cases. Raw JSON, launch tuple, interpreter/provider
identities, type/count traces, stdout/stderr and command completion are durably recorded before
assertions. The next proposed execution is only the separately selected standalone contract job,
with no Electron resolution, PTY, native payload or canonical-marker acquisition. Its actual result
must be independently reviewed before another native pilot is proposed.

Electron dependency preparation now verifies an existing pinned Windows install or fails missing. It
does not import the lazy Electron index or start an installer. The complete dependency digest is
frozen only after this preparation, and later identity rechecks remain strict. The WinPS
prerequisite and preparation stay inside the original core work deadline. The 1 MiB contract
evidence and 512 KiB early-entry journal are charged within the existing 10 MiB evidence cap; they
do not increase disk thresholds. Early failures retain their input, raw transport and descriptor
closure evidence.

One fresh GitHub-hosted Windows manual attempt uses pinned Node 24.22.0 x64 and lockfile
dependencies. The live owner binds run, attempt 1, repository, commit, source, coverage, policy,
dependencies, actual runtime paths/hashes, principal SID, physical roots, nonce and one immutable
600-second monotonic budget. The last 60 seconds admit cleanup only. There is no retry or deadline
reset. Exactly two stages run in order: the existing real Bash/winpty assertions with their
25-second limit, then one existing desktop native cycle with normal GC, a 64 KiB payload and growing
catalog. The cooperative growth canary is an optional local control and supplies no admission or
release prerequisite.

The owner exclusively acquires the canonical `diagnostic-hub-v060-check.lock` once. Marker bytes
contain the live binding digest, avoiding a self-referential file hash. After acquisition, fresh
read-only PowerShell `FileSecurity` readback validates the marker separately from
`DirectorySecurity`: exactly three standard full-control inherited allow ACEs for SYSTEM,
Administrators and the actual runner SID; directory flags 0x13 and marker file flags 0x10. Owner and
group are checked within the disposable hosted trust boundary. The marker's bounded regular
single-link bytes, file identity and descriptor receipt are retained separately. Evidence is
nonsecret synthetic CI output with a physical ancestry binding, not private-storage ACL admission.
No ACL, ownership, token, profile or security settings change.

A validated nonce path map routes PTY HOME and its native journal, Playwright artifacts/traces,
early Electron temp/crash/log paths, existing userData/sessionData, app build, downloads, results
and SSH qualification artifacts. Electron reads back the early paths before use. Vite uses the
pinned supported `configLoader: 'runner'` route, avoiding its bundle-loader temporary module;
dependencies are not edited. Ordinary fixture defaults and TEMP/TMP remain unchanged. Chromium
sandbox and actual native file/SQLite behavior remain intact.

Windows/.NET compiler, SQLite/platform scratch and OS caches may still write outside app-controlled
paths. Known default tsx scratch is observed separately and charged when present. Unknown external
writes are not counted as zero. This trusted disposable pilot does not promise whole-host filesystem
interception or private user-machine qualification.

Periodic logical-size observations retain timestamps, scan duration, gaps, final/post-close
inventory and `measuredPeakLowerBound`. The 246 MiB/8192-file private-plus-known-tool threshold, 256
MiB/job and 512 MiB/cohort limits are observed stop/admission thresholds. Evidence has a cooperative
10 MiB pre-write budget; raw stdout/stderr have 1 MiB per-stream bounds. Observed excess, scan
failure, substituted roots or unexpected app routes stop later work and initiate joining. Samples
cannot exclude transient inter-sample excursions: `hardNativeDiskCap=false`,
`transientPeakKnown=false`, and `capacityQualifiedForFullPair=false` throughout. No native burst
bound or invented overshoot margin is claimed. Cooperative reservation headroom remains only
`reservedHeadroom`.

Startup scopes exist before factories. Exposed children are registered immediately before awaiting,
with PID/creation identity, bounded output, exit and inherited-pipe close. Build preparation runs in
owned children, stops its services and joins observed descendants. Opaque Playwright launch is
registered before invocation and its process adopted immediately on success; rejection without
independent closure proof stays unknown and holds ownership. Stage IPC cancellation handlers exist
before preparation. Evidence has one outstanding credit; an ACK follows the owner's fsync, rather
than merely a send callback.

PTY shutdown uses graceful EOF and the finite native timeout. It duplicates the borrowed winpty
agent handle before freeing the RPC object, checks termination and waits, joins Bash, agent and both
pumps, drains output, disposes pipes and closes handles before the complete leaf receipt.
`winpty_free` is not an exit receipt. The PowerShell process must also exit and close inherited
pipes before HOME or journal deletion. Unconfirmed termination, wait, pump, pipe, handle, descriptor
or receipt retains the fixture and a referenced ownership hold; the former two-second middle-owner
kill is removed.

Cancellation fences new work and late approval. A demonstrably joined failed/cancelled attempt may
release its canonical marker within the cleanup reserve while retaining a failed verdict. Unknown
startup, descendant, file, root or durable-evidence closure cannot release. The referenced hold is
allocated before trying to write its receipt, so a full disk or failed sync/close cannot turn
uncertainty into process exit.

Local deterministic tests use disposable files, real log descriptors, controlled harmless Node
processes and injected Windows readback ports. They do not qualify real Windows PowerShell, C#
compilation, Bash/winpty, Electron, native capacity, the 30-minute pair or 100 cycles. Independent
review and explicit execution authorization for this exact new source are required before any hosted
pilot run.
