param([Parameter(Mandatory=$true)][string]$BashExecutable,
      [Parameter(Mandatory=$true)][string]$CommandLine,
      [Parameter(Mandatory=$true)][string]$WorkingDirectory,
      [int]$DeadlineMs=15000)
$ErrorActionPreference='Stop'
# One local monotonic clock domain shared with the managed helper; no extra process or probe.
function Write-PtyTiming([string]$Phase) {
    $row = [ordered]@{ schema=1; phase=$Phase; clockDomain='helper-stopwatch'; pid=$PID; ticks=([Diagnostics.Stopwatch]::GetTimestamp()).ToString([Globalization.CultureInfo]::InvariantCulture); frequency=([Diagnostics.Stopwatch]::Frequency).ToString([Globalization.CultureInfo]::InvariantCulture) }
    [Console]::Error.WriteLine('HUB_OS_PTY_TIMING ' + ($row | ConvertTo-Json -Compress))
}
Write-PtyTiming 'helper-entry'
Write-PtyTiming 'identity-checks-before'
if (-not [IO.Path]::IsPathRooted($BashExecutable) -or $BashExecutable -ine $env:HUB_TEST_WINPTY_BASH) { throw 'Explicit discovered Bash identity required.' }
$identities = $env:HUB_TEST_WINPTY_IDENTITIES | ConvertFrom-Json
foreach ($item in $identities.PSObject.Properties) {
    $file = Get-Item -LiteralPath $item.Value.path -ErrorAction Stop
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PTY tool reparse point refused.' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant() -cne $item.Value.sha256) { throw 'PTY tool bytes changed.' }
    if ($item.Value.architecture -cne 'x64') { throw 'PTY tool architecture is unreviewed.' }
}
if ((Get-Process -Id $PID).Path -ine $identities.pwsh.path) { throw 'Actual PowerShell executable differs.' }
if ($BashExecutable -ine $identities.bash.path -or $env:HUB_TEST_WINPTY_DLL -ine $identities.dll.path -or $env:HUB_TEST_WINPTY_AGENT -ine $identities.agent.path) { throw 'PTY tool path handoff differs.' }
Write-PtyTiming 'identity-checks-after'
# Counters and stamps are retained in memory; no diagnostic write enters the call interval.
function Read-PtySelfCpu {
    $self=$null
    try {
        $self=[Diagnostics.Process]::GetCurrentProcess(); $self.Refresh()
        $total=$self.TotalProcessorTime.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        $user=$self.UserProcessorTime.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        $kernel=$self.PrivilegedProcessorTime.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        return [pscustomobject]@{ available=$true; totalTicks=$total; userTicks=$user; kernelTicks=$kernel; sampledAt=([Diagnostics.Stopwatch]::GetTimestamp()).ToString([Globalization.CultureInfo]::InvariantCulture) }
    } catch { return [pscustomobject]@{ available=$false; reason=$_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length)) } }
    finally { if($null -ne $self){$self.Dispose()} }
}
function Read-PtyLoadedRuntime {
    $names=@('System.Management.Automation','System.Private.CoreLib','Microsoft.CodeAnalysis','Microsoft.CodeAnalysis.CSharp')
    $loaded=[AppDomain]::CurrentDomain.GetAssemblies(); if($loaded.Length -gt 512){throw 'Loaded assembly count envelope refused.'}; $records=@()
    foreach($name in $names) {
        try {
            $assembliesForName=@($loaded | Where-Object { $_.GetName().Name -ceq $name })
            if($assembliesForName.Count -ne 1){throw 'Loaded assembly identity unavailable or ambiguous.'}
            $assembly=$assembliesForName[0]
            # Loaded metadata only: do not read physical assembly files on startup.
            $records+= [pscustomobject]@{ name=$name; available=$true; fullName=$assembly.FullName; moduleVersionId=$assembly.ManifestModule.ModuleVersionId.ToString(); physicalIdentity=[pscustomobject]@{available=$false;reason='No physical assembly read authorized on readiness path.'} }
        } catch { $records+= [pscustomobject]@{ name=$name; available=$false; reason=$_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length)) } }
    }
    return ,$records
}
$beforeLoggingStart=[Diagnostics.Stopwatch]::GetTimestamp()
Write-PtyTiming 'Add-Type-before'
[Console]::Error.WriteLine('HUB_OS_PTY_PHASE Add-Type-before')
$beforeLoggingEnd=[Diagnostics.Stopwatch]::GetTimestamp()
$cpuBefore=Read-PtySelfCpu
$callFailure=$null
$callStart=[Diagnostics.Stopwatch]::GetTimestamp()
try { Add-Type -Path (Join-Path $PSScriptRoot 'winpty-bridge.cs') }
catch { $callFailure=$_ }
finally { $callEnd=[Diagnostics.Stopwatch]::GetTimestamp() }
$cpuAfter=Read-PtySelfCpu
$afterLoggingStart=$null; $afterLoggingEnd=$null
if($null -eq $callFailure) {
    $afterLoggingStart=[Diagnostics.Stopwatch]::GetTimestamp()
    [Console]::Error.WriteLine('HUB_OS_PTY_PHASE Add-Type-after')
    Write-PtyTiming 'Add-Type-after'
    $afterLoggingEnd=[Diagnostics.Stopwatch]::GetTimestamp()
}
$identityStart=[Diagnostics.Stopwatch]::GetTimestamp()
$runtime=$null; $runtimeReason=$null; $created=$null
try {
    $self=[Diagnostics.Process]::GetCurrentProcess()
    try { $created=$self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) } finally { $self.Dispose() }
    $runtime=Read-PtyLoadedRuntime
} catch { $runtimeReason=$_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length)) }
$identityEnd=[Diagnostics.Stopwatch]::GetTimestamp()
$afterStartText=$null; $afterEndText=$null; $callErrorText=$null
if($null -ne $afterLoggingStart){$afterStartText=$afterLoggingStart.ToString(); $afterEndText=$afterLoggingEnd.ToString()}
if($null -ne $callFailure){$callErrorText=$callFailure.Exception.Message.Substring(0,[Math]::Min(1024,$callFailure.Exception.Message.Length))}
$fact=[ordered]@{ schema=1; kind='pty-compile-observation'; clockDomain='helper-stopwatch'; pid=$PID; createdFileTime=$created; frequency=[Diagnostics.Stopwatch]::Frequency.ToString([Globalization.CultureInfo]::InvariantCulture); callStart=$callStart.ToString(); callEnd=$callEnd.ToString(); cpuBefore=$cpuBefore; cpuAfter=$cpuAfter; cpuMeaning='Self process CPU over sampling interval includes counter-read overhead; call elapsed includes Add-Type internal work/IO, not compiler CPU attribution.'; beforeLoggingStart=$beforeLoggingStart.ToString(); beforeLoggingEnd=$beforeLoggingEnd.ToString(); afterLoggingStart=$afterStartText; afterLoggingEnd=$afterEndText; identityCaptureStart=$identityStart.ToString(); identityCaptureEnd=$identityEnd.ToString(); powershellVersion=$PSVersionTable.PSVersion.ToString(); edition=$PSVersionTable.PSEdition; dotnetVersion=[Environment]::Version.ToString(); processorCount=[Environment]::ProcessorCount; powershellFile=$identities.pwsh; loadedAssemblies=$runtime; runtimeReason=$runtimeReason; hostLoad=[ordered]@{available=$false;reason='No additional host-load query authorized.'}; callSucceeded=($null -eq $callFailure); callError=$callErrorText }
try {
    $json=$fact | ConvertTo-Json -Depth 8 -Compress
    if([Text.Encoding]::UTF8.GetByteCount($json) -gt 8192) {
        $fact.loadedAssemblies=$null; $fact.runtimeReason='Complete identity record exceeded8192byte frame; no partial identity attestation.'
        $json=$fact | ConvertTo-Json -Depth 8 -Compress
    }
    if([Text.Encoding]::UTF8.GetByteCount($json) -gt 8192){throw 'Bounded compile observation unavailable.'}
    [Console]::Error.WriteLine('HUB_OS_PTY_COMPILE '+$json)
} catch { if($null -ne $callFailure){throw $callFailure}; throw }
if($null -ne $callFailure){throw $callFailure}
Write-PtyTiming 'closure-contract-before'
if (-not [HubWinptyFixture]::ClosureContract()) { throw 'PTY closure contracts failed.' }
Write-PtyTiming 'closure-contract-after'
Write-PtyTiming 'managed-Run-before'
[Console]::Error.WriteLine('HUB_OS_PTY_PHASE managed-Run-before')
$result = [HubWinptyFixture]::Run($BashExecutable,$CommandLine,$WorkingDirectory,$DeadlineMs)
[Console]::Error.WriteLine('HUB_OS_PTY_PHASE managed-Run-after')
Write-PtyTiming 'managed-Run-after'
exit $result
