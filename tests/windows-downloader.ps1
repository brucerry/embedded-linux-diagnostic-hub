param([switch]$NoninteractiveProbe)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Net.Http
Add-Type -TypeDefinition @"
using System;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Collections.Generic;
using System.Threading.Tasks;
namespace HubDownloadFixture {
 public sealed class Client : IDisposable {
  public static Dictionary<string,byte[]> Bodies=new Dictionary<string,byte[]>(StringComparer.Ordinal);
  public static Dictionary<string,string> Redirects=new Dictionary<string,string>(StringComparer.Ordinal);
  public static List<string> Requests=new List<string>();
  public static Action<string> OnRequest; public static long Oversize;
  HttpClient headers=new HttpClient(); public TimeSpan Timeout {get;set;}
  public HttpRequestHeaders DefaultRequestHeaders {get{return headers.DefaultRequestHeaders;}}
  public Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,HttpCompletionOption option) {
   string uri=request.RequestUri.AbsoluteUri;Requests.Add(uri);if(OnRequest!=null)OnRequest(uri);
   var r=new HttpResponseMessage();
   if(Redirects.ContainsKey(uri)){r.StatusCode=HttpStatusCode.Redirect;r.Headers.Location=new Uri(Redirects[uri],UriKind.RelativeOrAbsolute);r.Content=new ByteArrayContent(new byte[0]);}
   else if(Bodies.ContainsKey(uri)){r.StatusCode=HttpStatusCode.OK;r.Content=new ByteArrayContent(Bodies[uri]);if(Oversize>0)r.Content.Headers.ContentLength=Oversize;}
   else {r.StatusCode=HttpStatusCode.NotFound;r.Content=new ByteArrayContent(new byte[0]);}
   return Task.FromResult(r);
  }
  public void Dispose(){headers.Dispose();}
 }
}
"@ -ReferencedAssemblies System.Net.Http
# Replace only the built-in client factory. Real HTTP streaming/parser/filesystem code runs;
# synthetic responses and Start-Process interception prevent network and executable interaction.
function New-Object {
    param([Parameter(Position=0)][string]$TypeName,[Parameter(Position=1)][object[]]$ArgumentList)
    if ($TypeName -eq 'System.Net.Http.HttpClient') { return (New-HubFixtureClient) }
    $result = Microsoft.PowerShell.Utility\New-Object @PSBoundParameters
    return ,$result
}
function New-HubFixtureClient { return [HubDownloadFixture.Client]::new() }
$global:HubFixtureLaunches = New-Object 'System.Collections.Generic.List[object]'
function Start-Process {
    param($FilePath,$ArgumentList,[switch]$PassThru,[switch]$Wait)
    if (-not [IO.File]::Exists($FilePath)) { throw 'Launch preceded verified file creation.' }
    if ([IO.File]::ReadAllText($FilePath) -cne 'synthetic executable bytes - never run') { throw 'Unexpected fixture launch bytes.' }
    $global:HubFixtureLaunches.Add([pscustomobject]@{File=$FilePath;Arguments=$ArgumentList;Wait=[bool]$Wait;Node=$env:ELECTRON_RUN_AS_NODE})
    return [pscustomobject]@{ExitCode=0;Id=12345}
}
$originalTemp=$env:TEMP; $originalTmp=$env:TMP
$root = Join-Path ([IO.Path]::GetTempPath()) ('hub-windows-guided-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$root = (Get-Item -LiteralPath $root).FullName
$fixtureScratch=Join-Path $root 'temporary'; [IO.Directory]::CreateDirectory($fixtureScratch)|Out-Null
$env:TEMP=$fixtureScratch; $env:TMP=$fixtureScratch
$launcher = Join-Path $PSScriptRoot '../public/download-run.ps1'
$originalArch=$env:PROCESSOR_ARCHITECTURE; $originalWow=$env:PROCESSOR_ARCHITEW6432
$setup='Diagnostic-Hub-Windows-x64-Setup.exe'; $portable='Diagnostic-Hub.exe'
$payload=[Text.Encoding]::UTF8.GetBytes('synthetic executable bytes - never run')
$algorithm=[Security.Cryptography.SHA256]::Create()
try { $digest=[BitConverter]::ToString($algorithm.ComputeHash($payload)).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() }
$commit='a' * 40
$api='https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub'
$download='https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v0.6.0'
$script:Cases=0
function Add-Body([string]$Uri,[string]$Text) { [HubDownloadFixture.Client]::Bodies[$Uri]=[Text.Encoding]::UTF8.GetBytes($Text) }
function Reset-Fixture {
    [HubDownloadFixture.Client]::Bodies.Clear(); [HubDownloadFixture.Client]::Redirects.Clear(); [HubDownloadFixture.Client]::Requests.Clear(); [HubDownloadFixture.Client]::Oversize=0; [HubDownloadFixture.Client]::OnRequest=$null
    $global:HubFixtureLaunches.Clear()
    $script:Info=@{schemaVersion=1;product='dev.diagnostichub.desktop';platform='win32';arch='x64';version='0.6.0';commit=$commit;asset=$setup;bytes=$payload.Length;sha256=$digest;payloadManifestSHA256=('b'*64)}
    $infoText=$script:Info | ConvertTo-Json -Compress
    $script:Assets=@(@{name=$portable;size=$payload.Length;browser_download_url="$download/$portable"},@{name="$portable.sha256";size=128;browser_download_url="$download/$portable.sha256"},@{name=$setup;size=$payload.Length;browser_download_url="$download/$setup"},@{name="$setup.sha256";size=128;browser_download_url="$download/$setup.sha256"},@{name="$setup.info.json";size=([Text.Encoding]::UTF8.GetByteCount($infoText));browser_download_url="$download/$setup.info.json"})
    $script:Release=@{draft=$false;prerelease=$true;tag_name='v0.6.0';target_commitish=$commit;assets=$script:Assets}
    Add-Body "$api/releases/tags/v0.6.0" ($script:Release | ConvertTo-Json -Depth 8 -Compress)
    Add-Body "$api/releases?per_page=100" (ConvertTo-Json -InputObject @($script:Release) -Depth 8 -Compress)
    foreach($name in @($setup,$portable)) { [HubDownloadFixture.Client]::Bodies["$download/$name"]=$payload; Add-Body "$download/$name.sha256" ($digest+'  '+$name+[char]10) }
    Add-Body "$download/$setup.info.json" $infoText
}
function Invoke-Fixture([string]$Name,[hashtable]$Options,[string]$ErrorPattern='') {
    $script:Cases++
    $destination=Join-Path $root ($Name+" ' "+[char]0x8336+' & $(literal)')
    $parameters=@{Version='v0.6.0';Directory=$destination}
    foreach($k in $Options.Keys){$parameters[$k]=$Options[$k]}
    $failure=$null; $output=''
    try { $output=(& $launcher @parameters | Out-String) } catch { $failure=$_.Exception.Message + ' @ ' + $_.ScriptStackTrace }
    if($ErrorPattern) { if(-not $failure -or $failure -notmatch $ErrorPattern){throw "Case $Name did not refuse as expected: $failure $output"} }
    elseif($failure) { throw "Case $Name failed: $failure" }
    return [pscustomobject]@{Directory=$destination;Output=$output;Error=$failure}
}
try {
    $env:PROCESSOR_ARCHITECTURE='AMD64';$env:PROCESSOR_ARCHITEW6432=$null
    if ($NoninteractiveProbe) { Reset-Fixture; $null=Invoke-Fixture 'noninteractive' @{} 'approval surface'; if ([HubDownloadFixture.Client]::Requests.Count -ne 0 -or $global:HubFixtureLaunches.Count -ne 0) { throw 'Noninteractive setup performed network or launch.' }; Write-Output 'Noninteractive full-helper refusal passed before network or launch.'; return }
    Reset-Fixture
    $saved=Invoke-Fixture 'setup-only' @{SetupDownloadOnly=$true}
    if($global:HubFixtureLaunches.Count -ne 0 -or -not [IO.File]::Exists((Join-Path $saved.Directory $setup)) -or -not [IO.File]::Exists((Join-Path $saved.Directory "$setup.info.json"))){throw 'Setup download-only did not retain exact assets without launch.'}
    if([IO.File]::ReadAllText((Join-Path $saved.Directory $setup)) -cne [Text.Encoding]::UTF8.GetString($payload)){throw 'Saved bytes differ.'}
    if($saved.Output -notmatch $commit){throw 'Source commit not displayed.'}
    Reset-Fixture
    $legacy=Invoke-Fixture 'portable-only' @{DownloadOnly=$true}
    if($global:HubFixtureLaunches.Count -ne 0 -or [HubDownloadFixture.Client]::Requests.Count -ne 2 -or -not [IO.File]::Exists((Join-Path $legacy.Directory $portable))){throw 'Original pinned portable download-only contract changed.'}
    if([Environment]::UserInteractive -and -not ([Environment]::GetCommandLineArgs() -match '^-NonInteractive$')) {
        Reset-Fixture
        $installPath=Join-Path $root "installed app ' & literal"
        $guided=Invoke-Fixture 'guided' @{NoLaunch=$true;InstallDirectory=$installPath;Version=''}
        if($global:HubFixtureLaunches.Count -ne 1 -or -not $global:HubFixtureLaunches[0].Wait -or $global:HubFixtureLaunches[0].Arguments -cne ('/NOLAUNCH /D='+$installPath) -or $global:HubFixtureLaunches[0].Node){throw 'Guided argument/normal launch contract changed.'}
        if([IO.Directory]::Exists($installPath)){throw 'Helper created application installation before wizard consent.'}
        if($guided.Output -notmatch 'not confirmed'){throw 'Helper claimed readiness from setup exit.'}
        Reset-Fixture
        $normal=Invoke-Fixture 'portable-open' @{Portable=$true}
        if($global:HubFixtureLaunches.Count -ne 1 -or $global:HubFixtureLaunches[0].Wait -or [IO.Path]::GetFileName($global:HubFixtureLaunches[0].File) -cne $portable){throw 'Explicit portable launch failed.'}
    } else { Write-Output 'Actual interactive-host launch planning cases unavailable on this host; not counted as native acceptance.' }
    foreach($change in @(@{commit=('c'*40)},@{arch='arm64'},@{version='0.5.2'},@{asset=$portable},@{sha256=('c'*64)},@{bytes=1},@{publisherVerified=$true})) {
        Reset-Fixture;foreach($k in $change.Keys){$script:Info[$k]=$change[$k]};Add-Body "$download/$setup.info.json" ($script:Info|ConvertTo-Json -Compress)
        $null=Invoke-Fixture ('invalid-'+$script:Cases) @{SetupDownloadOnly=$true} 'descriptor|checksum'
        if($global:HubFixtureLaunches.Count -ne 0){throw 'Invalid descriptor launched a program.'}
    }
    Reset-Fixture;Add-Body "$download/$setup.info.json" ('{"schemaVersion":1,"schemaVersion":1}')
    $null=Invoke-Fixture 'duplicate-json' @{SetupDownloadOnly=$true} 'JSON'
    Reset-Fixture;Add-Body "$download/$setup.info.json" ('{"version":"0.6.0","\u0076ersion":"0.6.0"}')
    $null=Invoke-Fixture 'escaped-duplicate-json' @{SetupDownloadOnly=$true} 'JSON'
    Reset-Fixture;Add-Body "$download/$setup.sha256" (('0'*64)+'  '+$setup)
    $null=Invoke-Fixture 'bad-checksum' @{SetupDownloadOnly=$true} 'disagree'
    Reset-Fixture;[HubDownloadFixture.Client]::Bodies["$download/$setup"]=[Text.Encoding]::UTF8.GetBytes('wrong')
    $null=Invoke-Fixture 'corrupt' @{SetupDownloadOnly=$true} 'length|checksum|bound'
    Reset-Fixture;[HubDownloadFixture.Client]::Bodies.Remove("$download/$setup.info.json")|Out-Null
    $null=Invoke-Fixture 'missing-info' @{SetupDownloadOnly=$true} 'HTTP 404'
    Reset-Fixture;$script:Release.assets=@($script:Assets|Where-Object{$_.name -ne $setup});Add-Body "$api/releases/tags/v0.6.0" ($script:Release|ConvertTo-Json -Depth 8 -Compress)
    $null=Invoke-Fixture 'legacy-missing-setup' @{SetupDownloadOnly=$true} 'Portable|DownloadOnly'
    Reset-Fixture;[HubDownloadFixture.Client]::Redirects["$download/$setup.info.json"]='http://example.invalid/unsafe'
    $null=Invoke-Fixture 'http-redirect' @{SetupDownloadOnly=$true} 'HTTPS'
    Reset-Fixture;Add-Body "$download/$setup.info.json" (($script:Info|ConvertTo-Json -Compress)+(' '*17000));[HubDownloadFixture.Client]::OnRequest=[Action[string]]({param($uri)if($uri -ceq "$download/$setup.info.json"){[HubDownloadFixture.Client]::Oversize=1}}.GetNewClosure())
    $null=Invoke-Fixture 'stream-bound' @{SetupDownloadOnly=$true} 'bound'
    Reset-Fixture;[HubDownloadFixture.Client]::Oversize=2147483649L
    $null=Invoke-Fixture 'oversized' @{SetupDownloadOnly=$true} 'bound'
    Reset-Fixture
    $foreign=Join-Path $root ("foreign ' "+[char]0x8336+' & $(literal)');[IO.Directory]::CreateDirectory($foreign)|Out-Null;[IO.File]::WriteAllText((Join-Path $foreign $setup),'operator bytes')
    $null=Invoke-Fixture 'foreign' @{SetupDownloadOnly=$true} 'Existing download differs'
    if([IO.File]::ReadAllText((Join-Path $foreign $setup)) -cne 'operator bytes'){throw 'Foreign cache overwritten.'}
    Reset-Fixture
    $parent=Join-Path $root 'reviewed-parent';[IO.Directory]::CreateDirectory($parent)|Out-Null
    [HubDownloadFixture.Client]::OnRequest=[Action[string]]({param($uri)if($uri -ceq "$download/$setup"){[IO.Directory]::Move($parent,$parent+'-original');[IO.Directory]::CreateDirectory($parent)|Out-Null}}.GetNewClosure())
    $null=Invoke-Fixture 'parent-swap' @{SetupDownloadOnly=$true;Directory=(Join-Path $parent 'missing')} 'identity changed'
    if([IO.Directory]::Exists((Join-Path $parent 'missing'))){throw 'Substituted parent received writes.'}
    if(@(Get-ChildItem -LiteralPath $fixtureScratch).Count -eq 0){throw 'Identity failure did not preserve scratch evidence.'}
    Reset-Fixture;$before=[HubDownloadFixture.Client]::Requests.Count;$env:PROCESSOR_ARCHITECTURE='x86'
    $null=Invoke-Fixture 'unsupported' @{SetupDownloadOnly=$true} 'x64'
    if([HubDownloadFixture.Client]::Requests.Count -ne $before){throw 'Unsupported architecture used network.'}
    $env:PROCESSOR_ARCHITEW6432='AMD64';$null=Invoke-Fixture 'wow64-download' @{DownloadOnly=$true}
    $null=Invoke-Fixture 'conflicting' @{SetupDownloadOnly=$true;DownloadOnly=$true} 'either'
    $null=Invoke-Fixture 'invalid-version' @{Version='../../other';DownloadOnly=$true} 'release tag'
    $null=Invoke-Fixture 'invalid-semver' @{Version='v0.6.0-01';DownloadOnly=$true} 'release tag'
    $null=Invoke-Fixture 'invalid-args' @{Silent=$true} 'Silent'
    Write-Output ('Windows full helper mocked qualification passed: {0} cases, no network or executable interaction.' -f $script:Cases)
} finally {
    [HubDownloadFixture.Client]::OnRequest=$null
    $env:PROCESSOR_ARCHITECTURE=$originalArch;$env:PROCESSOR_ARCHITEW6432=$originalWow
    $env:TEMP=$originalTemp; $env:TMP=$originalTmp
    $expectedParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if([IO.Path]::GetDirectoryName($root) -ine $expectedParent -or [IO.Path]::GetFileName($root) -notmatch '^hub-windows-guided-[a-f0-9]{32}$' -or ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe fixture cleanup root.'}
    Remove-Item -LiteralPath $root -Recurse -Force
}
