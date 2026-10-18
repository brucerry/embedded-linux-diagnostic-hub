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
Write-PtyTiming 'Add-Type-before'
[Console]::Error.WriteLine('HUB_OS_PTY_PHASE Add-Type-before')
Add-Type -Path (Join-Path $PSScriptRoot 'winpty-bridge.cs')
[Console]::Error.WriteLine('HUB_OS_PTY_PHASE Add-Type-after')
Write-PtyTiming 'Add-Type-after'
Write-PtyTiming 'closure-contract-before'
if (-not [HubWinptyFixture]::ClosureContract()) { throw 'PTY closure contracts failed.' }
Write-PtyTiming 'closure-contract-after'
Write-PtyTiming 'managed-Run-before'
[Console]::Error.WriteLine('HUB_OS_PTY_PHASE managed-Run-before')
$result = [HubWinptyFixture]::Run($BashExecutable,$CommandLine,$WorkingDirectory,$DeadlineMs)
[Console]::Error.WriteLine('HUB_OS_PTY_PHASE managed-Run-after')
Write-PtyTiming 'managed-Run-after'
exit $result
