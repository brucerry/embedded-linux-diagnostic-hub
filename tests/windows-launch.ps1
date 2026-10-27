param(
    [Parameter(Mandatory = $true)]
    [string]$Executable
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$temporary = Join-Path $env:TEMP ("DiagnosticHub-portable-smoke-" + [Guid]::NewGuid().ToString('N'))
$launch = $null
$tracked = @()
New-Item -ItemType Directory -Path $temporary | Out-Null

try {
    $copiedExe = Join-Path $temporary 'Diagnostic-Hub.exe'
    Copy-Item -LiteralPath $Executable -Destination $copiedExe
    $env:ELECTRON_RUN_AS_NODE = $null
    $profile = Join-Path $temporary 'profile'
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $debugPort = $listener.LocalEndpoint.Port
    $listener.Stop()
    $launch = Start-Process -FilePath $copiedExe -ArgumentList @("--user-data-dir=$profile", "--remote-debugging-port=$debugPort") -PassThru
    $window = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)

    while ([DateTime]::UtcNow -lt $deadline -and -not $window) {
        $instances = @(Get-CimInstance Win32_Process)
        $tracked = @($launch.Id)
        for ($depth = 0; $depth -lt 5; $depth++) {
            $children = @($instances | Where-Object { $_.ParentProcessId -in $tracked } | ForEach-Object { $_.ProcessId })
            $tracked = @($tracked + $children | Select-Object -Unique)
        }
        $window = Get-Process -Id $tracked -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowTitle -like 'Diagnostic Hub*' } | Select-Object -First 1
        if (-not $window) { Start-Sleep -Milliseconds 500 }
    }

    if (-not $window) { throw 'Portable executable did not open the Diagnostic Hub window within 30 seconds.' }
    Write-Output ('Windows version: ' + [Environment]::OSVersion.Version.ToString())
    Write-Output ('Window title: ' + $window.MainWindowTitle)
    Write-Output ('Bundled runtime: ' + $window.Path)
    Write-Output ('Signature: ' + (Get-AuthenticodeSignature -LiteralPath $copiedExe).Status)
    $target = Invoke-RestMethod -Uri "http://127.0.0.1:$debugPort/json" |
        Where-Object { $_.url -eq 'app://bundle/index.html' } | Select-Object -First 1
    if (-not $target) { throw 'The packaged application page was not found.' }
    $socket = New-Object System.Net.WebSockets.ClientWebSocket
    $cancellation = New-Object System.Threading.CancellationTokenSource
    $cancellation.CancelAfter(10000)
    try {
        $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, $cancellation.Token).GetAwaiter().GetResult() | Out-Null
        $expression = 'JSON.stringify({connection:document.querySelector(".sample-tag").textContent,heading:document.querySelector("h1").textContent,bridge:typeof window.diagnosticHub.connect,node:typeof window.require,layout:Boolean(document.querySelector(".site-header")),hardware:document.querySelectorAll(".hardware-tile").length,metrics:document.querySelectorAll(".metric-card").length,guide:Boolean(document.querySelector(".connection-start")),exportDisabled:[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Export report").disabled})'
        $request = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $expression; returnByValue = $true } } | ConvertTo-Json -Depth 5 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($request)
        $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$bytes)
        $socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cancellation.Token).GetAwaiter().GetResult() | Out-Null
        $buffer = New-Object byte[] 65536
        $incoming = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$buffer)
        $received = $socket.ReceiveAsync($incoming, $cancellation.Token).GetAwaiter().GetResult()
        $response = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count) | ConvertFrom-Json
        $state = $response.result.result.value | ConvertFrom-Json
        if ($state.connection -ne 'NOT CONNECTED' -or $state.heading -ne 'Device overview' -or $state.bridge -ne 'function' -or $state.node -ne 'undefined' -or -not $state.layout -or $state.hardware -ne 0 -or $state.metrics -ne 0 -or -not $state.guide -or -not $state.exportDisabled) {
            throw ('Packaged UI or preload isolation failed: ' + ($state | ConvertTo-Json -Compress))
        }
        Write-Output 'Empty startup, connection guide, disabled export and isolated native bridge verified.'
    } finally {
        $socket.Dispose()
        $cancellation.Dispose()
    }
    Write-Output 'Windows portable cold-launch smoke passed.'
    $window.CloseMainWindow() | Out-Null
    $launch.WaitForExit(5000) | Out-Null
} finally {
    if ($launch -and -not $launch.HasExited) {
        & taskkill.exe /PID $launch.Id /T /F 2>$null | Out-Null
    }
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
