# Bounded deterministic C# runner. Node journals the report and enforces the mandatory76/0gate.
# Compile the exact production source and fixture in one assembly, then use injected replies only.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 fixture required.' }
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Windows PowerShell 5.1 fixture profile required.' }
$root = Split-Path -Parent $PSScriptRoot
$observer = Join-Path $root 'scripts/lib/windows-ownership-snapshot.cs'
$fixture = Join-Path $PSScriptRoot 'fixtures/windows-token-query-contract.cs'
$observerSHA256 = (Get-FileHash -LiteralPath $observer -Algorithm SHA256).Hash.ToLowerInvariant()
$fixtureSHA256 = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
Add-Type -Path @($observer, $fixture) -ReferencedAssemblies @('System.dll', 'System.Core.dll')
$result = [HubOwnershipSnapshot.Tests.DeterministicTests]::Run()
if ((Get-FileHash -LiteralPath $observer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $observerSHA256 -or (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fixtureSHA256) { throw 'Compiled fixture source changed; no retry.' }
$json = [pscustomobject]@{ schema = 1; observerSHA256 = $observerSHA256; fixtureSHA256 = $fixtureSHA256; result = $result } | ConvertTo-Json -Depth 6 -Compress
if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 32768) { throw 'Compiled fixture result bound; no retry.' }
$json
