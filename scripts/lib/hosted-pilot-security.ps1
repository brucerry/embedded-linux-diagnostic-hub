$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$plans = @(ConvertFrom-Json $env:HUB_NATIVE_PILOT_SECURITY_PATHS)
if ($plans.Count -lt 1 -or $plans.Count -gt 3) { throw 'Fixed pilot security path bound.' }
$rows = @(foreach ($plan in $plans) {
    $item = Get-Item -LiteralPath $plan.path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point refused.' }
    $acl = Get-Acl -LiteralPath $plan.path
    if ($plan.kind -eq 'file') {
        if ($item.PSIsContainer -or $acl -isnot [Security.AccessControl.FileSecurity]) { throw 'Marker FileSecurity required.' }
    } elseif ($plan.kind -eq 'directory') {
        if (-not $item.PSIsContainer -or $acl -isnot [Security.AccessControl.DirectorySecurity]) { throw 'DirectorySecurity required.' }
    } else { throw 'Unplanned object kind.' }
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    $aces = @(foreach ($ace in $raw.DiscretionaryAcl) {
        $bytes = New-Object byte[] $ace.BinaryLength
        $ace.GetBinaryForm($bytes, 0)
        [pscustomobject]@{ type = [int]$ace.AceType; flags = [int]$ace.AceFlags; binary = [Convert]::ToBase64String($bytes) }
    })
    [pscustomobject]@{ path = [string]$plan.path; kind = [string]$plan.kind; owner = $raw.Owner.Value; group = $raw.Group.Value; daclPresent = [bool](($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0); daclNull = ($null -eq $raw.DiscretionaryAcl); aces = @($aces); binary = [Convert]::ToBase64String($acl.GetSecurityDescriptorBinaryForm()) }
})
[pscustomobject]@{principal = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rows = @($rows)} | ConvertTo-Json -Depth 6 -Compress
