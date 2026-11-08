# Windows file handles and explicit process creation (source preparation)

This Node-API v8 addon implements read-only observations and a separately requested process-creation
operation. Opening an existing PID never becomes ownership of that process. Only a successful
`CreateProcessW` return supplies the new operation's process and thread HANDLEs. Neither route
installs, closes a window, verifies originally loaded code, or retires descendants. The existing
native offline-launch entry, shared lifecycle consumer, and full release gates remain closed.

`prepare` allocates an opaque, type-tagged native wrapper before any Windows effect. The JavaScript
wrapper retains that owner before loader IO. It bypasses the CommonJS cache/extension hooks with the
captured Node `dlopen` builtin and a fresh private module object. The explicit native initializer
only defines exports; ordinary DLL/C++ runtime initialization is not a retirement or loaded-byte
proof. File pinning and process observation run as owned async work; a strong reference and fixed
HANDLE slots exist before acquisition. Cancellation only sets a flag. Late acquired handles are
adopted, retained and reported nonpassing.

File pinning checks the current process token for an administrator group (including a disabled
group), elevation, unsupported impersonation, and medium integrity. It resolves an admitted fixed
drive to its local volume GUID before file opens, then opens bounded ancestors and exactly
`Diagnostic Hub.exe` and `resources/app.asar` without write/delete sharing; rejects reparse nodes,
hardlinked files and mismatched normalized volume-GUID parent paths; then hashes the actual open
handles. These are leases on two named files, not a complete installation inventory or
filesystem/ACL attestation.

Process observation opens only `PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE`. It compares the
retained handle's PID/creation time and the **current named image file** to the pinned executable.
Reopening `QueryFullProcessImageNameW`'s path cannot establish the originally mapped executable file
object or loaded ASAR bytes, especially if a process predates a replacement. Window handles are
bounded observations of that PID, not stable capabilities. `refuseNormalClose` always refuses: no
HWND/PID/path sampling is represented as atomic close authority. The separate fixed cooperative
caller below still needs actual host/runtime verification. Actual installer consent/offline/UI facts
and independent retirement observations are still missing.

## Explicit creation and returned-handle custody

`launchPinnedProcess` is an explicit operation, never called by the read-only producer or existing
native offline-launch CLI. Its JavaScript wrapper requires the exact data action
`launch-pinned-installed` and profile `binding.root + "\\native-launch-profile"`. These inputs are
configuration, not authorization. Native code opens that existing profile through the held local
volume-GUID parent, retains a no-reparse directory HANDLE without write/delete sharing, and reads
bounded directory pages with list access until actual enumeration EOF. Unsupported, truncated,
nonempty, or nonterminal enumeration refuses before creation. An empty observation does not prove
freshness, exclusivity, ACL ownership, or containment of every write the application may make. A
genuine externally established fresh, exclusively owned staging/profile and action authorization
remain prerequisites for any future activation. No boolean, receipt, or caller-supplied mode can
supply those facts. The backend creates, deletes, or changes permissions on no directory.

Before creation, the existing owner now acquires a Node-API thread-safe function (TSFN) on the main
thread: one logical acquisition, queue bound one, no queued calls, no waiter or new worker.
Creation, explicit loop-reference and cleanup-marker registration must each acknowledge success. A
strong wrapper reference and owner registry protect finalizer data. The marker is registered after
the TSFN so reverse-order environment cleanup marks teardown before its finalizer. Native creation
independently requires these acknowledgments; caller flags cannot supply them.

A referenced TSFN prevents ordinary event-loop drain until destruction. It does not prevent
`process.exit`, crashes, forced environment teardown, or establish external host ownership. An
independent host/caller custodian is still required for those cases. Acquired resources survive a
cancellation before CreateProcess; only actual non-creation/terminal sampling permits an explicit
release. A rejected acquisition does not prove no resource exists and is never retried.

Failure errors expose only a frozen, non-authoritative snapshot of retention flags and counts at
capture time. The mutable owner, capability, native ports, HANDLEs, maps, source paths, and buffers
remain private. Nonenumerability alone would not provide that privacy. Primary error objects,
including a thrown `undefined`, remain available through ordinary causes or aggregate errors; later
failures cannot overwrite the first. A custody snapshot cannot admit an operation, recover a native
capability, or attest current resource closure.

