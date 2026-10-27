#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$Directory = '',
    [switch]$DownloadOnly,
    [switch]$Portable,
    [switch]$SetupDownloadOnly,
    [switch]$NoLaunch,
    [string]$InstallDirectory = ''
)

$ErrorActionPreference = 'Stop'
$repo = 'brucerry/embedded-linux-diagnostic-hub'
$website = 'https://brucerry.github.io/embedded-linux-diagnostic-hub/'
$setupAsset = 'Diagnostic-Hub-Windows-x64-Setup.exe'
$portableAsset = 'Diagnostic-Hub.exe'
$versionPattern = '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$'
if ($SetupDownloadOnly -and ($DownloadOnly -or $Portable)) { throw 'Choose either setup download-only or the portable options.' }
$portableMode = $Portable -or $DownloadOnly
$saveOnly = $DownloadOnly -or $SetupDownloadOnly -or ($portableMode -and $NoLaunch)
if ($InstallDirectory -and $portableMode) { throw '-InstallDirectory applies only to the setup wizard; -Directory remains the download folder.' }
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if (-not [Environment]::Is64BitOperatingSystem -or $architecture -cne 'AMD64') { throw "This desktop release requires Windows x64. Use the website: $website" }
if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'Windows 10 or Windows 11 is required.' }
if ($Version -and ($Version.Length -gt 128 -or $Version -cnotmatch $versionPattern)) { throw 'Use a release tag such as v0.6.0.' }
# Windows PowerShell accepts slash prefixes and unambiguous -NonI abbreviations.
# Inspect the actual host argv; a fully spelled switch is not the only noninteractive form.
$noninteractiveHost = @([Environment]::GetCommandLineArgs() | Where-Object {
    if ($_ -match '^[-/]([A-Za-z]+)$') {
        $hostOption = $Matches[1]
        $hostOption.Length -ge 4 -and 'NonInteractive'.StartsWith($hostOption, [StringComparison]::OrdinalIgnoreCase)
    }
}).Count -gt 0
$interactiveHost = [Environment]::UserInteractive -and -not $noninteractiveHost
if (-not $saveOnly -and -not $interactiveHost) { throw 'No interactive desktop approval surface. Use -SetupDownloadOnly, or -DownloadOnly for the portable EXE. Noninteractive input is not installation consent.' }

