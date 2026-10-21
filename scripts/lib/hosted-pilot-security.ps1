$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Set-StrictMode -Version Latest
$script:hubSecurityDiagnostic = $env:HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC -ceq 'first-collector-query-v2'
$script:hubSecurityDiagnosticRows = 0
$script:hubSecurityDiagnosticBytes = 0
$script:hubSecurityDiagnosticStdoutBytes = 0
function Write-HubSecurityPhase {
    param([string]$Phase)
    if (-not $script:hubSecurityDiagnostic) { return }
    if ($Phase -cin @('before-stdout', 'after-stdout')) { return }
    if ($Phase -notmatch '^[a-z-]{1,32}$') { throw 'Bounded diagnostic phase required.' }
    # Fixed tags/numbers only: no extra cmdlet/module initialization, paths or environment values.
    $ticks = [Diagnostics.Stopwatch]::GetTimestamp().ToString([Globalization.CultureInfo]::InvariantCulture)
    $frequency = [Diagnostics.Stopwatch]::Frequency.ToString([Globalization.CultureInfo]::InvariantCulture)
    $line = '{"schema":1,"kind":"security-phase","phase":"' + $Phase + '","pid":' + $PID + ',"ticks":"' + $ticks + '","frequency":"' + $frequency + '"}'
    $bytes = [Text.Encoding]::UTF8.GetByteCount($line + [Environment]::NewLine)
    if ($script:hubSecurityDiagnosticRows -ge 16 -or $bytes -gt 256 -or $script:hubSecurityDiagnosticBytes + $bytes -gt 4096) { throw 'Security diagnostic pre-write bound.' }
    $script:hubSecurityDiagnosticRows++
    $script:hubSecurityDiagnosticBytes += $bytes
    if ($Phase -cin @('stderr-write-returned', 'stderr-flush-returned', 'after-process-acquisition', 'after-process-path')) {
        if ($script:hubSecurityDiagnosticStdoutBytes + $bytes -gt 65536) { throw 'Diagnostic stdout pre-write bound.' }
        $script:hubSecurityDiagnosticStdoutBytes += $bytes
        [Console]::Out.WriteLine($line)
        [Console]::Out.Flush()
        return
    }
    [Console]::Error.WriteLine($line)
    if ($Phase -ceq 'before-interpreter') { Write-HubSecurityPhase -Phase 'stderr-write-returned' }
    [Console]::Error.Flush()
    if ($Phase -ceq 'before-interpreter') { Write-HubSecurityPhase -Phase 'stderr-flush-returned' }
}
Write-HubSecurityPhase -Phase 'entry'
function Get-HubShape {
    param($Value)
    if ($null -eq $Value) { return [pscustomobject]@{ type = $null; count = 0; array = $false } }
    $count = 1
    if ($Value -is [array]) { $count = $Value.Length }
    return [pscustomobject]@{ type = $Value.GetType().FullName; count = $count; array = [bool]($Value -is [array]) }
}
$trace = [ordered]@{ root = $null; rootElements = @(); validation = @(); rows = @(); getItemCalls = 0; getAclCalls = 0; red = $null }
Write-HubSecurityPhase -Phase 'before-interpreter'
$interpreterProcess = Get-Process -Id $PID
Write-HubSecurityPhase -Phase 'after-process-acquisition'
$interpreterPath = $interpreterProcess.Path
Write-HubSecurityPhase -Phase 'after-process-path'
$interpreter = [ordered]@{ path = $interpreterPath; version = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition; x64 = [Environment]::Is64BitProcess; script = $PSCommandPath }
Write-HubSecurityPhase -Phase 'after-interpreter'
$report = $null
$exitCode = 0
try {
    if ($interpreter.edition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or -not $interpreter.x64) { throw 'Actual x64 Windows PowerShell 5.1 Desktop required.' }
    if ($env:HUB_NATIVE_PILOT_SECURITY_RED_CONTROL -eq '1') {
        # Exact failed legacy capture/provider/operator chain. This read-only red control
        # deliberately reports failure; it never supplies admitted security facts.
        $plans = @(ConvertFrom-Json $env:HUB_NATIVE_PILOT_SECURITY_PATHS)
        $trace.root = Get-HubShape -Value $plans
        $trace.rootElements = @(foreach ($element in $plans) { Get-HubShape -Value $element })
        foreach ($plan in $plans) {
            $trace.getItemCalls++
            $item = Get-Item -LiteralPath $plan.path -Force
            $trace.red = [pscustomobject]@{ plan = (Get-HubShape -Value $plan); path = (Get-HubShape -Value $plan.path); item = (Get-HubShape -Value $item); itemTypes = @(foreach ($element in $item) { $element.GetType().FullName }); attributes = (Get-HubShape -Value $item.Attributes) }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point refused.' }
        }
        throw 'Legacy red control unexpectedly passed; diagnosis must be reviewed.'
    }
    # Direct assignment preserves the legacy cmdlet's single root-array object.
    Write-HubSecurityPhase -Phase 'before-plan-parse'
    $plans = ConvertFrom-Json -InputObject $env:HUB_NATIVE_PILOT_SECURITY_PATHS -ErrorAction Stop
    Write-HubSecurityPhase -Phase 'after-plan-parse'
    $trace.root = Get-HubShape -Value $plans
    $trace.rootElements = @(foreach ($element in $plans) { Get-HubShape -Value $element })
    if ($plans -isnot [array] -or $plans.Count -lt 1 -or $plans.Count -gt 3) { throw 'Flat pilot plan array of one to three records required.' }
    if ($script:hubSecurityDiagnostic -and ($plans.Count -ne 1 -or $plans[0].kind -cne 'directory')) { throw 'First collector diagnostic requires one directory plan.' }
    foreach ($plan in $plans) {
        if ($null -eq $plan -or $plan -is [array] -or $plan -isnot [System.Management.Automation.PSCustomObject]) { throw 'Scalar plan record required.' }
        $keys = @($plan.PSObject.Properties.Name | Sort-Object)
        if ($keys.Count -ne 2 -or ($keys -join ',') -cne 'kind,path') { throw 'Exactly path and kind fields required.' }
        $trace.validation += [pscustomobject]@{ plan = (Get-HubShape -Value $plan); path = (Get-HubShape -Value $plan.path); kind = (Get-HubShape -Value $plan.kind) }
        if ($plan.path -isnot [string] -or $plan.kind -isnot [string]) { throw 'Scalar string path and kind required.' }
        if ($plan.kind -cnotin @('directory', 'file')) { throw 'Unplanned object kind.' }
        if ($plan.path.Length -lt 1 -or $plan.path.Length -gt 1024 -or $plan.path -notmatch '^[A-Za-z]:\\' -or $plan.path.IndexOf([char]0) -ge 0 -or $plan.path -match '[\r\n"]' -or -not [IO.Path]::IsPathRooted($plan.path)) { throw 'Bounded absolute literal path required.' }
    }
    $rows = @(foreach ($plan in $plans) {
        $rowTrace = [pscustomobject][ordered]@{ plan = (Get-HubShape -Value $plan); path = (Get-HubShape -Value $plan.path); kind = (Get-HubShape -Value $plan.kind); item = $null; attributes = $null; container = $null; acl = $null }
        $trace.rows += $rowTrace
        $trace.getItemCalls++
        Write-HubSecurityPhase -Phase 'before-get-item'
        $item = Get-Item -LiteralPath $plan.path -Force -ErrorAction Stop
        Write-HubSecurityPhase -Phase 'after-get-item'
        $rowTrace.item = Get-HubShape -Value $item
        if ($item -isnot [IO.FileSystemInfo] -or $item -is [array]) { throw 'Exactly one filesystem item required.' }
        $attributes = $item.Attributes
        $rowTrace.attributes = Get-HubShape -Value $attributes
        if ($attributes -isnot [IO.FileAttributes] -or $attributes -is [array]) { throw 'Scalar FileAttributes required.' }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point refused.' }
        $rowTrace.container = Get-HubShape -Value $item.PSIsContainer
        if ($item.PSIsContainer -isnot [bool]) { throw 'Scalar container property required.' }
        $trace.getAclCalls++
        Write-HubSecurityPhase -Phase 'before-get-acl'
        $acl = Get-Acl -LiteralPath $plan.path -ErrorAction Stop
        Write-HubSecurityPhase -Phase 'after-get-acl'
        $rowTrace.acl = Get-HubShape -Value $acl
        if ($plan.kind -eq 'file') {
            if ($item.PSIsContainer -or $acl -isnot [Security.AccessControl.FileSecurity]) { throw 'Marker FileSecurity required.' }
        } else {
            if (-not $item.PSIsContainer -or $acl -isnot [Security.AccessControl.DirectorySecurity]) { throw 'DirectorySecurity required.' }
        }
        $descriptor = $acl.GetSecurityDescriptorBinaryForm()
        if ($descriptor.Length -gt 8192) { throw 'Descriptor byte bound exceeded.' }
        $raw = [Security.AccessControl.RawSecurityDescriptor]::new($descriptor, 0)
        if ($null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -gt 32) { throw 'Bounded nonnull DACL required.' }
        $aces = @(foreach ($ace in $raw.DiscretionaryAcl) {
            if ($ace.BinaryLength -gt 512) { throw 'ACE byte bound exceeded.' }
            $bytes = New-Object byte[] $ace.BinaryLength
            $ace.GetBinaryForm($bytes, 0)
            [pscustomobject]@{ type = [int]$ace.AceType; flags = [int]$ace.AceFlags; binary = [Convert]::ToBase64String($bytes) }
        })
        [pscustomobject]@{ path = $plan.path; kind = $plan.kind; owner = $raw.Owner.Value; group = $raw.Group.Value; daclPresent = [bool](($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0); daclNull = ($null -eq $raw.DiscretionaryAcl); aces = @($aces); binary = [Convert]::ToBase64String($descriptor) }
    })
    $report = [ordered]@{ schema = 1; complete = $true; principal = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; interpreter = $interpreter; trace = $trace; rows = @($rows); error = $null }
} catch {
    Write-HubSecurityPhase -Phase 'refused'
    $exitCode = 1
    $report = [ordered]@{ schema = 1; complete = $false; principal = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; interpreter = $interpreter; trace = $trace; rows = @(); error = [pscustomobject]@{ id = $_.FullyQualifiedErrorId; type = $_.Exception.GetType().FullName; message = $_.Exception.Message.Substring(0, [Math]::Min(512, $_.Exception.Message.Length)); position = $_.InvocationInfo.PositionMessage.Substring(0, [Math]::Min(1024, $_.InvocationInfo.PositionMessage.Length)) } }
}
Write-HubSecurityPhase -Phase 'before-serialize'
$json = $report | ConvertTo-Json -Depth 12 -Compress
Write-HubSecurityPhase -Phase 'after-serialize'
if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 65536) { throw 'Provider reply byte bound exceeded.' }
if ($script:hubSecurityDiagnostic -and $script:hubSecurityDiagnosticStdoutBytes + [Text.Encoding]::UTF8.GetByteCount($json + [Environment]::NewLine) -gt 65536) { throw 'Diagnostic stdout report bound exceeded.' }
Write-HubSecurityPhase -Phase 'before-stdout'
[Console]::Out.WriteLine($json)
Write-HubSecurityPhase -Phase 'after-stdout'
exit $exitCode