The requested executable is the leased volume-GUID executable name and cwd is the pinned
installation root. Fixed arguments select `--inspect=127.0.0.1:0` for the main-process inspector and
the profile through the existing `--user-data-dir` route. There is no browser-debugging switch or
caller-selected inspector address/port. Native code owns a writable quoted command buffer and
explicit double-NUL Unicode environment before creation. APPDATA, LOCALAPPDATA, TEMP, TMP, and
USERPROFILE use the pinned profile; SystemRoot and WINDIR use the bounded actual local
Windows-directory query. There is no arbitrary inherited environment or caller-selected executable.
These are requested inputs, not observations of the running application's environment, effective
profile, or initialized runtime. The current process and executing worker's thread-token eligibility
are rechecked before creation.

`CreateProcessW` receives an explicit application name, no suspension and no job. An extended
startup attribute list admits exactly the three stdio HANDLEs described below; no other
observer/host HANDLE is in that list. The owner and fixed process/thread output slots precede the
call; both outputs are adopted before any allocation, validation, or cancellation check. A false
return with unexpected non-null outputs remains unknown and cannot be released as a successful
creation. Cancellation reserves no retry and never terminates anything. If creation was already
submitted, a late returned process remains retained. Creation returns before application
initialization, so it establishes no ready, visible-window, installer, or loaded-code result.
Holding named-file leases is not a public CreateProcess-from-file-HANDLE API or proof of the mapped
image section.

`sampleOwnedProcess` can observe the already returned HANDLE even after cancellation or the first
error; it never accepts a replacement PID or acquires another process. It uses a zero-duration wait,
creation time, and exit-code query. A signaled wait establishes root termination; numeric exit code
259 alone never decides liveness. Pipe observations are a separate operation. There are no stable
HWND capabilities, normal-close requests, automatic process control, or descendant observations.
`releaseOwnedProcessHandles` refuses a live or unknown root before release submission. After actual
non-creation or root termination plus both actual output EOF observations, it closes only its own
HANDLEs once and joins acknowledged async-work/reference cleanup. Only then does it request TSFN
release once; that pointer is never used again. The existing Promise waits for the normal finalizer
callback plus marker-removal and remaining bookkeeping ACK. HANDLE closure, release request, release
ACK and finalizer observation are distinct facts. The finalizer is not proof that every TSFN
allocation or namespace is retired.

Created-process `/v2` rows add the actual reference acknowledgment; historical `/v1` records remain
unchanged. Release results distinguish HANDLE closure from acquisition, release, finalizer,
finalizer-bookkeeping and environment-closing observations. A submitted acquisition cannot be
relabeled as absent. Missing/contradictory facts retain the private owner, never admit a full case.
No-acquisition cancellation is different from submitted-but-unconfirmed acquisition.

Forced/null-environment or premature finalization never acknowledges graceful closure. A failure in
finalizer cleanup or Promise settlement leaves lifetime/bookkeeping UNKNOWN. Once the last reference
is closing, retained C++/JS data or an unresolved Promise cannot guarantee the loop stays alive; no
recursive keeper, forced shutdown or cleanup fallback is added. Safe app close, loaded code and
descendant retirement remain unproved, and full native/release gates stay closed. Successful normal
release acknowledges only the owner's component resources.

The direct JavaScript controls execute the actual wrapper in a bounded VM with closed in-memory
filesystem/native-port substitutes. Those model objects are not Node-API capabilities and never
enter the production module's private capability map. Tests do not compile or execute this new C++
branch. The preserved `b769e0d` creation source compiled successfully without addon loading. Its
build evidence remains separate from this source/VM preparation. These controls do not test actual
loop liveness, N-API finalization, pipe behavior or Windows runtime behavior; this stdio addition
has not been compiled or executed by them.

## Owned stdio and main-inspector discovery

The existing owner reserves every output slot before creating three anonymous pipes. Stdin is
EOF-only: the parent closes its writer before creation. Stdout and stderr have separate private
readers. Parent-facing ends are noninheritable; `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` contains only
the three child-facing ends. Attribute storage and its fixed handle array stay owned through
creation, followed by one explicit attribute-list deletion. The `DeleteProcThreadAttributeList` API
returns no status; the recorded fact is its normal return, not a stronger destruction proof. After
adopting **both** process/thread outputs, the parent closes its copies of the child ends once.
Unacknowledged closes remain retained. Any failed `CreatePipe` is an unknown acquisition even if its
outputs look null: Microsoft documents those outputs as indeterminate. No retry, GC close or
inferred no-effect release is used.

