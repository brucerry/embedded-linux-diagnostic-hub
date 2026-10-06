param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$temporary = Join-Path $env:TEMP ('DiagnosticHub-host-check-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
$originalCursor = $null
$launch = $null; $sockets = @(); $script:requestId = 0
. "$PSScriptRoot/windows-cdp.ps1"
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class HubCursorProbe {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct CursorInfo { public int Size; public int Flags; public IntPtr Cursor; public Point Position; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point position);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point position);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point position);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CursorInfo info);
}
'@
[HubCursorProbe]::SetProcessDPIAware() | Out-Null
try {
    $copied = Join-Path $temporary 'Diagnostic-Hub.exe'
    Copy-Item -LiteralPath $Executable -Destination $copied
    $profile = Join-Path $temporary 'profile'
    $mainPort = Free-Port; $rendererPort = Free-Port
    $env:ELECTRON_RUN_AS_NODE = $null
    $launch = Start-Process -FilePath $copied -ArgumentList @("--user-data-dir=$profile", "--inspect=127.0.0.1:$mainPort", "--remote-debugging-port=$rendererPort") -PassThru
    $main = Open-Inspector $mainPort $false; $sockets += $main
    $renderer = Open-Inspector $rendererPort $true; $sockets += $renderer
    $profileJson = ConvertTo-Json -InputObject $profile -Compress
    $setup = @"
(async () => {
    const require = process.getBuiltinModule('module').createRequire(process.execPath);
    const {app,dialog,BrowserWindow} = require('electron');
    const fromApp = process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
    const {Server} = fromApp('ssh2');
    const key = require('node:crypto').generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs1'});
    app.setPath('userData',$profileJson);
    dialog.showMessageBox = async () => { throw Error('Unexpected OS-modal SSH dialog'); };
    globalThis.fixtureAuthentications = 0;
    globalThis.fixtureSsh = new Server({hostKeys:[key]},client => {
        client.on('error',()=>{});
        client.on('authentication',ctx => { if(ctx.method==='password' && ctx.username==='engineer' && ctx.password==='test-only-secret')ctx.accept();else ctx.reject(); });
        client.on('ready',()=>{ globalThis.fixtureAuthentications++; client.on('session',accept=>accept().on('exec',(acceptExec,_reject,info)=>{
            const stream=acceptExec();
            if(info.command.includes('/sys/class/net/*')) {
                if(!info.command.includes('Invalid argument')) { stream.exit(1);stream.end();return; }
                stream.write('/sys/class/net/lan0/operstate=up\n/sys/class/net/lan0/carrier=1\n/sys/class/net/lan0/statistics/rx_packets=123\n/sys/class/net/lan1/operstate=down\n/sys/class/net/lan1/statistics/rx_packets=5\n');
                stream.stderr.write('Warning: /sys/class/net/lan1/carrier could not be read (Invalid argument). Other valid readings are retained.\n');
            } else { stream.write('Fixture evidence\n');stream.stderr.write('Fixture standard error\n'); }
            stream.exit(0);stream.end();
        })); });
    });
    await new Promise(resolve=>fixtureSsh.listen(0,'127.0.0.1',resolve));
    globalThis.fixtureEndpoint = '127.0.0.1:'+fixtureSsh.address().port;
    const fs=require('node:fs');fs.mkdirSync($profileJson,{recursive:true});
    fs.writeFileSync($profileJson+'/known-hosts.json',JSON.stringify({[fixtureEndpoint]:'SHA256:'+ 'A'.repeat(43),'other-board:22':'unchanged'}));
    return {port:fixtureSsh.address().port,enabled:BrowserWindow.getAllWindows()[0].isEnabled()};
})()
"@
    $fixture = Evaluate $main $setup
    $fixtureJson = ConvertTo-Json -InputObject $fixture -Compress
    Evaluate $renderer ('globalThis.fixtureSettings = ' + $fixtureJson) | Out-Null
    $exercise = @'
(async () => {
    const wait=async fn=>{const start=Date.now();while(!fn()){if(Date.now()-start>30000)throw Error('Fixture UI timed out');await new Promise(r=>setTimeout(r,50));}};
    const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text || b.getAttribute('aria-label')===text);
    const fill=(label,value)=>{const el=[...document.querySelectorAll('label')].find(el=>el.textContent.startsWith(label)).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
    await wait(()=>button('Connect device'));button('Connect device').click();await wait(()=>document.querySelector('.modal form'));
    fill('Hostname or IP address','127.0.0.1');fill('Port',String(fixtureSettings.port));fill('SSH username','engineer');fill('Password','test-only-secret');
    await new Promise(r=>setTimeout(r,0));document.querySelector('.modal form').requestSubmit();await wait(()=>document.querySelector('.host-verification'));
    if(document.querySelector('.host-verification h3').textContent!=='SSH host key changed')throw Error('Missing replacement prompt');
    if(document.activeElement!==button('Cancel verification'))throw Error('Cancel is not focused by default');
    if(getComputedStyle(button('Trust replacement device')).cursor!=='pointer')throw Error('Wrong button cursor');
    if(getComputedStyle(document.querySelector('.host-fingerprint code')).cursor!=='text')throw Error('Fingerprint cursor is hidden');
    return {promptVisible:true,buttonCursor:'pointer',fingerprintCursor:'text'};
})()
'@
    Write-Output ('Windows inline prompt: ' + ((Evaluate $renderer $exercise) | ConvertTo-Json -Compress))
    if (-not (Evaluate $main "process.getBuiltinModule('module').createRequire(process.execPath)('electron').BrowserWindow.getAllWindows()[0].isEnabled()")) { throw 'The host prompt disabled the native app window.' }
    $handle = Evaluate $main "Number(process.getBuiltinModule('module').createRequire(process.execPath)('electron').BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE()).toString()"
    Evaluate $main "(()=>{const window=process.getBuiltinModule('module').createRequire(process.execPath)('electron').BrowserWindow.getAllWindows()[0];window.restore();window.show();window.setAlwaysOnTop(true);window.focus();})()" | Out-Null
    [HubCursorProbe]::SetForegroundWindow([IntPtr]([long]$handle)) | Out-Null
    Start-Sleep -Milliseconds 200
    $target = Evaluate $renderer "(()=>{const box=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Cancel verification').getBoundingClientRect();return {x:(box.left+box.width/2)*devicePixelRatio,y:(box.top+box.height/2)*devicePixelRatio};})()"
    $originalCursor = New-Object HubCursorProbe+Point
    [HubCursorProbe]::GetCursorPos([ref]$originalCursor) | Out-Null
    $point = New-Object HubCursorProbe+Point; $point.X = [int]$target.x; $point.Y = [int]$target.y
    if (-not [HubCursorProbe]::ClientToScreen([IntPtr]([long]$handle), [ref]$point)) { throw 'Cannot locate the app cursor target.' }
    [HubCursorProbe]::SetCursorPos($point.X, $point.Y) | Out-Null
    Start-Sleep -Milliseconds 150
    if ([HubCursorProbe]::GetAncestor([HubCursorProbe]::WindowFromPoint($point), 2) -ne [IntPtr]([long]$handle)) { throw ('Cursor check target mismatch: app='+$handle+' point='+$point.X+','+$point.Y+' root='+[HubCursorProbe]::GetAncestor([HubCursorProbe]::WindowFromPoint($point), 2)) }
    $cursor = New-Object HubCursorProbe+CursorInfo; $cursor.Size = [Runtime.InteropServices.Marshal]::SizeOf($cursor)
    if (-not [HubCursorProbe]::GetCursorInfo([ref]$cursor) -or ($cursor.Flags -band 1) -eq 0 -or $cursor.Cursor -eq [IntPtr]::Zero) { throw 'The Windows cursor is not visible over the in-app confirmation.' }
    Write-Output 'Windows GetCursorInfo confirms a visible cursor over the verification controls.'
    Evaluate $renderer "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Cancel verification').click()" | Out-Null
    Start-Sleep -Milliseconds 300
    if ((Evaluate $main 'globalThis.fixtureAuthentications') -ne 0) { throw 'Cancelled key was authenticated.' }
    if (-not (Evaluate $main "process.getBuiltinModule('fs').readFileSync($profileJson+'/known-hosts.json','utf8').includes('SHA256:'+ 'A'.repeat(43))")) { throw 'Cancellation changed the stored key.' }
    $accept = @'
(async()=>{
    const wait=async fn=>{const start=Date.now();while(!fn()){if(Date.now()-start>30000)throw Error('Acceptance timed out');await new Promise(r=>setTimeout(r,50));}};
    const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text || b.getAttribute('aria-label')===text);
    await wait(()=>!button('Connect via SSH').disabled);
    const input=document.querySelector('input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'test-only-secret');input.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,0));document.querySelector('.modal form').requestSubmit();await wait(()=>button('Trust replacement device'));button('Trust replacement device').click();
    await wait(()=>document.querySelector('.sample-tag')?.textContent==='SSH SESSION');
    document.querySelector('[role=switch]').click();await wait(()=>!button('Disconnect device').disabled);
    button('All hardware').click();await wait(()=>document.querySelectorAll('.probe-card').length===23);
    [...document.querySelectorAll('.probe-card')].find(el=>el.querySelector('h3').textContent==='UART / serial ports').click();await wait(()=>document.querySelector('.evidence-tabs'));
    const tabs=[...document.querySelectorAll('[role=tab]')].map(el=>el.textContent);
    if(JSON.stringify(tabs)!==JSON.stringify(['Standard output','Standard error']))throw Error('Raw evidence tabs have extra punctuation or views');
    button('Close dialog').click();await wait(()=>!document.querySelector('[role=dialog]'));
    [...document.querySelectorAll('.probe-card')].find(el=>el.querySelector('h3').textContent==='LAN / Ethernet').click();await wait(()=>document.querySelector('.ethernet-warning'));
    if(document.querySelector('.evidence-meta .badge').textContent!=='Collected')throw Error('Partial LAN became a failed probe');
    [...document.querySelectorAll('[role=tab]')].find(el=>el.textContent==='Table view').click();await wait(()=>document.querySelector('.evidence-table'));
    const evidence=document.querySelector('.evidence-table').textContent;
    if(!evidence.includes('/sys/class/net/lan0/carrier') || !evidence.includes('/sys/class/net/lan1/operstate') || evidence.includes('/sys/class/net/lan1/carrier'))throw Error('Invalid or missing partial LAN rows');
    return {connected:true,rawTabs:tabs,partialLANWarning:true,validLANInterfaces:true};
})()
'@
    Write-Output ('Windows acceptance and raw tabs: ' + ((Evaluate $renderer $accept) | ConvertTo-Json -Compress))
    if (-not (Evaluate $main "(()=>{const keys=JSON.parse(process.getBuiltinModule('fs').readFileSync($profileJson+'/known-hosts.json','utf8'));return keys[fixtureEndpoint]!=='SHA256:'+ 'A'.repeat(43) && keys['other-board:22']==='unchanged';})()")) { throw 'Replacement did not preserve other keys.' }
    Write-Output 'Windows host-key confirmation passed: native window stays enabled, cancel preserves trust, acceptance connects, cursor styles are visible, raw tabs have no dot.'
} finally {
    if ($null -ne $originalCursor) { [HubCursorProbe]::SetCursorPos($originalCursor.X, $originalCursor.Y) | Out-Null }
    foreach ($socket in $sockets) { $socket.Dispose() }
    if ($launch -and -not $launch.HasExited) { & taskkill.exe /PID $launch.Id /T /F 2>$null | Out-Null }
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
