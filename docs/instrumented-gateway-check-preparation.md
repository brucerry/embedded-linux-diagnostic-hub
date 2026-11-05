# Separate instrumented Gateway ownership check

Historical candidate 289 preparation is described below. The subsequent owned child, complete prelaunch census and compatibility prerequisite are documented in [instrumented-gateway-child-preparation.md](instrumented-gateway-child-preparation.md); its explicit activation supersedes the earlier missing-child prerequisites without claiming execution.

Preparation only. No compiler, inspector, Gateway, socket, package install, product process, push
or hosted job ran. This adds an explicit-port source/byte producer, an ownership workload driver,
an inert native-port entry and synthetic controls. It adds no active workflow, default launcher,
CLI activation, environment/config reader, TCP inspector endpoint or release grant.

## Same production source, distinct evidence

The successful unmodified-CLI reference is commit 760dba0c7ab9f44b8eb7e00a4b53923272ea488a,
tree 596e7f87fd8ef697e2f5b1509b342c0edddce7ec, run 41990160342, attempt 1, job 127120220376,
receipt SHA256 93c09e75f5f719a3ede713eadf6014d75a892979fe8e171b8e822790f50ecd9c.
That experiment passed health/auth/direct-close checks. It did not observe internal ownership.

A read-only census of that exact committed tree froze 213 production files under src/shared/
electron/backend/gateway/public plus package/config/license/example/Gateway documentation inputs.
The canonical path/mode/blob/size/SHA256 inventory digest is
14c3f8cb832fc751c0676ccdb16cecc747e2c3eac0d0ef31d0182b462f9d9325.
The JSON fixture contains only that metadata, not historical runtime output. The new producer
re-observes its actual selected source through observeSourceBridge, compares all 213 file identities
to this frozen digest before dispatch, and rechecks the complete source around the handoffs.
Thus changed production files cannot silently borrow the old CLI reference. New instrumentation
source/tooling is separately bound to its own exact commit/tree; it is not the old full tree.

The old receipt is a historical reference, not a live API or cryptographic service attestation.
The instrumented result never transfers ownership, performance or GC claims onto the unmodified
CLI. Its shippedCLIBehavior/shippingPerformance/shippingGC stay null; releaseAcceptance is false.

## Source and byte producer

prepareInstrumentedGatewayCheck has only explicit source-provider/compiler/readback ports.
It issues one fixed Node/esbuild command for tests/fixtures/instrumented-gateway-check-entry.ts,
bundled as CommonJS to a new validation/gateway-ownership/instrumented/ownership.cjs, external ssh2.
The native owner must create that new output namespace before dispatch and refuse prior work.
There is no replay or default process API here. Owner/id/role/cwd/argv and exact lifecycle schema
must agree; spawn/exit/close flags are strictly true, timeout/termination false, exit0, no signal
or cleanup errors, bounded elapsed time. Rejected dispatch stays owned by the supplied executor;
a fulfilled promise or generic passed flag cannot substitute for direct observations.

The tool observation requires canonical Node/esbuild paths and hashes. Before dispatch, bounded
esbuild bytes must match the hash and an admitted Node shebang/node-script format; native/unknown
entries fail rather than being fed to Node. The future native controller must obtain those facts
through descriptor-bound reads, select Node 24 with no injected exec arguments, and constrain the
complete environment. These source-level ports do not establish that real installation or compiler
behavior. A malicious compiler/parent is outside the diagnostic trusted-harness assumption.

Artifact readback is Buffer-only, nonempty and checked against the existing 32 MiB bound before
copying. The independent prelaunch script snapshot is at most 512 files/64 MiB total/32 MiB each,
with canonical paths inside the owned instrumented directory and the existing 4096 path ceiling.
The entry bytes must exactly equal its snapshot member. Copies, source/tool rechecks, hashes and
the actual command-ack digest bind the result. Snapshot data is not supplied by Inspector events.
The binding explicitly remains local source/command/byte consistency, not independent build/service
attestation; buildProvenanceVerified stays false.

## Actual ownership workload

The inert exported runPreparedInstrumentedGatewayCheck entry supplies actual prepareInstrumentedGateway,
Node HTTP and synchronous clock ports only when called by a separately admitted controller.
Importing the entry does not itself connect a Session, construct the Gateway, listen or start timers.
The tests do not import that native entry or the product implementation; they use the actual source
bootstrap/collector with fake inspector/product/HTTP/clock ports and copied source inputs.