`drainOwnedStdio` runs in the same serial async-work owner as existing observations. Each explicit
call consumes at most 64 KiB per stream, retaining only the first 64 KiB of each. Those are capture
bounds, not the operating system's anonymous-pipe capacity. The operation does not wait in a loop
for data or add a background poller. `PeekNamedPipe` followed by `ReadFile` uses the sole owned
reader and consumes only available bytes. These synchronous APIs do **not** provide an absolute
wall-clock deadline in a multithreaded host; an external custodian is still needed for an unknown OS
call or forced host exit. A caller must explicitly drain often enough to avoid child backpressure.
No native activation is granted by this source preparation.

Only `ERROR_BROKEN_PIPE` from the actual pipe read/peek records EOF. Zero available bytes, a
successful zero-byte read, and root termination do not. A descendant may retain an inherited writer
after root termination. Overflow is sticky and fails capture; later explicit calls can discard
bounded excess until real EOF so that component resources can still be released. Read errors retain
unknown custody without retrying that reader. A created root cannot release its handles or TSFN
until root termination **and both EOF observations**; non-creation can release confirmed resources
without pretending an application ran.

The wrapper validates bounded canonical base64, exact cumulative byte prefixes, and sticky
EOF/overflow before adopting each observation. The two 64 KiB raw buffers need at most 174,768
base64 bytes combined; the complete internal JSON result is bounded to that amount plus 4,096 bytes.
Raw bytes, returned data and inspector URLs stay in private owner state. Public process `/v2` rows
remain unchanged with `stdioObserved:false`: that row alone is not stdio evidence. The explicit
drain API returns only frozen counts/flags and whether an endpoint was observed, never log bytes or
its token.

Submission makes the current capture observation unknown until the returned shape, bytes and
monotonic facts validate. A rejected or contradictory drain cannot reuse an earlier EOF snapshot to
release resources. Only an explicitly requested later valid drain can re-establish that current
observation; it cannot bypass a native read-failure/busy fence. Overflow or endpoint parsing can
still fail after valid EOF adoption, without erasing that component closure fact or the first error.

Complete stderr lines matching `Debugger listening on ws://127.0.0.1:<port>/<UUID>` supply a private
main-inspector endpoint. Fragmented lines wait for a newline or actual EOF; malformed, duplicate,
non-loopback or credential/query/fragment-bearing candidates refuse. Endpoint lookup requires the
original active capability, with no pending operation, cancellation or primary failure. The endpoint
is **owned-stderr provenance**, not proof that only the root emitted it, kernel socket ownership,
server authentication or physically loaded bytes. A descendant can inherit the writer. The fixed
cooperative caller below is a separate explicit operation; importing or draining never connects or
dispatches quit. The synthetic HWND close delegate and all native/full lifecycle acceptance gates
remain refused.

## Fixed cooperative normal quit (source preparation)

`requestWindowsNativeNormalQuit` uses only the original private native-created capability and its
validated private main-inspector endpoint. It accepts no URL, expression, transport factory or
caller-issued authority flag. It reserves a private one-use owner and stable Promise before timers,
native observations or WebSocket construction. Repeated calls join that same result, including a
failure; cancellation or a missing reply never grants another quit attempt. Public terminal/drain
operations are fenced while this owner runs, and cancellation signals its existing owner rather than
issuing a replacement command.

The endpoint need not already have appeared in an immediate post-creation read. Discovery now runs
inside this same owner using explicit native drains and retained-HANDLE samples before connection.
Startup discovery and later root/EOF joins share the original 15-second deadline and 750 polling
budget; neither phase resets it. A missing, malformed or cancelled endpoint never causes a fallback
port scan, new controller or replacement connection.

The caller samples the retained native process HANDLE, connects its own captured Node WebSocket,
enables Runtime, and requires a default context with a bounded `uniqueId`. Both fixed evaluations
use that exact `uniqueContextId`; there is no numeric-ID fallback or retargeting after context loss.
The identity evaluation returns only `process.pid` and `process.type`. Its PID must match the actual
native-created PID and its type must be `browser`. A second native HANDLE sample must still report
the root live before the only quit evaluation: `setImmediate(() => app.quit())`, with a returned
`{scheduled:true}`. This is a trusted-inspector protocol reply and scheduling acknowledgment, not
kernel socket authentication, proof of which process wrote stderr, loaded-image identity or proof
that cleanup has completed. No path spelling, selected run label, builder Node version or copied
JSON substitutes for these observations.

