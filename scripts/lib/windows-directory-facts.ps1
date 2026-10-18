# Fixed read-only directory metadata observation. No token/access-analysis/native interop.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$report = [pscustomobject]@{
    schema = 1; profile = 'literal-directory-security-facts-v1'; complete = $false
    filesystemProfile = 'Get-Acl-DirectorySecurity'; collectionApproval = $false
    scope = 'owner-group-dacl-only'; tokenContext = 'not-collected'; effectiveAccess = 'not-evaluated'
    sacl = 'not-requested'; mandatoryLabel = 'not-requested'; resourceAttributes = 'not-requested'; cap = 'not-requested'
    aceSemantics = 'opaque-not-evaluated'; aceOrder = 'provider-returned'
    atomicCustody = $false; protectionAfterReturn = $false; privatePathApproved = $false; admissionChanged = $false
    descriptorBytes = 0; descriptorUtf8Bytes = 0; rows = @(); stoppedAt = $null; error = $null
}
function FailureText($record) {
    $text = $record.Exception.GetType().FullName + ': ' + $record.Exception.Message
    if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 512) { return ($record.Exception.GetType().Name + ': HResult=' + $record.Exception.HResult + '; message exceeds512byte bound') }
    return $text
}
function PhysicalDirectory([string]$literal) {
    $attributes = [IO.File]::GetAttributes($literal)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'Physical directory required; reparse/non-directory refused.' }
}
$paths = @()
try {
    $paths = @(ConvertFrom-Json $env:HUB_PREFLIGHT_DIRECTORY_PATHS)
    if ($paths.Count -lt 1 -or $paths.Count -gt 24) { throw 'Fixed directory-row bound.' }
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
    for ($index = 0; $index -lt $paths.Count; $index++) {
        $literal = $paths[$index]
        $row = [pscustomobject]@{ path = $literal; availability = 'unavailable'; owner = $null; group = $null; sddl = $null; descriptorBytes = $null; daclPresent = $null; daclNull = $null; daclState = 'unavailable'; aceCount = $null; aces = $null; error = $null }
        try {
            if ($literal -isnot [string] -or $literal.Length -gt 4096 -or $literal.IndexOf([char]0) -ge 0 -or -not [IO.Path]::IsPathRooted($literal)) { throw 'Fixed absolute literal path required.' }
            PhysicalDirectory $literal
            $acl = Get-Acl -LiteralPath $literal -ErrorAction Stop
            if ($acl -isnot [Security.AccessControl.DirectorySecurity]) { throw 'Filesystem DirectorySecurity observation unavailable.' }
            $row.owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
            $row.group = $acl.GetGroup([Security.Principal.SecurityIdentifier]).Value
            # Use the provider's in-memory binary control flags; SDDL is not the state oracle.
            $binary = $acl.GetSecurityDescriptorBinaryForm()
            if ($null -eq $binary -or $binary.Length -lt 20 -or $binary.Length -gt 16384) { throw 'Provider binary descriptor unavailable/bounded.' }
            $raw = [Security.AccessControl.RawSecurityDescriptor]::new($binary, 0)
            if ($raw.BinaryLength -gt 16384 -or $report.descriptorBytes + $raw.BinaryLength -gt 32768) { throw 'Descriptor binary-byte bound.' }
            $row.descriptorBytes = $raw.BinaryLength
            $row.daclPresent = [bool]($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent)
            $row.daclNull = ($null -eq $raw.DiscretionaryAcl)
            if (-not $row.daclPresent) {
                if (-not $row.daclNull) { throw 'Inconsistent absent DACL representation.' }
                $row.daclState = 'absent'
            } elseif ($row.daclNull) { $row.daclState = 'null' }
            else {
                $count = $raw.DiscretionaryAcl.Count
                if ($count -gt 128) { throw 'DACL ACE bound.' }
                $row.aceCount = $count
                $aces = [Collections.Generic.List[object]]::new()
                foreach ($ace in $raw.DiscretionaryAcl) {
                    if ($ace.BinaryLength -lt 4 -or $ace.BinaryLength -gt 16384) { throw 'Opaque ACE byte bound.' }
                    $bytes = New-Object byte[] $ace.BinaryLength
                    $ace.GetBinaryForm($bytes, 0)
                    $aces.Add([pscustomobject]@{ type = [int]$ace.AceType; flags = [int]$ace.AceFlags; binary = [Convert]::ToBase64String($bytes) })
                }
                $row.aces = @($aces.ToArray())
                $row.daclState = $(if ($row.aceCount -eq 0) { 'empty' } else { 'nonempty' })
            }
            $sddl = $acl.GetSecurityDescriptorSddlForm($sections)
            $textBytes = [Text.Encoding]::UTF8.GetByteCount($sddl)
            if ($textBytes -gt 16384 -or $report.descriptorUtf8Bytes + $textBytes -gt 32768) { throw 'Descriptor UTF8byte bound.' }
            $row.sddl = $sddl
            $sddlCheck = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
            PhysicalDirectory $literal
            $row.availability = 'observed'
        } catch { $row.error = FailureText $_; $report.error = $row.error; $report.stoppedAt = $index }
        $oldBinary = $report.descriptorBytes; $oldText = $report.descriptorUtf8Bytes
        if ($null -ne $row.descriptorBytes) { $report.descriptorBytes += $row.descriptorBytes }
        if ($null -ne $row.sddl) { $report.descriptorUtf8Bytes += [Text.Encoding]::UTF8.GetByteCount($row.sddl) }
        $report.rows += $row
        $candidate = $report | ConvertTo-Json -Depth 8 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($candidate) -gt 32256) {
            $report.rows = @($report.rows | Select-Object -First $index)
            $report.descriptorBytes = $oldBinary; $report.descriptorUtf8Bytes = $oldText
            $report.error = 'Serialized directory-result bound; current row not retained.'; $report.stoppedAt = $index
            break
        }
        if ($null -ne $row.error) { break }
    }
    if ($null -eq $report.error -and $report.rows.Count -eq $paths.Count) { $report.complete = $true }
} catch { $report.error = FailureText $_; $report.stoppedAt = 0 }
$json = $report | ConvertTo-Json -Depth 8 -Compress
if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 32768) { throw 'Directory report bound; no retry.' }
$json
