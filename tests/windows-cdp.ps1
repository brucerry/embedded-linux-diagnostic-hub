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
function Invoke-Cdp($Socket, [string]$Method, $Params) {
    $script:requestId++
    $id = $script:requestId
    $request = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 30 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($request)
    $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$bytes)
    $timeout = New-Object Threading.CancellationTokenSource
    $timeout.CancelAfter(90000)
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
function Evaluate($Socket, [string]$Expression) {
    $response = Invoke-Cdp $Socket 'Runtime.evaluate' @{ expression = $Expression; awaitPromise = $true; returnByValue = $true }
    if ($response.exceptionDetails) { throw ($response.exceptionDetails | ConvertTo-Json -Depth 10 -Compress) }
    return $response.result.value
}