The application already routes `app.quit` through its `before-quit` controller, which joins update,
connection, SSH, console, native-capture and report cleanup and can block quitting on failure. This
caller does not bypass that controller with `app.exit`, `Browser.close`, a HWND message, process
termination or a cleanup fallback. After the scheduling reply, it closes only its own inspector
connection before waiting for actual root termination, because a debugger attachment can delay exit.
A successful result requires observed root exit code zero, both actual pipe EOF observations, owned
transport-close/listener bookkeeping, all three replies, and no unknown reply waits. Native HANDLE
and TSFN release remains a separate explicit operation after those component facts.

Every response wait is retained before send; frames are bounded to 64 KiB and total received data to
1 MiB. Those are validation/retention bounds, not a hard quota on the WebSocket implementation's
internal receive buffers. A fixed 15-second observation deadline and at most 750 explicit 20 ms
sample/drain delays bound JavaScript observation work; they cannot bound a synchronous Windows I/O
call or establish resource closure by timeout. Timers are retained opaque Node Timeout objects with
their documented methods, not integer IDs. Socket/listener/timer returns that contradict their real
API remain privately retained; native Promise returns are observed, and their unknown outcome is
sticky even if a later close/removal returns normally. Proxy returns are rejected before structural
inspection. No new worker, polling service or keepalive framework is introduced.

A close event cannot complete transport bookkeeping until listener acquisition has finished and
exact listener removals have returned. Pending reply waits may then retire only as
**closed-unacknowledged**, preserving the distinction from a server ACK or completed quit. A failure
before the constructor is ever invoked has a known no-connection result with
`ownedInspectorCloseObserved:false`; a submitted constructor that throws or returns an unsupported
object remains unknown. The narrow `joinWindowsNativeNormalQuitTransport` can observe only that
already-issued operation after failure or cancellation. It cannot reconnect or dispatch another
command. Pending native observations that outlive the deadline remain in the native-task owner and
block release until their real settlement.

Protocol/transport exceptions and frames stay private because they can contain an endpoint token.
The first fixed public failure is stable; native observation errors retain their original causes
through the existing custody contract. Unknown constructors, callbacks, timers and return values
retain their exact private references. Component release is refused until transport, timers and
native tasks are actually accounted for. A failed quit can still permit component-only release after
genuine root/pipe/transport closure; it never becomes a successful quit or full-case result.

This source operation uses the same fixed cooperative Inspector shape as the existing Mac owner,
without importing its Playwright-containing fixture or exposing arbitrary evaluation. It activates
no native CLI and changes no full installer consumer or admission gate. Real activation still
requires an eligible ordinary-user host, trusted immutable native build/stage, genuinely fresh owned
profile/action scope and separately authorized runtime work. Source/closed-VM controls exercise
actual JavaScript orchestration and fixed expressions only. They prove neither a real
WebSocket/Inspector/app-quit exchange nor Windows runtime, loaded-code, descendant or full release
acceptance. The original JavaScript-only owned-quit change retained the separately compiled
`349ad72` stdio component; those controls claimed no repeat C++ compilation.

Explicit `release` attempts to close each newly owned observer HANDLE once, and closes owned CNG
objects. It invalidates the capability when submitted. A failed close keeps private custody and is
never retried, including by GC or environment teardown. Closing a process query handle does not
close or terminate the process. A successful release acknowledges only these observer handles, with
process ownership and descendant closure remaining false. Unknown async setup/completion also
retains the owner and fence.

The loader requires exact fixed paths and explicit expected hashes for the native binary, this
source and `binding.gyp`, plus Node 24.22.0/x64. These are configuration and disk samples. They do
not authenticate compilation, service/run labels, source provenance, or physically loaded DLL bytes.
Pre/post pathname hashes around `dlopen` are not an atomic loaded-DLL identity proof. A future
actual invocation needs a separately trusted immutable native build/stage, host eligibility and
action authorization. No native binary is checked in or available from this source preparation. Fake
tests issue no native caps.

## Callable owned-runtime composition and original-record readback

