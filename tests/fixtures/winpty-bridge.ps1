param([Parameter(Mandatory=$true)][string]$CommandLine,
      [Parameter(Mandatory=$true)][string]$WorkingDirectory,
      [int]$DeadlineMs=15000)
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'winpty-bridge.cs')
exit [HubWinptyFixture]::Run($CommandLine,$WorkingDirectory,$DeadlineMs)
