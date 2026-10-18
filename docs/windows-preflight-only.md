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