`observeWindowsNativeOwnedRuntime` in the existing lifecycle module is a callable component
producer. It snapshots the expected tuple/build inputs and reserves the existing single-authority
scope before asynchronous preparation, adopts the returned private capability, pins the two named
files, creates the fixed process, then calls the actual fixed cooperative quit owner. It does not
substitute an external PID or accept a caller-supplied native transcript, mode flag or port factory.
No external native entrypoint invocation has run as part of this source preparation.

After the actual quit operation, the producer copies and validates three canonical originals while
the capability still permits those reads: `file-pins/v1`, terminal `created-process/v2`, and
`normal-quit/v1`. The quit original is created inside the private successful protocol path, after
its own bookkeeping checks, rather than from an externally mutable returned Promise or result. Its
PID, thread and creation-time tuple must match the created-process original, and the identity reply
must match that PID and `browser` type. Returned launch/quit values are compared with their private
originals; they cannot manufacture evidence by changing a public Promise's `then` method.

Only after those checks does `produceWindowsNativeOwnedRuntime` explicitly join the native
HANDLE/TSFN release. It compares the returned ACK with the separate private `owned-release/v1`
original and validates complete component acknowledgments before releasing the lifecycle scope.
Failure retains the actual capability or pending reservation and its original error, including
`undefined`, without implicit release, termination or retry. The two new original-record readers
return byte copies only; read-only access after invalidation grants no new operation or current
custody authority.

The narrowly versioned `windows-native-owned-runtime/v1` projection holds those four originals and
fixed references under `windows-native/owned-runtime/<role>.json`. The existing shared consumer
checks the selected source/run/package/root bindings and all component correlations, then rereads
each original with its role-specific bound, fatal UTF-8 decoding, complete canonical JSON,
length/hash equality and exact projection equality. The read-only
`windows-native-readonly-consistency/v1` contract remains unchanged; created-process rows are never
relabeled as external-PID observations. Global dynamic-evidence anti-reuse is unchanged. Successful
semantic readback reports only
`selected-pinned-runtime-and-component-closure-consistent-unqualified`; the enclosing lifecycle and
full installer gate still refuse qualification.

These are **default-network, selected pinned-runtime** observations. Expected version, Setup
artifact, source and run values are reference labels, not independently observed runtime version,
Setup bytes, installation or authenticated service issuance. `requestedLaunch` binds the selected
profile and source-fixed command semantics; it is not sampled runtime argv. File pins cover only the
executable and ASAR. Retained-HANDLE flags describe capture before release, while the release
original records a later component ACK; serialized old rows never authenticate current native
ownership. No stream contents or endpoint tokens are included in the projection.

The `windows-nsis:offline-launch` case name supplies the existing container association only. It
does not turn these records into installation, machine-offline or UI evidence. The full offline CLI
still refuses before IO, and its dedicated-profile-outside-installation policy is unchanged. This
component's source-fixed profile remains `root + "\\native-launch-profile"`; it is deliberately not
an adapter that bypasses that policy. Real NSIS consent/finish and installed metadata, genuine
machine-offline/UI observations, authentic source/package/run issuance, loaded-code binding and
independent retirement are still absent. Mac observation dispatch and all unconditional full
acceptance refusals remain unchanged.

### Fixed sibling profile for the installed-app startup policy

The shipping `selectDesktopStartup` rejects a dedicated profile inside a marked installation root.
The original inside-root component remains available unchanged, but cannot be substituted for that
installed-app path. The additive `launchWindowsNativePinnedSiblingProcess` operation requires the
exact action `launch-pinned-sibling-profile` and exact selected profile
`binding.root + ".native-launch-profile"`. It accepts no arbitrary profile path. The corresponding
`observeWindowsNativeOwnedSiblingRuntime` caller performs the same actual preparation, pinning,
creation, cooperative quit and explicit component-release sequence with this fixed sibling command.

The native branch derives the sibling from the pinned volume-GUID root under the already retained
parent directory. That parent HANDLE is borrowed from an existing ancestor lease, not newly opened
or independently closed. Before opening the sibling and again before creation, native code checks
the current DOS-drive mapping against the pinned volume, the held parent identity and final path,
and the exact canonical relative spelling of the root. An 8.3 alias or case rewrite is
conservatively refused by this new branch; the old branch's spelling policy is unchanged. These
samples are not an atomic DOS-namespace or loaded-code authentication claim.

