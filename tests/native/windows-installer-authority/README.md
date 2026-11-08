# Windows read-handle authority (source preparation)

This Node-API v8 addon implements read-only native observations. It does not launch, install, close
a window, own an observed process, verify originally loaded code, or retire descendants. The
existing native offline-launch entry and full release gates remain closed.

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
[CreateFileW share modes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew),
[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes),
[QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew),
[GetWindowThreadProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid),
and
[CloseHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-closehandle).
Node-API wrap/type-tag/freeze/async-work declarations were checked in the retained official Node
24.22.0 headers; no addon was loaded to check them.

A direct compile/link (future approved Windows job only) can use the selected x64 MSVC developer
environment without app dependencies, Python, node-gyp or npm scripts:

```text
cl /nologo /TP /std:c++17 /EHsc /MD /LD /DNAPI_VERSION=8 /DNODE_GYP_MODULE_NAME=windows_installer_authority /DUNICODE /D_UNICODE /I<verified-node-include> authority.cc /link /OUT:<fresh-owned-output>/windows_installer_authority.node <verified-win-x64-node.lib> bcrypt.lib advapi32.lib user32.lib
```

This command compiles and links only. It must not load, import or invoke the addon. A successful
compile does not validate runtime behavior, native host eligibility, file locking, token
observations, process facts, safe app close, or release acceptance.
