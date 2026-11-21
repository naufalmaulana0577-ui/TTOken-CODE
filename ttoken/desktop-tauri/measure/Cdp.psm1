<#
.SYNOPSIS
Minimal Chrome DevTools Protocol client for driving the Web client in both builds.

.DESCRIPTION
The Electron build opens the protocol with --remote-debugging-port; the Tauri build opens it through WebView2 when
TTOKEN_DESKTOP_DEBUG_PORT is set. Both expose the same page, so one driver measures both builds the same way.
Only Runtime.evaluate and Input.dispatchMouseEvent are used; no protocol domain is enabled, so the page receives no
extra instrumentation beyond the open connection.
#>

Set-StrictMode -Version Latest

function Find-CdpPage {
    <#
    .SYNOPSIS
    Wait for the page target whose URL starts with UrlPrefix and return it (it carries webSocketDebuggerUrl).

    .DESCRIPTION
    With Process, the wait ends as soon as that process exits. The endpoint is polled ten times a second, so a wait
    that starts with the app takes little processor time from its startup.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int] $Port,
        [Parameter(Mandatory)] [string] $UrlPrefix,
        [int] $TimeoutSeconds = 120,
        [System.Diagnostics.Process] $Process
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($null -ne $Process -and $Process.HasExited) {
            throw "the app exited with code $($Process.ExitCode) before its DevTools page appeared"
        }
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2 -NoProxy
            $page = @($targets | Where-Object { $_.type -eq 'page' -and $_.url.StartsWith($UrlPrefix) }) | Select-Object -First 1
            if ($null -ne $page) { return $page }
        }
        catch {
            # The endpoint opens after the browser process starts.
            Write-Verbose "DevTools endpoint not ready: $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds 100
    }
    throw "no DevTools page starting with $UrlPrefix appeared on port $Port within $TimeoutSeconds seconds"
}

function Connect-Cdp {
    <#
    .SYNOPSIS
    Open a DevTools connection to one page target.

    .DESCRIPTION
    Input reaches a page only while it is the foreground page of its window, so the connection brings the page to
    the front, unless NoActivate is given: then the caller does that once the window shows (Page.bringToFront).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $WebSocketUrl, [switch] $NoActivate)
    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    $socket.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(30)
    $null = $socket.ConnectAsync([uri] $WebSocketUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $session = [pscustomobject]@{ Socket = $socket; NextId = 1 }
    if (-not $NoActivate) { $null = Invoke-Cdp -Session $session -Method 'Page.bringToFront' }
    $session
}

function Disconnect-Cdp {
    <# .SYNOPSIS Close a DevTools connection; a page that already went away is not an error. #>
    param([Parameter(Mandatory)] [object] $Session)
    try {
        if ($Session.Socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
            $null = $Session.Socket.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'done',
                [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        }
    }
    catch { Write-Verbose "DevTools connection closed with: $($_.Exception.Message)" }
    finally { $Session.Socket.Dispose() }
}

function Receive-CdpMessage {
    param([Parameter(Mandatory)] [object] $Session, [Parameter(Mandatory)] [datetime] $Deadline)
    $buffer = [byte[]]::new(65536)
    $stream = [IO.MemoryStream]::new()
    try {
        do {
            $remaining = $Deadline - (Get-Date)
            if ($remaining -le [TimeSpan]::Zero) { throw 'DevTools reply timed out' }
            $cancel = [Threading.CancellationTokenSource]::new($remaining)
            try {
                $segment = [ArraySegment[byte]]::new($buffer)
                $result = $Session.Socket.ReceiveAsync($segment, $cancel.Token).GetAwaiter().GetResult()
            }
            finally { $cancel.Dispose() }
            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { throw 'DevTools connection closed' }
            $stream.Write($buffer, 0, $result.Count)
        } while (-not $result.EndOfMessage)
        [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json -Depth 50
    }
    finally { $stream.Dispose() }
}

function Invoke-Cdp {
    <# .SYNOPSIS Send one protocol command and return its result; events received meanwhile are dropped. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [object] $Session,
        [Parameter(Mandatory)] [string] $Method,
        [hashtable] $Params = @{},
        [int] $TimeoutSeconds = 120
    )
    $id = $Session.NextId
    $Session.NextId = $id + 1
    $json = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 20 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $null = $Session.Socket.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true,
        [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        $message = Receive-CdpMessage -Session $Session -Deadline $deadline
        if ($message.PSObject.Properties.Name -notcontains 'id' -or $message.id -ne $id) { continue }
        if ($message.PSObject.Properties.Name -contains 'error') { throw "DevTools $Method failed: $($message.error.message)" }
        return $message.result
    }
}

function Invoke-CdpScript {
    <#
    .SYNOPSIS
    Evaluate a script in the page and return its JSON value; with AwaitPromise the script's promise is awaited.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [object] $Session,
        [Parameter(Mandatory)] [string] $Expression,
        [switch] $AwaitPromise,
        [int] $TimeoutSeconds = 120
    )
    $params = @{ expression = $Expression; returnByValue = $true; awaitPromise = $AwaitPromise.IsPresent }
    $result = Invoke-Cdp -Session $Session -Method 'Runtime.evaluate' -Params $params -TimeoutSeconds $TimeoutSeconds
    if ($result.PSObject.Properties.Name -contains 'exceptionDetails') {
        $details = $result.exceptionDetails
        $text = if ($details.PSObject.Properties.Name -contains 'exception' -and $details.exception.PSObject.Properties.Name -contains 'description') {
            $details.exception.description
        }
        else { $details.text }
        throw "page script failed: $text"
    }
    if ($result.result.PSObject.Properties.Name -contains 'value') { return $result.result.value }
    $null
}

function Invoke-CdpClick {
    <# .SYNOPSIS Click at viewport coordinates (CSS pixels) with trusted mouse input. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [object] $Session, [Parameter(Mandatory)] [double] $X, [Parameter(Mandatory)] [double] $Y)
    Invoke-Cdp -Session $Session -Method 'Input.dispatchMouseEvent' -Params @{ type = 'mouseMoved'; x = $X; y = $Y } | Out-Null
    Invoke-Cdp -Session $Session -Method 'Input.dispatchMouseEvent' -Params @{
        type = 'mousePressed'; x = $X; y = $Y; button = 'left'; buttons = 1; clickCount = 1
    } | Out-Null
    Invoke-Cdp -Session $Session -Method 'Input.dispatchMouseEvent' -Params @{
        type = 'mouseReleased'; x = $X; y = $Y; button = 'left'; buttons = 0; clickCount = 1
    } | Out-Null
}

Export-ModuleMember -Function Find-CdpPage, Connect-Cdp, Disconnect-Cdp, Invoke-Cdp, Invoke-CdpScript, Invoke-CdpClick
