$ErrorActionPreference = 'Stop'
$temporary = Join-Path $env:TEMP ('hub-downloader-test-' + [Guid]::NewGuid().ToString('N'))
$originalArchitecture = $env:PROCESSOR_ARCHITECTURE
$originalWowArchitecture = $env:PROCESSOR_ARCHITEW6432
$global:HubDownloaderTestLaunches = 0
$global:HubDownloaderTestRequests = 0
$global:HubDownloaderTestCorrupt = $false
$global:HubDownloaderTestPayload = [Text.Encoding]::UTF8.GetBytes('test-only-executable')
$sha = [Security.Cryptography.SHA256]::Create()
$global:HubDownloaderTestHash = [BitConverter]::ToString($sha.ComputeHash($global:HubDownloaderTestPayload)).Replace('-', '').ToLowerInvariant()
$sha.Dispose()

# Exercise Windows PowerShell 5.1 without contacting GitHub or executing a downloaded program.
function Invoke-RestMethod {
    param($Uri)
    $global:HubDownloaderTestRequests++
    return @([PSCustomObject]@{
        draft = $false
        prerelease = $true
        tag_name = 'v0.1.0'
        assets = @(@{ name = 'Diagnostic-Hub.exe' }, @{ name = 'Diagnostic-Hub.exe.sha256' })
    })
}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $OutFile)
    $global:HubDownloaderTestRequests++
    if ($Uri.EndsWith('.sha256')) {
        $digest = if ($global:HubDownloaderTestCorrupt) { '0' * 64 } else { $global:HubDownloaderTestHash }
        [IO.File]::WriteAllText($OutFile, "$digest  Diagnostic-Hub.exe`n")
    } else {
        [IO.File]::WriteAllBytes($OutFile, $global:HubDownloaderTestPayload)
    }
}
function Start-Process {
    param($FilePath)
    if (-not (Test-Path -LiteralPath $FilePath)) { throw 'Launch attempted before download completed.' }
    $global:HubDownloaderTestLaunches++
}
try {
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'
    $env:PROCESSOR_ARCHITEW6432 = $null
    $launcher = Join-Path $PSScriptRoot '../public/download-run.ps1'
    & $launcher -Directory $temporary
    if ($global:HubDownloaderTestLaunches -ne 1 -or $global:HubDownloaderTestRequests -ne 3) { throw 'Expected verified preview discovery and one unelevated launch.' }
    $verified = Join-Path $temporary 'Diagnostic-Hub.exe'
    $global:HubDownloaderTestCorrupt = $true
    $rejected = $false
    try { & $launcher -Directory $temporary } catch { $rejected = $_.Exception.Message -match 'checksum mismatch' }
    if (-not $rejected -or $global:HubDownloaderTestLaunches -ne 1) { throw 'Corrupt download was not blocked.' }
    if ((Get-FileHash $verified).Hash.ToLowerInvariant() -ne $global:HubDownloaderTestHash) { throw 'Last verified executable was replaced.' }
    $before = $global:HubDownloaderTestRequests
    $env:PROCESSOR_ARCHITECTURE = 'x86'
    $rejected = $false
    try { & $launcher -Directory $temporary } catch { $rejected = $_.Exception.Message -match 'Windows x64' }
    if (-not $rejected -or $global:HubDownloaderTestRequests -ne $before) { throw 'Unsupported architecture contacted GitHub.' }
    $env:PROCESSOR_ARCHITEW6432 = 'AMD64'
    $global:HubDownloaderTestCorrupt = $false
    & $launcher -Directory $temporary -Version v0.1.0 -DownloadOnly
    if ($global:HubDownloaderTestRequests -ne $before + 2 -or $global:HubDownloaderTestLaunches -ne 1) { throw 'Pinned download-only from 32-bit PowerShell failed.' }
    Write-Output 'Windows downloader passed: preview discovery, SHA-256 rejection, architecture detection, unelevated launch and download-only.'
} finally {
    $env:PROCESSOR_ARCHITECTURE = $originalArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $originalWowArchitecture
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