# Built-in .NET only. No execution-policy, privilege, registry, device or host-policy changes.
Add-Type -AssemblyName System.Net.Http
if (-not ('DiagnosticHubDownload.Native' -as [type])) {
$hubNativeSource = @"
using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace DiagnosticHubDownload {
 public sealed class Entry {
  public uint Attributes, Links; public ulong Index, Created; public uint Volume;
  public bool Directory { get { return (Attributes & 16) != 0; } }
  public bool Reparse { get { return (Attributes & 1024) != 0; } }
  public string Token { get { return Volume.ToString(CultureInfo.InvariantCulture)+":"+Index.ToString(CultureInfo.InvariantCulture)+":"+Created.ToString(CultureInfo.InvariantCulture); } }
 }
 public static class Native {
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr sec,uint d,uint f,IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectory(string p,IntPtr security);
  public static Entry Get(string p) {
   using(var h=CreateFile(p,128,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
    if(h.IsInvalid) { int e=Marshal.GetLastWin32Error(); if(e==2 || e==3)return null; throw new Win32Exception(e,"Cannot inspect download path."); }
    Info i; if(!GetFileInformationByHandle(h,out i))throw new Win32Exception(Marshal.GetLastWin32Error());
    return new Entry { Attributes=i.Attributes,Links=i.Links,Volume=i.Volume,Index=((ulong)i.IndexHigh<<32)|i.IndexLow,Created=((ulong)(uint)i.Creation.dwHighDateTime<<32)|(uint)i.Creation.dwLowDateTime };
   }
  }
  public static void MakeDirectory(string p) { if(!CreateDirectory(p,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error(),"Exclusive directory creation failed."); }
 }
 public sealed class Json {
  string text; int pos,tokens;
  static readonly System.Text.RegularExpressions.Regex Number=new System.Text.RegularExpressions.Regex(@"\G-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?",System.Text.RegularExpressions.RegexOptions.CultureInvariant,TimeSpan.FromSeconds(1));
  Json(string s){text=s;}
  void Error(){throw new FormatException("Invalid or unsupported release JSON.");}
  void Space(){while(pos<text.Length && " \t\r\n".IndexOf(text[pos])>=0)pos++;}
  string String(){
   if(pos>=text.Length || text[pos++]!='\"')Error();var b=new StringBuilder();
   while(pos<text.Length){char c=text[pos++];if(c=='\"')return b.ToString();if(c<32)Error();
    if(c=='\\'){if(pos>=text.Length)Error();c=text[pos++];switch(c){case '\"':case '\\':case '/':break;case 'b':c='\b';break;case 'f':c='\f';break;case 'n':c='\n';break;case 'r':c='\r';break;case 't':c='\t';break;case 'u':if(pos+4>text.Length)Error();ushort u;if(!UInt16.TryParse(text.Substring(pos,4),NumberStyles.AllowHexSpecifier,CultureInfo.InvariantCulture,out u))Error();pos+=4;c=(char)u;break;default:Error();break;}}
    b.Append(c);
   }Error();return null;
  }
  bool Literal(string s){if(pos+s.Length<=text.Length && System.String.CompareOrdinal(text,pos,s,0,s.Length)==0){pos+=s.Length;return true;}return false;}
  object Value(int depth){
   if(depth>32 || ++tokens>100000)Error();Space();if(pos>=text.Length)Error();char c=text[pos];
   if(c=='{'){pos++;Space();var d=new Dictionary<string,object>(StringComparer.Ordinal);var keys=new HashSet<string>(StringComparer.OrdinalIgnoreCase);if(pos<text.Length && text[pos]=='}'){pos++;return d;}while(true){Space();string k=String();if(!keys.Add(k))Error();Space();if(pos>=text.Length || text[pos++]!=':')Error();d.Add(k,Value(depth+1));Space();if(pos>=text.Length)Error();c=text[pos++];if(c=='}')return d;if(c!=',')Error();}}
   if(c=='['){pos++;Space();var a=new List<object>();if(pos<text.Length && text[pos]==']'){pos++;return a;}while(true){a.Add(Value(depth+1));Space();if(pos>=text.Length)Error();c=text[pos++];if(c==']')return a;if(c!=',')Error();}}
   if(c=='\"')return String();if(Literal("true"))return true;if(Literal("false"))return false;if(Literal("null"))return null;
   var m=Number.Match(text,pos);decimal n=0;if(!m.Success || !Decimal.TryParse(m.Value,NumberStyles.Float,CultureInfo.InvariantCulture,out n))Error();pos+=m.Length;return n;
  }
  public static object Parse(string s){if(s==null || s.Length==0 || s.Length>2097152)throw new FormatException("Release JSON exceeds its bound.");var p=new Json(s);object value=p.Value(0);p.Space();if(p.pos!=s.Length)p.Error();return value;}
 }
}
"@
    Add-Type -TypeDefinition $hubNativeSource
}

$script:HubDLPaths = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
$script:HubDLFiles = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
$script:HubDLStages = New-Object 'System.Collections.Generic.List[string]'
$script:HubDLGuardFailed = $false
$script:HubDLUser = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
function Get-HubDLPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Length -gt 4096 -or $Path -match '[\x00-\x1f\x7f]') { throw 'Choose an ordinary local path without control characters.' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -notmatch '^[A-Za-z]:\\' -or $full.Substring(3) -match '[:"<>|?*]') { throw 'Choose a local drive path; network and alternate-stream paths are unsupported.' }
    foreach ($part in $full.Substring(3).Split('\')) { if ($part -and ($part -match '[. ]$' -or $part -match '^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)')) { throw 'Choose a path without reserved or ambiguous Windows components.' } }
    if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
    return $full
}
function Stop-HubDLGuard([string]$Message) { $script:HubDLGuardFailed = $true; throw "Download filesystem identity changed: $Message. Preserve artifacts." }
function Get-HubDLChain([string]$Path) {
    $items = New-Object 'System.Collections.Generic.List[string]'
    $current = $Path
    while ($true) { $items.Add($current); $parent = [IO.Path]::GetDirectoryName($current); if (-not $parent) { break }; $current = $parent }
    $items.Reverse(); return ,$items
}
function Test-HubDLDirectory([string]$Path, [switch]$Track) {
    foreach ($part in (Get-HubDLChain $Path)) {
        $entry = [DiagnosticHubDownload.Native]::Get($part)
        $token = 'absent'
        if ($entry) { if ($entry.Reparse -or -not $entry.Directory) { Stop-HubDLGuard 'a parent is linked or not a directory' }; $token = $entry.Token }
        if ($script:HubDLPaths.ContainsKey($part)) { if ($script:HubDLPaths[$part] -cne $token) { Stop-HubDLGuard 'a reviewed parent was replaced' } }
        elseif ($Track) { if ($script:HubDLPaths.Count -ge 512) { Stop-HubDLGuard 'path table exceeds bound' }; $script:HubDLPaths.Add($part,$token) }
        else { Stop-HubDLGuard 'unbound parent' }
    }
}
function Test-HubDLParent([string]$File) { $parent = [IO.Path]::GetDirectoryName($File); Test-HubDLDirectory $parent; if ($script:HubDLPaths[$parent] -ceq 'absent') { Stop-HubDLGuard 'parent is missing' } }
function Get-HubDLFile([string]$File) {
    Test-HubDLParent $File
    $entry = [DiagnosticHubDownload.Native]::Get($File)
    if ($entry -and ($entry.Directory -or $entry.Reparse -or $entry.Links -ne 1)) { Stop-HubDLGuard 'file is not regular single-link content' }
    if ($script:HubDLFiles.ContainsKey($File) -and $entry -and $script:HubDLFiles[$File] -cne $entry.Token) { Stop-HubDLGuard 'a declared file was replaced' }
    return $entry
}
function Test-HubDLNewFile([string]$File) { if (Get-HubDLFile $File) { Stop-HubDLGuard 'new output appeared before creation' } }
function Set-HubDLFile([string]$File) { $entry = Get-HubDLFile $File; if (-not $entry) { Stop-HubDLGuard 'created file disappeared' }; $script:HubDLFiles[$File] = $entry.Token }
function Test-HubDLOwner([string]$Path) { $owner = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value; if ($owner -cne $script:HubDLUser) { throw 'Choose a download directory owned by your current user.' } }
function New-HubDLDirectory([string]$Path) {
    Test-HubDLDirectory $Path
    foreach ($part in (Get-HubDLChain $Path)) {
        if ($script:HubDLPaths[$part] -ceq 'absent') {
            $parent = [IO.Path]::GetDirectoryName($part); Test-HubDLDirectory $parent
            if ([DiagnosticHubDownload.Native]::Get($part)) { Stop-HubDLGuard 'directory appeared before exclusive creation' }
            [DiagnosticHubDownload.Native]::MakeDirectory($part)
            Test-HubDLDirectory $parent
            $entry = [DiagnosticHubDownload.Native]::Get($part)
            if (-not $entry -or -not $entry.Directory -or $entry.Reparse) { Stop-HubDLGuard 'created directory is unsafe' }
            $script:HubDLPaths[$part] = $entry.Token
        }
    }
    Test-HubDLDirectory $Path; Test-HubDLOwner $Path
}
function New-HubDLStage([string]$Parent) {
    Test-HubDLDirectory $Parent
    $stage = Join-Path $Parent ('.DiagnosticHub-download-' + [Guid]::NewGuid().ToString('N'))
    Test-HubDLDirectory $stage -Track
    New-HubDLDirectory $stage
    $script:HubDLStages.Add($stage); return $stage
}
function Open-HubDLSealed([string]$File) {
    $entry = Get-HubDLFile $File
    if (-not $entry) { throw 'Verified download is missing.' }
    $stream = [IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $current = Get-HubDLFile $File
        if (-not $current -or $current.Token -cne $entry.Token) { Stop-HubDLGuard 'file changed before verification' }
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() }
        $stream.Position = 0
        $script:HubDLFiles[$File] = $entry.Token
        return [pscustomobject]@{Stream=$stream; Hash=$hash; Bytes=$stream.Length; Token=$entry.Token}
    } catch { $stream.Dispose(); throw }
}
function Invoke-HubDLHttp([string]$Uri, [long]$MaxBytes, [string]$OutFile = '') {
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false; $handler.UseCookies = $false
    $client = New-Object System.Net.Http.HttpClient -ArgumentList (,$handler)
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    $null = $client.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent','Diagnostic-Hub-download-helper')
    $output = $null
    try {
        for ($redirect=0; $redirect -le 5; $redirect++) {
            $address = New-Object Uri $Uri
            if ($address.Scheme -cne 'https' -or $address.UserInfo) { throw 'Release downloads require HTTPS without embedded credentials.' }
            $request = New-Object System.Net.Http.HttpRequestMessage -ArgumentList ([Net.Http.HttpMethod]::Get),$address
            $response = $null
            try {
                $response = $client.SendAsync($request,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
                $status = [int]$response.StatusCode
                if ($status -in @(301,302,303,307,308)) {
                    if ($redirect -eq 5 -or -not $response.Headers.Location) { throw 'Release redirect limit reached.' }
                    $Uri = (New-Object Uri -ArgumentList $address,$response.Headers.Location).AbsoluteUri
                    continue
                }
                if ($status -ne 200) { throw ('Release request failed (HTTP {0}); no unverified program will run.' -f $status) }
                if ($response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -gt $MaxBytes) { throw 'Release response exceeds its byte bound.' }
                if ($OutFile) {
                    Test-HubDLNewFile $OutFile
                    $output = [IO.File]::Open($OutFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
                    Set-HubDLFile $OutFile
                } else { $output = New-Object IO.MemoryStream }
                $responseStream = $response.Content.ReadAsStreamAsync().Result
                try {
                    $buffer = New-Object byte[] 65536
                    [long]$received = 0
                    while ($true) {
                        $read = $responseStream.ReadAsync($buffer,0,$buffer.Length)
                        if (-not $read.Wait(30000)) { throw 'Release download stalled; retry without changing host settings.' }
                        $count = $read.Result
                        if ($count -eq 0) { break }
                        $received += $count
                        if ($received -gt $MaxBytes) { throw 'Release response exceeds its byte bound.' }
                        $output.Write($buffer,0,$count)
                    }
                    if ($response.Content.Headers.ContentLength -and $received -ne $response.Content.Headers.ContentLength) { throw 'Release response length is incomplete.' }
                    if (-not $OutFile) { return ,$output.ToArray() }
                    return
                } finally { $responseStream.Dispose() }
            } finally { if ($response) { $response.Dispose() }; $request.Dispose(); if ($output) { $output.Dispose(); $output=$null } }
        }
    } finally { $client.Dispose(); $handler.Dispose() }
}
function Read-HubDLJson([string]$Uri,[long]$Bound) {
    $data = Invoke-HubDLHttp $Uri $Bound
    $encoding = New-Object Text.UTF8Encoding -ArgumentList $false,$true
    return ,([DiagnosticHubDownload.Json]::Parse($encoding.GetString($data)))
}
function Get-HubDLText([object]$Object,[string]$Name) { if (-not ($Object -is [Collections.Generic.Dictionary[string,object]]) -or -not $Object.ContainsKey($Name) -or -not ($Object[$Name] -is [string])) { throw "Missing or invalid release field: $Name" }; return $Object[$Name] }
function Test-HubDLNames([object]$Release,[string[]]$Names) {
    if (-not ($Release -is [Collections.Generic.Dictionary[string,object]]) -or -not $Release.ContainsKey('assets')) { return $false }
    foreach ($name in $Names) { $count=0; foreach ($entry in $Release['assets']) { if (($entry -is [Collections.Generic.Dictionary[string,object]]) -and $entry.ContainsKey('name') -and $entry['name'] -ceq $name) { $count++ } }; if ($count -ne 1) { return $false } }
    return $true
}
function Get-HubDLAsset([object]$Release,[string]$Name,[string]$Base,[long]$Limit) {
    $found = @($Release['assets'] | Where-Object { $_['name'] -ceq $Name })
    if ($found.Count -ne 1) { throw 'Selected release is missing unique setup assets. Use -Portable or -DownloadOnly for this same version; no different release was selected.' }
    $entry = $found[0]
    if ((Get-HubDLText $entry 'browser_download_url') -cne "$Base/$Name" -or -not ($entry['size'] -is [decimal]) -or $entry['size'] -le 0 -or $entry['size'] -gt $Limit -or [decimal]::Truncate($entry['size']) -ne $entry['size']) { throw 'Selected release asset URL or size is invalid.' }
    return $entry
}
function Remove-HubDLStages {
    foreach ($stage in $script:HubDLStages) {
        try {
            if ($script:HubDLGuardFailed) { throw 'An identity check already failed.' }
            Test-HubDLDirectory $stage
            $declared = @($script:HubDLFiles.Keys | Where-Object { [IO.Path]::GetDirectoryName($_) -ieq $stage })
            $seen=0
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($stage)) { $seen++; if ($seen -gt 8 -or $declared -inotcontains $entry) { throw 'Undeclared stage content is retained.' } }
            foreach ($file in $declared) { $entry = Get-HubDLFile $file; if ($entry) { Test-HubDLParent $file; [IO.File]::Delete($file) } }
            Test-HubDLDirectory $stage; [IO.Directory]::Delete($stage,$false)
            $script:HubDLPaths[$stage] = 'absent'
        } catch { Write-Warning "Download scratch retained for inspection: $stage" }
    }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$sourceLock=$null; $launchLock=$null
$finalLocks=New-Object 'System.Collections.Generic.List[object]'
try {
    if (-not $Version) {
        $releases = Read-HubDLJson "https://api.github.com/repos/$repo/releases?per_page=100" 2097152
        foreach ($candidate in $releases) {
            if (($candidate -is [Collections.Generic.Dictionary[string,object]]) -and $candidate['draft'] -is [bool] -and -not $candidate['draft'] -and $candidate['tag_name'] -is [string] -and $candidate['tag_name'] -cmatch $versionPattern -and (Test-HubDLNames $candidate @($portableAsset,"$portableAsset.sha256"))) { $Version=$candidate['tag_name']; break }
        }
        if (-not $Version) { throw 'No compatible published Windows release was found.' }
    }
    if ($Version.Length -gt 128 -or $Version -cnotmatch $versionPattern) { throw 'Use a release tag such as v0.6.0.' }
    $base = "https://github.com/$repo/releases/download/$Version"
    if (-not $Directory) { $Directory = Join-Path $env:LOCALAPPDATA "DiagnosticHub\downloads\$Version" }
    $Directory = Get-HubDLPath $Directory
    Test-HubDLDirectory $Directory -Track
    if ($InstallDirectory) { $InstallDirectory = Get-HubDLPath $InstallDirectory }
    $asset = if ($portableMode) { $portableAsset } else { $setupAsset }
    $expectedBytes = 2147483648L
    $descriptorBytes=$null; $sourceCommit='not recorded for legacy portable delivery'
    if (-not $portableMode) {
        $release = Read-HubDLJson "https://api.github.com/repos/$repo/releases/tags/$Version" 2097152
        if ((Get-HubDLText $release 'tag_name') -cne $Version -or -not ($release['draft'] -is [bool]) -or $release['draft']) { throw 'Selected release publication identity is invalid.' }
        $sourceCommit = Get-HubDLText $release 'target_commitish'
        if ($sourceCommit -cnotmatch '^[a-f0-9]{40}$') { throw 'Selected setup release must identify its exact source commit.' }
        $setupEntry = Get-HubDLAsset $release $asset $base 2147483648L
        $null = Get-HubDLAsset $release "$asset.sha256" $base 4096
        $null = Get-HubDLAsset $release "$asset.info.json" $base 16384
        $descriptorBytes = Invoke-HubDLHttp "$base/$asset.info.json" 16384
        $encoding = New-Object Text.UTF8Encoding -ArgumentList $false,$true
        $info = [DiagnosticHubDownload.Json]::Parse($encoding.GetString($descriptorBytes))
        $fields = @('schemaVersion','product','platform','arch','version','commit','asset','bytes','sha256','payloadManifestSHA256')
        if (-not ($info -is [Collections.Generic.Dictionary[string,object]]) -or $info.Count -ne $fields.Count) { throw 'Invalid setup descriptor fields.' }
        foreach ($field in $fields) { if (-not $info.ContainsKey($field)) { throw 'Invalid setup descriptor fields.' } }
        if (-not ($info['schemaVersion'] -is [decimal]) -or $info['schemaVersion'] -ne 1 -or (Get-HubDLText $info 'product') -cne 'dev.diagnostichub.desktop' -or (Get-HubDLText $info 'platform') -cne 'win32' -or (Get-HubDLText $info 'arch') -cne 'x64' -or (Get-HubDLText $info 'version') -cne $Version.Substring(1) -or (Get-HubDLText $info 'commit') -cne $sourceCommit -or (Get-HubDLText $info 'asset') -cne $asset -or -not ($info['bytes'] -is [decimal]) -or $info['bytes'] -ne $setupEntry['size'] -or (Get-HubDLText $info 'sha256') -cnotmatch '^[a-f0-9]{64}$' -or (Get-HubDLText $info 'payloadManifestSHA256') -cnotmatch '^[a-f0-9]{64}$') { throw 'Setup descriptor does not match the selected release identity.' }
        $expectedBytes = [long]$info['bytes']
    }
    $checksumData = Invoke-HubDLHttp "$base/$asset.sha256" 4096
    $checksumText = ([Text.Encoding]::UTF8.GetString($checksumData)).Trim()
    $match = [Regex]::Match($checksumText,('\A([a-fA-F0-9]{64})  ' + [Regex]::Escape($asset) + '\z'))
    if (-not $match.Success) { throw 'Invalid release checksum document; no program will run.' }
    $expectedHash = $match.Groups[1].Value.ToLowerInvariant()
    if (-not $portableMode -and $expectedHash -cne $info['sha256']) { throw 'Setup checksum and descriptor disagree.' }
    $temporary = Get-HubDLPath ([IO.Path]::GetTempPath())
    Test-HubDLDirectory $temporary -Track
    $scratch = New-HubDLStage $temporary
    $download = Join-Path $scratch $asset
    Invoke-HubDLHttp "$base/$asset" $expectedBytes $download
    $sourceLock = Open-HubDLSealed $download
    if ($sourceLock.Hash -cne $expectedHash -or (-not $portableMode -and $sourceLock.Bytes -ne $expectedBytes)) { throw 'Download checksum mismatch or incomplete setup; no program will run.' }
    $checksumCanonical = [Text.Encoding]::UTF8.GetBytes($expectedHash + '  ' + $asset + [char]10)
    $plan = @([pscustomobject]@{Name=$asset; Data=$null; Hash=$expectedHash; Bytes=$sourceLock.Bytes},[pscustomobject]@{Name="$asset.sha256"; Data=$checksumCanonical; Hash=''; Bytes=$checksumCanonical.Length})
    if ($descriptorBytes) { $plan += [pscustomobject]@{Name="$asset.info.json"; Data=$descriptorBytes; Hash=''; Bytes=$descriptorBytes.Length} }
    foreach ($item in $plan) { if ($item.Data) { $h=[Security.Cryptography.SHA256]::Create(); try { $item.Hash=[BitConverter]::ToString($h.ComputeHash($item.Data)).Replace('-','').ToLowerInvariant() } finally { $h.Dispose() } } }
    New-HubDLDirectory $Directory
    foreach ($item in $plan) {
        $target = Join-Path $Directory $item.Name
        if (Get-HubDLFile $target) { $check=Open-HubDLSealed $target; try { if ($check.Hash -cne $item.Hash -or $check.Bytes -ne $item.Bytes) { throw 'Existing download differs from the verified release. Preserve it and choose another -Directory.' } } finally { $check.Stream.Dispose() } }
    }
    $cacheStage = New-HubDLStage $Directory
    foreach ($item in $plan) {
        $target = Join-Path $Directory $item.Name
        if (Get-HubDLFile $target) { continue }
        $incoming = Join-Path $cacheStage $item.Name
        Test-HubDLNewFile $incoming
        $writer = [IO.File]::Open($incoming,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        try { Set-HubDLFile $incoming; if ($item.Data) { $writer.Write($item.Data,0,$item.Data.Length) } else { $sourceLock.Stream.Position=0; $sourceLock.Stream.CopyTo($writer) } } finally { $writer.Dispose() }
        $check=Open-HubDLSealed $incoming
        try { if ($check.Hash -cne $item.Hash -or $check.Bytes -ne $item.Bytes) { throw 'Copied download bytes changed.' } } finally { $check.Stream.Dispose() }
        Test-HubDLNewFile $target; Test-HubDLParent $incoming
        [IO.File]::Move($incoming,$target)
        $script:HubDLFiles.Remove($incoming) | Out-Null
        Set-HubDLFile $target
    }
    foreach ($item in $plan) {
        $final = Open-HubDLSealed (Join-Path $Directory $item.Name)
        if ($final.Hash -cne $item.Hash -or $final.Bytes -ne $item.Bytes) { $final.Stream.Dispose(); throw 'Saved verified bytes changed before result or launch.' }
        $finalLocks.Add($final)
    }
    $executable = Join-Path $Directory $asset
    Write-Output "Verified $Version`: $executable"
    Write-Output "Source: $sourceCommit"
    Write-Output 'Release integrity verified; publisher signing is not asserted. Normal Windows policy applies.'
    if (-not $saveOnly) {
        Test-HubDLDirectory $Directory
        $launchLock = Open-HubDLSealed $executable
        if ($launchLock.Hash -cne $expectedHash -or $launchLock.Bytes -ne $sourceLock.Bytes) { throw 'Verified executable changed before launch.' }
        $arguments = ''
        if (-not $portableMode) { if ($NoLaunch) { $arguments='/NOLAUNCH' }; if ($InstallDirectory) { if ($arguments) { $arguments += ' ' }; $arguments += '/D=' + $InstallDirectory } }
        $start = @{FilePath=$executable; PassThru=$true}
        if ($arguments) { $start.ArgumentList=$arguments }
        if (-not $portableMode) { $start.Wait=$true }
        $priorNode = $env:ELECTRON_RUN_AS_NODE
        try { $env:ELECTRON_RUN_AS_NODE=$null; $process=Start-Process @start } finally { $env:ELECTRON_RUN_AS_NODE=$priorNode }
        if (-not $portableMode) { if ($process.ExitCode -ne 0) { throw ('Setup closed with exit code {0}; the verified download is retained. No ready installation is declared.' -f $process.ExitCode) }; Write-Output 'Setup closed. Installation or application readiness is not confirmed by this helper.' }
        else { Write-Output 'Portable launch requested; native readiness has not been observed.' }
    } else { Write-Output 'Download-only: no program was executed.' }
} finally {
    if ($launchLock) { $launchLock.Stream.Dispose() }
    foreach ($final in $finalLocks) { $final.Stream.Dispose() }
    if ($sourceLock) { $sourceLock.Stream.Dispose() }
    Remove-HubDLStages
}
