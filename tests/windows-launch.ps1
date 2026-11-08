param(
    [Parameter(Mandatory = $true)]
    [string]$Executable
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$temporary = Join-Path $env:TEMP ("DiagnosticHub-portable-smoke-" + [Guid]::NewGuid().ToString('N'))
$launch = $null
$window = $null
$listener = $null
$socket = $null
$cancellation = $null
$launchAttempted = $false
$failure = $null
$cleanupFailures = @()
New-Item -ItemType Directory -Path $temporary | Out-Null

try {
    $copiedExe = Join-Path $temporary 'Diagnostic-Hub.exe'
    $sourceHash = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash
    Copy-Item -LiteralPath $Executable -Destination $copiedExe
    if ((Get-FileHash -LiteralPath $copiedExe -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Copied portable executable differs from its selected input.' }
    Write-Output ('Portable executable SHA256: ' + $sourceHash.ToLowerInvariant())
    $env:ELECTRON_RUN_AS_NODE = $null
    $profile = Join-Path $temporary 'profile'
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $debugPort = $listener.LocalEndpoint.Port
    $listener.Stop()
    $launchAttempted = $true
    $launch = Start-Process -FilePath $copiedExe -ArgumentList @("--user-data-dir=$profile", "--remote-debugging-port=$debugPort") -PassThru
    $launch.Handle | Out-Null
    $launchStart = $launch.StartTime.ToUniversalTime()
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $target = $null

    while ([DateTime]::UtcNow -lt $deadline -and -not $target) {
        if (-not $window) {
            # This is bounded discovery on a fresh CI VM, not a process-namespace proof.
            $instances = @(Get-CimInstance Win32_Process -OperationTimeoutSec 2)
            $tracked = @($launch.Id)
            for ($depth = 0; $depth -lt 5; $depth++) {
                $children = @($instances | Where-Object { $_.ParentProcessId -in $tracked } | ForEach-Object { $_.ProcessId })
                $tracked = @($tracked + $children | Select-Object -Unique)
            }
            $processes = @(Get-Process -Id $tracked -ErrorAction SilentlyContinue)
            try {
                $window = $processes | Where-Object { $_.MainWindowTitle -like 'Diagnostic Hub*' } | Select-Object -First 1
                if ($window) {
                    $window.Handle | Out-Null
                    if ($window.StartTime.ToUniversalTime() -lt $launchStart) { throw 'Discovered window predates this launch.' }
                }
            } finally {
                foreach ($process in $processes) {
                    if (-not [object]::ReferenceEquals($process, $window)) { $process.Dispose() }
                }
            }
        }
        if ($window) {
            if ($window.HasExited) { throw 'The discovered application exited before startup was verified.' }
            if (($deadline - [DateTime]::UtcNow).TotalSeconds -lt 1) { break }
            try {
                $target = Invoke-RestMethod -Uri "http://127.0.0.1:$debugPort/json" -TimeoutSec 1 |
                    Where-Object { $_.url -eq 'app://bundle/index.html' } | Select-Object -First 1
            } catch {
                $target = $null
            }
        }
        if (-not $target) { Start-Sleep -Milliseconds 100 }
    }
    if (-not $window -or -not $target) { throw 'Portable window and packaged page were not ready within 30 seconds.' }
    $endpoint = [Uri]$target.webSocketDebuggerUrl
    if ($endpoint.Scheme -ne 'ws' -or $endpoint.Host -ne '127.0.0.1' -or $endpoint.Port -ne $debugPort -or $endpoint.UserInfo -or $endpoint.Query -or $endpoint.Fragment -or -not $endpoint.AbsolutePath.StartsWith('/devtools/page/')) {
        throw 'The packaged page returned an unexpected local debugger endpoint.'
    }
    Write-Output ('Windows version: ' + [Environment]::OSVersion.Version.ToString())
    Write-Output ('Window title: ' + $window.MainWindowTitle)
    Write-Output ('Bundled runtime: ' + $window.Path)
    Write-Output ('Signature: ' + (Get-AuthenticodeSignature -LiteralPath $copiedExe).Status)
    $socket = New-Object System.Net.WebSockets.ClientWebSocket
    $cancellation = New-Object System.Threading.CancellationTokenSource
    $cancellation.CancelAfter(10000)
    $socket.ConnectAsync($endpoint, $cancellation.Token).GetAwaiter().GetResult() | Out-Null
    $expression = '(() => { const connection=document.querySelector(".sample-tag"),heading=document.querySelector("h1"),layout=document.querySelector(".site-header"),guide=document.querySelector(".connection-start"),button=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Export report"); return JSON.stringify({ready:Boolean(connection&&heading&&layout&&guide&&button),connection:connection?.textContent,heading:heading?.textContent,bridge:typeof window.diagnosticHub?.connect,node:typeof window.require,layout:Boolean(layout),hardware:document.querySelectorAll(".hardware-tile").length,metrics:document.querySelectorAll(".metric-card").length,guide:Boolean(guide),exportDisabled:button?.disabled}); })()'
    $ready = $false
    $messageCount = 0
    $frameCount = 0
    for ($requestId = 1; $requestId -le 64 -and -not $ready; $requestId++) {
        $cancellation.Token.ThrowIfCancellationRequested()
        $request = @{ id = $requestId; method = 'Runtime.evaluate'; params = @{ expression = $expression; returnByValue = $true } } | ConvertTo-Json -Depth 5 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($request)
        $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$bytes)
        $socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cancellation.Token).GetAwaiter().GetResult() | Out-Null
        $matched = $false
        while (-not $matched) {
            $messageCount++
            if ($messageCount -gt 128) { throw 'Debugger message count exceeded its bound.' }
            $message = New-Object System.IO.MemoryStream
            try {
                $buffer = New-Object byte[] 8192
                $incoming = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$buffer)
                do {
                    $cancellation.Token.ThrowIfCancellationRequested()
                    $frameCount++
                    if ($frameCount -gt 256) { throw 'Debugger frame count exceeded its bound.' }
                    $received = $socket.ReceiveAsync($incoming, $cancellation.Token).GetAwaiter().GetResult()
                    if ($received.MessageType -ne [System.Net.WebSockets.WebSocketMessageType]::Text) { throw 'Debugger returned a non-text or closed message.' }
                    if ($message.Length + $received.Count -gt 65536) { throw 'Debugger response exceeded 64 KiB.' }
                    $message.Write($buffer, 0, $received.Count)
                } while (-not $received.EndOfMessage)
                $response = [System.Text.Encoding]::UTF8.GetString($message.ToArray()) | ConvertFrom-Json
            } finally {
                $message.Dispose()
            }
            if ($null -eq $response.id) { continue }
            if (($response.id -isnot [int] -and $response.id -isnot [long]) -or $response.id -ne $requestId) { throw 'Debugger response ID did not match the request.' }
            if ($response.error -or $response.result.exceptionDetails) { throw 'Packaged renderer evaluation failed.' }
            $state = $response.result.result.value | ConvertFrom-Json
            $ready = $state.ready -is [bool] -and $state.ready
            $matched = $true
        }
        if (-not $ready) { Start-Sleep -Milliseconds 100 }
    }
    if (-not $ready) { throw 'Packaged startup DOM was not ready within the bounded debugger observation.' }
    if ($state.connection -ne 'NOT CONNECTED' -or $state.heading -ne 'Device overview' -or $state.bridge -ne 'function' -or $state.node -ne 'undefined' -or -not $state.layout -or $state.hardware -ne 0 -or $state.metrics -ne 0 -or -not $state.guide -or -not $state.exportDisabled) {
        throw ('Packaged UI or preload isolation failed: ' + ($state | ConvertTo-Json -Compress))
    }
    Write-Output 'Empty startup, connection guide, disabled export and isolated native bridge verified.'
    $closeDeadline = [DateTime]::UtcNow.AddSeconds(5)
    if (-not $window.CloseMainWindow()) { throw 'The observed application window did not accept normal close.' }
    $remaining = [Math]::Max(0, [int]($closeDeadline - [DateTime]::UtcNow).TotalMilliseconds)
    if (-not $window.WaitForExit($remaining)) { throw 'The observed application process did not exit normally within five seconds.' }
    $remaining = [Math]::Max(0, [int]($closeDeadline - [DateTime]::UtcNow).TotalMilliseconds)
    if (-not $launch.WaitForExit($remaining)) { throw 'The original portable launcher did not exit within the same close budget.' }
    if (-not $window.HasExited -or -not $launch.HasExited -or $window.ExitCode -ne 0 -or $launch.ExitCode -ne 0) { throw 'Observed window or launcher termination was unsuccessful.' }
} catch {
    $failure = $_
} finally {
    foreach ($resource in @($socket, $cancellation, $window, $launch)) {
        if ($resource) {
            try { $resource.Dispose() } catch { $cleanupFailures += 'handle-dispose' }
        }
    }
    if ($listener) {
        try { $listener.Stop() } catch { $cleanupFailures += 'listener-stop' }
    }
    # Retain copied EXE/profile after every launch attempt; unknown children are never killed or deleted here.
    try {
        Write-Output ('Retained isolated smoke directory: ' + $temporary)
        Write-Output ('Launch attempted: ' + $launchAttempted + '; descendant/namespace retirement is not established.')
    } catch { $cleanupFailures += 'retention-output' }
}
if ($failure) { throw $failure }
if ($cleanupFailures.Count) { throw ('Cold-launch handle cleanup failed: ' + ($cleanupFailures -join ', ')) }
Write-Output 'Windows portable cold-launch smoke passed; observed window and launcher exited successfully.'
