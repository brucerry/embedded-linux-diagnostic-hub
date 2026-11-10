# Linux borrowed-FD namespace operations: source draft

This revision adds a separate ABI2 removal operation to the borrowed-directory-FD rename binding.
The new ABI2 source has not been built, loaded or qualified in this task. Prior ABI1 component
results do not qualify it. There is no install hook or command service.
Existing `linux-native-backend` defaults remain unchanged (`moveNoReplace=null`).

`electron/linux-native-driver.ts` now connects the same guarded transaction algorithm to the
concrete backend without relabelling native effects as memory. It requires explicit supplied host
operations and a no-replace primitive; missing/default operations refuse before any action. It
snapshots the plan, host methods and filesystem constants, retains the original at-most-two- minute
backend window, and consumes exactly one transaction. Install/repair/update/rollback keep their
existing reservation, preimage, activity, journal and uncertainty custody checks. Summaries remain
`nativeQualified:false` and `productionDispatch:false`. This is functional unqualified driver code,
not a native loader or execution permission. Fake facade tests establish algorithmic behavior only.
Existing memory-model tag rejection remains intact.

An explicit `resume` operation now completes a fully verified `prepared` or `old-retained`
transaction, including the exact slot state after a move completed before its journal advance. It
requires a fresh consented review, the same source/payload/transaction, inactive app slots and a new
atomic root reservation. A still-held reservation refuses recovery. The original journal owner is
preserved; only the new invocation's reservation can be released. Complete prior and candidate
payloads, profile identity and untouched pending menu preimages are checked before any recovery
mutation. No payload is recopied or deleted. Partial `copying`, partial or foreign menu files,
mismatched sources and uncertain current outcomes remain retained and refused. Recovery never
retires or retries the old invocation. Actual kernel ownership, crashes, filesystem durability and
native loading still require qualification; controlled facade tests do not establish them.

The same explicit action also recovers completed app activation with interrupted forward menu
creation, replacement or deselection. It admits only the exact acknowledged menu phase or the
verified physical result of that phase's single submitted write/move. It first checks both full app
payloads and the menu journal's original ownership against the retained previous payload. It never
skips an intermediate journal transition, recopies an existing menu file, overwrites a foreign
destination, deletes retained content or touches the profile. Complete writes and no-replace moves
can be acknowledged from a fresh review; partial bytes, unreachable phase/action combinations and
menu rollback interruptions stay refused. A live launch/other root reservation cannot be acquired or
retired by this recovery action.

`electron/linux-owned-launch.ts` adds a separate one-use, unqualified launch controller. It checks
the complete installed payload under a fresh reservation before invoking the explicitly supplied
process host. The Node host launches only `ROOT/app/diagnostic-hub`, with no arguments, shell,
detachment, unref or signals, and with a fixed environment plus validated local desktop variables.
Output is drained and counted up to 64 KiB per pipe, never retained. Initial child PID/UID/parent,
executable and stable start-ticks are read through the existing guarded backend. Normal direct-child
exit, close and both pipes' EOF/close are separate acknowledgements within the existing at-most-two-
minute window. Failures retain custody and do not retry or kill anything.

Even after normal direct closure, the root reservation stays held: this controller supplies no
successor handoff or Finalize authority. It does not prove window visibility, responsiveness, actual
profile selection, loaded libraries or descendant retirement. Node child handles plus `/proc`
samples are not pidfd/immutable-executable proof and do not isolate hostile same-UID changes. Local
desktop authentication paths are explicit user selections, not authenticated display endpoints. The
deadline records/retains uncertainty; it does not forcibly bound a stuck synchronous OS call or
terminate a child. A future real caller must retain the controller and provide authorized lifetime
custody. No production entry imports this launcher, and no native application was started here.

Finalize remains unavailable: the current interfaces have no authoritative
descendant-retirement observer or native Linux window/profile/successor reader. The generic boot
acknowledgement also does not consume this Linux transaction journal. Direct-child closure, an
inactive executable scan, a self-reported reply or a synthetic observation supplies none of that
missing authority. Menu recovery does not add a retirement receipt or deletion capability.

