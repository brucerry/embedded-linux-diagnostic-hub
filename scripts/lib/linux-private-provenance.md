# Private Linux build facts, source only

This additive variant supports the existing Linux folder/package/review work in
OpenSpec `plan-windows-permanent-delivery` tasks 15.1, 15.3, 15.4, 16.3 and 18.3.
It separates private build consistency from published-release facts and keeps all
those native/adoption tasks open. It creates no signer, issuer, trust Boolean or
new release requirement. Original published validation remains unchanged.

Published observation selection retains its existing exact fields and actual
selected release bytes (tag, resolved commit, draft:false, URL and asset) plus
legacy Linux build-info bytes. Existing historical records remain readable.
The existing release verifier rejects the new private metadata discriminator or
source-record field before its ordinary published checks; historical five/six-key
metadata shapes are preserved. No workflow or publication path is enabled.

Private selection explicitly has `mode:private-build`, repository, version,
sourceCommit, sourceTree, sourceManifestSHA256, buildId, archiveSHA256,
archiveBytes, sourceRecordSHA256 and buildRecordSHA256. No tag, release URL,
draft/prerelease status, or releaseRecordSHA256 is permitted. Expected record
digests and source/build/artifact facts must be independently selected, not
inferred from the payload. The source manifest digest identifies the exact
retained source-manifest record bytes; sourceCommit/tree identify the truthful
isolated Git snapshot. Neither is a proof that those sources produced the binary.

The source record has exactly schema:1, kind:private-linux-build-source,
repository, version, commit, tree, sourceManifestSHA256 and buildId. Commit/tree
are lowercase40hex, manifest/digests64hex, buildId32hex. A private build record
has schema:1, kind:private-linux-build, the existing version/commit/platform/arch/
two-asset hashes, plus sourceTree/sourceManifestSHA256/buildId/sourceRecordSHA256,
archiveBytes and validation. The source and build records are separately hashed,
bounded64KiB, closed, selected and compared with one another and the existing
plan. A stale build ID, source tree/manifest, artifact length/hash, version or
record digest refuses. Paths use sourcePath/buildPath in private mode and
releasePath/buildPath in published mode, with the original ownership, ancestor,
nonoverlap, stable-identity and deadline checks in the disk adapter. No fallback
converts a rejected private selection into published acceptance.

`record-linux-build.mjs` is now import-safe. No-argument CLI still records the
published-compatible six-key shape, but validation defaults to an explicit
unperformed string, never an automatic loopback-pass claim. A private invocation
requires --mode=private-build, --source-record=PATH and an independently supplied
--source-record-sha256=SHA256. Both modes require the actual40hex GITHUB_SHA to
match their selected source, and artifact hashes come from the actual assets
when the CLI is eventually admitted. Mode-specific schemas are not interchangeable.

Optional --validation-result=PATH must be paired with an independently selected
--validation-sha256=SHA256. The exact bounded result has schema:1,
kind:linux-packaged-loopback-ssh, status:passed|failed|unperformed, version,
commit, buildId (private32hex or published null), and both exact asset hashes.
Only a selected matching passed result produces a verified claim. Failed and
absent/unperformed results remain so; malformed, stale or cross-build results
refuse before output. The digest authenticates selection consistency, not a
signature or the truth of arbitrary JSON: the supplied result must already have
been independently verified. This code does not run a smoke test or create such
evidence. Metadata creation exit0 alone is not validation success. Published
output remains a string; private output uses status/resultSHA256, with null only
for unperformed. The actual selected result remains separately retained evidence.

Future CLI effects (NOT exercised here): bounded source/package/optional result
reads, two actual asset hashes (each capped2GiB), and writing/replacing the same
release/linux-build-info.json. Node streams may normally close their own input
handles. Write failure may leave a partial/unqualified sidecar; there is no
unlink, retry, temporary cleanup, child, app, Git or helper invocation. Such real
reads/output replacement need their own scoped build/artifact admission. Help,
import, argument validation and the new tests never select this concrete IO.

The prospective pure tests use only in-memory JSON/Buffer/hash operations and
injected read/hash/write functions. They import neither the concrete disk adapter
nor archive codecs. CLI main is excluded by its exact import.meta/argv guard.
There are no hooks, filesystem fixtures, timers, listener, native syscall, app,
cleanup or spawned child in test callbacks. Only Node's ordinary test runner and
one file worker/runner IPC are prospective process effects.

No code or test has run in this source preparation. Real archive/tree/descriptor
observation, package production, source integration/typecheck, Linux IO/ASAR,
codec/kernel/native/helper/lifecycle/platform and release acceptance remain
unqualified. Real handoff remains provenance-unavailable; native/mutation
dispatch is unchanged and disabled. Historical cleanup incident remains OPEN;
the missing historical33-file aggregate is not recovered by this NEW work.
