# Windows PowerShell pilot provider contract

This is a source candidate for independent review. No real interpreter result or new execution
authorization is claimed. The first proposed run selects the `winps-provider-contract` job in
`.github/workflows/windows-portable.yml` with `windows_pilot_winps_contract=true`, the exact frozen
`contract_source_sha256`, and `windows_native_pilot=false` plus `windows_preflight_only=false`. It
restores the existing lockfile loader dependencies and uses Node 24.22.0 x64. It never invokes
Electron resolution, a PTY, the native entry, collection, an installer or canonical-marker
acquisition.

The command resolves the physical System32 `WindowsPowerShell/v1.0/powershell.exe`, hashes its x64
PE bytes and the actual production `hosted-pilot-security.ps1`, and invokes
`-NoProfile -NonInteractive -File`. The script must report Desktop, full version 5.1 and an x64
process at that executable path. It never substitutes PowerShell 7 or changes execution policy.
Inherited `PSModulePath` is removed only from the child environment. TEMP/TMP remain unchanged.

One exclusive nonce child under canonical profile Temp contains two distinct directories and one
regular sentinel. One directory includes legal spaces, brackets, a dollar sign and apostrophes.
Actual Node `JSON.stringify` transports each plan through the production environment variable. The
real provider uses Get-Item -LiteralPath and Get-Acl and returns ordered
DirectorySecurity/FileSecurity rows. Green replies pass through the production Node
principal/group/ACE parser, including file flags 0x10 separately from directory flags 0x13.

Thirty actual-interpreter cases are required: one red control executes the exact failed legacy
capture/provider/bitwise chain with two valid directories; three green cases contain one directory,
two directories and two directories plus a file; 26 negatives cover schema, array/scalar, path, kind
and missing-item boundaries. The red control must retain outer/inner, path, item and attributes
types/counts and the actual op_BitwiseAnd error. A different observation fails the diagnosis check.
Green rows must have scalar PSCustomObject plans, System.String paths/kinds, one FileSystemInfo
object and scalar FileAttributes. Invalid plan shapes must make zero provider calls. No array
flattening, first-element selection, attribute casts, ACL fallback or permission repair is allowed.

The shared contract budget is 180 seconds, with its last 30 seconds reserved for cleanup. Each
command retains the existing 10-second/65,536-byte limits. Evidence is capped at 1 MiB and 512 rows;
raw chunks and exact input hashes are retained before process, parse or type assertions. Missing
query closure or descriptor sync/close proof establishes a referenced hold and retains the fixture.
Known joined failures may remove only bound test-owned objects and return a failed result. The
workflow ceiling is eight minutes, including dependency restoration, and allows one attempt with no
rerun. Timeout or VM teardown is not closure proof.

The contract is also a prerequisite in any later native entry. Its success would qualify only this
provider path on that hosted attempt. It would not approve native execution, full-pair capacity,
shipping, security isolation or a retry. The native dependency gate separately verifies an
already-settled Electron 44.5.1 installation before freezing all dependencies; a missing install
fails rather than causing a hidden bootstrap.

Mac deterministic tests exercise Node validation, wire/evidence ordering, real disposable
descriptors and cleanup with controlled reply ports. They are not a replacement for the required
real x64 WinPS 5.1 run. Review the proposed source and run scope first, then obtain separate
authorization for exactly one contract run and review its actual evidence.
