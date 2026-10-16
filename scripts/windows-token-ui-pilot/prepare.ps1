[CmdletBinding()]
param(
    [ValidateSet('Prepare', 'SelfTest', 'HostedPilot')][string]$Mode = 'Prepare',
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Prepare and SelfTest do not enter any token, process-launch or UI pilot APIs.
# The environment checks below are an operational guard, not a VM attestation.
if ($Mode -eq 'HostedPilot') {
    $expected = @{ GITHUB_ACTIONS = 'true'; CI = 'true'; RUNNER_ENVIRONMENT = 'github-hosted'; RUNNER_OS = 'Windows'; RUNNER_ARCH = 'X64'; PILOT_EXECUTION_APPROVED = 'true' }
    foreach ($name in $expected.Keys) {
        if ([Environment]::GetEnvironmentVariable($name) -ine $expected[$name]) { throw "Hosted pilot unavailable: $name" }
    }
    if ($env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d+$' -or $env:GITHUB_SHA -notmatch '^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$') { throw 'Missing hosted source/run identity.' }
}
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitProcess) { throw 'Built-in Windows x64 .NET Framework compiler required.' }
function Assert-PlainDirectory([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path.StartsWith('\\')) { throw 'An existing local absolute directory is required.' }
    $item = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($Path))
    while ($null -ne $item) {
        if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Missing or reparse directory: $($item.FullName)" }
        $item = $item.Parent
    }
}
$nonce = [Guid]::NewGuid().ToString('N')
$actualHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $parent = if ($Mode -eq 'HostedPilot') { $actualHome } else { [IO.Path]::GetTempPath() }
    $OutputDirectory = Join-Path $parent "diagnostic-hub-token-ui-pilot-$nonce"
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
Assert-PlainDirectory ([IO.Path]::GetDirectoryName($outputRoot))
if ($Mode -eq 'HostedPilot' -and (-not $outputRoot.StartsWith($actualHome.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $env:USERPROFILE -ine $actualHome)) { throw 'Hosted output must be inside the actual existing user home, without profile redirection.' }
if (Test-Path -LiteralPath $outputRoot) { throw 'Refusing existing output/case directory; preserve its receipts.' }
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$references = @('System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'WPF/UIAutomationClient.dll', 'WPF/UIAutomationTypes.dll', 'WPF/WindowsBase.dll') | ForEach-Object { Join-Path $framework $_ }
foreach ($required in @($compiler) + $references) { if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing bundled Windows component; no installation attempted: $required" } }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$files = @('scripts/windows-token-ui-pilot/Model.cs', 'scripts/windows-token-ui-pilot/Native.cs', 'scripts/windows-token-ui-pilot/Program.cs', 'scripts/windows-token-ui-pilot/pilot.manifest', 'tests/windows-token-ui-pilot/SelfTests.cs')
$sourceHashes = @($files | ForEach-Object { @{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $repoRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant() } })
[void][IO.Directory]::CreateDirectory($outputRoot)
$sourceCopy = Join-Path $outputRoot 'reviewed-source'
[void][IO.Directory]::CreateDirectory($sourceCopy)
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $sourceCopy ([IO.Path]::GetFileName($file))) }
$exe = Join-Path $outputRoot 'token-ui-pilot.exe'
$compileArguments = @('/nologo', '/target:exe', '/platform:x64', '/warnaserror+', '/optimize+', "/out:$exe", "/win32manifest:$(Join-Path $sourceCopy 'pilot.manifest')") + @($references | ForEach-Object { "/reference:$_" }) + @('Model.cs', 'Native.cs', 'Program.cs', 'SelfTests.cs' | ForEach-Object { Join-Path $sourceCopy $_ })
& $compiler @compileArguments 2>&1 | Tee-Object -FilePath (Join-Path $outputRoot 'compile.log')
if ($LASTEXITCODE -ne 0) { throw "Pilot compilation failed: $LASTEXITCODE" }
foreach ($row in $sourceHashes) {
    if ((Get-FileHash -LiteralPath (Join-Path $sourceCopy ([IO.Path]::GetFileName($row.path))) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $row.sha256) { throw 'Source bytes changed during preparation.' }
}
$manifest = @{ schema = 'token-ui-pilot-preparation-v1'; pilotOnly = $true; installerExecuted = $false; mode = $Mode; helperSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant(); sources = $sourceHashes; operationalPilotRequested = ($Mode -eq 'HostedPilot'); sourceCommit = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT }
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputRoot 'preparation.json') -Encoding utf8
Write-Output "Prepared reviewed helper: $outputRoot"
if ($Mode -in @('SelfTest', 'HostedPilot')) {
    & $exe --self-test | Tee-Object -FilePath (Join-Path $outputRoot 'pure-self-tests.json')
    if ($LASTEXITCODE -ne 0) { throw "Pure self-tests failed: $LASTEXITCODE" }
}
if ($Mode -eq 'HostedPilot') {
    # This is the only operational call. Never invoke this mode on a personal laptop.
    & $exe --run-hosted-pilot $outputRoot $nonce
    if ($LASTEXITCODE -ne 0) { throw 'Hosted token/dummy UI pilot failed or is unavailable. Preserve the evidence; do not grant privileges or alter desktop ACLs.' }
}
