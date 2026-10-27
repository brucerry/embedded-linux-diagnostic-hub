# Linux no-replace directory move: source-only draft

This repo-owned addon exposes one operation over borrowed directory FDs. It is not built, loaded,
packaged, enabled or qualified. There is no install hook, automatic loader or command service.
Existing `linux-native-backend` defaults remain unchanged (`moveNoReplace=null`).

The nested `binding.gyp` follows the existing node-gyp addon convention used by ssh2/cpu-features.
It uses plain Node-API C headers, with no new npm runtime dependency, NAN or FFI dependency. Koffi
is not a declared/installed runtime package; residual platform lock entries do not supply an
approved binding, and retired-component package exclusions remain intact.

## ABI 1 / status version 1

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
