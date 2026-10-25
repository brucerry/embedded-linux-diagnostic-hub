# BOUND STAGED SOURCE ONLY. No invocation or publication authority in this packet.
# Entry refusal removed only under approved local source preparation;operational gates remain.
$script:C=@{Frozen=$false;Pending=$null;Window=$null;Phase='ENTRY';ControlCharge=[long]0;EvidenceCharge=[long]0;Files=0;Summaries=@{};Hashes=@{}}
$script:Read=[byte[]]::new(65536)
$script:Writer=[byte[]]::new(65536)
$script:RequestKeys=@('version','request_nonce','allocation_nonce','repository_id','actor_id','commit','ref','workflow_path','workflow_sha256','collector_sha256','policy_sha256','job_key','issued_utc','expires_utc','artifact_prefix','retention_days','n1_policy','utc_error_seconds','source_reference_sha256')
$script:RequestMax=@(4,32,32,10,8,40,64,64,64,64,64,16,20,20,16,3,32,2,64)
$script:PolicyKeys=@('version','namespace_model','namespace_exclusion','utc_error_seconds','ledger_requirement','repository','repository_id','actor','actor_id','event','job_key','ref','workflow_path','workflow_name','request_nonce','artifact_prefix','retention_days','checkout_action_sha','upload_action_sha','source_reference_sha256','read_count','file.0','file.1','file.2','file.3')
$script:PolicyMax=@(11,32,32,2,40,40,10,16,8,17,16,64,64,32,32,16,3,40,40,64,1,264,264,264,264)
$script:ContextNames=@('GITHUB_REPOSITORY','GITHUB_SHA','GITHUB_ACTOR','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_JOB','GITHUB_WORKFLOW','GITHUB_REPOSITORY_ID','GITHUB_ACTOR_ID','GITHUB_EVENT_NAME','GITHUB_REF','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','GITHUB_WORKSPACE','RUNNER_TEMP','RUNNER_OS','RUNNER_ARCH','RUNNER_ENVIRONMENT')
$script:ContextMax=@(40,40,16,20,1,16,32,10,8,17,64,192,40,192,160,7,3,16)
$script:Leaves=@('admission.bin','command-intent.bin','control.bin','result.bin','bootstrap.bin','terminal.bin')
function Freeze([object]$Reason) {
    $script:C.Frozen=$true;$script:C.Failure=$Reason;$script:C.Phase='FROZEN_UNKNOWN'
    # Keep all pending arguments,outputs,streams,hashers and buffers reachable.
    # No final IO,observation,retry,Close-to-unblock,cancel or cleanup after cut.
    [Threading.Thread]::Sleep([Threading.Timeout]::Infinite)
    throw 'ACQUIRE_PARK_RETURN_UNKNOWN'
}
function Before([string]$Op,[object]$Arguments) {
    if($script:C.Frozen -or $null -eq $script:C.Window){Freeze 'CLOCK_OR_STATE_UNAVAILABLE'}
    if($null -ne $script:C.Pending -and $script:C.Pending.State -cne 'RETURNED'){Freeze 'PENDING_NOT_REUSABLE'}
    $p=@{Op=$Op;Arguments=$Arguments;State='PENDING';Value=$null;Before=[long]0;After=[long]0;Failure=$null};$script:C.Pending=$p
    $p.Before=[Diagnostics.Stopwatch]::GetTimestamp();$w=$script:C.Window
    if($p.Before -lt $w.Last -or $p.Before -ge $w.Endpoint){Freeze 'PRECALL_CLOCK_REFUSED'}
    $w.Last=$p.Before
    if($Op -ceq 'claim-open'){
        if($script:C.MetadataCharge -le 0 -or $script:C.MetadataCharge -gt 65536 -or $w.Outer-$p.Before -lt 720*$w.Frequency){Freeze 'FIT_OR_FRESH720_REFUSED'}
        $w.FreshGate=$p.Before
    }
    return $p.Before
}
function After([string]$Op,[long]$Before,[object]$Value) {
    $p=$script:C.Pending
    if($null -eq $p -or $p.Op -cne $Op -or $p.Before -ne $Before){Freeze 'CALL_IDENTITY_REFUSED'}
    $p.Value=$Value;$p.State='PHYSICAL_RETURN'
    $p.After=[Diagnostics.Stopwatch]::GetTimestamp();$w=$script:C.Window
    if($p.After -lt $Before -or $p.After -lt $w.Last -or $p.After -ge $w.Endpoint){Freeze 'RETURN_CLOCK_UNKNOWN_OR_LATE'}
    $w.Last=$p.After;$p.State='RETURNED'
    if(-not $script:C.Summaries.ContainsKey($Op)){
        if($script:C.Summaries.Count -ge 48){Freeze 'SUMMARY_CAP'}
        $script:C.Summaries[$Op]=@{First=$Before;Before=$Before;After=$p.After;Count=[long]0;Max=[long]0}
    }
    $s=$script:C.Summaries[$Op];if($s['Count'] -eq [long]::MaxValue){Freeze 'COUNT_OVERFLOW'}
    $s['Count']++;$s.Before=$Before;$s.After=$p.After;if($p.After-$Before -gt $s.Max){$s.Max=$p.After-$Before}
}
function Hex([byte[]]$Bytes) {
    if($Bytes.Length -ne 32){Freeze 'HASH_SHAPE'}
    $chars=[char[]]::new(64);$digits='0123456789abcdef'
    for($i=0;$i -lt 32;$i++){$chars[2*$i]=$digits[$Bytes[$i] -shr 4];$chars[2*$i+1]=$digits[$Bytes[$i] -band 15]}
    return -join $chars
}
function Hash-Bytes([byte[]]$Bytes) {
    $b=Before 'hash-new' $Bytes;$script:C.Hasher=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256);After 'hash-new' $b $script:C.Hasher
    if($null -eq $script:C.Hasher){Freeze 'HASH_NULL'};$h=$script:C.Hasher
    $b=Before 'hash-append' @($h,$Bytes);$h.AppendData($Bytes,0,$Bytes.Length);After 'hash-append' $b $null
    $b=Before 'hash-result' $h;$script:C.HashReturn=$h.GetHashAndReset();After 'hash-result' $b $script:C.HashReturn
    $hex=Hex $script:C.HashReturn
    $b=Before 'hash-dispose' $h;$h.Dispose();After 'hash-dispose' $b $null;$script:C.Hasher=$null
    return $hex
}
function Parse-Fields([byte[]]$Bytes,[string[]]$Keys,[int[]]$Maxima,[bool]$Policy) {
    # Pure finite byte grammar. No whole ASCII text/Split-lines/re-encode copy.
    $pos=0;$map=@{}
    for($j=0;$j -lt $Keys.Length;$j++){
        $key=$Keys[$j]
        for($k=0;$k -lt $key.Length;$k++){if($pos -ge $Bytes.Length -or $Bytes[$pos++] -ne [int]$key[$k]){Freeze 'CANONICAL_KEY'}}
        if($pos -ge $Bytes.Length -or $Bytes[$pos++] -ne 61){Freeze 'CANONICAL_EQUALS'}
        $start=$pos
        while($pos -lt $Bytes.Length -and $Bytes[$pos] -ne 10){if($Bytes[$pos] -lt 32 -or $Bytes[$pos] -gt 126){Freeze 'CANONICAL_ASCII'};$pos++}
        $n=$pos-$start
        if($n -le 0 -or $n -gt $Maxima[$j] -or $pos -ge $Bytes.Length){Freeze 'CANONICAL_LENGTH'}
        if($Policy -and $key.StartsWith('file.',[StringComparison]::Ordinal)){$map[$key]=@{Offset=$start;Count=$n}}
        else{$map[$key]=[Text.Encoding]::ASCII.GetString($Bytes,$start,$n)}
        $pos++
    }
    if($pos -ne $Bytes.Length){Freeze 'CANONICAL_TRAILING_BYTES'}
    return $map
}
function Read-Transport([string]$B64,[string]$Digest) {
    if($null -eq $B64 -or $null -eq $Digest -or $B64.Length -gt 8192 -or $Digest -cnotmatch '^[0-9a-f]{64}$'){Freeze 'TRANSPORT_DOMAIN'}
    if($B64.Length -eq 0 -or $B64.Length%4 -ne 0){Freeze 'BASE64_LENGTH'}
    $pad=0;if($B64.EndsWith('==',[StringComparison]::Ordinal)){$pad=2}elseif($B64.EndsWith('=',[StringComparison]::Ordinal)){$pad=1}
    for($i=0;$i -lt $B64.Length-$pad;$i++){if($B64[$i] -cnotmatch '[A-Za-z0-9+/]'){Freeze 'BASE64_CHARACTER'}}
    for($i=$B64.Length-$pad;$i -lt $B64.Length;$i++){if($B64[$i] -ne '='){Freeze 'BASE64_PADDING'}}
    $predicted=($B64.Length/4)*3-$pad
    # Transport ceilings8192/6144 remain;this exact finite request template has
    # a tighter1280 decoded/1708 encoded acceptance bound,not silent truncation.
    if($predicted -gt 6144 -or $predicted -gt 1280 -or $B64.Length -gt 1708){Freeze 'REQUEST_TEMPLATE_FIT'}
    $script:C.Decoded=[Convert]::FromBase64String($B64)
    $script:C.CanonicalB64=[Convert]::ToBase64String($script:C.Decoded)
    if($script:C.Decoded.Length -ne $predicted -or $script:C.CanonicalB64 -cne $B64){Freeze 'BASE64_NONCANONICAL'}
    $script:C.CanonicalB64=$null # known pure comparison finished before policy IO
    $script:C.Request=Parse-Fields $script:C.Decoded $script:RequestKeys $script:RequestMax $false
}
function Start-Window {
    if($null -ne $script:C.Seed -or $null -ne $script:C.Window -or $script:C.Phase -cne 'ENTRY'){Freeze 'NO_REENTRY_OR_WINDOW_RESET'}
    # First metadata instructions are trusted hosted bootstrap,not a qualified
    # owner supervising its own initial clock. Original dispatch expiry persists.
    $script:C.Seed=@{A=[long]0;B=[long]0;UTC=$null;Frequency=[long]0}
    $s=$script:C.Seed;$s.A=[Diagnostics.Stopwatch]::GetTimestamp();$s.UTC=[DateTimeOffset]::UtcNow;$s.B=[Diagnostics.Stopwatch]::GetTimestamp();$s.Frequency=[Diagnostics.Stopwatch]::Frequency
}
function Bind-Window {
    $q=$script:C.Request;$s=$script:C.Seed
    $style=[Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    $issued=[DateTimeOffset]::ParseExact($q.issued_utc,"yyyy-MM-ddTHH:mm:ss'Z'",[Globalization.CultureInfo]::InvariantCulture,$style)
    $expires=[DateTimeOffset]::ParseExact($q.expires_utc,"yyyy-MM-ddTHH:mm:ss'Z'",[Globalization.CultureInfo]::InvariantCulture,$style)
    if(($expires-$issued).Ticks -ne 9000000000 -or $q.utc_error_seconds -cne '30' -or $s.Frequency -le 0 -or $s.Frequency -gt 1000000000 -or $s.A -lt 0 -or $s.B -lt $s.A){Freeze 'WINDOW_DOMAIN'}
    $remaining=($expires-$s.UTC).Ticks-300000000 # SUPPLIED_ASSUMPTION,not measured accuracy
    if($remaining -le 0 -or $remaining -gt 9000000000){Freeze 'WINDOW_REFUSED'}
    $span=[long][decimal]::Truncate(([decimal]$remaining*$s.Frequency)/10000000)
    if($s.A -gt [long]::MaxValue-$span -or $s.A -gt [long]::MaxValue-600*$s.Frequency){Freeze 'CLOCK_OVERFLOW'}
    $outer=$s.A+$span;if($outer -lt 120*$s.Frequency){Freeze 'CLOCK_UNDERFLOW'}
    $owner=[Math]::Min($s.A+600*$s.Frequency,$outer-120*$s.Frequency);$setup=[Math]::Min($s.A+60*$s.Frequency,$owner)
    $script:C.Window=@{Outer=$outer;Owner=$owner;Setup=$setup;Endpoint=$setup;Last=$s.B;Frequency=$s.Frequency;FreshGate=[long]0}
    $b=Before 'clock-admission' $s;After 'clock-admission' $b $s
}
function Read-Context {
    $m=@{};$chars=0
    for($j=0;$j -lt $script:ContextNames.Length;$j++){
        $name=$script:ContextNames[$j];$b=Before 'context-read' $name
        $script:C.ContextReturn=[Environment]::GetEnvironmentVariable($name);After 'context-read' $b $script:C.ContextReturn
        $v=$script:C.ContextReturn
        if($null -eq $v -or $v.Length -le 0 -or $v.Length -gt $script:ContextMax[$j]){Freeze 'CONTEXT_LENGTH'}
        foreach($ch in $v.ToCharArray()){if([int]$ch -lt 32 -or [int]$ch -gt 126){Freeze 'CONTEXT_ASCII'}}
        $chars+=$v.Length;if($chars -gt 1280){Freeze 'CONTEXT_TOTAL'};$m[$name]=$v
    }
    $script:C.Context=$m;$script:C.ContextChars=$chars
    $q=$script:C.Request
    if($m.GITHUB_REPOSITORY -cne 'brucerry/embedded-linux-diagnostic-hub' -or $m.GITHUB_REPOSITORY_ID -cne '1405501450' -or $m.GITHUB_ACTOR -cne 'brucerry' -or $m.GITHUB_ACTOR_ID -cne '88369201' -or $m.GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $m.GITHUB_RUN_ATTEMPT -cne '1' -or $m.GITHUB_JOB -cne 'acquire' -or $m.RUNNER_ENVIRONMENT -cne 'github-hosted' -or $m.RUNNER_OS -cne 'Windows' -or $m.RUNNER_ARCH -cne 'X64'){Freeze 'CONTEXT_POLICY'}
    if($m.GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]{0,19}$' -or $q.commit -cnotmatch '^[0-9a-f]{40}$' -or $m.GITHUB_SHA -cne $q.commit -or $m.GITHUB_WORKFLOW_SHA -cne $q.commit -or $m.GITHUB_REF -cne $q.ref -or $m.GITHUB_WORKFLOW_REF -cne ($m.GITHUB_REPOSITORY+'/'+$q.workflow_path+'@'+$q.ref)){Freeze 'CONTEXT_REF_IDENTITY'}
}
function Path-Valid([string]$Path,[int]$Cap) {
    if($Path.Length -gt $Cap -or $Path -cnotmatch '^[A-Za-z]:\\' -or $Path.Substring(2).Contains(':') -or $Path.Contains('/') -or $Path.Contains('"') -or $Path.Contains('~') -or $Path.Contains('*') -or $Path.Contains('?')){Freeze 'PATH_DOMAIN'}
    foreach($p in $Path.Substring(3).Split([char]92)){if($p.Length -eq 0 -or $p -ceq '.' -or $p -ceq '..' -or $p -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([.]|$)' -or $p.EndsWith(' ',[StringComparison]::Ordinal) -or $p.EndsWith('.',[StringComparison]::Ordinal)){Freeze 'PATH_ALIAS'}}
}
function Read-Pinned([string]$Path,[int]$Cap) {
    $b=Before 'input-open' $Path;$script:C.Input=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);After 'input-open' $b $script:C.Input
    $n=0
    while($n -le $Cap){$ask=[Math]::Min(1024,$Cap+1-$n);$b=Before 'input-read' @($script:C.Input,$script:Read,$n,$ask);$script:C['Count']=$script:C.Input.Read($script:Read,$n,$ask);After 'input-read' $b $script:C['Count'];if($script:C['Count'] -lt 0 -or $script:C['Count'] -gt $ask){Freeze 'INPUT_COUNT'};if($script:C['Count'] -eq 0){break};$n+=$script:C['Count']}
    if($n -gt $Cap){Freeze 'INPUT_CAP'}
    $b=Before 'input-close' $script:C.Input;$script:C.Input.Close();After 'input-close' $b $null;$script:C.Input=$null
    $out=[byte[]]::new($n);[Buffer]::BlockCopy($script:Read,0,$out,0,$n)
    return ,$out
}
function Parse-Readset {
    $script:C.Readset=[object[]]::new(4);$p=$script:C.Policy
    if($p.read_count -cnotmatch '^[1-4]$'){Freeze 'READSET_UNBOUND'};$count=[int]$p.read_count
    $seen=@{}
    for($j=0;$j -lt 4;$j++){
        $r=$p['file.'+$j];$start=$r['Offset'];$end=$start+$r['Count'];$parts=[string[]]::new(5)
        for($k=0;$k -lt 5;$k++){$at=$start;while($start -lt $end -and $script:C.PolicyRaw[$start] -ne 124){$start++};$len=$start-$at;if($len -le 0){Freeze 'READSET_CANONICAL'};$parts[$k]=[Text.Encoding]::ASCII.GetString($script:C.PolicyRaw,$at,$len);if($k -lt 4){if($start -ge $end){Freeze 'READSET_FIELDS'};$start++}}
        if($start -ne $end){Freeze 'READSET_TRAILING'}
        if($j -ge $count){if(($parts -join '|') -cne 'UNUSED|UNUSED|0|UNUSED|-'){Freeze 'UNUSED_READSET'};continue}
        if($parts[0] -cnotmatch '^[a-z0-9_-]{1,16}$' -or $parts[2] -cnotmatch '^[1-9][0-9]{0,7}$'){Freeze 'READSET_SIZE_POLICY'}
        Path-Valid $parts[1] 160;$limit=[long]$parts[2];if($limit -gt 67108864){Freeze 'READSET_TEMPLATE_MAX'}
        if($parts[3] -cne 'MATCH' -and $parts[3] -cne 'OBSERVE_ONLY'){Freeze 'READSET_DATA_POLICY'}
        if(($parts[3] -ceq 'MATCH' -and $parts[4] -cnotmatch '^[0-9a-f]{64}$') -or ($parts[3] -ceq 'OBSERVE_ONLY' -and $parts[4] -cne '-')){Freeze 'READSET_DIGEST_POLICY'}
        if($seen.ContainsKey($parts[1])){Freeze 'READSET_ALIAS'};$seen[$parts[1]]=$true
        $script:C.Readset[$j]=@{Role=$parts[0];Path=$parts[1];Maximum=$limit;Mode=$parts[3];Expected=$parts[4]}
    }
    $script:C.ReadCount=$count
}
function Encode([object[]]$Pairs,[int]$Cap) {
    # Finite DATA encoding,not a callback/command dispatcher. No full text copy.
    $n=0
    if($Pairs.Count -gt 64 -or $Cap -le 0){Freeze 'ENCODER_SHAPE'}
    foreach($p in $Pairs){if($p.Count -ne 2 -or $null -eq $p[0] -or $null -eq $p[1]){Freeze 'ENCODER_PAIR'}}
    foreach($p in $Pairs){$n+=$p[0].Length+$p[1].Length+2;if($n -gt $Cap){Freeze 'WIRE_CAP'}}
    $out=[byte[]]::new($n);$at=0
    foreach($p in $Pairs){for($part=0;$part -lt 2;$part++){foreach($ch in $p[$part].ToCharArray()){if([int]$ch -lt 32 -or [int]$ch -gt 126){Freeze 'WIRE_ASCII'};$out[$at++]=[byte][int]$ch};$out[$at++]=if($part -eq 0){61}else{10}}}
    if($at -ne $n){Freeze 'WIRE_LENGTH'};return ,$out
}
function Bind-Policy {
    $q=$script:C.Request;$p=$script:C.Policy;$c=$script:C.Context
    $expected=@{version='ACQ1_POLICY';namespace_model='workflow-trust-freshvm-v1';namespace_exclusion='NO_ADVERSARIAL_ADMIN_SYSTEM';utc_error_seconds='30';ledger_requirement='EXTERNAL_SPENT_BY_REQUEST_SHA';repository='brucerry/embedded-linux-diagnostic-hub';repository_id='1405501450';actor='brucerry';actor_id='88369201';event='workflow_dispatch';job_key='acquire';workflow_path='.github/workflows/windows-m01-acquisition.yml';workflow_name='M01 acquisition';artifact_prefix='m01-acquire';source_reference_sha256='8616cb56a30af4cb46048039478578373d0ce63c5372a73a61a08837b49bf6a4'}
    foreach($key in $expected.Keys){if($p[$key] -cne $expected[$key]){Freeze 'POLICY_FIXED_VALUE'}}
    if($q.version -cne 'ACQ1' -or $q.request_nonce -cnotmatch '^[0-9a-f]{32}$' -or $q.allocation_nonce -cnotmatch '^[0-9a-f]{32}$' -or $q.request_nonce -cne $p.request_nonce -or $q.n1_policy -cne $p.namespace_model){Freeze 'REQUEST_AUTHORITY_POLICY'}
    foreach($key in @('repository_id','actor_id','ref','workflow_path','job_key','artifact_prefix','retention_days','utc_error_seconds','source_reference_sha256')){if($q[$key] -cne $p[$key]){Freeze 'REQUEST_POLICY_BINDING'}}
    foreach($key in @('workflow_sha256','collector_sha256','policy_sha256')){if($q[$key] -cnotmatch '^[0-9a-f]{64}$'){Freeze 'REQUEST_HASH_BINDING'}}
    if($p.ref -cnotmatch '^refs/heads/[A-Za-z0-9_/-]{1,53}$' -or $p.ref.Contains('..') -or $p.retention_days -cnotmatch '^[1-9][0-9]{0,2}$' -or $p.checkout_action_sha -cnotmatch '^[0-9a-f]{40}$' -or $p.upload_action_sha -cnotmatch '^[0-9a-f]{40}$' -or $c.GITHUB_WORKFLOW -cne $p.workflow_name){Freeze 'POLICY_UNBOUND'}
    # Extra workflow environment values are fixed POLICY DATA,not dispatch inputs.
    $b=Before 'binding-data-read' 'ACQUIRE_NONCE';$script:C.NonceBinding=[Environment]::GetEnvironmentVariable('ACQUIRE_NONCE');After 'binding-data-read' $b $script:C.NonceBinding
    $b=Before 'binding-data-read' 'ACQUIRE_RETENTION_DAYS';$script:C.RetentionBinding=[Environment]::GetEnvironmentVariable('ACQUIRE_RETENTION_DAYS');After 'binding-data-read' $b $script:C.RetentionBinding
    if($script:C.NonceBinding -cne $p.request_nonce -or $script:C.RetentionBinding -cne $p.retention_days){Freeze 'WORKFLOW_DATA_BINDING'}
    Parse-Readset
}
function Hash-File([string]$Path,[long]$Maximum) {
    $b=Before 'file-attributes' $Path;$first=$b;$script:C.Attributes=[IO.File]::GetAttributes($Path);After 'file-attributes' $b $script:C.Attributes
    if(($script:C.Attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0){Freeze 'FILE_TYPE_UNAVAILABLE'}
    $b=Before 'fileinfo-new' $Path;$script:C.FileInfo=[IO.FileInfo]::new($Path);After 'fileinfo-new' $b $script:C.FileInfo
    $b=Before 'file-length' $script:C.FileInfo;$script:C['Length']=$script:C.FileInfo.Length;After 'file-length' $b $script:C['Length']
    if($script:C['Length'] -lt 0 -or $script:C['Length'] -gt $Maximum){Freeze 'FILE_SIZE_LIMIT'}
    $b=Before 'file-open' $Path;$script:C.Input=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);After 'file-open' $b $script:C.Input
    $b=Before 'hash-new' $Path;$script:C.Hasher=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256);After 'hash-new' $b $script:C.Hasher
    if($null -eq $script:C.Hasher){Freeze 'HASH_NULL'}
    $total=[long]0;$chunk=65536
    if($null -ne $script:C.OutputPaths -and ($Path -ceq $script:C.OutputPaths['control.bin'] -or $Path -ceq $script:C.OutputPaths['terminal.bin'])){$chunk=1024}
    while($true){$b=Before 'file-read' @($script:C.Input,$script:Read);$script:C['Count']=$script:C.Input.Read($script:Read,0,$chunk);After 'file-read' $b $script:C['Count'];$n=$script:C['Count'];if($n -lt 0 -or $n -gt 65536 -or $total -gt $Maximum-$n){Freeze 'FILE_READ_LIMIT'};if($n -eq 0){break};$total+=$n;$b=Before 'hash-append' @($script:C.Hasher,$script:Read,$n);$script:C.Hasher.AppendData($script:Read,0,$n);After 'hash-append' $b $null}
    if($total -ne $script:C['Length']){Freeze 'FILE_STABILITY_UNKNOWN'}
    $b=Before 'hash-result' $script:C.Hasher;$script:C.HashReturn=$script:C.Hasher.GetHashAndReset();After 'hash-result' $b $script:C.HashReturn;$hex=Hex $script:C.HashReturn
    $b=Before 'hash-dispose' $script:C.Hasher;$script:C.Hasher.Dispose();After 'hash-dispose' $b $null;$script:C.Hasher=$null
    $b=Before 'file-close' $script:C.Input;$script:C.Input.Close();After 'file-close' $b $null;$script:C.Input=$null
    return @{Bytes=$total;Hash=$hex;Before=$first;After=$script:C.Pending.After}
}
function Check-Space([bool]$Initial) {
    $parent=$script:C.Context.RUNNER_TEMP
    $b=Before 'parent-attributes' $parent;$script:C.Attributes=[IO.File]::GetAttributes($parent);After 'parent-attributes' $b $script:C.Attributes
    if(($script:C.Attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($script:C.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){Freeze 'PARENT_TYPE'}
    $b=Before 'drive-new' $parent;$script:C.Drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($parent));After 'drive-new' $b $script:C.Drive
    $b=Before 'space-read' $script:C.Drive;$script:C.Free=$script:C.Drive.AvailableFreeSpace;After 'space-read' $b $script:C.Free
    $minimum=if($Initial){2147483648}else{134217728};if($script:C.Free -lt $minimum){Freeze 'FREE_SPACE_THRESHOLD'}
}
function Known-Absent([string]$Path) {
    $b=Before 'absence-query' $Path
    try{$script:C.Existing=[IO.File]::GetAttributes($Path)}catch [IO.FileNotFoundException]{$script:C.Absence=$_;After 'absence-query' $b $script:C.Absence;return}catch{$script:C.Error=$_;Freeze $_}
    After 'absence-query' $b $script:C.Existing;Freeze 'EXISTING_PATH'
}
function Write-Verified([string]$Path,[byte[]]$Bytes,[int]$Cap,[string]$Role) {
    if($Bytes.Length -gt $Cap -or $script:C.EvidenceCharge -gt 10485760-$Bytes.Length){Freeze 'WRITE_RESERVATION'}
    if($Role -ceq 'control' -and $script:C.ControlCharge -gt 1048576-$Bytes.Length){Freeze 'CONTROL_AGGREGATE'}
    $script:C.EvidenceCharge+=$Bytes.Length;if($Role -ceq 'control'){$script:C.ControlCharge+=$Bytes.Length};$script:C.Files++
    if($script:C.Files -gt 7 -or $script:C.Files -gt 256 -or $script:C.EvidenceCharge -gt 67108864){Freeze 'GENERATED_THRESHOLD'}
    $op=if($Path -ceq $script:C.Claim){'claim-open'}else{'writer-open'}
    $b=Before $op @($Path,$Bytes);$script:C.Output=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);After $op $b $script:C.Output
    $b=Before 'writer-write' @($script:C.Output,$Bytes);$script:C.Output.Write($Bytes,0,$Bytes.Length);After 'writer-write' $b $null
    $b=Before 'writer-flush' $script:C.Output;$script:C.Output.Flush($true);After 'writer-flush' $b $null
    $b=Before 'writer-close' $script:C.Output;$script:C.Output.Close();After 'writer-close' $b $null;$script:C.Output=$null
    Verify-File $Path $Bytes
}
function Verify-File([string]$Path,[byte[]]$Bytes) {
    $b=Before 'verify-open' $Path;$script:C.Input=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);After 'verify-open' $b $script:C.Input
    $off=0
    while($off -lt $Bytes.Length){$ask=[Math]::Min(1024,$Bytes.Length-$off);$b=Before 'verify-read' @($script:C.Input,$script:Read,$ask);$script:C['Count']=$script:C.Input.Read($script:Read,0,$ask);After 'verify-read' $b $script:C['Count'];$n=$script:C['Count'];if($n -le 0 -or $n -gt $ask){Freeze 'VERIFY_COUNT'};for($j=0;$j -lt $n;$j++){if($script:Read[$j] -ne $Bytes[$off+$j]){Freeze 'VERIFY_BYTES'}};$off+=$n}
    $b=Before 'verify-eof' $script:C.Input;$script:C['Count']=$script:C.Input.Read($script:Read,0,1);After 'verify-eof' $b $script:C['Count'];if($script:C['Count'] -ne 0){Freeze 'VERIFY_EOF'}
    $b=Before 'verify-close' $script:C.Input;$script:C.Input.Close();After 'verify-close' $b $null;$script:C.Input=$null
}
function Make-Directory([string]$Path) {
    Known-Absent $Path
    $b=Before 'directory-create' $Path;$script:C.Directory=[IO.Directory]::CreateDirectory($Path);After 'directory-create' $b $script:C.Directory
    $b=Before 'directory-attributes' $Path;$script:C.Attributes=[IO.File]::GetAttributes($Path);After 'directory-attributes' $b $script:C.Attributes
    if(($script:C.Attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($script:C.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){Freeze 'DIRECTORY_TYPE'}
    $b=Before 'enumerable-new' $Path;$script:C.Enumerable=[IO.Directory]::EnumerateFileSystemEntries($Path);After 'enumerable-new' $b $script:C.Enumerable
    $b=Before 'enumerator-new' $script:C.Enumerable;$script:C.Enumerator=$script:C.Enumerable.GetEnumerator();After 'enumerator-new' $b $script:C.Enumerator
    $b=Before 'enumerator-next' $script:C.Enumerator;$script:C.HasEntry=$script:C.Enumerator.MoveNext();After 'enumerator-next' $b $script:C.HasEntry;if($script:C.HasEntry){Freeze 'DIRECTORY_NOT_CLEAN'}
}
function Prepare-Metadata {
    $q=$script:C.Request;$c=$script:C.Context
    Path-Valid $c.RUNNER_TEMP 160;Path-Valid $c.GITHUB_WORKSPACE 192
    $script:C.Leaf='m01-acquire-'+$q.request_nonce+'-'+$c.GITHUB_RUN_ID+'-acquire-1'
    $script:C.Root=[IO.Path]::Combine($c.RUNNER_TEMP,$script:C.Leaf);$script:C.Claim=$script:C.Root+'.claim';$script:C.Observer=[IO.Path]::Combine($script:C.Root,'observer')
    $paths=@($script:C.Root,$script:C.Claim,$script:C.Observer,$script:C.SelfPath,$script:C.PolicyPath,$script:C.WorkflowPath);$script:C.OutputPaths=@{}
    foreach($leaf in $script:Leaves){$v=[IO.Path]::Combine($script:C.Observer,$leaf);$paths+=,$v;$script:C.OutputPaths[$leaf]=$v}
    $chars=0;foreach($path in $paths){Path-Valid $path 320;$chars+=$path.Length}
    if(2*$chars -gt 6400){Freeze 'PATH_COPY_BUDGET'};$script:C.PathChars=$chars
    for($j=0;$j -lt $script:C.ReadCount;$j++){$p=$script:C.Readset[$j].Path;if($p.Equals($script:C.Claim,[StringComparison]::OrdinalIgnoreCase) -or $p.Equals($script:C.Root,[StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($script:C.Root+'\',[StringComparison]::OrdinalIgnoreCase)){Freeze 'READ_WRITE_ALIAS'}}
    $pairs=@();foreach($key in $script:ContextNames){$pairs+=,@($key,$c[$key])};$script:C.ContextWire=Encode $pairs 2048
    $script:C.Hashes.context=Hash-Bytes $script:C.ContextWire
    $n=128+$script:C.Decoded.Length+$script:C.PolicyRaw.Length+$script:C.ContextWire.Length
    if($n -gt 6144){Freeze 'ADMISSION_TEMPLATE'};$script:C.Admission=[byte[]]::new($n)
    $a=$script:C.Admission;[Buffer]::BlockCopy([BitConverter]::GetBytes([uint32]1),0,$a,0,4)
    $lens=@($script:C.Decoded.Length,$script:C.PolicyRaw.Length,$script:C.ContextWire.Length)
    for($j=0;$j -lt 3;$j++){[Buffer]::BlockCopy([BitConverter]::GetBytes([uint32]$lens[$j]),0,$a,4+4*$j,4)}
    $w=$script:C.Window;$s=$script:C.Seed;$values=@($s.A,$s.B,$s.Frequency,$s.UTC.Ticks,$w.Outer,$w.Owner,$w.Setup)
    for($j=0;$j -lt 7;$j++){[Buffer]::BlockCopy([BitConverter]::GetBytes([long]$values[$j]),0,$a,16+8*$j,8)}
    [Buffer]::BlockCopy([Text.Encoding]::ASCII.GetBytes($q.request_nonce),0,$a,80,32);$a[112]=30;$a[113]=1 # SUPPLIED_ASSUMPTION markers,not OS proof
    $at=128;foreach($bytes in @($script:C.Decoded,$script:C.PolicyRaw,$script:C.ContextWire)){[Buffer]::BlockCopy($bytes,0,$a,$at,$bytes.Length);$at+=$bytes.Length}
    $pairs=@(@('version','ACQ1_INTENT'),@('state','SPENT'),@('request_nonce',$q.request_nonce),@('allocation_nonce',$q.allocation_nonce),@('request_sha256',$script:C.RequestSHA),@('policy_sha256',$q.policy_sha256),@('collector_sha256',$q.collector_sha256),@('workflow_sha256',$q.workflow_sha256),@('context_sha256',$script:C.Hashes.context),@('root',$script:C.Root),@('claim',$script:C.Claim),@('relative_files',($script:Leaves -join '|')),@('run',$c.GITHUB_RUN_ID),@('job','acquire'),@('attempt','1'),@('issued',$q.issued_utc),@('expiry',$q.expires_utc),@('mapping_a',[string]$s.A),@('mapping_b',[string]$s.B),@('frequency',[string]$s.Frequency),@('outer',[string]$w.Outer),@('owner',[string]$w.Owner),@('setup',[string]$w.Setup),@('namespace_model','SUPPLIED_ASSUMPTION_N1'),@('utc_error_seconds','30'),@('ledger','ASSUMED_EXTERNAL_SPENT_BY_REQUEST_SHA'))
    for($j=0;$j -lt $script:C.ReadCount;$j++){$f=$script:C.Readset[$j];$pairs+=,@(('file.'+$j),($f.Role+'|'+$f.Path+'|'+$f.Maximum+'|'+$f.Mode+'|'+$f.Expected))}
    $script:C.Intent=Encode $pairs 2816
    $script:C.Hashes.admission=Hash-Bytes $a;$script:C.Hashes.intent=Hash-Bytes $script:C.Intent
    # Complete simultaneous named copy bound:OS+managed transports/context,
    # decoded/parsed/raw inputs,path copies,actual A/I and reserved transient/
    # readback/record/hold spans. Array/dictionary/CLR overhead is UNKNOWN,not heap proof.
    $charge=4*($script:C.RequestB64.Length+$script:C.RequestSHA.Length+$script:C.NonceBinding.Length+$script:C.RetentionBinding.Length)+$script:C.Decoded.Length+2*$script:C.Decoded.Length+$script:C.PolicyRaw.Length+2*$script:C.PolicyRaw.Length+4*$script:C.ContextChars+$script:C.ContextWire.Length+2*$script:C.PathChars+$a.Length+$script:C.Intent.Length+5632+1024+2048+3072+512+1024+6144+4096
    if($charge -gt 65536){Freeze 'ACTUAL_COMBINED_METADATA_GUARD'};$script:C.MetadataCharge=$charge;$script:C.Phase='METADATA_PREPARED'
}
function Append-Control([byte[]]$Bytes) {
    if($Bytes.Length -gt 1024 -or $script:C.ControlCharge -gt 1048576-$Bytes.Length -or $script:C.EvidenceCharge -gt 10485760-$Bytes.Length){Freeze 'CONTROL_RECORD_FIT'}
    $script:C.ControlCharge+=$Bytes.Length;$script:C.EvidenceCharge+=$Bytes.Length
    $b=Before 'control-write' @($script:C.Output,$Bytes);$script:C.Output.Write($Bytes,0,$Bytes.Length);After 'control-write' $b $null
    $b=Before 'writer-flush' $script:C.Output;$script:C.Output.Flush($true);After 'writer-flush' $b $null
    Verify-ControlRange $Bytes
    $script:C.ControlOffset+=$Bytes.Length
}
function Verify-ControlRange([byte[]]$Bytes) {
    $script:C.ControlExpected=$Bytes
    $b=Before 'verify-open' $script:C.OutputPaths['control.bin'];$script:C.Input=[IO.FileStream]::new($script:C.OutputPaths['control.bin'],[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::Read -bor [IO.FileShare]::Write));After 'verify-open' $b $script:C.Input
    $left=[long]$script:C.ControlOffset
    while($left -gt 0){$ask=[int][Math]::Min(1024,$left);$b=Before 'verify-read' @($script:C.Input,$script:Read,$ask);$script:C['Count']=$script:C.Input.Read($script:Read,0,$ask);After 'verify-read' $b $script:C['Count'];$n=$script:C['Count'];if($n -le 0 -or $n -gt $ask){Freeze 'CONTROL_PREFIX_COUNT'};$left-=$n}
    $off=0
    while($off -lt $Bytes.Length){$ask=[Math]::Min(1024,$Bytes.Length-$off);$b=Before 'verify-read' @($script:C.Input,$script:Read,$ask);$script:C['Count']=$script:C.Input.Read($script:Read,0,$ask);After 'verify-read' $b $script:C['Count'];$n=$script:C['Count'];if($n -le 0 -or $n -gt $ask){Freeze 'CONTROL_RANGE_COUNT'};for($j=0;$j -lt $n;$j++){if($script:Read[$j] -ne $Bytes[$off+$j]){Freeze 'CONTROL_RANGE_BYTES'}};$off+=$n}
    $b=Before 'verify-eof' $script:C.Input;$script:C['Count']=$script:C.Input.Read($script:Read,0,1);After 'verify-eof' $b $script:C['Count'];if($script:C['Count'] -ne 0){Freeze 'CONTROL_RANGE_EOF'}
    $b=Before 'verify-close' $script:C.Input;$script:C.Input.Close();After 'verify-close' $b $null;$script:C.Input=$null;$script:C.ControlExpected=$null
}
function Record-Fact([string]$Role,[string]$Provenance,[string]$Path,[long]$Bytes,[string]$Digest,[string]$Status,[string]$BeforeFact='UNAVAILABLE',[string]$AfterFact='UNAVAILABLE') {
    $script:C.Record=Encode @(@('role',$Role),@('provenance',$Provenance),@('path',$Path),@('bytes',$(if($Provenance -ceq 'OBSERVED'){[string]$Bytes}else{'NOT_APPLICABLE'})),@('sha256',$Digest),@('status',$Status),@('before',$BeforeFact),@('after',$AfterFact)) 1024
    Append-Control $script:C.Record;$script:C.Record=$null
}
function Terminal-Row([int]$Index) {
    [Array]::Clear($script:Writer,0,10240)
    [Buffer]::BlockCopy([BitConverter]::GetBytes([uint32]$Index),0,$script:Writer,0,4)
    $text=if($Index -lt $script:C.TerminalFacts.Length){$script:C.TerminalFacts[$Index]}else{'UNAVAILABLE_UNUSED_SLOT'}
    if($text.Length -gt 10224){Freeze 'TERMINAL_ROW'}
    $rowState=if($Index -lt $script:C.TerminalFacts.Length){1}else{2};[Buffer]::BlockCopy([BitConverter]::GetBytes([uint32]$rowState),0,$script:Writer,4,4);[Buffer]::BlockCopy([BitConverter]::GetBytes([uint32]$text.Length),0,$script:Writer,8,4)
    for($k=0;$k -lt $text.Length;$k++){if([int]$text[$k] -gt 126 -or [int]$text[$k] -lt 32){Freeze 'TERMINAL_ASCII'};$script:Writer[16+$k]=[byte][int]$text[$k]}
}
function Publish-Terminal {
    $path=$script:C.OutputPaths['terminal.bin']
    if($script:C.EvidenceCharge -gt 10485760-327680){Freeze 'TERMINAL_RESERVE'};$script:C.EvidenceCharge+=327680;$script:C.Files++
    $b=Before 'terminal-open' $path;$script:C.Output=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);After 'terminal-open' $b $script:C.Output
    for($j=0;$j -lt 32;$j++){Terminal-Row $j;$b=Before 'terminal-write' @($script:C.Output,$script:Writer,$j);$script:C.Output.Write($script:Writer,0,10240);After 'terminal-write' $b $null}
    $b=Before 'writer-flush' $script:C.Output;$script:C.Output.Flush($true);After 'writer-flush' $b $null
    $b=Before 'writer-close' $script:C.Output;$script:C.Output.Close();After 'writer-close' $b $null;$script:C.Output=$null
    $b=Before 'verify-open' $path;$script:C.Input=[IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);After 'verify-open' $b $script:C.Input
    for($j=0;$j -lt 32;$j++){Terminal-Row $j;$off=0;while($off -lt 10240){$b=Before 'verify-read' @($script:C.Input,$script:Read,$off);$script:C['Count']=$script:C.Input.Read($script:Read,$off,10240-$off);After 'verify-read' $b $script:C['Count'];$n=$script:C['Count'];if($n -le 0 -or $n -gt 10240-$off){Freeze 'TERMINAL_SHORT'};$off+=$n};for($k=0;$k -lt 10240;$k++){if($script:Read[$k] -ne $script:Writer[$k]){Freeze 'TERMINAL_READBACK'}}}
    $b=Before 'verify-eof' $script:C.Input;$script:C['Count']=$script:C.Input.Read($script:Read,0,1);After 'verify-eof' $b $script:C['Count'];if($script:C['Count'] -ne 0){Freeze 'TERMINAL_EOF'}
    $b=Before 'verify-close' $script:C.Input;$script:C.Input.Close();After 'verify-close' $b $null;$script:C.Input=$null
    $h=Hash-File $path 327680;$script:C.Hashes.terminal=$h.Hash
}
function Invoke-Acquire([string]$RequestB64,[string]$RequestSHA) {
    try {
        Start-Window
        $script:C.RequestB64=$RequestB64;$script:C.RequestSHA=$RequestSHA
        Read-Transport $RequestB64 $RequestSHA;Bind-Window
        $script:C.Hashes.request=Hash-Bytes $script:C.Decoded
        if($script:C.Hashes.request -cne $RequestSHA){Freeze 'TRANSPORT_HASH'}
        Read-Context
        $script:C.SelfPath=$PSCommandPath;$script:C.PolicyPath=[IO.Path]::Combine($PSScriptRoot,'acquisition-policy.txt');$script:C.WorkflowPath=[IO.Path]::Combine($script:C.Context.GITHUB_WORKSPACE,$script:C.Request.workflow_path.Replace('/', '\'))
        Path-Valid $script:C.SelfPath 320;Path-Valid $script:C.PolicyPath 320;Path-Valid $script:C.WorkflowPath 320
        $script:C.PolicyRaw=Read-Pinned $script:C.PolicyPath 2560
        $script:C.Hashes.policy=Hash-Bytes $script:C.PolicyRaw
        if($script:C.Hashes.policy -cne $script:C.Request.policy_sha256){Freeze 'POLICY_HASH'}
        $script:C.Policy=Parse-Fields $script:C.PolicyRaw $script:PolicyKeys $script:PolicyMax $true
        Bind-Policy
        $h=Hash-File $script:C.SelfPath 65536;if($h.Hash -cne $script:C.Request.collector_sha256){Freeze 'COLLECTOR_HASH'};$script:C.Hashes.collector=$h.Hash
        $h=Hash-File $script:C.WorkflowPath 65536;if($h.Hash -cne $script:C.Request.workflow_sha256){Freeze 'WORKFLOW_HASH'};$script:C.Hashes.workflow=$h.Hash
        Prepare-Metadata;Check-Space $true
        Known-Absent $script:C.Root;Known-Absent $script:C.Claim
        $script:C.ClaimBytes=Encode @(@('state','SPENT'),@('request_sha256',$RequestSHA),@('nonce',$script:C.Request.request_nonce),@('run',$script:C.Context.GITHUB_RUN_ID),@('job','acquire'),@('attempt','1'),@('authority','SUPPLIED_ASSUMPTION_N1')) 512
        Write-Verified $script:C.Claim $script:C.ClaimBytes 512 'control';$script:C.Phase='CLAIM_SPENT'
        Make-Directory $script:C.Root;Make-Directory $script:C.Observer
        Write-Verified $script:C.OutputPaths['command-intent.bin'] $script:C.Intent 2816 'control';$script:C.Phase='INTENT_PUBLISHED'
        Write-Verified $script:C.OutputPaths['admission.bin'] $script:C.Admission 6144 'control'
        # These named input aliases retire only after complete durable byte
        # publication/readback. Raw OS environment costs remain charged;source
        # policy/request parsed values and all pending objects stay rooted.
        $script:C.Decoded=$null;$script:C.PolicyRaw=$null;$script:C.ContextWire=$null;$script:C.Admission=$null;$script:C.Intent=$null;$script:C.ClaimBytes=$null
        $script:C.Window.Endpoint=$script:C.Window.Owner;$script:C.Phase='ACQUIRING'
        $path=$script:C.OutputPaths['control.bin'];$script:C.Files++;$script:C.ControlOffset=[long]0
        $b=Before 'writer-open' $path;$script:C.Output=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);After 'writer-open' $b $script:C.Output
        Record-Fact 'namespace' 'SUPPLIED_ASSUMPTION' $script:C.Root 0 '-' 'N1_WORKFLOW_DISCIPLINE_NOT_OS_EXCLUSIVITY'
        Record-Fact 'clock' 'SUPPLIED_ASSUMPTION' '-' 30 '-' 'N2_SECONDS_SUBTRACTED_NOT_MEASURED'
        Record-Fact 'ledger' 'SUPPLIED_ASSUMPTION' '-' 0 $RequestSHA 'EXTERNAL_SPENT_REQUIRED_NOT_INTERNALLY_VERIFIED'
        Record-Fact 'M01-v3' 'STATIC_REFERENCE' '-' 0 $script:C.Policy.source_reference_sha256 'NOT_DELIVERED_OR_INVOKED'
        Record-Fact 'native-security' 'UNAVAILABLE' '-' 0 '-' 'NO_ACL_SID_VOLUME_PARENT_JOB_LOADED_IMAGE_PROOF'
        for($j=0;$j -lt $script:C.ReadCount;$j++){
            Check-Space $false;$f=$script:C.Readset[$j];$h=Hash-File $f.Path $f.Maximum
            Record-Fact $f.Role 'OBSERVED' $f.Path $h.Bytes $h.Hash 'SELECTED_FILE_BYTES_ONLY' ([string]$h.Before) ([string]$h.After)
            $script:C.Hashes['file'+$j]=$h.Hash
            if($f.Mode -ceq 'MATCH' -and $h.Hash -cne $f.Expected){Freeze 'SELECTED_FILE_HASH'}
        }
        # Fixed bounded summary cut. It excludes its own final publication and
        # does not reconstruct individual earlier read calls.
        $keys=@($script:C.Summaries.Keys);foreach($op in $keys){$s=$script:C.Summaries[$op];$wire=Encode @(@('summary',$op),@('first',[string]$s.First),@('before',[string]$s.Before),@('after',[string]$s.After),@('count',[string]$s['Count']),@('maximum_ticks',[string]$s.Max)) 1024;Append-Control $wire}
        $b=Before 'writer-flush' $script:C.Output;$script:C.Output.Flush($true);After 'writer-flush' $b $null
        $b=Before 'writer-close' $script:C.Output;$script:C.Output.Close();After 'writer-close' $b $null;$script:C.Output=$null
        $wire=$null;$keys=$null
        $h=Hash-File $path 1048576;$script:C.Hashes.control=$h.Hash
        $bootstrap=Encode @(@('domain','ACQUIRE'),@('run',$script:C.Context.GITHUB_RUN_ID),@('phase','KNOWN_ACQUISITION_RETURN'),@('qualification','UNAVAILABLE'),@('host_loss','UNKNOWN')) 4096
        Write-Verified $script:C.OutputPaths['bootstrap.bin'] $bootstrap 4096 'bootstrap';$bootstrap=$null
        $script:C.TerminalFacts=@('N1=SUPPLIED_ASSUMPTION_WORKFLOW_DISCIPLINE','N2=SUPPLIED_ASSUMPTION_30_SECONDS_SUBTRACTED','ledger=EXTERNAL_SPENT_NOT_INTERNAL_REPLAY_PROOF',('request_sha256='+$RequestSHA),('control_sha256='+$script:C.Hashes.control),('namespace='+$script:C.Root),'M01=STATIC_REFERENCE_NOT_DELIVERED',('selected_files='+$script:C.ReadCount),'loaded_image_security_parent_job=UNAVAILABLE','resource_scope=SELECTED_FILES_FREE_SPACE_ONLY','physical_closure_and_delivery=UNKNOWN','terminal_capacity=327680_rows32','final_publication_endpoints=UNAVAILABLE','RISK1=ACCEPTED_DESIGN_ONLY')
        $factChars=0;foreach($fact in $script:C.TerminalFacts){$factChars+=$fact.Length};if(2*$factChars -gt 2048){Freeze 'TERMINAL_FACT_COPY_BUDGET'}
        $script:C.Phase='EXPORTING';Publish-Terminal
        $result=Encode @(@('version','ACQ1_RESULT'),@('request_sha256',$RequestSHA),@('control_sha256',$script:C.Hashes.control),@('terminal_sha256',$script:C.Hashes.terminal),@('selected_files',[string]$script:C.ReadCount),@('generated_files','7'),@('original_outer',[string]$script:C.Window.Outer),@('fresh_gate',[string]$script:C.Window.FreshGate),@('native_qualification','UNAVAILABLE'),@('physical_closure','UNKNOWN'),@('self_publication_endpoints','UNAVAILABLE')) 1024
        Write-Verified $script:C.OutputPaths['result.bin'] $result 8192 'result'
        if($script:C.Files -ne 7 -or $null -ne $script:C.Input -or $null -ne $script:C.Output -or $null -ne $script:C.Hasher -or $script:C.Pending.State -cne 'RETURNED'){Freeze 'FINAL_CUSTODY'}
        $script:C.Phase='COMPLETE';return
    } catch {$script:C.Error=$_;if($null -ne $script:C.Pending){$script:C.Pending.Failure=$_};Freeze $_}
}
# Fixed caller;environment expressions are DATA only. Source guard above ALWAYS
# refuses before definitions or any call. No alternate entry/test/arming path.
Invoke-Acquire $env:ACQUIRE_REQUEST_B64 $env:ACQUIRE_REQUEST_SHA256
exit 0 # reachable only after known complete return;invocation requires separate authority
