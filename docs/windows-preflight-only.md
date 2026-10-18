# First hosted Windows validation: metadata only

This candidate adds one manual `windows_preflight_only` boolean to the existing registered Windows
workflow. True skips the standing build and admits one independent 15-minute preparation job. There
is no collection option or build dependency. False/omitted preserves existing
main/PR/reusable/manual standing behavior. No workflow is dispatched by this patch.

The probe restores no dependencies itself: the job restores only the lockfile with pinned Node
24.22.0 x64. It inspects Electron44.5.1 files without launching them. It records actual
image/runtime, source, complete dependency/loader hashes, canonical temporary directory, marker
absence, current SID/owner/SDDL and single/multiple-path PowerShell5.1 serialization. Only fresh
nonce-named metadata files exercise O_RDWR read/fsync/close/reopen, including injected sync/close
failures and cleanup. It records free capacity and installed Git/pwsh/bash/cygpath/winpty DLL/agent
paths, hashes and PE architecture, or explicit absence. C# compilation may inspect the bridge method
without invoking it. The existing derived JS-only SSH bundle is prepared and identified; no native
application starts.

All observations are unreviewed. Missing tools, mismatched owners, unavailable metrics and failures
remain explicit; no ACL, owner, policy, credential, driver or canonical-marker change makes them
pass. Any existing canonical marker blocks admission. Logs/reports are bounded before writes;
disposable file handles are independently synced/closed and partial facts are retained when
possible. Source aliases, expired admission and rebinding block further work. The probe has a
five-minute shared work budget including a 30-second cleanup reserve inside the 15-minute hosted
setup/upload envelope.

The facts apply only to the recorded job/host. They are not an approved collection manifest and
cannot be restamped onto a later windows-latest allocation. A same-host approval/custody mechanism
or explicit independently approved host-binding protocol remains unresolved. Native PTY, generation
reset, Save cancel/failure, actual descendant joins, profile overshoot/capacity acceptance, full
normal/forced soaks, calibrated policy, installers and shipping archives remain separate
prerequisites.

Known collector defects in the inert666 input are unreachable from this workflow/probe. Their
repairs are a separate packet. A successful preflight uploads its bounded metadata and stops for
independent review. It does not enqueue any native, product, PTY, installer, platform matrix or soak
follow-up.

The final disposable metadata reopen uses `O_RDWR | O_NOFOLLOW` (where available), as does the
middle read, so each descriptor passed to fsync has writable access. Local regression controls model
Windows writable-flush requirements on actual disposable files for nominal, injected sync and
injected close cases; a genuine writable flush failure still fails. These controls are not native
Windows observations and do not approve collection.

Hosted run `39094809530` on commit `9c5afbadab9fa4afefd69918b3b2901ebdfd9ae5` matched source
`3577982001db416ee08cf371ea9e53eedda108ebd7868603801d5c047ef575a4` but both Windows PowerShell 5.1
ACL observations failed to autoload `Microsoft.PowerShell.Security`. The workflow used `pwsh` to
launch Node, which passed its inherited environment to the absolute, hashed Windows PowerShell
executable.

Microsoft documents that a PowerShell 7 module path survives an intermediate process and can resolve
shared module names to incompatible versions. The preflight now omits all case variants of
`PSModulePath` from only the Windows PowerShell child environment, allowing its normal startup
defaults. It leaves the parent environment, PowerShell 7 child environment, profile flags, execution
policy, JSON path transport, owner checks, command limits and metadata admission unchanged. It does
not edit machine/user module paths, install/import a replacement module, or change ACLs or security
settings.

The original artifact did not capture `PSModulePath`, the selected Security module or its underlying
import exception. Environment inheritance is the evidence-backed mechanism addressed by this patch,
not a claim to have observed the exact shadowed module on that now-finished host. Added bounded
observations record inherited module paths and actual Windows PowerShell version/home/module
path/Get-Acl module identity for future review. Local deterministic command-port tests are not a
Windows rerun.

