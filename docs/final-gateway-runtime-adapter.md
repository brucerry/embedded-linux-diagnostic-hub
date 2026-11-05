# Final Gateway tar: independent file census and direct-child adapter

This is source preparation, not a runtime pass. No actual tar was installed, dependency downloaded,
process spawned, server started, credential/configuration file read or permission changed. Synthetic
fixtures use recording filesystems, EventEmitters and the existing bounded archive codecs.

`createFinalGatewayObserver` validates the selected Gateway build record, exact archive/hash/member
census and prepared lock against separately supplied frozen source-lock bytes. It retains checked
USTAR member copies without extraction. Build-record bytes are copied and hashed before asynchronous
work, so caller mutation cannot silently rebind evidence. Inputs must already be admitted by the
separate provenance boundary; byte/schema consistency does not authenticate a producer or grant use.

The read-only observer walks an already prepared POSIX installation through explicit filesystem
ports. It independently hashes every regular file, checks each shipped payload file against the tar,
compares required installed package names/versions to the validated lock closure, refuses extraneous
or optional package files and `.node` files, and observes a separately selected executable Node
file. Canonical paths, stable descriptor/path metadata, single-link files and no
group/other-writable or setid modes are required. It reads in 64 KiB chunks and verifies size/hash
and metadata before close. Descriptor acquisition is registered before open; pending/rejected
open/close cannot produce ready state or silently discard an unacknowledged handle. Primary errors
and cleanup diagnostics remain available through the failure owner. There is no retry, forced close,
mutation or installation API.

The installation census is bounded to 4,096 entries / 256 MiB regular-file bytes, 64 MiB/file, 1
MiB/package manifest and 256 MiB for the separate Node executable. These are observer admission
bounds, not CI quotas or hardware limits. They do not guarantee a JavaScript/native heap ceiling.
The full regular-file snapshot is independent of the child's claims; it still does not establish
that files came from the lock's registry tarball integrity. No package archive was acquired or
verified here. Directory aliases, links and unknown root files fail; real credential-bearing
root-level `.env.gateway`/`.npmrc` paths are refused before opening, not inspected or silently
excluded.

After a successful census, `observeChild` accepts an already-owned direct child, not a PID/JSON
receipt or command to execute. The parent must attach it before spawn/exit/close events can be
missed. The supplied Node handle's reported executable/arguments must be exactly the selected Node
path and installed `dist-gateway/main.cjs`, with ignored stdin and piped stdout/stderr. The
controlled explicit-environment launch profile is a future admission decision; the observer never
reads an environment, credential or real `.env.gateway`. Normal npm's env-file startup is not
silently claimed covered. Missing observations remain pending; error/nonzero/signal outcomes cannot
emit success. Only output byte counts are retained; raw output/errors are not written into evidence.

Direct spawn/exit/close and both stream closures precede a second independent file census and
acknowledged removal of owned observers. Held/rejected file or listener cleanup stays visible;
`joined` means this direct observation joined its known calls/listeners, **not** process-tree or
Gateway resource retirement. The caller retains the child and all process ownership. There is no
spawn, signal, timeout-as-retirement, debugger, module hook, import of the target or source-fixture
substitution. Completed controllers cannot be replayed onto a replacement child.

The returned canonical JSONL bytes/SHA256 bind the exact selected source/build/tar, before/after
installed-file census and parent-reported direct-child observations. They are not written/uploaded;
a separately owned writer/readback must later establish durable emission. All of these remain null:
actual kernel executable mapping, loaded JavaScript/dependency mapping, descendant retirement,
Gateway session/stream ownership, configuration identity, reviewed policy and normal/forced GC.
`releaseAcceptance` stays false and no release consumer is relaxed.

## What cannot yet be independently established

- Lock name/version/SRI fields do not authenticate extracted installed bytes. Completing dependency
  provenance needs independently retained package bytes with exact integrity-to-member mapping, or
  an explicitly admitted trusted installation snapshot. Current file census establishes observed
  bytes and stability only; it does not invent that trust decision.
- Node's reported spawn paths and a matching on-disk Node hash are not an OS-mapped executable or
  proof of JavaScript files actually loaded. Pre/post checks cannot exclude transient substitution
  followed by restoration. There is no accepted native loader observer or immutable-input trust
  assumption in this implementation.
- `gateway/main.ts` owns the server internally and exposes normal shutdown through SIGINT/SIGTERM;
  its shipped CLI does not export `ownershipSnapshot` over IPC/HTTP. The source-fixture IPC host
  cannot qualify final tar ownership. No new debug endpoint or signal authority is added here.
- `/api/health` reports version/session summary, not all HTTP/SSH/console tasks. Such public results
  cannot supply exhaustive ownership, descendant closure, calibrated resource policy, full measured
  workload/soak semantics or durable parent closure.

Actual installation, execution, loopback networking and normal shutdown each still need a bounded
admitted owner and input/resource scope. Approval alone cannot supply missing native observations.
Package/storage, spending, native/DUT, publication and release gates remain held. This module
operates only through source-owned filesystem/child interfaces; fake results are not shipping
qualification.