## Initial no-menu current-payload uninstall

The separate permanent entry accepts `--operation uninstall-current`. It uses the actual native
host, guarded backend, a fresh review and explicit applying confirmation. Only a completed initial
installation with no menu, previous/staged payload, retained lineage or update-recovery state is
supported. Active or unknown executable-path observations refuse before removal writes. The
source folder and profile stay outside the target; settings, reports and original records remain.
This operation does not Finalize an update or claim that all maintenance artifacts were removed.

Under the existing per-root cooperative reservation, the current payload is moved with NOREPLACE
into a fresh owned0700 quarantine. Original manifest, installation, ownership and journal bytes are
retained outside the deletion target before its in-tree metadata is removed. The bounded plan
contains only those originals and exact manifest leaves/directories. Each leaf is moved to the
private `disposal/entry` slot, checked again by identity and bytes, and submitted once to
`unlinkOwned(parentFD, basename, kind, expectedDev, expectedIno)`. The C export requires an owned
exact0700 CLOEXEC parent and checks the expected file/directory identity before one direct
`SYS_unlinkat` attempt. Regular files remain single-link; directories must actually be empty.
There is no recursive or pathname fallback, retry, restore, profile removal or source removal.

Linux has no atomic expected-inode compare-and-unlink primitive. This design relies on the private
disposal directory and cooperative reservation; it does not isolate a malicious writer with the
same UID. A raced object moved into quarantine is retained on mismatch, never deleted or restored.
Before each step, the current source, reservation, remaining exact inventory and bounded
executable-path activity under the actual quarantine/disposal paths are checked. These are
observations, not an interval-wide inactivity or descendant-retirement guarantee.

The fsynced state records an issued move/unlink before submission. Failure, cancellation/deadline,
partial writes or lost acknowledgements retain the owner and first error without automatic replay
or cleanup. A later explicit invocation requires fresh review/consent and an available reservation;
it admits only phase-consistent source/disposal presence and original bindings. Corrupt, foreign,
unsupported or still-owned state refuses. Pending removal blocks ordinary setup/launch. After
known completion, a later consented fresh no-menu install preserves the complete removal directory
with NOREPLACE under a name bound to the original installation UUID before creating its new
journal. This permits a new initial lifecycle while retaining every earlier removal record.

ABI1 modules retain rename support but provide no uninstall capability. The fixed builder receipt
now truthfully reports ABI2. The adapter captures closed data descriptors and preserves thrown
unlink errors, including `undefined`, so a throw after a successful syscall cannot authorize retry.
Memory controls and compiler inspection supply no native deletion or uninstall qualification.

The installed Linux `readUpdateInfo` producer now emits an optional `linuxSetupReadiness` self-
observation through the existing trusted main-frame IPC. It reads the bounded ownership and active
journal twice via the existing non-following descriptor-bound read helper, matches their local
candidate/transaction/profile bindings, and samples actual main-process profile-lock, frame,
navigation generation, visibility, minimized/loading state and opaque native window handle before
and after those reads. Metadata races, unsupported handles, changed profiles/documents or unknown
states yield `null` while ordinary update information remains available. No new listener, debug
endpoint, metadata file, setup effect or permission is introduced; Linux skips the incompatible
generic boot-ack writer. Other platforms retain their existing acknowledgement path.

This is an actual source-level producer integration, not native qualification. Its startup manifest
identity and main-process window/profile reports are self-observations; payload integrity remains
`not-checked`, independent process/window observations and descendant retirement remain false, and
`finalizationAuthority` is always false. The existing pure successor verifier, reservation custody
and unconditional Linux setup/release refusals are unchanged. An authenticated challenge/readback
path plus independent kernel, physical-profile and compositor/window facts and normal whole-group
retirement are still missing. Existing exact-source native harness profiles/receipts are historical;
the changed main-process source requires reviewed rebinding and real native execution separately.

