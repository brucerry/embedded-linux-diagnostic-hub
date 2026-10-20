param([Parameter(Mandatory=$true)][string]$BashExecutable,
      [Parameter(Mandatory=$true)][string]$CommandLine,
      [Parameter(Mandatory=$true)][string]$WorkingDirectory,
      [int]$DeadlineMs=15000,
      [switch]$CompileOnly,
      [string]$AssemblyOutput,
      [string]$PreparedAssembly)
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
if(($CompileOnly -and $PreparedAssembly) -or (-not $CompileOnly -and $AssemblyOutput)){throw 'Mixed compile/runtime mode refused.'}
if($PreparedAssembly) {
    # Read once, verify those exact bytes, then load those bytes. No runtime compilation fallback.
    $bound=$env:HUB_TEST_WINPTY_ASSEMBLY | ConvertFrom-Json
    $inputs=$env:HUB_TEST_WINPTY_PREPARED_INPUTS | ConvertFrom-Json
    if($inputs.Count -ne 2){throw 'Prepared source inputs required.'}
    foreach($inputFile in $inputs){
        $sourceFile=Get-Item -LiteralPath $inputFile.path
        if(($sourceFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $sourceFile.PSIsContainer -or (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceFile.FullName).Hash.ToLowerInvariant() -cne $inputFile.sha256){throw 'Prepared bridge source input changed.'}
    }
    if(-not [IO.Path]::IsPathRooted($PreparedAssembly) -or $PreparedAssembly -cne $bound.path -or ([IO.Path]::GetDirectoryName($PreparedAssembly) -ine $WorkingDirectory)){throw 'Bound private assembly required.'}
    $item=Get-Item -LiteralPath $PreparedAssembly
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -or $item.Length -le 0 -or $item.Length -gt 1048576){throw 'Prepared assembly shape refused.'}
    $bytes=[IO.File]::ReadAllBytes($PreparedAssembly)
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$digest=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    if($bytes.Length -ne $bound.bytes -or $digest -cne $bound.sha256){throw 'Prepared assembly bytes changed.'}
    Write-PtyTiming 'artifact-load-before'
    $prepared=$env:HUB_TEST_WINPTY_PREPARED | ConvertFrom-Json
    if($prepared.artifact.path -cne $bound.path -or $prepared.artifact.sha256 -cne $digest){throw 'Artifact handoff differs.'}
    if($identities.pwsh.path -cne $prepared.runtime.powershellFile.path -or $identities.pwsh.sha256 -cne $prepared.runtime.powershellFile.sha256){throw 'Prepared PowerShell identity changed.'}
    if($PSVersionTable.PSVersion.ToString() -cne $prepared.runtime.powershellVersion -or $PSVersionTable.PSEdition -cne $prepared.runtime.edition -or [Environment]::Version.ToString() -cne $prepared.runtime.dotnetVersion -or -not [Environment]::Is64BitProcess){throw 'Prepared compiler/runtime compatibility changed.'}
    $loadedBefore=[AppDomain]::CurrentDomain.GetAssemblies();if($loadedBefore.Length -gt 512){throw 'Loaded assembly envelope refused.'}
    foreach($assembly in $loadedBefore){if($null -ne $assembly.GetType('HubWinptyFixture',$false,$false)){throw 'Unexpected preloaded bridge type.'}}
    $loaded=[Reflection.Assembly]::Load($bytes)
    $type=$loaded.GetType('HubWinptyFixture',$true,$false)
    if($type.Assembly -ne $loaded -or -not $type.IsPublic -or $null -eq $type.GetMethod('Run') -or $null -eq $type.GetMethod('ClosureContract')){throw 'Prepared bridge managed ABI differs.'}
    $self=[Diagnostics.Process]::GetCurrentProcess()
    try{$birth=$self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)}finally{$self.Dispose()}
    $runMethod=$type.GetMethod('Run');$closureMethod=$type.GetMethod('ClosureContract')
    if(-not $runMethod.IsStatic -or $runMethod.ReturnType.FullName -cne 'System.Int32' -or ($runMethod.GetParameters().ParameterType.FullName -join ',') -cne 'System.String,System.String,System.String,System.Int32' -or -not $closureMethod.IsStatic -or $closureMethod.ReturnType.FullName -cne 'System.Boolean' -or $closureMethod.GetParameters().Length -ne 0){throw 'Bridge method ABI differs.'}
    if($loaded.FullName -cne $prepared.managed.fullName){throw 'Loaded assembly identity differs.'}
    $load=[ordered]@{schema=1;kind='pty-artifact-load';pid=$PID;createdFileTime=$birth;compilerPID=$prepared.compilerPID;compilerCreatedFileTime=$prepared.compilerCreatedFileTime;artifact=$prepared.artifact;context=$prepared.context;runtime=$prepared.runtime;loadedType=$type.FullName;moduleVersionId=$loaded.ManifestModule.ModuleVersionId.ToString()}
    $loadJson=$load | ConvertTo-Json -Depth 8 -Compress
    if([Text.Encoding]::UTF8.GetByteCount($loadJson) -gt 8192){throw 'Load receipt bound.'}
    [Console]::Error.WriteLine('HUB_OS_PTY_LOAD '+$loadJson)
    Write-PtyTiming 'artifact-load-after'
} else {
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
$sourceLocks=@()
if($CompileOnly) {
    $compileInputs=$env:HUB_TEST_WINPTY_COMPILE_INPUTS | ConvertFrom-Json
    if($compileInputs.Count -ne 2){throw 'Exact compiler source inputs required.'}
    foreach($inputFile in $compileInputs) {
        if($inputFile.path -ine (Join-Path $PSScriptRoot 'winpty-bridge.cs') -and $inputFile.path -ine $PSCommandPath){throw 'Foreign compile source refused.'}
        $sourceHandle=[IO.File]::Open($inputFile.path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $sourceLocks+=$sourceHandle
        $inputHash=[Security.Cryptography.SHA256]::Create()
        try{$inputDigest=([BitConverter]::ToString($inputHash.ComputeHash($sourceHandle))).Replace('-','').ToLowerInvariant()}finally{$inputHash.Dispose()}
        if($inputDigest -cne $inputFile.sha256 -or $sourceHandle.Length -ne $inputFile.bytes){throw 'Compiler input bytes changed.'}
    }
}
$beforeLoggingStart=[Diagnostics.Stopwatch]::GetTimestamp()
Write-PtyTiming 'Add-Type-before'
[Console]::Error.WriteLine('HUB_OS_PTY_PHASE Add-Type-before')
$beforeLoggingEnd=[Diagnostics.Stopwatch]::GetTimestamp()
$cpuBefore=Read-PtySelfCpu
$callFailure=$null
$callStart=[Diagnostics.Stopwatch]::GetTimestamp()
try {
    if($CompileOnly) {
        if(-not [IO.Path]::IsPathRooted($AssemblyOutput) -or [IO.File]::Exists($AssemblyOutput) -or ([IO.Path]::GetDirectoryName($AssemblyOutput) -ine $WorkingDirectory)){throw 'Fresh private assembly output required.'}
        Add-Type -Path (Join-Path $PSScriptRoot 'winpty-bridge.cs') -OutputAssembly $AssemblyOutput -OutputType Library
    } else { Add-Type -Path (Join-Path $PSScriptRoot 'winpty-bridge.cs') }
}
catch { $callFailure=$_ }
finally { $callEnd=[Diagnostics.Stopwatch]::GetTimestamp() }
$sourceCloseFailure=$null
foreach($sourceHandle in $sourceLocks){try{$sourceHandle.Dispose()}catch{if($null -eq $sourceCloseFailure){$sourceCloseFailure=$_}}}
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
$fact=[ordered]@{ schema=1; kind='pty-compile-observation'; clockDomain='helper-stopwatch'; pid=$PID; createdFileTime=$created; frequency=[Diagnostics.Stopwatch]::Frequency.ToString([Globalization.CultureInfo]::InvariantCulture); callStart=$callStart.ToString(); callEnd=$callEnd.ToString(); cpuBefore=$cpuBefore; cpuAfter=$cpuAfter; cpuMeaning='Self process CPU over sampling interval includes source-handle closure and counter-read overhead; call elapsed includes Add-Type internal work/IO, not compiler CPU attribution.'; beforeLoggingStart=$beforeLoggingStart.ToString(); beforeLoggingEnd=$beforeLoggingEnd.ToString(); afterLoggingStart=$afterStartText; afterLoggingEnd=$afterEndText; identityCaptureStart=$identityStart.ToString(); identityCaptureEnd=$identityEnd.ToString(); powershellVersion=$PSVersionTable.PSVersion.ToString(); edition=$PSVersionTable.PSEdition; dotnetVersion=[Environment]::Version.ToString(); processorCount=[Environment]::ProcessorCount; powershellFile=$identities.pwsh; loadedAssemblies=$runtime; runtimeReason=$runtimeReason; hostLoad=[ordered]@{available=$false;reason='No additional host-load query authorized.'}; callSucceeded=($null -eq $callFailure); callError=$callErrorText }
try {
    $json=$fact | ConvertTo-Json -Depth 8 -Compress
    if([Text.Encoding]::UTF8.GetByteCount($json) -gt 8192) {
        $fact.loadedAssemblies=$null; $fact.runtimeReason='Complete identity record exceeded8192byte frame; no partial identity attestation.'
        $json=$fact | ConvertTo-Json -Depth 8 -Compress
    }
    if([Text.Encoding]::UTF8.GetByteCount($json) -gt 8192){throw 'Bounded compile observation unavailable.'}
    [Console]::Error.WriteLine('HUB_OS_PTY_COMPILE '+$json)
} catch { if($null -ne $callFailure){throw $callFailure}; throw }
if($null -ne $sourceCloseFailure){[Console]::Error.WriteLine('HUB_OS_PTY_SOURCE_CLOSE '+$sourceCloseFailure.Exception.Message.Substring(0,[Math]::Min(512,$sourceCloseFailure.Exception.Message.Length)))}
if($null -ne $callFailure){throw $callFailure}
if($null -ne $sourceCloseFailure){throw $sourceCloseFailure}
}
if($CompileOnly){
    $name=[Reflection.AssemblyName]::GetAssemblyName($AssemblyOutput)
    $compiled=[ordered]@{schema=1;kind='pty-compiled-artifact';pid=$PID;path=$AssemblyOutput;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $AssemblyOutput).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $AssemblyOutput).Length;fullName=$name.FullName}
    $compiledJson=$compiled | ConvertTo-Json -Compress
    if([Text.Encoding]::UTF8.GetByteCount($compiledJson) -gt 8192){throw 'Compiled artifact receipt bound.'}
    [Console]::Error.WriteLine('HUB_OS_PTY_ARTIFACT '+$compiledJson)
    exit 0
}
Write-PtyTiming 'closure-contract-before'
$closureResult=if($PreparedAssembly){$closureMethod.Invoke($null,@())}else{[HubWinptyFixture]::ClosureContract()}
if (-not $closureResult) { throw 'PTY closure contracts failed.' }
Write-PtyTiming 'closure-contract-after'
Write-PtyTiming 'managed-Run-before'
[Console]::Error.WriteLine('HUB_OS_PTY_PHASE managed-Run-before')
$result = if($PreparedAssembly){[int]$runMethod.Invoke($null,@($BashExecutable,$CommandLine,$WorkingDirectory,$DeadlineMs))}else{[HubWinptyFixture]::Run($BashExecutable,$CommandLine,$WorkingDirectory,$DeadlineMs)}
[Console]::Error.WriteLine('HUB_OS_PTY_PHASE managed-Run-after')
Write-PtyTiming 'managed-Run-after'
exit $result
