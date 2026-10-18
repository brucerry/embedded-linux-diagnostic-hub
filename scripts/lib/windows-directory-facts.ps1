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
    descriptorBytes = 0; descriptorUtf8Bytes = 0; rows = [object[]]@(); stoppedAt = $null; error = $null
    serializationContract = $null
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
# Direct assignment preserves the root JSON array on WinPS5.1. Never cast an
# unvalidated item to string: arrays/Count-value wrappers must fail, not stringify.
function ConvertTo-DirectoryPaths([string]$json) {
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 24576) { throw 'Fixed path-plan byte bound.' }
    $trimmed = $json.Trim()
    if ($trimmed.Length -lt 2 -or $trimmed[0] -ne '[' -or $trimmed[$trimmed.Length - 1] -ne ']') { throw 'Root JSON array required.' }
    $decoded = ConvertFrom-Json -InputObject $json -ErrorAction Stop
    if ($decoded -isnot [array] -or $decoded.Count -lt 1 -or $decoded.Count -gt 24) { throw 'Fixed directory-row bound.' }
    $typed = [Collections.Generic.List[string]]::new()
    foreach ($item in $decoded) {
        if ($item -isnot [string] -or $item.Length -gt 4096 -or $item.IndexOf([char]0) -ge 0 -or -not [IO.Path]::IsPathRooted($item)) { throw 'Fixed absolute literal string path required.' }
        $typed.Add($item)
    }
    # One pipeline object; callers assign directly to string[], never @(command).
    return ,($typed.ToArray())
}
function ConvertTo-DirectoryJson($value) {
    return (ConvertTo-Json -InputObject $value -Depth 8 -Compress)
}
function Assert-DirectoryContract([bool]$condition, [string]$detail) {
    if (-not $condition) { throw ('Directory serialization contract: ' + $detail) }
}
# Pure managed PowerShell contracts; no filesystem/provider/token/native calls.
# Invokes the production decoder and serializer in this same child before Get-Acl.
function Test-DirectorySerializationContract {
    $result = [pscustomobject]@{ schema = 1; suite = 'directory-input-serialization-v1'; passed = 0; failed = 0; error = $null }
    try {
        $single = [string[]]@('C:\literal [x] $value legal')
        $multiple = [string[]]@('C:\', 'D:\two', 'C:\literal [x] $value legal')
        $maximum = [string[]]@(for ($n = 0; $n -lt 24; $n++) { 'C:\p' + $n })
        foreach ($expected in @($single, $multiple, $maximum)) {
            $json = ConvertTo-DirectoryJson $expected
            [string[]]$actual = ConvertTo-DirectoryPaths $json
            Assert-DirectoryContract ($actual -is [string[]] -and $actual.Count -eq $expected.Count) 'typed path count'
            for ($n = 0; $n -lt $expected.Count; $n++) {
                Assert-DirectoryContract ([string]::Equals($actual[$n], $expected[$n], [StringComparison]::Ordinal)) 'literal/order roundtrip'
            }
            $result.passed++
        }
        $rejected = [Collections.Generic.List[string]]::new()
        foreach ($bad in @('[]', 'null', '"C:\\scalar"', '{"Count":1,"value":["C:\\one"]}', '[{"Count":14,"value":["D:\\","D:\\a","D:\\a\\_temp","D:\\a\\_temp\\diagnostic-hub-windows-preflight","C:\\","C:\\Users","C:\\Users\\RUNNER~1","C:\\Users\\RUNNER~1\\AppData","C:\\Users\\RUNNER~1\\AppData\\Local","C:\\Users\\RUNNER~1\\AppData\\Local\\Temp","C:\\Users\\runneradmin","C:\\Users\\runneradmin\\AppData","C:\\Users\\runneradmin\\AppData\\Local","C:\\Users\\runneradmin\\AppData\\Local\\Temp"]}]', '[["C:\\nested"]]', '[null]', '[1]', '[true]', '["relative"]', '[""]', '["C:\\nul\u0000"]', '["C:\\one",null]', '[broken]')) { $rejected.Add($bad) }
        $rejected.Add((ConvertTo-DirectoryJson ([string[]]@('C:\' + ('x' * 4097)))))
        $rejected.Add((ConvertTo-DirectoryJson ([string[]]@($maximum + 'C:\overflow'))))
        $rejected.Add((' ' * 24577) + '[]')
        foreach ($bad in $rejected) {
            $refused = $false
            try { $unused = ConvertTo-DirectoryPaths $bad } catch { $refused = $true }
            Assert-DirectoryContract $refused 'malformed/empty/non-string/bounded plan accepted'
            $result.passed++
        }
        # Zero/one/many rows and ACE arrays; null must remain null, not [].
        for ($count = 0; $count -le 3; $count++) {
            $rows = [Collections.Generic.List[object]]::new()
            for ($n = 0; $n -lt $count; $n++) {
                $aces = [Collections.Generic.List[object]]::new()
                for ($a = 0; $a -lt $n; $a++) { $aces.Add([pscustomobject]@{ type = 127; flags = 17; binary = 'fxEIAKq7zN0=' }) }
                $rows.Add([pscustomobject]@{ path = $multiple[$n]; owner = 'S-1-5-32-544'; group = $null; sddl = 'O:BAG:BAD:(XA;;GA;;;WD;(@User.X == "literal S:()"))'; daclPresent = $true; daclNull = $false; aceCount = $n; aces = [object[]]($aces.ToArray()); nullAces = $null; error = $null })
            }
            $model = [pscustomobject]@{ complete = $false; rows = [object[]]($rows.ToArray()); stoppedAt = $null; error = 'retained error'; descriptorBytes = 0 }
            $json = ConvertTo-DirectoryJson $model
            $decoded = ConvertFrom-Json -InputObject $json -ErrorAction Stop
            Assert-DirectoryContract ($decoded.rows -is [array] -and $decoded.rows.Count -eq $count -and $decoded.complete -is [bool] -and -not $decoded.complete -and $null -eq $decoded.stoppedAt -and $decoded.error -ceq 'retained error' -and $decoded.descriptorBytes -eq 0) 'report shape/scalars'
            for ($n = 0; $n -lt $count; $n++) {
                $row = $decoded.rows[$n]
                Assert-DirectoryContract ($row.path -is [string] -and $row.path -ceq $multiple[$n] -and $row.sddl -ceq $rows[$n].sddl -and $null -eq $row.group -and $null -eq $row.nullAces -and $row.aces -is [array] -and $row.aces.Count -eq $n -and $row.aceCount -eq $n -and $row.daclPresent -is [bool] -and $row.daclPresent -and -not $row.daclNull) 'row/ACE shape'
                if ($n -gt 0) { Assert-DirectoryContract ($row.aces[0].type -eq 127 -and $row.aces[0].flags -eq 17 -and $row.aces[0].binary -ceq 'fxEIAKq7zN0=') 'opaque ACE roundtrip' }
            }
            $result.passed++
        }
        $states = [object[]]@(
            [pscustomobject]@{ daclState = 'absent'; daclPresent = $false; daclNull = $true; aceCount = $null; aces = $null },
            [pscustomobject]@{ daclState = 'null'; daclPresent = $true; daclNull = $true; aceCount = $null; aces = $null },
            [pscustomobject]@{ daclState = 'unavailable'; daclPresent = $null; daclNull = $null; aceCount = $null; aces = $null }
        )
        $stateJson = ConvertTo-DirectoryJson ([pscustomobject]@{ rows = $states })
        $stateReport = ConvertFrom-Json -InputObject $stateJson -ErrorAction Stop
        Assert-DirectoryContract ($stateReport.rows -is [array] -and $stateReport.rows.Count -eq 3) 'DACL state rows'
        for ($n = 0; $n -lt 3; $n++) {
            $row = $stateReport.rows[$n]
            Assert-DirectoryContract ($row.daclState -ceq $states[$n].daclState -and $row.daclPresent -eq $states[$n].daclPresent -and $row.daclNull -eq $states[$n].daclNull -and $null -eq $row.aceCount -and $null -eq $row.aces) 'absent/null/unavailable remains distinct'
        }
        $result.passed++
    } catch { $result.failed = 1; $result.error = FailureText $_ }
    return $result
}
[string[]]$paths = @()
$rows = [Collections.Generic.List[object]]::new()
try {
    $report.serializationContract = Test-DirectorySerializationContract
    if ($report.serializationContract.failed -ne 0 -or $report.serializationContract.passed -ne 25) { throw 'Directory serialization contract failed; no Get-Acl admission.' }
    [string[]]$paths = ConvertTo-DirectoryPaths $env:HUB_PREFLIGHT_DIRECTORY_PATHS
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
    for ($index = 0; $index -lt $paths.Count; $index++) {
        [string]$literal = $paths[$index]
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
                $row.aces = [object[]]($aces.ToArray())
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
        $rows.Add($row)
        $report.rows = [object[]]($rows.ToArray())
        $candidate = ConvertTo-DirectoryJson $report
        if ([Text.Encoding]::UTF8.GetByteCount($candidate) -gt 32256) {
            $rows.RemoveAt($index)
            $report.rows = [object[]]($rows.ToArray())
            $report.descriptorBytes = $oldBinary; $report.descriptorUtf8Bytes = $oldText
            $report.error = 'Serialized directory-result bound; current row not retained.'; $report.stoppedAt = $index
            break
        }
        if ($null -ne $row.error) { break }
    }
    if ($null -eq $report.error -and $report.rows.Count -eq $paths.Count) { $report.complete = $true }
} catch { $report.error = FailureText $_; $report.stoppedAt = 0 }
$json = ConvertTo-DirectoryJson $report
if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 32768) { throw 'Directory report bound; no retry.' }
$json
