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

Ownership diagnostics retain the original exact-user owner admission policy while collecting
read-only context for review. Windows may use a group SID as the token's default owner; owner/user
inequality alone does not establish unsafe access, and equality does not establish a private DACL.
The earlier ownership-context probe recorded token user/default-owner SIDs, role checks and raw DACL
entries as review leads. Its exported helper remains for regression coverage; production now uses
the single bounded snapshot described below. Privacy approval, root selection, directory creation,
ACL mutation, elevation and fallback remain absent. Null/absent DACLs and inherit-only entries
remain explicit.

The fixed existing-directory inventory covers the output root, canonical OS temp, RUNNER_TEMP,
LOCALAPPDATA/Temp and USERPROFILE/AppData/Local/Temp when already present and physical. It never
searches recursively, creates an alternative, changes TEMP/TMP, or relocates the canonical marker.
Missing, aliased, over-depth or unobservable candidates are unavailable. All output uses the
existing command, journal and report bounds; malformed/partial identity or ACL data is rejected. A
successful diagnostic observation cannot change ownerConfirmed or admit a metadata probe.

OpenSpec's trusted-ownership clauses concern application identities, leases, acknowledged writes and
truthful platform states; they do not prescribe owner-SID equality as an NTFS trust policy. A future
policy must address token user/default owner/enabled groups, applicable ordered DACL rules,
untrusted writers and parent-directory replacement, not just membership in Administrators. An
already restricted physical temp directory is preferable to a broad writable root if its actual
identity, DACL and ancestry can be qualified without changing security. No suitable alternative or
group-owner trust policy is established by this diagnostic patch.

The consolidated ownership snapshot replaces the earlier ownership-context subprocess with one
bounded read-only Windows x64/local-NTFS observer. The same five candidates expand only to their
root-to-leaf ancestors: at most24 unique directories, with pre-observed volume/file IDs. It opens
existing directories for READ_CONTROL/attributes, without delete sharing, rejects reparse points,
and holds the handles through descriptor/identity rechecks. It reads owner/group/DACL and mandatory
label plus resource-policy presence, and calls native AccessCheck(MAXIMUM_ALLOWED) with a duplicate
of the actual calling token and filesystem generic mapping. It never assigns/impersonates the
duplicate, obtains a linked/elevated token, adjusts privileges, or opens any directory for writes.

The token projection is limited to current user/group attributes, restricting SIDs, default owner/
primary group/default DACL, integrity/mandatory policy/elevation state and five relevant privilege
states. Documented user/device-claim and device-group presence is counted only; nonempty contexts
stop without exporting claim values. Reserved token-information classes35/36/39 are not queried;
their absence is not certified. Conditional/object/unknown DACL or resource-policy states,
unsupported filesystems, sharing failures, identity/descriptor/token drift and API/buffer failures
produce an indeterminate snapshot. All acquired handles receive independent close attempts.

Bounds are five candidates,24 directories,128 groups/restricted SIDs/ACEs,64 token privileges read
internally but only five projected,16KiB native buffers,32KiB aggregate descriptors,24KiB request
and32KiB result JSON. Native work admits at most five seconds, inside the unchanged ten-second
command bound; neither bounds an already blocked synchronous kernel call by itself. No retry,
privilege enablement, installation, candidate expansion, data-content read, or recursive inventory
is a fallback. The existing journal/report/job caps are unchanged.

AccessCheck results are discretionary rights for this actual token, with integrity labels retained
for review; they are not a full kernel-open or all-principal privacy determination. In particular,
there is no approved trusted/untrusted-principal policy, and read handles close before any later
preflight I/O. Delete-sharing pins do not freeze DACL changes, exclude privileged actors, or protect
future operations after close. Therefore even a consistent snapshot reports privatePathApproved:
false, protectionAfterReturn:false and an indeterminate directory decision. No diagnostic result
changes the original owner gate or authorizes collection. These architectural/policy gaps require a
reviewed resolution, not an indefinite series of probes. There is no local C# compiler/PowerShell
runtime here; native compilation, interop and Windows semantics are not qualified by JS fixtures.

The API contract follows Microsoft documentation for
[AccessCheck](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-accesscheck),
[GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation),
[TOKEN_INFORMATION_CLASS](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class),
[CreateFileW sharing/lifetime](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
and
[SECURITY_INFORMATION read rights](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-information).
The local tests validate projection and failure handling; they do not establish native API behavior.