The sibling directory must already exist. Its one owned lease is reserved before `CreateFileW`, uses
no write/delete sharing, rejects reparse points, and must resolve to the exact derived sibling path
on the same volume with an identity distinct from the installation root and parent. The existing
bounded directory enumeration must reach its actual empty EOF. Parent and profile identities are
checked again before `CreateProcessW`; the actual GUID profile is used in the fixed command and
explicit environment. No directory is created, removed, or given new permissions.

The new created-process original is `windows-native-created-process/v3`. Its `profileDirectory`
contains the observed `volumeSerial`, `fileId`, `parentFileId`, `emptyAtPreflight`, and
`leaseRetained`. A null value means no validated profile observation, including cancellation before
native launch submission; it never proves absence, freshness or success. A successful producer
requires complete profile facts, the same pinned-file volume, and distinct directory/file
identities. Emptiness and a retained HANDLE still do not establish fresh/exclusive staging ownership
or authorize an action. Those external prerequisites remain required before any actual activation.

This branch uses `windows-native-normal-quit/v2`, `windows-native-owned-release/v2`, and
`windows-native-owned-runtime/v2` to bind the new requested command explicitly. It uses the existing
four role paths, canonical originals and strict original-byte rereads. The old created-process/v2,
quit/release/runtime v1 readers remain restricted to the original inside-root command; records are
not repinned, migrated or relabeled. Both versions remain unqualified. Compatibility with the
shipping profile-location rule does not establish an installation, observed application profile,
runtime version, machine-offline condition, UI interaction, loaded bytes, service/run provenance or
descendant retirement. The offline CLI and unconditional full installer gate remain refused.

The changed C++ source requires a separately authorized Windows compilation and runtime validation;
the earlier compiled `349ad72` binary is not build evidence for this new branch. Source/memory
controls neither load the addon nor create a profile, pipe, socket or target process.

The local integration controls must execute this real observe function against the same actual
authority wrapper exports under closed memory/native-port substitutes, then feed its emitted bytes
through the actual shared consumer/readback. Authored rows separately test invalid projections; they
do not stand in for that real call wiring or constitute native evidence. The earlier inside-root
composition retained the compiled `349ad72` backend; its build does not validate the new sibling
profile source. No addon, real WebSocket/Inspector, target process, installer or security operation
is activated by these controls or by this documentation.

## Build prerequisite (not executed)

A Windows x64 MSVC compiler, Windows SDK, official Node 24.22.0 headers and matching win-x64
`node.lib` are required. Existing node-gyp tooling is optional when using `binding.gyp`; the direct
compiler command below does not require it or Python. `binding.gyp` links the system BCrypt,
Advapi32 and User32 libraries. No dependency fetch, install script, Linux stub build or native
compilation was run during source preparation. A future reviewed build must use already provisioned
verified headers/toolchain and retain the actual binary/source/build identities. Its output is
expected only at `build/Release/windows_installer_authority.node`. Compilation and real Windows API
behavior remain unverified until that Windows build and controlled host work occur.

The implementation follows the public contracts for
[CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw),
[GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex),
[WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject),
[CreateFileW share modes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew),
[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes),
[QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew),
[GetWindowThreadProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid),
and
[CloseHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-closehandle).
Node-API wrap/type-tag/freeze/async-work/TSFN declarations were checked in the retained official
Node 24.22.0 headers. The exact
[Node 24.22 TSFN contract](https://github.com/nodejs/node/blob/v24.22.0/doc/api/n-api.md#deciding-whether-to-keep-the-process-running)
and [implementation](https://github.com/nodejs/node/blob/v24.22.0/src/node_api.cc) distinguish
normal loop references, release and cleanup/finalization. No addon or real TSFN was invoked to check
them.

A direct compile/link (future approved Windows job only) can use the selected x64 MSVC developer
environment without app dependencies, Python, node-gyp or npm scripts:

```text
cl /nologo /TP /std:c++17 /EHsc /MD /LD /DNAPI_VERSION=8 /DNODE_GYP_MODULE_NAME=windows_installer_authority /DUNICODE /D_UNICODE /I<verified-node-include> authority.cc /link /OUT:<fresh-owned-output>/windows_installer_authority.node <verified-win-x64-node.lib> bcrypt.lib advapi32.lib user32.lib
```

This command compiles and links only. It must not load, import or invoke the addon. A successful
compile does not validate runtime behavior, native host eligibility, file locking, token
observations, process facts, safe app close, or release acceptance.