An opt-in source-level installer readback now uses a fourth stdio pipe of the owned launch. The
launcher supplies `DIAGNOSTIC_HUB_SETUP_READBACK=1` only in that mode; packaged installed Linux main
wraps inherited descriptor 3 only after the explicit flag and ordinary-user/socket checks. Normal
launches and other platforms touch no descriptor. No listening/connecting endpoint or pathname,
credential, permission change, shell argument or debug interface is added. This relies on the
reviewed direct launcher's private inherited channel; `fstat` and Node stream construction do not
prove socket peer credentials, isolate hostile same-UID FD reuse or authenticate immutable code.

The first trusted `readUpdateInfo` observation offers readiness. After its independent initial child
process sample, the installer sends one fresh 256-bit nonce and exact transaction/profile/ payload
binding. Main refreshes readiness before its one reply. The parent validates the complete closed
record and nonce, checks freshness and rejoins the same child PID/start ticks. Frames are capped at
12 KiB before concatenation/JSON parsing, inbound bytes at 32 KiB per endpoint, and
duplicate/unknown/truncated/invalid-UTF8 frames fail closed. No automatic challenge or write retry
exists. Stream write callbacks, writable finish, readable EOF, end acknowledgement and close are
separate facts; errors retain custody without destroy/signals. App quit independently joins this
channel alongside existing product owners. The owned launch retains its root reservation even after
successful channel readback and direct-child closure.

Authentication is limited to the specifically owned channel plus fresh challenge and source-bound
candidate binding. `channelBoundFreshReadback` is not native successor qualification. The reply's
independent process/window, descendant retirement and Finalize authority remain false. Actual
Electron inheritance/descriptor-family/peer behavior, window/profile observations and normal
whole-group retirement remain unrun and must be qualified in an owned native environment. A stuck or
failed handshake can intentionally block quit to preserve uncertain channel custody; the existing
cooperative 120-second launch window is not an OS lifetime/termination primitive. No real native
process, descriptor, socket or launch was exercised by this preparation.

There is still no admitted `.node` loading implementation. The existing object-only ABI checker
cannot authenticate binary origin or prove that a pathname load uses the bytes just inspected. No
supported immutable-file/identity-at-load and independently observed runtime dependency binding has
been implemented in this repository. The driver therefore never chooses a filename, calls
`require`/`dlopen`, or supplies a default native host. An already supplied callable is an explicit
unqualified host dependency, not evidence that a real binary passed strict admission. Production
setup dispatch stays review-only until native loading and lifecycle qualification are complete.

This preparation neither inspects retained compilation sessions nor admits any older local binary.
For real installation the remaining sequence is: identify and authenticate a fresh binary and its
source/toolchain/runtime/dependency closure; establish supported identity-preserving native load;
qualify the actual syscall and guarded filesystem/crash/recovery behavior on owned Linux paths; then
complete owned launch/normal-close, Finalize/removal and AppImage-specific behavior and real
run-bound lifecycle receipts. The new folder driver supplies none of those missing native claims.

The nested `binding.gyp` follows the existing node-gyp addon convention used by ssh2/cpu-features.
It uses plain Node-API C headers, with no new npm runtime dependency, NAN or FFI dependency. Koffi
is not a declared/installed runtime package; residual platform lock entries do not supply an
approved binding, and retired-component package exclusions remain intact.

## Legacy ABI1 rename / status version1

Linux x64 only; Node-API 8; a consuming Node/Electron runtime must expose Node-API >=8. The frozen
exports are exactly `abiVersion=1`, `napiVersion=8`, `statusVersion=1`, `platform=linux`,
`arch=x64`, and `renameNoReplace(srcDirFD, srcName, dstDirFD, dstName)`.

