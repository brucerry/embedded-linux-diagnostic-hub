param(
    [string]$Version = '',
    [string]$Directory = '',
    [switch]$DownloadOnly
)

# Windows PowerShell 5.1 is sufficient; no installer, elevation or policy changes.
$ErrorActionPreference = 'Stop'
$repo = 'brucerry/embedded-linux-diagnostic-hub'
$website = 'https://brucerry.github.io/embedded-linux-diagnostic-hub/'
$asset = 'Diagnostic-Hub.exe'
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if (-not [Environment]::Is64BitOperatingSystem -or $architecture -ne 'AMD64') {
    throw "This desktop release requires Windows x64. Electron 44 has no 32-bit Windows runtime. Use the website: $website"
}
if ([Environment]::OSVersion.Version.Major -lt 10) {
    throw 'This desktop release requires Windows 10 or Windows 11.'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
if ($Version) {
    if ($Version -notmatch '^v\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$') { throw 'Use a release tag such as v0.1.0.' }
} else {
    # Assign directly so PowerShell 5.1 enumerates the API's returned array in the pipeline.
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100"
    $release = $releases | Where-Object {
        -not $_.draft -and $_.tag_name -match '^v\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$' -and
        $_.assets.name -contains $asset -and $_.assets.name -contains "$asset.sha256"
    } | Select-Object -First 1
    if (-not $release) { throw "No published Windows release was found. Check https://github.com/$repo/releases." }
    $Version = $release.tag_name
}
$base = "https://github.com/$repo/releases/download/$Version"
if (-not $Directory) { $Directory = Join-Path $env:LOCALAPPDATA "DiagnosticHub\downloads\$Version" }
New-Item -ItemType Directory -Path $Directory -Force | Out-Null
$staged = Join-Path $Directory ('.download.' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staged | Out-Null
try {
    $checksumFile = Join-Path $staged "$asset.sha256"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset.sha256" -OutFile $checksumFile
    $checksum = (Get-Content -LiteralPath $checksumFile -Raw).Trim()
    if ($checksum -notmatch ('^([a-fA-F0-9]{64})  ' + [Regex]::Escape($asset) + '$')) {
        throw 'Invalid release checksum document; no application will be launched.'
    }
    $expected = $Matches[1]
    $download = Join-Path $staged $asset
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $download
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $expected) {
        throw 'Download checksum mismatch; no application will be launched.'
    }
    $executable = Join-Path $Directory $asset
    Move-Item -LiteralPath $download -Destination $executable -Force
    Write-Output "Verified ${Version}: $executable"
    if (-not $DownloadOnly) {
        $env:ELECTRON_RUN_AS_NODE = $null
        Start-Process -FilePath $executable
    }
} finally {
    Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
}
