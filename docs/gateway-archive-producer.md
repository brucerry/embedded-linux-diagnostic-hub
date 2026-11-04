# Gateway source/stage/archive producer engine

This source implements the next Gateway producer step. It is not wired to a workflow, default
package command or process launcher. **No npm, esbuild, package, server, product or soak has run.**
Existing release consumers remain fail closed; product/runtime/loader/GC/retirement fields remain
null and `releaseAcceptance` remains false. Source, build and archive facts cannot qualify runtime.

## Source and lock contract

The producer constructs the existing read-only source provider for an explicitly selected canonical
source root (tests inject raw synthetic Git data). Complete Git/index/worktree identity is observed
around build, lock and archive handoffs. Actual source package/lock, license, example configuration
and Gateway docs are read from that provider and matched to its byte/hash inventory. Version and
package names remain source-derived; the source lock and complete source inventory are retained by
hash. Source files and installed dependencies are not modified by the engine.

`projectGatewayLock` selects only the already locked SSH dependency/optional graph, preserving its
existing resolution paths and versions. It is not a registry resolver. Required and optional
classification is recomputed for that selected graph; unrelated UI/dev package records are not
staged. Missing resolution, non-semver selectors, links, peers, unsupported URLs or ambiguous source
metadata fail. No unsupported data is silently converted into a different package identity.

The prepared lock must come back after an **acknowledged offline npm normalization command**. It
must contain precisely its declared reachable graph, with required/optional flags consistent with
that graph. Each package name, version, resolved URL, integrity and remaining metadata must match an
eligible source lock entry. Rehoming cannot rename another package. Extraneous packages or changed
metadata fail. Source projection or a mocked acknowledgement alone does not demonstrate that a real
npm version accepts this lock. The real offline npm compatibility check remains unrun.

## Owned effects and command capability

`OwnedGatewayStage` allocates one new leaf under an existing canonical `validation/`, refuses
pre-existing work, and owns separate `stage`, `build`, `cache`, `config` and `artifacts`
directories. Two empty config files are created there. No HOME redirect, Git hook override,
permission change, user config edit, existing-data deletion or automatic retry is implemented.

Issued build and lock plans are immutable instance capabilities. Owner, operation ID, role, cwd and
command must match the returned observation. A capability cannot be forged from its JSON fields or
replayed. A file-IO lease excludes command/inventory/publication admission until acknowledgement.
Every open/write/sync/read/close is tracked. Failed or unacknowledged close/open retains custody;
primary errors and close diagnostics remain available. A fully observed nonzero direct-command
closure fails the stage without falsely claiming that command is still running. Unknown, stale or
rejected dispatch retains its command owner. A later closure cannot erase an already latched
failure.

The build plan uses the observed Node/esbuild entries, frozen `gateway/main.ts`, external `ssh2` and
an output inside the owned build directory. The lock plan uses the observed Node/npm entry, owned
prefix/cache and the two new config files, with `--offline`, `--ignore-scripts`,
`--package-lock-only`, `--omit=optional`, disabled audit/fund/global/workspaces. It performs no
online fallback. Explicit config paths select new files for this command; they do not modify
existing settings. A future execution review must also constrain npm environment overrides, proxy/CA
trust, cache/log effects and installed toolchain provenance before dispatch.

There is deliberately **no default command executor**. A future admitted adapter must observe real
spawn/exit/close events using the existing raw lifecycle contract, preserve its owner on rejection,
and manage deadlines, descendants and failure/timeout cleanup. Do not infer acknowledgement from a
resolved RPC or fabricate closure fields from a PID. The engine does not invoke the existing
observer's default termination behavior or provide a forced-cleanup escape. Normal direct closure is
not proof of descendant, npm cache or whole-job retirement.

## Exact tar and record

Only the eight existing Gateway payload paths are admitted: package/lock, compiled main, README,
license, environment example, Caddy example and Gateway docs. Extra files, even an empty undeclared
directory, links or special files fail. The staged manifest must match the derived source manifest;
compiled and copied source bytes cannot change during lock preparation.

The writer emits explicit directories and regular files in canonical USTAR, with metadata modes
0755/0644, UID/GID and mtime zero. These are archive metadata, not changes to host permissions or
claims about the real publisher's ownership. Paths are never truncated. The existing independent
`LinuxTarCensus` checks the entire inventory; exact canonical bytes additionally cover header fields
that its normalized census does not expose, including version bytes, ownership and padding.
Synchronous gzip is applied only to these newly generated bytes and self-checked. This is not an
untrusted gzip-admission parser or extraction routine.

The existing admission bounds remain: 64 MiB/member, 256 MiB total payload, 128 MiB compressed,
4,096 visited entries, with a separately bounded 16 MiB record. They are not disk quotas or memory
qualification thresholds. Actual build/npm/cache writes must fit separately admitted job resources.

Archive, canonical checksum and `gateway-build.json` are written exclusively, synced, closed and
reread with stable single-link identity checks. Source/tool/stage bytes are rechecked before and
after manifest handoff. A later failure retains earlier files; a `built` file can survive a failed
job and never substitutes for independent terminal service status and exact artifact readback. The
returned owner snapshot covers tracked file IO and direct command observations only. The record
makes no assertion that its own process, descendants, cache or generated workspace has retired.

## Qualification and review still required

No actual command executor, job admission or release wiring is supplied. Real offline npm
compatibility, actual installed transitive toolchain and module loading, independent
service/run/job/ attempt/artifact identity, shipping Gateway execution and runtime/loader evidence
remain missing. Per-GC calibration, independently reviewed policies, full-product duration/cycles,
retention and normal retirement are still required. Native/package/storage/spending holds remain
unchanged.

Tests use a memory filesystem and actual-source owner/lock/tar code, the actual raw child observer
with EventEmitter/fake clocks, synchronous codecs and committed package-lock data as read-only
input. They do not install, dispatch commands, touch actual configs or establish real runtime
qualification. A separate peer review must assess this engine before an execution adapter is wired
or admitted.