The C callback validates four arguments, nonnegative integer FDs, complete well-formed UTF-16/UTF-8
single basenames (1–255 bytes, no dot/parent/slash/backslash/control/NUL), ordinary current UID,
live owned directory handles without shared write/set-ID/sticky bits, and close-on-exec FDs. It
never opens/closes a caller FD or resolves a supplied path. Exactly one
`syscall(SYS_renameat2, ..., RENAME_NOREPLACE)` is attempted; there is no retry or fallback. Success
is numeric 0. Other stable numeric statuses are:

| Status | Meaning                                           |
| ------ | ------------------------------------------------- |
| 1      | destination exists (EEXIST/ENOTEMPTY)             |
| 2      | syscall/flag/filesystem support unavailable       |
| 3      | permission/ordinary-user/parent ownership refused |
| 4      | cross-device move refused                         |
| 5      | invalid argument/name                             |
| 6      | invalid/non-directory/non-CLOEXEC FD              |
| 7      | unknown failure                                   |
| 8      | interrupted; outcome unclaimed, no retry          |
| 9      | read-only filesystem                              |
| 10     | busy                                              |

The TS adapter accepts only the exact closed ABI and numeric 0 success, throws fixed error codes
without raw exception text, paths or errno messages, and captures the function independently. It
takes an already supplied module object; it performs **no native loading**. This validation is not a
security boundary for native code. A future approved loader must verify exact binary/source
provenance, physical path, hash/length, ELF architecture, dependency closure and runtime binding
**before loading**, since module initialization itself executes native code.

## Build and qualification prerequisites

A separately approved native Linux x64 environment needs an identified C17 compiler/linker, make, a
compatible Python and the existing node-gyp tool, pinned Node-API headers, and Linux headers
exposing `SYS_renameat2` and `RENAME_NOREPLACE`. Missing platform/header support causes a compile
error. A kernel/filesystem returning unsupported status refuses; ordinary rename/copy/delete is
never substituted. This work did not inspect or invoke any Linux toolchain or compiler.

For a later approved build, use the existing node-gyp with an explicit local pinned header root
(`--nodedir=...`) in this nested directory; do not allow its default header download. Identify the
fresh build root/output and build effects first. No build command is activated by package scripts.
The resulting `.node` would be a physical binary outside ASAR, separately hashed and reviewed;
packaging/admission/loading integration is deliberately deferred.

Nonoperative command shape for a later separately approved fresh Linux source copy:

```text
<PINNED_NODE> <EXISTING_NODE_GYP>/bin/node-gyp.js configure build \
  --directory=<FRESH_COPY>/native/linux-rename-noreplace \
  --nodedir=<PINNED_LOCAL_LINUX_TARGET_HEADER_ROOT> \
  --python=<VERIFIED_PYTHON> --make=<VERIFIED_MAKE> --jobs=1
```

These are placeholders, not a runnable grant. Use verified Linux target headers/configuration, not
this Mac's configuration; stop if headers/tooling are missing rather than downloading. The future
build creates node-gyp-owned configuration/object/binary outputs in that fresh copy. It does not
require installation into the system or loading/running the addon as part of build. No fresh build
root, actual toolchain identities or artifact hashes are assigned by this draft.

Required native checks include actual compile/load/Node-API compatibility, owned directory FDs,
CLOEXEC, Unicode names, destination races preserving all pre-existing bytes, source/parent changes,
EXDEV/permission/unsupported/interruption behavior, and exact backend identity checks. FD/source
rechecks do not provide atomic source-inode CAS or security isolation from an adversarial same-UID
thread/process. Borrowed FD lifetime, syscall atomicity, crash durability and runtime timing remain
unqualified. Fake JS and static source checks cannot establish these properties.

## Prospective menu use (source only)

The unqualified menu backend also uses this same basename/borrowed-parent-FD operation to move
regular owned desktop files between a pinned XDG applications directory and private retained
maintenance slots. It validates regular-file type, single-link ownership, byte/hash/inode identity,
empty destination and same filesystem first. ABI/C code is unchanged; no binary is loaded here.
Actual regular-file rename behavior, source-inode race limits and both parent-sync semantics need
native Linux qualification. No ordinary rename, unlink or copy/delete fallback is supplied.
