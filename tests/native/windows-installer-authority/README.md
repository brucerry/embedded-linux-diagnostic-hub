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
HWND/PID/path sampling is represented as atomic close authority. A reviewed
owned-app-thread/authenticated IPC protocol, actual installer consent/offline/UI facts, and
independent retirement observations are still missing.

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

The requested executable is the leased volume-GUID executable name, cwd is the pinned installation
root, and the sole argument selects that profile through the existing `--user-data-dir` route.
Native code owns a writable quoted command buffer and explicit double-NUL Unicode environment before
creation. APPDATA, LOCALAPPDATA, TEMP, TMP, and USERPROFILE use the pinned profile; SystemRoot and
WINDIR use the bounded actual local Windows-directory query. There is no arbitrary inherited
environment or caller-selected executable. These are requested inputs, not observations of the
running application's environment, effective profile, or initialized runtime. The current process
and executing worker's thread-token eligibility are rechecked before creation.

`CreateProcessW` receives an explicit application name, no inherited HANDLEs, no suspension, no job,
and no stdio redirection. The owner and fixed process/thread output slots precede the call; both
outputs are adopted before any allocation, validation, or cancellation check. A false return with
unexpected non-null outputs remains unknown and cannot be released as a successful creation.
Cancellation reserves no retry and never terminates anything. If creation was already submitted, a
late returned process remains retained. Creation returns before application initialization, so it
establishes no ready, visible-window, installer, or loaded-code result. Holding named-file leases is
not a public CreateProcess-from-file-HANDLE API or proof of the mapped image section.

`sampleOwnedProcess` can observe the already returned HANDLE even after cancellation or the first
error; it never accepts a replacement PID or acquires another process. It uses a zero-duration wait,
creation time, and exit-code query. A signaled wait establishes root termination; numeric exit code
259 alone never decides liveness. There are no pipes, output EOF observations, stable HWND
capabilities, normal-close requests, automatic process control, or descendant observations.
`releaseOwnedProcessHandles` refuses a live or unknown root before release submission. After actual
non-creation or root termination, it closes only its own HANDLEs once and joins acknowledged
async-work/reference cleanup. Only then does it request TSFN release once; that pointer is never
used again. The existing Promise waits for the normal finalizer callback plus marker-removal and
remaining bookkeeping ACK. HANDLE closure, release request, release ACK and finalizer observation
are distinct facts. The finalizer is not proof that every TSFN allocation or namespace is retired.

Created-process `/v2` rows add the actual reference acknowledgment; historical `/v1` records remain
unchanged. Release results distinguish HANDLE closure from acquisition, release, finalizer,
finalizer-bookkeeping and environment-closing observations. A submitted acquisition cannot be
relabeled as absent. Missing/contradictory facts retain the private owner, never admit a full case.
No-acquisition cancellation is different from submitted-but-unconfirmed acquisition.

Forced/null-environment or premature finalization never acknowledges graceful closure. A failure in
finalizer cleanup or Promise settlement leaves lifetime/bookkeeping UNKNOWN. Once the last reference
is closing, retained C++/JS data or an unresolved Promise cannot guarantee the loop stays alive; no
recursive keeper, forced shutdown or cleanup fallback is added. Stdio/EOF, safe app close, loaded
code and descendant retirement remain unproved, and full native/release gates stay closed.
Successful normal release acknowledges only the owner's component resources.

The direct JavaScript controls execute the actual wrapper in a bounded VM with closed in-memory
filesystem/native-port substitutes. Those model objects are not Node-API capabilities and never
enter the production module's private capability map. Tests do not compile or execute this new C++
branch. The preserved `b769e0d` creation source compiled successfully without addon loading. That
build evidence remains separate: this TSFN extension has not been compiled or executed. Its
source/VM controls do not test actual loop liveness, N-API finalization or Windows runtime behavior.

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