References:
[Microsoft about_PSModulePath](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.5#starting-windows-powershell-from-powershell-7)
and
[Windows PowerShell CLI flags](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1).

The current directory observation uses schema 1 / profile `literal-directory-security-facts-v1`. It
reuses the successful Get-Acl -LiteralPath boundary and requests only owner, group and DACL
sections. Its five fixed candidate labels expand only to their existing root-to-leaf ancestors, with
at most 24 planned path spellings. There is no recursive discovery or fallback root. The provider
must return filesystem DirectorySecurity; no NTFS or other filesystem qualification is inferred from
a successful descriptor read.

One fresh isolated Windows PowerShell 5.1 child runs the fixed hash-pinned script with JSON literal
paths in environment data. It uses the unchanged NoProfile/NonInteractive/shell:false boundary,
child-only PSModulePath isolation, current execution policy, 10 second / 64 KiB command cap and
shared 300 second budget with 30 second reserve. It loads no C# and calls no explicit
token,duplication, AccessCheck,Authz or new native-interop code. Existing unrelated preflight
inspection steps stay unchanged. The historical token observer and 76-case fixture remain separate
dormant test material, with their successful compiled result retained in run 39102874140; they are
not basic-directory prerequisites and their unavailable context is not reinterpreted as empty.

Each bounded provider row contains owner/group SIDs, owner/group/DACL-only SDDL and explicit DACL
state: absent, null, empty, nonempty or unavailable. The DACL state comes from the provider object's
in-memory binary descriptor control flags and DACL pointer/count, not an SDDL roundtrip. The full
binary descriptor is not emitted. Missing/null ACLs have null count/data, an empty ACL has an
observed count 0 and empty list, and conversion failure remains unavailable. Ordered ACE headers and
canonical base64 binary are retained as opaque provider-returned data, including unfamiliar,
conditional and object entries. The code does not sort, discard, evaluate or infer applicability
from ACEs. If a provider/SDDL/ACE conversion fails, bounded previously retrieved text and facts stay
partial and no empty ACL is fabricated. A provider parser supplies structural decoding; Node checks
schema, bounds, row order and opaque headers, not a new SDDL semantics engine.

Node independently checks physical lstat/realpath identities before and after the command. The
report records device/file IDs and labels the comparison no-drift-detected, drift-detected or
not-complete. That equality cannot exclude ABA, bind the read to a kernel handle, establish atomic
custody or protect later I/O. Omitted/unavailable post-identities remain null. Unknown token context
is declared not-collected; effective access is not-evaluated; SACL, labels, resource attributes and
CAP are not-requested. privatePathApproved,collectionApproval,admissionChanged,atomicCustody and
protectionAfterReturn remain false. No rights masks or fake AccessCheck results are reported.

Limits remain 24 rows, 128 ACEs, 16 KiB per binary descriptor and UTF8 descriptor text, 32 KiB
aggregates, 32 KiB serialized provider result and assembled directory report. Overflow stops; it
does not truncate an SDDL/ACE into a complete fact. If assembly cannot retain whole descriptors
within its bound, it explicitly omits those records and preserves bounded filesystem identities in
an incomplete report. The existing report/journal caps remain. Process timeout/signal/nonzero/parse
failures retain available pre/post identities with descriptorAvailability unavailable, not a
fabricated empty list.

Drift,reparse points,missing paths,access/parse/bounds errors,source or executable changes,
cancellation and deadline exhaustion leave a journaled partial observation and escape outside step()
before subsequent probes. No retry,privilege enablement,policy adjustment or alternate root occurs.
Journal sync/close uncertainty blocks the parent attempt; a completed acquisition is not a durable
or trusted attempt by itself. Existing ownerConfirmed and its metadata-I/O branch remain byte-exact;
the earlier owner probes still record their principal SID solely for that unchanged gate. Directory
facts never choose a root,accept Administrators ownership,unblock collection or establish a trusted
principal policy. Same-host continuing custody/approval for later I/O remains unresolved.

Local deterministic controls exercise the actual directory orchestration/command port with injected
spawn results and real disposable identities,journal sync/close and report writes. They cover DACL
states,opaque retention,partial access failure,malformed/oversized
responses,reparse/drift,cancellation, source/runtime changes and cleanup failures. They do not run
PowerShell or qualify this new script on Windows. Sealed source/failure review is required before
any push or hosted attempt.

References:
[Get-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-acl?view=powershell-5.1),
[security descriptor sections](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.accesscontrolsections?view=netframework-4.8.1),
and
[null/empty DACL distinctions](https://learn.microsoft.com/en-us/windows/win32/secauthz/null-dacls-and-empty-dacls).

The provider binary getter reads the already loaded managed descriptor, not permanent storage:
[GetSecurityDescriptorBinaryForm](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.objectsecurity.getsecuritydescriptorbinaryform?view=netframework-4.8.1).
