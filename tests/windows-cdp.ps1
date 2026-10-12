function Free-Port {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop(); return $port
}
function Open-Inspector([int]$Port, [bool]$Renderer) {
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list")
            $target = if ($Renderer) { $targets | Where-Object { $_.url -eq 'app://bundle/index.html' } | Select-Object -First 1 } else { $targets | Select-Object -First 1 }
            if ($target) {
                $socket = New-Object Net.WebSockets.ClientWebSocket
                $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
                return $socket
            }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    throw "Inspector did not become ready on port $Port"
}
function Invoke-Cdp($Socket, [string]$Method, $Params, [int]$TimeoutMilliseconds = 90000) {
    $script:requestId++
    $id = $script:requestId
    $request = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 30 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($request)
    $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$bytes)
    $timeout = New-Object Threading.CancellationTokenSource
    $timeout.CancelAfter($TimeoutMilliseconds)
    try {
        $Socket.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, $timeout.Token).GetAwaiter().GetResult() | Out-Null
        do {
            $buffer = New-Object byte[] 65536
            $incoming = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$buffer)
            $message = New-Object IO.MemoryStream
            try {
                do {
                    $received = $Socket.ReceiveAsync($incoming, $timeout.Token).GetAwaiter().GetResult()
                    $message.Write($buffer, 0, $received.Count)
                } while (-not $received.EndOfMessage)
                $response = [Text.Encoding]::UTF8.GetString($message.ToArray()) | ConvertFrom-Json
            } finally { $message.Dispose() }
        } while ($response.id -ne $id)
        if ($response.error) { throw ($response.error | ConvertTo-Json -Compress) }
        return $response.result
    } finally { $timeout.Dispose() }
}
function Evaluate($Socket, [string]$Expression, [int]$TimeoutMilliseconds = 90000) {
    $response = Invoke-Cdp $Socket 'Runtime.evaluate' @{ expression = $Expression; awaitPromise = $true; returnByValue = $true } $TimeoutMilliseconds
    if ($response.exceptionDetails) { throw ($response.exceptionDetails | ConvertTo-Json -Depth 10 -Compress) }
    return $response.result.value
}

function Wait-RendererReady($Socket, [int]$TimeoutMilliseconds = 30000) {
    # /json/list advertises a pending URL before its document has committed.
    # Reuse the original UI-startup budget and inspect the actual current realm.
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $state = $null
    $expression = @'
({
    url:document.URL,
    ready:document.readyState,
    bridge:typeof window.diagnosticHub?.connect === 'function',
    connect:[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Connect device' || button.getAttribute('aria-label') === 'Connect device')
})
'@
    while ([DateTime]::UtcNow -lt $deadline) {
        $remaining = [int][Math]::Max(1, [Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalMilliseconds))
        try {
            $state = Evaluate $Socket $expression $remaining
            if ($state.url -eq 'app://bundle/index.html' -and $state.ready -eq 'complete' -and $state.bridge -and $state.connect) {
                return $state
            }
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { break }
            # A document replacement can occur between these read-only probes.
            # Other protocol/script failures remain failures, without retrying the exercise.
            if ($_.Exception.Message -notmatch 'Execution context was destroyed|Cannot find (default )?execution context|Cannot find context with specified id') { throw }
        }
        $remaining = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min(50, $remaining)) }
    }
    throw ('Committed renderer did not become ready within ' + $TimeoutMilliseconds + 'ms: ' + ($state | ConvertTo-Json -Compress))
}