The driver copies the admitted binding/scripts before acquisition. A fresh synthetic token, exact
Origin and never-contacted dummy target are used; no user env-file/SSH credentials or device route.
The existing observer owns a private in-process inspector.Session and never calls inspector.open.
It enables Debugger, compares actual returned script text byte-for-byte, then constructs the real
Gateway factory. No unknown script URL, live edit, sourceURL alias or CommonJS source transformation
is silently normalized or admitted after the fact.

The Gateway binds IPv4 127.0.0.1 with OS-selected port 0 and acknowledges its actual address. Before
one health request, the driver requires listening=true, stopping=false and cleanupTimers=1. One
bounded actual /api/health request must return the exact healthy response and retire its request,
response and socket owners. A second active product sample records actual counters while the server
and timer remain owned. It may include transient server-side HTTP custody: client closure does not
join the server's callbacks. It then invokes bootstrap.close once; that actual product join,
not the active sample, is the strict zero-counter gate.
Close must acknowledge the actual product close, zero all source-owned counters and arrays, detach
server listeners, drain source callbacks, acknowledge Debugger.disable and disconnect the owned
Session. The driver awaits the separate retirement acknowledgement; a rejected close alone is not
proof of cleanup. Failed-but-acknowledged local retirement remains failed rather than trapped as
success or silently retried. Changed observer record bytes/hash/canonical JSON also fail validation.

The 45-second watchdog can request the same once-only normal bootstrap close; it cannot force an
inspector callback, remove pending ownership, signal a process or retry a rejected close. Unknown
acquisition, async synchronous-port return, rejected timer cleanup or nonzero counter remains held.
There is no SIGTERM/SIGKILL, process group kill, forced exit or recursive deletion in this driver.

This smallest workload exercises server/timer ownership and completed HTTP resource return. It
does not exercise an active SSH transport, pending write, cancellation, held HTTP shutdown, console
or full soak. Counters that stayed zero are not evidence those other workloads retired correctly.
The bounded <=16 KiB receipt includes numeric/boolean samples and hashes only, with no token,
source text, request body/header, transcript, native error text, session IDs or target identifiers.
The full observer record remains bounded at 4 MiB and is hashed after byte/canonical verification.

## Concrete execution prerequisites and proposed scope

No contained child controller/workflow exists in this candidate. The complete supported path still
needs a reviewed controller that:

1. Validates exact source and frozen production comparison, descriptor-bound Node/compiler inputs,
   bounded build acknowledgement and artifact readback, with fresh owned directories.
2. Creates a separate instrumented installation and installs only required locked dependencies with
   scripts/optional/native addons disabled, owned cache/config paths and official registry origins.
   It must not alter the unmodified shipping tar/install or use a shared node_modules symlink.
3. Independently enumerates every potentially compiled non-builtin script under that new owned layout
   before launch, including external ssh2/transitives and the containing activation/controller file.
   Both dependencies and activation must resolve inside this admitted tree. A controller outside
   the tree, root checkout node_modules, Node -e/unknown anonymous scripts, omitted dependency scripts
   or unsupported source formats must fail; do not widen the allowlist from notifications.
4. Calls the inert entry inside one owned disposable Node child, retains all IO and parent-observed
   spawn/exit/IPC(if any)/stdout/stderr closure, checks the bounded child receipt only after normal
   parent-observed close, and preserves errors/unknown cleanup. No current port/schema proves this.

Real Node 24 Inspector replay ordering, file URLs and exact CommonJS getScriptSource behavior remain
unverified. Header/format incompatibility is a reason to stop and characterize, not strip wrappers or
declare a pass. The supported in-process Session API avoids a TCP debug endpoint, but neither it nor
zero counters supplies mapped kernel executable identity or authoritative whole-group retirement.
An independent supported platform supervisor/observer is still needed for that strict release gate.
The current managed platform does not provide such an acknowledgement, and approval cannot create it.

After those native controls are prepared/reviewed, the smallest new execution decision is one separate
standard public Ubuntu diagnostic job: bounded official Node/npm downloads, one instrumented build,
one owned child, one loopback health request, private in-process Inspector and normal local close,
20-minute job cap/45-second workload, no artifact/cache upload, <=16 KiB receipt-log readback, no
retry. No parent process kill or new security permission is proposed. Timeout/cancellation may rely
on GitHub teardown and still would not prove graceful descendant retirement. Total logs follow repo
retention and are sized only after retrieval; file/read bounds are not disk or heap quotas.

Routine source preparation is already authorized. The completed unmodified-CLI one-job permission
does not authorize this separate Inspector/instrumented execution. Fresh source/branch/trigger/access/
standard-runner/no-spend preflight and the exact new job decision are needed before publication.
Keep $0, package/storage, native/DUT and release holds unchanged. No paid upgrade or permission change.
